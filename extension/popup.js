const statusNode = document.querySelector('#status')
const connectButton = document.querySelector('#connect')
const disconnectButton = document.querySelector('#disconnect')
const settingsButton = document.querySelector('#settings')

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

connectButton.addEventListener('click', async () => {
  connectButton.disabled = true
  showStatus('Connecting to DSH Web...')
  try {
    const result = await sendMessage({ type: 'pairAuto' })
    if (result?.ok !== true) throw new Error(result?.error ?? 'Connection failed (is DSH Web running at the address in Settings?)')
    showStatus('Connected to DSH Web' + (result?.origin ? ' at ' + result.origin : ''), true)
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
  await refreshStatus()
}

void initialize()
