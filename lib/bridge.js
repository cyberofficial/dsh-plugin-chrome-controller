import { randomBytes } from 'node:crypto'

const PAIR_PATH = '/api/dsh-browser-extension/pair'
const CONNECT_PATH = '/dsh-browser-extension/connect'
const POLL_PATH = '/dsh-browser-extension/poll'
const RESPONSE_PATH = '/dsh-browser-extension/respond'
const DISCONNECT_PATH = '/dsh-browser-extension/disconnect'
const PAIR_LIFETIME_MS = 30_000
const SESSION_IDLE_MS = 60_000
const POLL_WAIT_MS = 15_000
const MAX_BODY_BYTES = 20 * 1024 * 1024
const MAX_PAIR_TOKENS = 16
// Backlog cap. In-flight commands are handed to poll waiters and leave the queue,
// so the bridge accepts at least MAX_IN_FLIGHT + this many commands before
// rejecting. Queued commands are delivered FIFO unless cancelled or the session ends.
const MAX_QUEUED_COMMANDS = 256
// Commands delivered per poll response. Chrome allows only ~6 concurrent
// connections per host (HTTP/1.1), so the extension keeps just a few long-polls
// open; each poll is answered with a batch of queued commands instead.
const MAX_COMMANDS_PER_POLL = 8

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExtensionOrigin(value) {
  if (typeof value !== 'string') return false
  try {
    const origin = new URL(value)
    return origin.protocol === 'chrome-extension:' && /^[a-p]{32}$/u.test(origin.hostname)
  } catch {
    return false
  }
}

function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress?.toLowerCase()
  return address === '127.0.0.1' || address === '::1' || address?.startsWith('127.')
    || address?.startsWith('::ffff:127.') === true
}

function writeJson(response, status, value, origin) {
  if (response.destroyed) return
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...(origin === undefined ? {} : {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      vary: 'Origin',
    }),
  })
  response.end(JSON.stringify(value))
}

function writePreflight(request, response) {
  const origin = request.headers.origin
  if (!isExtensionOrigin(origin) || !isLoopbackRequest(request)) {
    writeJson(response, 403, { error: 'Forbidden' })
    return
  }
  response.writeHead(204, {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '60',
    'cache-control': 'no-store',
    vary: 'Origin',
  })
  response.end()
}

async function readJsonBody(request) {
  const chunks = []
  let bytes = 0
  let tooLarge = false
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) {
      tooLarge = true
      continue
    }
    if (!tooLarge) chunks.push(chunk)
  }
  if (tooLarge) {
    const error = new Error('Request body is too large')
    error.statusCode = 413
    throw error
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Request body is not valid JSON')
  }
  if (!isRecord(value)) throw new Error('Request body must be a JSON object')
  return value
}

/** HTTP polling bridge between one DSH browser tool provider and the extension. */
export class BrowserExtensionBridge {
  #pairTokens = new Map()
  #pending = new Map()
  #queue = []
  #cancelled = new Set()
  #pollWaiters = new Set()
  #sessionToken
  #extensionOrigin
  #lastSeen = 0
  #nextRequestId = 0
  #operationTimeoutMs
  #disposeFetch
  #disposeRoutes = []
  #closed = false

