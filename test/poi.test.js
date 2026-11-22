import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { clampPoiPoint, normalizePoiArea, normalizePoiText, selectPoiPoint } from '../extension/poi.js'

const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')
function extract(name) {
  const match = new RegExp('(async )?function ' + name + '\\([\\s\\S]*?\\n\\}\\n', 'u').exec(background)
  assert.ok(match, name + ' is present in background.js')
  return match[0]
}
const poiEntries = new Function('return ' + extract('poiEntries'))()
let activeStore = {}
async function writePoiStore(mutate) {
  if (mutate(activeStore) === false) throw new Error('Unexpected no-op')
  return activeStore
}
const updatePoi = new Function('writePoiStore', 'normalizePoiText', 'normalizePoiArea', 'poiEntries', 'POI_PAGE_LIMIT', 'POI_TOTAL_LIMIT',
  'return ' + extract('updatePoi'))(writePoiStore, normalizePoiText, normalizePoiArea, poiEntries, 30, 300)
const collectPois = new Function('poiEntries', 'return ' + extract('collectPois'))(poiEntries)
const publicPoiEntry = new Function('return ' + extract('publicPoiEntry'))()

function storeHarness(initial = {}) {
  activeStore = structuredClone(initial)
  return { read: () => activeStore }
}

describe('POI area selection', () => {
  it('uses the exact point when area is zero', () => {
    const point = { x: 101.25, y: 202.5, area: normalizePoiArea() }
    assert.deepEqual(selectPoiPoint(point, 1795300000000), { x: 101.25, y: 202.5 })
  })

  it('is deterministic for the same UTC timestamp', () => {
    const point = { x: 300, y: 200, area: { shape: 'circle', radius: 20, width: 0, height: 0 } }
    assert.deepEqual(selectPoiPoint(point, 1795300000123), selectPoiPoint(point, 1795300000123))
  })

  it('keeps circle points inside the radius', () => {
    for (let seed = 0; seed < 100; seed++) {
      const selected = selectPoiPoint({ x: 0, y: 0, area: { shape: 'circle', radius: 15 } }, seed)
      assert.ok(selected.x ** 2 + selected.y ** 2 <= 225.000001)
    }
  })

  it('keeps rectangle points inside width and height and allows degenerate axes', () => {
    for (let seed = 0; seed < 100; seed++) {
      const selected = selectPoiPoint({ x: 100, y: 100, area: { shape: 'rectangle', width: 40, height: 0 } }, seed)
      assert.ok(selected.x >= 80 && selected.x <= 120)
      assert.equal(selected.y, 100)
    }
  })

  it('clamps selected candidates to the current viewport', () => {
    assert.deepEqual(clampPoiPoint({ x: -10, y: 999 }, 800, 600), { x: 0, y: 600 })
  })

  it('validates text and area ranges', () => {
    assert.equal(normalizePoiText('  okay button  '), 'okay button')
    assert.throws(() => normalizePoiText(' '), /instruction/)
    assert.throws(() => normalizePoiArea({ shape: 'circle', radius: 251 }), /between 0 and 250/)
    assert.throws(() => normalizePoiArea({ shape: 'rectangle', width: -1 }), /between 0 and 500/)
  })
})

