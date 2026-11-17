const statusNode = document.querySelector('#status')
const connectButton = document.querySelector('#connect')
const disconnectButton = document.querySelector('#disconnect')
const settingsButton = document.querySelector('#settings')
let activeDshTab
let isConnected = false

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError
      if (error !== undefined) reject(new Error(error.message))
      else resolve(response)
    })
  })
}

function showStatus(text, connectedState = false) {
  isConnected = connectedState
  statusNode.textContent = text
  connectButton.hidden = connectedState
  disconnectButton.hidden = !connectedState
}

async function refreshStatus() {
  try {
    const result = await sendMessage({ type: 'status' })
    showStatus(result?.connected ? 'Connected to DSH Web' : 'Not connected', result?.connected === true)
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error))
  }
}

const CONNECTION_SETTINGS_KEY = 'dshBrowserConnectionSettings'
const DEFAULT_DSH_ORIGIN = 'http://127.0.0.1:3080'

function dshTabInfo(tab, origin) {
  if (tab?.id === undefined || typeof tab.url !== 'string') return undefined
  let page
  try {
    page = new URL(tab.url)
  } catch {
    return undefined
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return undefined
  const isLoopback = page.hostname === '127.0.0.1' || page.hostname === 'localhost' || page.hostname === '[::1]'
  if (!isLoopback) return undefined
  // Prefer the configured DSH origin; accept any loopback DSH tab as a fallback.
  if (origin !== undefined && page.origin !== origin) return undefined
  return { tabId: tab.id, origin: page.origin, protocol: page.protocol, hostname: page.hostname }
}

async function readConfiguredOrigin() {
  try {
    const stored = await chrome.storage.local.get(CONNECTION_SETTINGS_KEY)
    const origin = stored?.[CONNECTION_SETTINGS_KEY]?.origin
    return typeof origin === 'string' && origin !== '' ? origin : DEFAULT_DSH_ORIGIN
  } catch {
    return DEFAULT_DSH_ORIGIN
  }
}

async function readActiveDshTab() {
  connectButton.disabled = true
  try {
    const configuredOrigin = await readConfiguredOrigin()
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    activeDshTab = dshTabInfo(active, configuredOrigin) ?? dshTabInfo(active)
    if (activeDshTab === undefined) {
      // Prefer a tab at the configured address, then any open DSH Web tab.
      const all = await chrome.tabs.query({})
      activeDshTab = all.map(tab => dshTabInfo(tab, configuredOrigin)).find(info => info !== undefined)
        ?? all.map(tab => dshTabInfo(tab)).find(info => info !== undefined)
    }
  } catch {
    activeDshTab = undefined
  } finally {
    connectButton.disabled = false
  }
}

connectButton.addEventListener('click', async () => {
  connectButton.disabled = true
  showStatus('Pairing...')
  try {
    if (activeDshTab === undefined) throw new Error('Open DSH Web at 127.0.0.1 in a Chrome tab before pairing')
    const { tabId, origin } = activeDshTab

    const result = await sendMessage({ type: 'pair', tabId, origin })
    if (result?.ok !== true) throw new Error(result?.error ?? 'Pairing failed')
    showStatus('Connected to DSH Web', true)
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error))
  } finally {
    connectButton.disabled = false
  }
})

disconnectButton.addEventListener('click', async () => {
  disconnectButton.disabled = true
  try {
    const result = await sendMessage({ type: 'disconnect' })
    if (result?.ok !== true) throw new Error(result?.error ?? 'Disconnect failed')
    showStatus('Disconnected')
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error))
  } finally {
    disconnectButton.disabled = false
  }
})

settingsButton.addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
})

async function initialize() {
  await Promise.all([readActiveDshTab(), refreshStatus()])
  if (activeDshTab === undefined && !isConnected) {
    statusNode.textContent = 'Open DSH Web at 127.0.0.1 in a Chrome tab before pairing.'
  }
}

void initialize()
