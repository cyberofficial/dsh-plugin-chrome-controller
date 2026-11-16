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

function dshTabInfo(tab) {
  if (tab?.id === undefined || typeof tab.url !== 'string') return undefined
  let page
  try {
    page = new URL(tab.url)
  } catch {
    return undefined
  }
  if ((page.protocol !== 'http:' && page.protocol !== 'https:') || page.hostname !== '127.0.0.1') return undefined
  return { tabId: tab.id, origin: page.origin, protocol: page.protocol, hostname: page.hostname }
}

async function readActiveDshTab() {
  connectButton.disabled = true
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    activeDshTab = dshTabInfo(active)
    if (activeDshTab === undefined) {
      // Fall back to any open DSH Web tab so the popup works from its own tab too.
      const all = await chrome.tabs.query({})
      activeDshTab = all.map(dshTabInfo).find(info => info !== undefined)
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
