import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { DOMAIN_FILTER_KEY, domainFilterAllows } from '../extension/origin.js'
import { BrowserExtensionBridge } from '../lib/bridge.js'
import { apply } from '../lib/index.js'

const EXTENSION_ORIGIN = 'chrome-extension://' + 'a'.repeat(32)
const PAIRING_KEY = 'dsh-plugin-chrome-controller/pairing-code'
const TRUSTED_HOST = 'dsh.example.ts.net'

/** Minimal plugin context: captures routes and models DSH's /api Host fence. */
function fakeContext({ bindHost = '127.0.0.1', rejection } = {}) {
  const routes = new Map()
  const fetchRoutes = new Map()
  const records = new Map()
  const handlers = new Map()
  const context = {
    routes,
    fetchRoutes,
    webServer: {
      host: bindHost,
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    connection: {
      fetch: {
        register(route) {
          fetchRoutes.set(route.path, route.fetch)
          return () => fetchRoutes.delete(route.path)
        },
      },
      requestRejection: rejection ?? (request => {
        const host = request.headers.host
        if (host === TRUSTED_HOST || host === 'localhost:3080' || host === '127.0.0.1:3080') return 401
        return 403
      }),
    },
    credentials: {
      async readRecord(key) { return records.get(key) },
      async modifyRecord(key, update) {
        const next = await update(records.get(key))
        if (next !== undefined) records.set(key, next)
        return records.get(key)
      },
    },
    handlers,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return () => handlers.delete(event)
    },
    effect: () => {},
  }
  return context
}

/** Drive one extension route with a fake node:http exchange. */
async function call(context, path, { method = 'POST', host = TRUSTED_HOST, origin = EXTENSION_ORIGIN, remoteAddress = '100.64.0.7', body } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  request.method = method
  request.headers = { host, ...(origin === null ? {} : { origin }) }
  request.socket = { remoteAddress }
  let status
  let headers = {}
  let text = ''
  const listeners = new Map()
  const response = {
    destroyed: false,
    writeHead(code, values) { status = code; headers = values ?? {} },
    end(chunk) { if (chunk !== undefined) text += String(chunk) },
    once(event, listener) { listeners.set(event, listener) },
    removeListener(event) { listeners.delete(event) },
  }
  const handler = context.routes.get('/dsh-browser-extension/' + path)
  assert.ok(handler, 'route ' + path + ' is registered')
  await handler(request, response)
  return { status, headers, json: text === '' ? undefined : JSON.parse(text) }
}

async function pairingCode(context) {
  return (await context.credentials.readRecord(PAIRING_KEY)).key
}

async function connect(context, options = {}) {
  const code = await pairingCode(context)
  const authorized = await call(context, 'authorize', { ...options, body: { pairingCode: code } })
  assert.equal(authorized.status, 200)
  const connected = await call(context, 'connect', { ...options, body: { pairToken: authorized.json.pairToken } })
  assert.equal(connected.status, 200)
  return connected.json.sessionToken
}

