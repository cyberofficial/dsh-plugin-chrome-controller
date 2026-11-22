// Pure helpers for saved points of interest. No Chrome APIs or DOM state.

export function normalizePoiText(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > 2000) {
    throw new Error('Enter an instruction of 1 to 2000 characters')
  }
  return value.trim()
}

/** Validate and complete an area. All-zero dimensions mean the exact point. */
export function normalizePoiArea(area = {}) {
  const shape = area.shape ?? 'circle'
  if (shape !== 'circle' && shape !== 'rectangle') throw new Error('Area shape must be circle or rectangle')
  const result = {
    shape,
    radius: area.radius ?? 0,
    width: area.width ?? 0,
    height: area.height ?? 0,
  }
  const ranges = { radius: 250, width: 500, height: 500 }
  for (const [key, max] of Object.entries(ranges)) {
    if (!Number.isFinite(result[key]) || result[key] < 0 || result[key] > max) {
      throw new Error(`${key} must be between 0 and ${max}`)
    }
  }
  return result
}

function mulberry32(seed) {
  return () => {
    let value = seed += 0x6D2B79F5
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

/** Choose a point around the original using a fresh UTC-millisecond seed. */
export function selectPoiPoint(point, timestamp) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) throw new Error('A saved point requires finite x and y')
  const area = normalizePoiArea(point.area)
  const random = mulberry32(Math.floor(timestamp) >>> 0)
  let dx = 0
  let dy = 0
  if (area.shape === 'circle') {
    const radius = area.radius * Math.sqrt(random())
    const angle = random() * Math.PI * 2
    dx = Math.cos(angle) * radius
    dy = Math.sin(angle) * radius
  } else {
    dx = (random() - 0.5) * area.width
    dy = (random() - 0.5) * area.height
  }
  return { x: point.x + dx, y: point.y + dy }
}

export function clampPoiPoint(point, width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('The saved point is no longer visible. Mark it again on the current page.')
  }
  return {
    x: Math.max(0, Math.min(width, point.x)),
    y: Math.max(0, Math.min(height, point.y)),
  }
}
