export const DEFAULT_DSH_ORIGIN = 'http://127.0.0.1:3080'
export const DOMAIN_FILTER_KEY = 'dshBrowserDomainFilter'

/**
 * Normalize a user-supplied DSH Web origin. Loopback hosts may use HTTP or
 * HTTPS; any other host must use HTTPS so the pairing code and session tokens
 * never cross the network in clear text.
 * @param {unknown} value - raw text from Settings or storage.
 * @returns {string | undefined} the canonical origin, or undefined when refused.
 */
export function normalizeDshOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    if (!loopback && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/** Parse Settings entries as domains, even when a full URL was pasted. */
export function parseDomainFilterEntries(value) {
  const domains = new Set()
  for (const [index, line] of value.split(/\r?\n/u).entries()) {
    const entry = line.trim()
    if (entry === '') continue
    const isUrl = /^https?:\/\/[^/]/iu.test(entry)
    const isHost = /^(?:\[[a-f0-9:.]+\]|[^:/?#@\[\]]+)(?::\d+)?$/iu.test(entry)
    const hostname = isUrl || isHost ? webHostname(isUrl ? entry : 'https://' + entry, true) : ''
    if (!hostname || /[\s\\]/u.test(entry)) {
      throw new Error('Enter a domain or an HTTP(S) URL on line ' + String(index + 1) + '.')
    }
    domains.add(hostname)
  }
  return [...domains]
}

function webHostname(value, rejectCredentials = false) {
  try {
    let url = new URL(value)
    if (url.protocol === 'blob:') url = new URL(url.origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (rejectCredentials && (url.username || url.password)) return ''
    const hostname = url.hostname.replace(/\.$/u, '')
    if (hostname.startsWith('[') || /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/u.test(hostname)) return hostname
  } catch {
    // Unknown or non-web addresses have no domain for the filter to compare.
  }
  return ''
}

export function domainFilterAllows(policy, url) {
  if (policy.mode === 'off') return true
  const hostname = webHostname(url)
  if (!hostname) return false
  const matched = policy.domains.some(domain => hostname === domain || hostname.endsWith('.' + domain))
  return policy.mode === 'whitelist' ? matched : !matched
}