describe('BrowserExtensionBridge authority admission', () => {
  let bridge
  afterEach(async () => { await bridge?.close(); bridge = undefined })

  it('keeps loopback pairing working', async () => {
    const context = fakeContext({ rejection: () => 403 })
    bridge = await BrowserExtensionBridge.create(context, { operationTimeoutMs: 1000 })
    const loopback = { host: '127.0.0.1:3080', remoteAddress: '127.0.0.1' }
    const preflight = await call(context, 'authorize', { ...loopback, method: 'OPTIONS' })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers['access-control-allow-origin'], EXTENSION_ORIGIN)
    await connect(context, loopback)
  })

  it('accepts a Host that DSH Web trusts from a remote peer and completes a command round trip', async () => {
    const context = fakeContext()
    bridge = await BrowserExtensionBridge.create(context, { operationTimeoutMs: 5000 })
    assert.equal((await call(context, 'authorize', { method: 'OPTIONS' })).status, 204)
    const sessionToken = await connect(context)
    const result = bridge.request('tabs.list', { a: 1 })
    const polled = await call(context, 'poll', { body: { sessionToken } })
    assert.equal(polled.status, 200)
    assert.equal(polled.json.commands.length, 1)
    const [command] = polled.json.commands
    assert.equal(command.method, 'tabs.list')
    const responded = await call(context, 'respond', { body: { sessionToken, id: command.id, ok: true, result: { tabs: [] } } })
    assert.equal(responded.status, 200)
    assert.deepEqual(await result, { tabs: [] })
  })

  it('rejects a Host that DSH Web does not trust', async () => {
    const context = fakeContext()
    bridge = await BrowserExtensionBridge.create(context, { operationTimeoutMs: 1000 })
    assert.equal((await call(context, 'authorize', { method: 'OPTIONS', host: 'evil.example' })).status, 403)
    const code = await pairingCode(context)
    const denied = await call(context, 'authorize', { host: 'evil.example', body: { pairingCode: code } })
    assert.equal(denied.status, 403)
    assert.equal(denied.headers['access-control-allow-origin'], undefined)
  })

  it('rejects a trusted Host when the Origin is not a Chrome extension', async () => {
    const context = fakeContext()
    bridge = await BrowserExtensionBridge.create(context, { operationTimeoutMs: 1000 })
    const code = await pairingCode(context)
    for (const origin of ['https://evil.example', null]) {
      const denied = await call(context, 'authorize', { origin, body: { pairingCode: code } })
      assert.equal(denied.status, 403)
    }
  })

  it('still rejects a loopback Host from a remote peer when DSH Web does not trust it', async () => {
    const context = fakeContext({ rejection: () => 403 })
    bridge = await BrowserExtensionBridge.create(context, { operationTimeoutMs: 1000 })
    const denied = await call(context, 'authorize', { method: 'OPTIONS', host: '127.0.0.1:3080', remoteAddress: '172.19.0.9' })
    assert.equal(denied.status, 403)
  })

  it('lets the webserver/authorize hook admit only trusted extension requests', async () => {
    const context = fakeContext()
    bridge = await BrowserExtensionBridge.create(context, { operationTimeoutMs: 1000 })
    const [hook] = context.handlers.get('webserver/authorize')
    const request = ({ host = TRUSTED_HOST, origin = EXTENSION_ORIGIN, method = 'POST', pathname = '/dsh-browser-extension/connect', remoteAddress = '100.64.0.7' } = {}) => ({
      transport: 'http', method, url: { pathname }, headers: { host, origin }, socket: { remoteAddress },
    })
    assert.deepEqual(hook(request(), 'anonymous'), { kind: 'allow' })
    assert.deepEqual(hook(request({ method: 'OPTIONS' }), 'anonymous'), { kind: 'allow' })
    assert.deepEqual(hook(request({ host: '127.0.0.1:3080', remoteAddress: '127.0.0.1' }), 'anonymous'), { kind: 'allow' })
    assert.equal(hook(request({ host: 'evil.example' }), 'anonymous'), undefined)
    assert.equal(hook(request({ origin: 'https://evil.example' }), 'anonymous'), undefined)
    assert.equal(hook(request({ pathname: '/api/other' }), 'anonymous'), undefined)
    assert.equal(hook(request({ method: 'GET' }), 'anonymous'), undefined)
    assert.equal(hook(request(), 'session'), undefined)
    await bridge.close()
    assert.equal(hook(request(), 'anonymous'), undefined)
  })

  it('preflights, admits and rejects on every extension route', async () => {
    const context = fakeContext()
    bridge = await BrowserExtensionBridge.create(context, { operationTimeoutMs: 1000 })
    const sessionToken = await connect(context)
    for (const path of ['authorize', 'connect', 'poll', 'respond', 'disconnect']) {
      assert.equal((await call(context, path, { method: 'OPTIONS' })).status, 204, path + ' preflight')
      assert.equal((await call(context, path, { method: 'OPTIONS', host: 'evil.example' })).status, 403, path + ' untrusted preflight')
      assert.equal((await call(context, path, { host: 'evil.example', body: {} })).status, 403, path + ' untrusted host')
      assert.equal((await call(context, path, { origin: 'https://evil.example', body: {} })).status, 403, path + ' web origin')
      assert.equal((await call(context, path, { method: 'GET' })).status, 405, path + ' method')
    }
    const disconnected = await call(context, 'disconnect', { body: { sessionToken } })
    assert.equal(disconnected.status, 200)
    assert.equal((await call(context, 'poll', { body: { sessionToken } })).status, 401)
  })

  it('fails closed when the Host fence throws', async () => {
    const context = fakeContext({ rejection: () => { throw new Error('boom') } })
    bridge = await BrowserExtensionBridge.create(context, { operationTimeoutMs: 1000 })
    assert.equal((await call(context, 'authorize', { method: 'OPTIONS' })).status, 403)
  })

  it('fails closed on an unexpected fence status', async () => {
    for (const status of [400, 429, 500]) {
      const context = fakeContext({ rejection: () => status })
      const local = await BrowserExtensionBridge.create(context, { operationTimeoutMs: 1000 })
      const result = await call(context, 'authorize', { method: 'OPTIONS' })
      await local.close()
      assert.equal(result.status, 403, `status ${status}`)
    }
  })

  it('starts when DSH Web binds an address other than 127.0.0.1', async () => {
    const context = fakeContext({ bindHost: '172.19.0.4' })
    bridge = await BrowserExtensionBridge.create(context, { operationTimeoutMs: 1000 })
    assert.ok(context.routes.has('/dsh-browser-extension/connect'))
  })
})