describe('POI storage', () => {
  it('creates, edits, and removes points while preserving identity and coordinates', async () => {
    const harness = storeHarness()
    const pageKey = 'a'.repeat(64)
    const address = { pageKey, site: 'example.test', pageUrl: 'https://example.test/form', originalUrl: 'https://example.test/form?a=1', canOpen: false }
    const saved = await updatePoi({ pageKey, address, x: 20, y: 30, frameStack: [], frameUrl: address.originalUrl },
      'save', 'okay button', { shape: 'circle', radius: 5 })
    const point = saved[pageKey].points[0]
    assert.equal(point.text, 'okay button')
    assert.equal(point.x, 20)
    assert.equal(point.y, 30)
    assert.equal(point.area.radius, 5)
    const edited = await updatePoi({ pageKey, address, id: point.id, savedOnly: true }, 'save', 'cancel button',
      { shape: 'rectangle', width: 12, height: 8 })
    assert.equal(edited[pageKey].points.length, 1)
    assert.equal(edited[pageKey].points[0].id, point.id)
    assert.equal(edited[pageKey].points[0].createdAt, point.createdAt)
    assert.equal(edited[pageKey].points[0].area.width, 12)
    const removed = await updatePoi({ pageKey, id: point.id }, 'remove')
    assert.equal(removed[pageKey], undefined)
  })

  it('enforces the per-page and global caps', async () => {
    const harness = storeHarness()
    const pageKey = 'b'.repeat(64)
    const address = { pageKey, site: 'example.test', pageUrl: 'https://example.test/' }
    for (let index = 0; index < 30; index++) {
      await updatePoi({ pageKey, address, x: index, y: 1 }, 'save', 'point ' + index, {})
    }
    await assert.rejects(updatePoi({ pageKey, address, x: 31, y: 1 }, 'save', 'overflow', {}), /30 points/)
    const totalHarness = storeHarness()
    for (let page = 0; page < 10; page++) {
      const key = String(page).padStart(64, 'c')
      const meta = { pageKey: key, site: 'example.test', pageUrl: 'https://example.test/' + page }
      for (let index = 0; index < 30; index++) {
        await updatePoi({ pageKey: key, address: meta, x: index, y: 1 }, 'save', 'point ' + index, {})
      }
    }
    await assert.rejects(updatePoi({ pageKey: 'd'.repeat(64), address: { site: 'example.test', pageUrl: 'https://example.test/' }, x: 1, y: 1 },
      'save', 'overflow', {}), /300 saved points/)
  })
})

describe('POI public results', () => {
  it('returns only the saved id, instruction, original coordinates, and page metadata', () => {
    const pageKey = 'e'.repeat(64)
    const stored = {
      [pageKey]: {
        site: 'example.test', pageUrl: 'https://example.test/form', originalUrl: 'https://example.test/form?x=1', canOpen: false,
        points: [{ id: 'abc', text: 'okay button', x: 10, y: 20, frameStack: ['/iframe[1]'], frameUrl: 'https://frame.test/', area: { shape: 'circle', radius: 10 }, createdAt: 1, updatedAt: 2 }],
      },
    }
    const address = { pageKey, site: 'example.test', pageUrl: 'https://example.test/form', canOpen: false }
    const result = publicPoiEntry(collectPois(stored, address)[0])
    assert.deepEqual(result, {
      id: 'abc', text: 'okay button', x: 10, y: 20,
      pageUrl: 'https://example.test/form', canOpen: false, onCurrentPage: true,
    })
    assert.equal('area' in result, false)
    assert.equal('frameStack' in result, false)
    assert.equal('seed' in result, false)
  })
})

describe('POI frame click resolution', () => {
  const resolvePoiClickPoint = new Function('runInFrame', 'resolveChildFrameId', 'selectPoiPoint', 'clampPoiPoint',
    'samePoiDocument', 'isRecord', 'poiFrameMetrics', 'poiViewportMetrics',
    'return ' + extract('resolvePoiClickPoint'))(
      async (tabId, frameId, func, args) => {
        if (func.name === 'poiFrameMetrics') {
          return {
            '/html[1]/iframe[1]': { left: 100, top: 50, scaleX: 2, scaleY: 2 },
            '/html[1]/div[1]/iframe[1]': { left: 50, top: 25, scaleX: 3, scaleY: 3 },
          }[args[0]] ?? null
        }
        if (func.name === 'poiViewportMetrics') return { width: 800, height: 600, url: 'https://excel.test/editor' }
        throw new Error('Unexpected frame function ' + func.name)
      },
      async (tabId, parent, segment) => segment.startsWith('/html[1]/iframe') ? 216 : 217,
      selectPoiPoint, clampPoiPoint,
      new Function('return ' + extract('samePoiDocument'))(),
      value => value !== null && typeof value === 'object' && !Array.isArray(value),
      new Function('return ' + extract('poiFrameMetrics'))(),
      new Function('return ' + extract('poiViewportMetrics'))(),
    )

  it('maps a nested-frame point into current main-viewport coordinates', async () => {
    const result = await resolvePoiClickPoint(1, {
      id: 'p1', x: 10, y: 20, frameStack: ['/html[1]/iframe[1]', '/html[1]/div[1]/iframe[1]'],
      frameUrl: 'https://excel.test/editor', area: normalizePoiArea(),
    })
    assert.deepEqual(result, { x: 260, y: 220 })
  })

  it('fails instead of clicking a missing or stale frame', async () => {
    await assert.rejects(resolvePoiClickPoint(1, {
      id: 'p2', x: 10, y: 20, frameStack: ['/html[1]/iframe[9]'], frameUrl: 'https://excel.test/editor', area: normalizePoiArea(),
    }), /could not be found|Mark the point again/)
  })

  it('rejects a point that is no longer visible', async () => {
    await assert.rejects(resolvePoiClickPoint(1, {
      id: 'p3', x: 900, y: 20, frameStack: [], frameUrl: '', area: normalizePoiArea(),
    }), /no longer visible/)
  })
})

