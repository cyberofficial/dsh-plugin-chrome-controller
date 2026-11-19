const statusNode = document.querySelector('#status')
const connectButton = document.querySelector('#connect')
const disconnectButton = document.querySelector('#disconnect')
const settingsButton = document.querySelector('#settings')
const noteModeButton = document.querySelector('#note-mode')
const pageNotesButton = document.querySelector('#page-notes')

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

function openNoteView(button, type) {
  button.addEventListener('click', async () => {
    noteModeButton.disabled = true
    pageNotesButton.disabled = true
    try {
      const result = await sendMessage({ type })
      if (result?.ok !== true) throw new Error(result?.error ?? 'Could not open the notes on this page')
      window.close()
    } catch (error) {
      statusNode.textContent = error instanceof Error ? error.message : String(error)
      noteModeButton.disabled = false
      pageNotesButton.disabled = false
    }
  })
}

openNoteView(noteModeButton, 'DSH_NOTE_MODE')
openNoteView(pageNotesButton, 'DSH_NOTE_LIST')

async function initializeNoteEditor(params) {
  document.querySelector('#connection-panel').hidden = true
  document.querySelector('#note-editor').hidden = false
  document.title = 'Element note'
  const form = document.querySelector('#note-form')
  const field = document.querySelector('#note-text')
  const status = document.querySelector('#note-status')
  const save = document.querySelector('#note-save')
  const remove = document.querySelector('#note-remove')
  const cancel = document.querySelector('#note-cancel')
  const tabId = Number(params.get('noteTab'))
  const token = params.get('noteToken')

  async function request(action, note) {
    const result = await sendMessage({ type: 'DSH_NOTE_EDITOR', tabId, token, action, note })
    if (result?.ok !== true) throw new Error(result?.error ?? 'Could not access the note')
    return result
  }

  function showError(error) {
    status.textContent = error instanceof Error ? error.message : String(error)
  }

  async function finish(action, note) {
    save.disabled = true
    remove.disabled = true
    cancel.disabled = true
    try {
      await request(action, note)
      window.close()
    } catch (error) {
      showError(error)
      save.disabled = false
      remove.disabled = false
      cancel.disabled = false
    }
  }

  cancel.addEventListener('click', async () => {
    cancel.disabled = true
    await request('cancel').catch(() => {})
    window.close()
  })
  try {
    const result = await request('read')
    document.querySelector('#note-xpath').textContent = result.xpath
    field.value = result.note ?? ''
    remove.hidden = result.note === undefined
    save.disabled = false
    field.focus()
  } catch (error) {
    showError(error)
    field.disabled = true
    return
  }
  form.addEventListener('submit', event => {
    event.preventDefault()
    const note = field.value.trim()
    if (note === '') {
      status.textContent = 'Enter a note before saving.'
      return
    }
    void finish('save', note)
  })
  remove.addEventListener('click', () => { void finish('remove') })
}

const popupParams = new URLSearchParams(location.search)
if (popupParams.has('noteToken')) void initializeNoteEditor(popupParams)
else void refreshStatus()