it('lets a change wait reach its extension deadline and honors harness cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const context = fakeContext()
  const tools = new Map()
  context.tools = { register(tool) { tools.set(tool.name, tool) } }
  context.systemPrompt = { section() {}, getSectionOrder: () => 0 }
  context.skills = { register() {} }
  context.effect = factory => t.after(factory())

  await apply(context)
  const sessionToken = await connect(context)
  const waitForChange = tools.get('dsh_browser_wait_for_change')
  const args = { tabId: 42, selector: '#status' }
  const result = waitForChange.execute(args, { signal: new AbortController().signal }).catch(error => error)
  const firstPoll = await call(context, 'poll', { body: { sessionToken } })
  const [command] = firstPoll.json.commands
  assert.equal(command.method, 'page.waitForChange')
  assert.equal(command.params.timeoutMs, 600_000)

  t.mock.timers.tick(600_000)
  const message = 'Timed out waiting for the selected element to change'
  await call(context, 'respond', {
    body: { sessionToken, id: command.id, ok: false, error: { message } },
  })
  assert.equal((await result).message, message)

  const controller = new AbortController()
  const pending = waitForChange.execute({ ...args, timeoutMs: 45_000 }, { signal: controller.signal })
  const secondPoll = await call(context, 'poll', { body: { sessionToken } })
  const [shortWait] = secondPoll.json.commands
  assert.equal(shortWait.params.timeoutMs, 45_000)

  t.mock.timers.tick(5_000)
  controller.abort(new Error('Harness deadline reached'))
  await assert.rejects(pending, { message: 'Harness deadline reached' })
  const cancelled = await call(context, 'poll', { body: { sessionToken } })
  assert.deepEqual(cancelled.json.cancelled, [shortWait.id])
})

async function mountDialogTools(t, ask) {
  const context = fakeContext()
  const tools = new Map()
  context.tools = { register(tool) { tools.set(tool.name, tool) } }
  context.systemPrompt = { section() {}, getSectionOrder: () => 0 }
  context.skills = { register() {} }
  context.get = key => key === 'userQuestions' ? { ask } : undefined
  context.effect = factory => t.after(factory())
  await apply(context)
  const sessionToken = await connect(context)
  const controller = new AbortController()
  t.after(() => controller.abort())
  return {
    run(name, args) { return tools.get('dsh_browser_' + name).execute(args, { agent: {}, signal: controller.signal }) },
    async receive(method) {
      const response = await call(context, 'poll', { body: { sessionToken } })
      const [command] = response.json.commands
      assert.equal(command.method, method)
      return command
    },
    async respond(command, result) {
      await call(context, 'respond', { body: { sessionToken, id: command.id, ok: true, result } })
    },
  }
}

it('asks the user when a click opens a dialog and responds while the tab queue is held', { timeout: 2_000 }, async t => {
  const asked = Promise.withResolvers()
  const answered = Promise.withResolvers()
  const plugin = await mountDialogTools(t, request => {
    asked.resolve(request.questions[0])
    return answered.promise
  })
  const result = plugin.run('click', { tabId: 42, selector: '#save' })
  const click = await plugin.receive('page.click')
  await plugin.respond(click, { blockedByDialog: 'dialog-1' })

  const inspect = await plugin.receive('page.dialogInspect')
  assert.deepEqual(inspect.params, { tabId: 42, dialogId: 'dialog-1' })
  await plugin.respond(inspect, {
    status: 'open',
    dialog: { id: 'dialog-1', type: 'confirm', origin: 'https://example.com', message: 'Save [draft](https://example.com)?' },
  })
  const question = await asked.promise
  assert.equal(question.id, 'dialog-1')
  assert.deepEqual(question.options.map(option => option.label), ['Cancel', 'Confirm'])
  assert.ok(question.detail.includes('\\[draft\\]'))
  answered.resolve({ answers: [{ id: question.id, selected: ['Confirm'] }] })

  const reply = await plugin.receive('page.dialogRespond')
  assert.deepEqual(reply.params, { tabId: 42, dialogId: 'dialog-1', accept: true })
  await plugin.respond(reply, { status: 'accepted' })
  assert.deepEqual(await result, {
    tabId: 42, status: 'dialog_handled', resolution: 'accepted', dialogType: 'confirm', origin: 'https://example.com', interrupted: true,
  })
})