  /**
   * Register authenticated pairing and loopback extension routes.
   * @param {object} context - DSH plugin context with connection and webServer services.
   * @param {{ operationTimeoutMs: number }} config - resolved bridge settings.
   */
  constructor(context, config) {
    if (context.webServer.host !== '127.0.0.1') {
      throw new Error('Chrome browser bridge requires DSH Web to bind to 127.0.0.1')
    }
    this.#operationTimeoutMs = config.operationTimeoutMs
    try {
      this.#disposeFetch = context.connection.fetch.register({
        path: PAIR_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: request => this.#pair(request),
      })
      this.#disposeRoutes.push(context.webServer.register({
        kind: 'exact',
        path: CONNECT_PATH,
        handler: (request, response) => this.#connect(request, response),
      }))
      this.#disposeRoutes.push(context.webServer.register({
        kind: 'exact',
        path: POLL_PATH,
        handler: (request, response) => this.#poll(request, response),
      }))
      this.#disposeRoutes.push(context.webServer.register({
        kind: 'exact',
        path: RESPONSE_PATH,
        handler: (request, response) => this.#respond(request, response),
      }))
      this.#disposeRoutes.push(context.webServer.register({
        kind: 'exact',
        path: DISCONNECT_PATH,
        handler: (request, response) => this.#disconnectRequest(request, response),
      }))
    } catch (error) {
      this.#disposeFetch?.()
      for (const dispose of this.#disposeRoutes) dispose()
      throw error
    }
  }

  /** @returns whether an extension session is currently active. */
  get connected() {
    return this.#sessionToken !== undefined && Date.now() - this.#lastSeen <= SESSION_IDLE_MS
  }

  /**
   * Queue one browser operation and wait for the extension response.
   * @param {string} method - fixed browser operation name.
   * @param {object} params - JSON arguments for the operation.
   * @param {AbortSignal} signal - DSH tool cancellation signal.
   * @returns {Promise<object>} extension result.
   */
  request(method, params, signal) {
    signal?.throwIfAborted()
    if (!this.#touchSession()) {
      return Promise.reject(new Error('Chrome extension is disconnected. Open DSH Web in Chrome and pair the extension.'))
    }
    const id = 'chrome-' + String(++this.#nextRequestId)
    return new Promise((resolve, reject) => {
      const startedAt = performance.now()
      if (method === 'page.drag') {
        console.info('[dsh-browser-drag-trace]', JSON.stringify({ id, side: 'host', event: 'request-start', at: Date.now(), timeoutMs: this.#operationTimeoutMs }))
      }
      const timer = setTimeout(() => {
        this.#finishRequest(id, new Error('Chrome browser operation timed out'), undefined, true)
      }, this.#operationTimeoutMs)
      const onAbort = () => {
        this.#finishRequest(id, signal.reason instanceof Error ? signal.reason : new Error('Browser operation cancelled'), undefined, true)
      }
      this.#pending.set(id, { resolve, reject, timer, signal, onAbort, delivered: false, method, startedAt })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      if (this.#queue.length >= MAX_QUEUED_COMMANDS) {
        this.#finishRequest(id, new Error('Chrome browser command queue is full'))
        return
      }
      const command = { id, method, params }
      // Hand the command to any waiting poll so several commands can be in
      // flight at once; otherwise queue it for the next poll.
      const waiter = this.#pollWaiters.values().next().value
      if (waiter !== undefined && waiter.token === this.#sessionToken) {
        this.#pending.get(id).delivered = true
        waiter.finish(command)
      }
      else this.#queue.push(command)
    })
  }

  /** Remove HTTP routes and expire pending browser operations. */
  async close() {
    if (this.#closed) return
    this.#closed = true
    try {
      await this.#disposeFetch?.()
    } finally {
      for (const dispose of this.#disposeRoutes) dispose()
      this.#disposeRoutes = []
      this.#pairTokens.clear()
      this.#clearSession(new Error('Chrome browser provider unloaded'))
    }
  }

  async #pair(_request) {
    if (this.#closed) return new Response('Browser provider is unloading', { status: 503 })
    this.#expirePairTokens()
    if (this.#pairTokens.size >= MAX_PAIR_TOKENS) {
      return new Response('Too many pending pairing requests', { status: 429 })
    }
    const pairToken = randomBytes(32).toString('base64url')
    this.#pairTokens.set(pairToken, Date.now() + PAIR_LIFETIME_MS)
    return new Response(JSON.stringify({ protocol: 1, pairToken }), {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      },
    })
  }

  #crossOriginRequest(request, response) {
    const origin = request.headers.origin
    if (!isExtensionOrigin(origin) || !isLoopbackRequest(request)) {
      writeJson(response, 403, { error: 'Forbidden' })
      return undefined
    }
    if (request.method === 'OPTIONS') {
      writePreflight(request, response)
      return undefined
    }
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'POST required' }, origin)
      return undefined
    }
    return origin
  }

  async #connect(request, response) {
    const origin = this.#crossOriginRequest(request, response)
    if (origin === undefined) return
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      writeJson(response, error.statusCode ?? 400, { error: error.message }, origin)
      return
    }
    const expiresAt = typeof body.pairToken === 'string' ? this.#pairTokens.get(body.pairToken) : undefined
    this.#pairTokens.delete(body.pairToken)
    if (expiresAt === undefined || expiresAt < Date.now()) {
      writeJson(response, 401, { error: 'Pairing token expired' }, origin)
      return
    }
    this.#clearSession(new Error('Chrome extension reconnected'))
    this.#sessionToken = randomBytes(32).toString('base64url')
    this.#extensionOrigin = origin
    this.#lastSeen = Date.now()
    writeJson(response, 200, { protocol: 1, sessionToken: this.#sessionToken }, origin)
  }

  async #poll(request, response) {
    const origin = this.#crossOriginRequest(request, response)
    if (origin === undefined) return
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      writeJson(response, error.statusCode ?? 400, { error: error.message }, origin)
      return
    }
    if (!this.#authorizeSession(body.sessionToken, origin, response)) return
    let commands
    try {
      commands = await this.#nextCommands(response, body.sessionToken)
    } catch (error) {
      writeJson(response, 409, { error: error.message }, origin)
      return
    }
    if (response.destroyed) return
    this.#touchSession()
    writeJson(response, 200, { commands, cancelled: [...this.#cancelled] }, origin)
    this.#cancelled.clear()
  }

  async #respond(request, response) {
    const origin = this.#crossOriginRequest(request, response)
    if (origin === undefined) return
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      writeJson(response, error.statusCode ?? 400, { error: error.message }, origin)
      return
    }
    if (!this.#authorizeSession(body.sessionToken, origin, response)) return
    if (typeof body.id !== 'string' || typeof body.ok !== 'boolean') {
      writeJson(response, 400, { error: 'Invalid browser response' }, origin)
      return
    }
    if (body.ok) this.#finishRequest(body.id, undefined, body.result)
    else this.#finishRequest(body.id, new Error(String(body.error?.message ?? 'Chrome browser operation failed')))
    writeJson(response, 200, { ok: true }, origin)
  }

  async #disconnectRequest(request, response) {
    const origin = this.#crossOriginRequest(request, response)
    if (origin === undefined) return
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      writeJson(response, error.statusCode ?? 400, { error: error.message }, origin)
      return
    }
    if (!this.#authorizeSession(body.sessionToken, origin, response)) return
    this.#clearSession(new Error('Chrome extension disconnected'))
    writeJson(response, 200, { ok: true }, origin)
  }

  #authorizeSession(token, origin, response) {
    if (this.#sessionToken === undefined || Date.now() - this.#lastSeen > SESSION_IDLE_MS) {
      this.#clearSession(new Error('Chrome extension session expired'))
      writeJson(response, 401, { error: 'Chrome extension session expired' }, origin)
      return false
    }
    if (typeof token !== 'string' || token !== this.#sessionToken || origin !== this.#extensionOrigin) {
      writeJson(response, 401, { error: 'Chrome extension session expired' }, origin)
      return false
    }
    this.#lastSeen = Date.now()
    return true
  }

  #touchSession() {
    if (this.#sessionToken === undefined) return false
    if (Date.now() - this.#lastSeen > SESSION_IDLE_MS) {
      this.#clearSession(new Error('Chrome extension session expired'))
      return false
    }
    this.#lastSeen = Date.now()
    return true
  }

  #nextCommands(response, token) {
    if (this.#queue.length > 0 || this.#cancelled.size > 0) {
      return Promise.resolve(this.#takeQueuedCommands(MAX_COMMANDS_PER_POLL))
    }
    // A handful of concurrent long-polls is fine (Chrome allows ~6 connections
    // per host); each waiting poll is answered with a batch of queued commands.
    return new Promise(resolve => {
      let finished = false
      let timer
      const waiter = {
        token,
        finish: command => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          response.removeListener('close', onClose)
          this.#pollWaiters.delete(waiter)
          const commands = command === null ? this.#takeQueuedCommands(MAX_COMMANDS_PER_POLL) : [command, ...this.#takeQueuedCommands(MAX_COMMANDS_PER_POLL - 1)]
          if (command !== null) this.#markDelivered(command)
          resolve(commands)
        },
      }
      const onClose = () => waiter.finish(null)
      timer = setTimeout(() => waiter.finish(null), POLL_WAIT_MS)
      this.#pollWaiters.add(waiter)
      response.once('close', onClose)
    })
  }

  #takeQueuedCommands(limit) {
    const commands = this.#queue.splice(0, limit)
    for (const command of commands) this.#markDelivered(command)
    return commands
  }

  #markDelivered(command) {
    const pending = this.#pending.get(command.id)
    if (pending !== undefined) pending.delivered = true
  }

  #expirePairTokens() {
    const now = Date.now()
    for (const [token, expiresAt] of this.#pairTokens) {
      if (expiresAt < now) this.#pairTokens.delete(token)
    }
  }

  #finishRequest(id, error, value, cancelDelivered = false) {
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    if (pending.method === 'page.drag') {
      console.info('[dsh-browser-drag-trace]', JSON.stringify({
        id,
        side: 'host',
        event: error === undefined ? 'request-resolved' : 'request-rejected',
        at: Date.now(),
        elapsedMs: Math.round(performance.now() - pending.startedAt),
        error: error === undefined ? undefined : String(error.message ?? error).slice(0, 200),
      }))
    }
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.onAbort)
    this.#queue = this.#queue.filter(command => command.id !== id)
    if (cancelDelivered && pending.delivered) {
      this.#cancelled.add(id)
      const waiter = this.#pollWaiters.values().next().value
      if (waiter !== undefined && waiter.token === this.#sessionToken) waiter.finish(null)
    }
    if (error !== undefined) pending.reject(error)
    else pending.resolve(value)
  }

  #clearSession(reason) {
    this.#pairTokens.clear()
    this.#sessionToken = undefined
    this.#extensionOrigin = undefined
    this.#lastSeen = 0
    this.#queue = []
    this.#cancelled.clear()
    for (const waiter of this.#pollWaiters) waiter.finish(null)
    this.#pollWaiters.clear()
    for (const [id] of this.#pending) this.#finishRequest(id, reason)
  }
}