describe('POI click result and dispatch guard', () => {
  it('returns only the id and uses the shared dispatch helper', async () => {
    const dispatched = []
    const clickSavedPoi = new Function('requireTabId', 'requirePoiId', 'readPoiStore', 'elementNoteAddress',
      'resolvePoiClickPoint', 'withDebugger', 'debuggerTargetsNeedingFreshCoordinates', 'viewportSize', 'dispatchClickAt', 'poiEntries', 'chrome',
      'return ' + extract('clickSavedPoi'))(
        value => value,
        value => value,
        async () => ({ ['f'.repeat(64)]: { points: [{ id: 'point-1', x: 10, y: 20, frameStack: [], area: normalizePoiArea() }] } }),
        async () => ({ pageKey: 'f'.repeat(64) }),
        async () => ({ x: 100, y: 120 }),
        async (tabId, operation) => operation({}),
        new Set(),
        async () => ({ width: 800, height: 600 }),
        async (target, tabId, x, y) => { dispatched.push({ target, tabId, x, y }) },
        poiEntries,
        { tabs: { get: async () => ({ url: 'https://example.test/form' }) } },
      )
    const result = await clickSavedPoi({ tabId: 7, id: 'point-1' })
    assert.deepEqual(result, { tabId: 7, clicked: true, id: 'point-1' })
    assert.deepEqual(dispatched, [{ target: {}, tabId: 7, x: 100, y: 120 }])
    assert.equal('x' in result, false)
    assert.equal('area' in result, false)
  })
})

describe('POI editor preview', () => {
  it('forwards live area changes to the originating frame', async () => {
    const sent = []
    const draft = {
      token: 'editor-token', pageKey: 'a'.repeat(64), x: 120, y: 140,
      picker: { token: 'view-token', frameId: 216 }, expiresAt: Date.now() + 10000,
    }
    const chrome = {
      runtime: { getURL: path => 'chrome-extension://test/' + path },
      storage: { session: { get: async key => ({ [key]: draft }) } },
      tabs: { sendMessage: async (tabId, message, options) => { sent.push({ tabId, message, options }) } },
    }
    const poiEditorMessage = new Function('chrome', 'poiEditorKey', 'readPoiStore', 'poiEntries', 'normalizePoiArea', 'updatePoi', 'resumePoiView',
      'return ' + extract('poiEditorMessage'))(
        chrome,
        new Function('return ' + extract('poiEditorKey'))(),
        async () => ({}),
        poiEntries,
        normalizePoiArea,
        async () => { throw new Error('preview must not save') },
        async () => { throw new Error('preview must not resume') },
      )
    const result = await poiEditorMessage({ action: 'preview', tabId: 7, token: 'editor-token', area: { shape: 'circle', radius: 25 } },
      { url: 'chrome-extension://test/popup.html?poiToken=editor-token' })
    assert.equal(result.ok, true)
    assert.deepEqual(sent, [{
      tabId: 7,
      message: { type: 'DSH_POI_AREA_PREVIEW', token: 'view-token', x: 120, y: 140, area: { shape: 'circle', radius: 25, width: 0, height: 0 } },
      options: { frameId: 216 },
    }])
  })
})