it('takes explicit prompt text from the user and leaves ambiguous answers open', { timeout: 2_000 }, async t => {
  let answer
  const plugin = await mountDialogTools(t, async () => ({ answers: [answer] }))
  for (const type of ['confirm', 'prompt']) {
    const dialog = { id: 'dialog-' + type, type, origin: 'https://example.com', message: 'Enter or confirm the name' }
    answer = { id: dialog.id, selected: [], custom: 'Draft A' }

    const result = plugin.run('handle_dialog', { tabId: 42 })
    const inspect = await plugin.receive('page.dialogInspect')
    await plugin.respond(inspect, { status: 'open', dialog })
    if (type === 'confirm') {
      assert.equal((await result).status, 'dialog_pending')
      continue
    }

    const reply = await plugin.receive('page.dialogRespond')
    assert.deepEqual(reply.params, { tabId: 42, dialogId: dialog.id, accept: true, promptText: 'Draft A' })
    await plugin.respond(reply, { status: 'closed' })
    assert.equal((await result).status, 'dialog_closed')
  }
})

it('unblocks a suspended Chrome command without running the rest of its sequence', { timeout: 2_000 }, async () => {
  const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')
  const worker = source.slice(0, source.indexOf('chrome.runtime.onInstalled.addListener'))
    .replace(/^import .*\r?$/gmu, '')
  const calls = []
  const suspended = Promise.withResolvers()
  let pendingHandler
  let domainPolicy
  const url = 'https://example.com/form?private=1'
  const context = createContext({
    AbortController, AbortSignal, URL, crypto, performance, setTimeout, clearTimeout,
    DOMAIN_FILTER_KEY, domainFilterAllows,
    chrome: {
      storage: {
        onChanged: { addListener() {} },
        local: { async setAccessLevel() {}, async get() { return { [DOMAIN_FILTER_KEY]: domainPolicy } } },
      },
      tabs: { async get() { return { url } } },
      debugger: {
        async attach() {},
        async sendCommand(target, method, params) {
          calls.push({ method, params })
          if (method === 'Page.enable') return {}
          if (method === 'Page.handleJavaScriptDialog') {
            pendingHandler = undefined
            browserEvent(target, 'Page.javascriptDialogClosed', { userInput: 'ignored' })
            suspended.resolve({ result: { value: params.accept } })
            return {}
          }
          if (params.expression === 'confirm("Save?")') {
            pendingHandler = target
            browserEvent(target, 'Page.javascriptDialogOpening', { type: 'confirm', url, message: 'Save?' })
            return suspended.promise
          }
          return { result: { value: { width: 800, height: 600 } } }
        },
      },
    },
  })
  const [run, browserEvent] = runInContext(worker + '\nactiveSession = { origin: "https://dsh.example", sessionToken: "test" }\n'
    + ';[executeBrowserOperation, onBrowserDialogEvent]', context)
  const attempt = await run('page.sequence', {
    tabId: 42,
    steps: [
      { action: 'evaluate', method: 'page.evaluate', params: { tabId: 42, expression: 'confirm("Save?")' } },
      { action: 'evaluate', method: 'page.evaluate', params: { tabId: 42, expression: 'nextStep()' } },
    ],
  })
  const first = await run('page.dialogInspect', { tabId: 42, dialogId: attempt.blockedByDialog })
  assert.equal(first.dialog.origin, 'https://example.com')
  assert.equal(first.dialog.message, 'Save?')
  assert.equal(calls[0].method, 'Page.enable')
  assert.equal((await run('page.wait', { tabId: 43, durationMs: 0 })).waitedMs, 0)

  const target = pendingHandler
  browserEvent(target, 'Page.javascriptDialogClosed', {})
  browserEvent(target, 'Page.javascriptDialogOpening', { type: 'beforeunload', url, message: '' })
  const newer = await run('page.dialogInspect', { tabId: 42 })
  assert.notEqual(newer.dialog.id, first.dialog.id)
  assert.equal((await run('page.dialogRespond', { tabId: 42, dialogId: first.dialog.id, accept: true })).status, 'closed')

  domainPolicy = { mode: 'whitelist', domains: ['other.example'] }
  await assert.rejects(run('page.dialogRespond', { tabId: 42, dialogId: newer.dialog.id, accept: true }), /domain filter/u)
  domainPolicy = undefined
  assert.equal((await run('page.dialogRespond', { tabId: 42, dialogId: newer.dialog.id, accept: false })).status, 'dismissed')

  assert.equal((await run('page.wait', { tabId: 42, durationMs: 0 })).waitedMs, 0)
  assert.equal(calls.filter(call => call.method === 'Page.handleJavaScriptDialog').length, 1)
  assert.equal(calls.filter(call => call.params?.expression === 'confirm("Save?")').length, 1)
  assert.equal(calls.some(call => call.params?.expression === 'nextStep()'), false)
})

describe('BrowserExtensionBridge pairing failure limit', () => {
  let bridge
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: 1_000_000 }))
  afterEach(async () => {
    await bridge?.close()
    bridge = undefined
    mock.timers.reset()
  })

  it('refuses every attempt after 10 wrong codes in a minute, then recovers', async () => {
    const context = fakeContext()
    bridge = await BrowserExtensionBridge.create(context, { operationTimeoutMs: 1000 })
    const wrong = { body: { pairingCode: 'x'.repeat(24) } }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.equal((await call(context, 'authorize', wrong)).status, 401)
    }
    const limited = await call(context, 'authorize', wrong)
    assert.equal(limited.status, 429)
    assert.match(limited.json.error, /wait a minute/u)
    const code = await pairingCode(context)
    assert.equal((await call(context, 'authorize', { body: { pairingCode: code } })).status, 429)
    mock.timers.tick(60_001)
    assert.equal((await call(context, 'authorize', { body: { pairingCode: code } })).status, 200)
  })

  it('resets the failure count after a successful pairing', async () => {
    const context = fakeContext()
    bridge = await BrowserExtensionBridge.create(context, { operationTimeoutMs: 1000 })
    const wrong = { body: { pairingCode: 'x'.repeat(24) } }
    for (let attempt = 0; attempt < 9; attempt += 1) await call(context, 'authorize', wrong)
    const code = await pairingCode(context)
    assert.equal((await call(context, 'authorize', { body: { pairingCode: code } })).status, 200)
    for (let attempt = 0; attempt < 9; attempt += 1) {
      assert.equal((await call(context, 'authorize', wrong)).status, 401)
    }
  })
})

describe('pairing settings page', () => {
  it('shows the escaped origin the user browsed to', async () => {
    const context = fakeContext()
    const bridge = await BrowserExtensionBridge.create(context, { operationTimeoutMs: 1000 })
    try {
      const page = await context.fetchRoutes.get('/api/dsh-browser-extension/pairing')(new Request('http://x/api/dsh-browser-extension/pairing', {
        headers: { host: 'dsh.example.ts.net"><b', 'x-forwarded-proto': 'https' },
      }))
      const html = await page.text()
      assert.match(html, /value="https:\/\/dsh\.example\.ts\.net&#34;&#62;&#60;b"/u)
    } finally {
      await bridge.close()
    }
  })
})

describe('pairing page HTTPS hint', () => {
  async function pageFor(headers) {
    const context = fakeContext()
    const bridge = await BrowserExtensionBridge.create(context, { operationTimeoutMs: 1000 })
    try {
      const page = await context.fetchRoutes.get('/api/dsh-browser-extension/pairing')(new Request('http://x/api/dsh-browser-extension/pairing', { headers }))
      return await page.text()
    } finally {
      await bridge.close()
    }
  }

  it('warns when the shown remote origin is plain HTTP', async () => {
    assert.match(await pageFor({ host: TRUSTED_HOST }), /enter the <code>https:\/\/<\/code> form/u)
  })

  it('stays quiet for HTTPS remote origins and loopback origins', async () => {
    assert.doesNotMatch(await pageFor({ host: TRUSTED_HOST, 'x-forwarded-proto': 'https' }), /form of this address/u)
    assert.doesNotMatch(await pageFor({ host: '127.0.0.1:3080' }), /form of this address/u)
  })
})

describe('extension origin rule', () => {
  it('allows loopback over HTTP or HTTPS and remote hosts only over HTTPS', async () => {
    const { normalizeDshOrigin } = await import('../extension/origin.js')
    assert.equal(normalizeDshOrigin('http://127.0.0.1:3080/x'), 'http://127.0.0.1:3080')
    assert.equal(normalizeDshOrigin('https://localhost:3080'), 'https://localhost:3080')
    assert.equal(normalizeDshOrigin('https://dsh.example.com'), 'https://dsh.example.com')
    assert.equal(normalizeDshOrigin('http://dsh.example.com'), undefined)
    assert.equal(normalizeDshOrigin('ftp://127.0.0.1'), undefined)
    assert.equal(normalizeDshOrigin(''), undefined)
  })
})
