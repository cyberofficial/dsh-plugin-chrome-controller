const statusNode = document.querySelector('#status')
const notesFeedback = document.querySelector('#notes-feedback')
const connectButton = document.querySelector('#connect')
const disconnectButton = document.querySelector('#disconnect')
const settingsButton = document.querySelector('#settings')
const noteModeButton = document.querySelector('#note-mode')
const pageNotesButton = document.querySelector('#page-notes')
const allNotesButton = document.querySelector('#all-notes')
const poiFeedback = document.querySelector('#poi-feedback')
const poiModeButton = document.querySelector('#poi-mode')
const pagePoisButton = document.querySelector('#page-pois')
const allPoisButton = document.querySelector('#all-pois')

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError
      if (error !== undefined) reject(new Error(error.message))
      else resolve(response)
    })
  })
}

function showStatus(text, connectedState = false, state = connectedState ? 'connected' : 'idle') {
  statusNode.textContent = text
  statusNode.dataset.state = state
  connectButton.hidden = connectedState
  disconnectButton.hidden = !connectedState
}

async function refreshStatus() {
  try {
    const result = await sendMessage({ type: 'status' })
    showStatus(result?.connected ? 'Connected to DSH Web' : 'Not connected', result?.connected === true)
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), false, 'error')
  }
}

connectButton.addEventListener('click', async () => {
  connectButton.disabled = true
  showStatus('Connecting to DSH Web...', false, 'working')
  try {
    const result = await sendMessage({ type: 'pairAuto' })
    if (result?.ok !== true) throw new Error(result?.error ?? 'Connection failed (is DSH Web running at the address in Settings?)')
    showStatus('Connected to DSH Web', true)
    statusNode.title = result.origin ?? ''
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), false, 'error')
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
    showStatus(error instanceof Error ? error.message : String(error), true, 'error')
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
    allNotesButton.disabled = true
    notesFeedback.hidden = true
    try {
      const result = await sendMessage({ type, action: 'open' })
      if (result?.ok !== true) throw new Error(result?.error ?? 'Could not open the notes on this page')
      window.close()
    } catch (error) {
      notesFeedback.textContent = error instanceof Error ? error.message : String(error)
      notesFeedback.hidden = false
      noteModeButton.disabled = false
      pageNotesButton.disabled = false
      allNotesButton.disabled = false
    }
  })
}

openNoteView(noteModeButton, 'DSH_NOTE_MODE')
openNoteView(pageNotesButton, 'DSH_NOTE_LIST')
openNoteView(allNotesButton, 'DSH_NOTE_ALL')

function openPoiView(button, type) {
  button.addEventListener('click', async () => {
    poiModeButton.disabled = true
    pagePoisButton.disabled = true
    allPoisButton.disabled = true
    poiFeedback.hidden = true
    try {
      const result = await sendMessage({ type, action: 'open' })
      if (result?.ok !== true) throw new Error(result?.error ?? 'Could not open points of interest on this page')
      window.close()
    } catch (error) {
      poiFeedback.textContent = error instanceof Error ? error.message : String(error)
      poiFeedback.hidden = false
      poiModeButton.disabled = false
      pagePoisButton.disabled = false
      allPoisButton.disabled = false
    }
  })
}

openPoiView(poiModeButton, 'DSH_POI_MODE')
openPoiView(pagePoisButton, 'DSH_POI_LIST')
openPoiView(allPoisButton, 'DSH_POI_ALL')

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
  const coords = document.querySelector('#note-coords')
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
    if (coords !== null && typeof result.x === 'number' && typeof result.y === 'number') {
      coords.textContent = Math.round(result.x) + ', ' + Math.round(result.y)
      coords.hidden = false
    } else {
      coords.hidden = true
    }
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

async function initializeAllNotes() {
  document.querySelector('#connection-panel').hidden = true
  document.querySelector('#all-notes-panel').hidden = false
  document.title = 'All Notes'
  const filter = document.querySelector('#all-notes-filter')
  const list = document.querySelector('#all-notes-list')
  const status = document.querySelector('#all-notes-status')
  let groups = []
  let pending = false
  const drafts = new Map()

  async function request(action, entry, note) {
    const result = await sendMessage({
      type: 'DSH_NOTE_ALL', action, pageKey: entry?.pageKey, xpath: entry?.xpath, id: entry?.id, note,
    })
    if (result?.ok !== true) throw new Error(result?.error ?? 'Could not load notes')
    return result.notes
  }

  function applyFilter() {
    const query = filter.value.trim().toLowerCase()
    let count = 0
    for (const group of groups) {
      let visible = false
      for (const entry of group.rows) {
        const matched = entry.searchText.includes(query)
        entry.row.hidden = !matched
        if (matched) {
          visible = true
          count++
        }
      }
      group.section.hidden = !visible
    }
    status.textContent = count === 0
      ? (query === '' ? 'No saved notes.' : 'No matching notes.')
      : String(count) + (count === 1 ? ' note' : ' notes')
  }

  function makeButton(label) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    return button
  }

  function makeRow(entry) {
    const draftKey = entry.pageKey + ':' + (entry.id ?? entry.xpath)
    const row = document.createElement('article')
    const url = entry.originalUrl ?? entry.pageUrl
    const source = document.createElement('p')
    source.className = 'note-source'
    if (entry.canOpen && url !== null) {
      const link = document.createElement('a')
      link.href = url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = url
      source.append(link)
    } else if (url !== null) {
      source.textContent = entry.originalUrl === null ? url + ' (original address unavailable)' : url
    } else {
      source.textContent = 'Unknown page'
    }
    const content = document.createElement('p')
    content.className = 'note-content'
    content.textContent = entry.note
    const path = document.createElement('code')
    path.className = 'note-path'
    path.textContent = entry.xpath
    const coords = document.createElement('code')
    coords.className = 'note-coords'
    if (typeof entry.x === 'number' && typeof entry.y === 'number') {
      coords.textContent = Math.round(entry.x) + ', ' + Math.round(entry.y)
    } else {
      coords.textContent = '(no coordinates saved)'
      coords.style.color = '#8a97a8'
    }
    const actions = document.createElement('div')
    actions.className = 'note-actions'
    const edit = makeButton('Edit')
    const remove = makeButton('Delete')
    remove.title = 'Double-click within 200 ms to delete'
    const save = makeButton('Save')
    const cancel = makeButton('Cancel')
    const field = document.createElement('textarea')
    field.rows = 4
    field.maxLength = 2000
    field.setAttribute('aria-label', 'Note')
    actions.append(edit, remove, save, cancel)
    row.append(source, content, path, coords, field, actions)

    function setEditing(editing, focus = false) {
      field.hidden = !editing
      save.hidden = !editing
      cancel.hidden = !editing
      edit.hidden = editing
      remove.hidden = editing
      content.hidden = editing
      if (editing) {
        field.value = drafts.get(draftKey) ?? entry.note
        if (focus) field.focus()
      }
    }

    async function update(action) {
      if (pending) return
      pending = true
      try {
        const notes = await request(action, entry, action === 'save' ? field.value : undefined)
        drafts.delete(draftKey)
        render(notes)
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error)
      } finally {
        pending = false
      }
    }

    let lastClick
    remove.addEventListener('click', event => {
      if (!event.isTrusted || event.button !== 0 || event.detail === 0 || pending) return
      const elapsed = event.timeStamp - lastClick
      if (lastClick === undefined || elapsed < 0 || elapsed > 200) {
        lastClick = event.timeStamp
        status.textContent = 'Click Delete again within 2 seconds to remove this note'
        setTimeout(() => {
          if (lastClick !== undefined) {
            lastClick = undefined
            status.textContent = ''
          }
        }, 2000)
        return
      }
      lastClick = undefined
      status.textContent = ''
      void update('remove')
    })
    edit.addEventListener('click', () => setEditing(true, true))
    cancel.addEventListener('click', () => {
      drafts.delete(draftKey)
      setEditing(false)
    })
    save.addEventListener('click', () => { void update('save') })
    field.addEventListener('input', () => drafts.set(draftKey, field.value))
    setEditing(drafts.has(draftKey))
    return { row, searchText: ((url ?? 'unknown page') + ' ' + entry.note + ' ' + entry.xpath).toLowerCase() }
  }

  function render(notes) {
    const bySite = new Map()
    for (const entry of notes) {
      let group = bySite.get(entry.site)
      if (group === undefined) {
        const section = document.createElement('section')
        const heading = document.createElement('h2')
        heading.textContent = entry.site ?? 'Unknown site'
        section.append(heading)
        group = { section, rows: [] }
        bySite.set(entry.site, group)
      }
      const row = makeRow(entry)
      group.rows.push(row)
      group.section.append(row.row)
    }
    groups = [...bySite.values()]
    list.replaceChildren(...groups.map(group => group.section))
    applyFilter()
  }

  filter.addEventListener('input', applyFilter)
  try {
    render(await request('list'))
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error)
  }
}

async function initializePoiEditor(params) {
  document.querySelector('#connection-panel').hidden = true
  document.querySelector('#poi-editor').hidden = false
  document.title = 'Point of Interest'
  const form = document.querySelector('#poi-form')
  const field = document.querySelector('#poi-text')
  const status = document.querySelector('#poi-status')
  const save = document.querySelector('#poi-save')
  const remove = document.querySelector('#poi-remove')
  const cancel = document.querySelector('#poi-cancel')
  const shape = document.querySelector('#poi-shape')
  const tabId = Number(params.get('poiTab'))
  const token = params.get('poiToken')
  function readArea() {
    return {
      shape: shape.value,
      radius: Number(document.querySelector('#poi-radius').value),
      width: Number(document.querySelector('#poi-width').value),
      height: Number(document.querySelector('#poi-height').value),
    }
  }
  function showArea(value) {
    document.querySelector('#poi-circle-fields').hidden = value !== 'circle'
    document.querySelector('#poi-rectangle-fields').hidden = value !== 'rectangle'
  }
  function previewArea() {
    showArea(shape.value)
    void request('preview').catch(showError)
  }
  shape.addEventListener('change', previewArea)
  for (const id of ['#poi-radius', '#poi-width', '#poi-height']) {
    document.querySelector(id).addEventListener('input', previewArea)
  }
  for (const button of document.querySelectorAll('[data-preset]')) {
    button.addEventListener('click', () => {
      field.value = button.dataset.preset
      field.focus()
      field.setSelectionRange(field.value.length, field.value.length)
    })
  }
  async function request(action) {
    const result = await sendMessage({
      type: 'DSH_POI_EDITOR', tabId, token, action,
      text: action === 'save' ? field.value : undefined,
      area: action === 'save' || action === 'preview' ? readArea() : undefined,
    })
    if (result?.ok !== true) throw new Error(result?.error ?? 'Could not access the point')
    return result
  }
  function showError(error) {
    status.textContent = error instanceof Error ? error.message : String(error)
  }
  async function finish(action) {
    save.disabled = true
    remove.disabled = true
    cancel.disabled = true
    try {
      await request(action)
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
    document.querySelector('#poi-coords').textContent = Math.round(result.x) + ', ' + Math.round(result.y)
    field.value = result.text ?? ''
    shape.value = result.area.shape
    document.querySelector('#poi-radius').value = result.area.radius
    document.querySelector('#poi-width').value = result.area.width
    document.querySelector('#poi-height').value = result.area.height
    showArea(shape.value)
    remove.hidden = result.id === undefined
    save.disabled = false
    field.focus()
    void request('preview').catch(showError)
  } catch (error) {
    showError(error)
    field.disabled = true
    return
  }
  form.addEventListener('submit', event => {
    event.preventDefault()
    if (field.value.trim() === '') {
      status.textContent = 'Enter an instruction before saving.'
      return
    }
    void finish('save')
  })
  remove.addEventListener('click', () => { void finish('remove') })
}

async function initializeAllPois() {
  document.querySelector('#connection-panel').hidden = true
  document.querySelector('#all-pois-panel').hidden = false
  document.title = 'All Points'
  const filter = document.querySelector('#all-pois-filter')
  const list = document.querySelector('#all-pois-list')
  const status = document.querySelector('#all-pois-status')
  let groups = []
  let pending = false
  const drafts = new Map()
  async function request(action, entry, text, area) {
    const result = await sendMessage({ type: 'DSH_POI_ALL', action, pageKey: entry?.pageKey, id: entry?.id, text, area })
    if (result?.ok !== true) throw new Error(result?.error ?? 'Could not load points')
    return result.points
  }
  function applyFilter() {
    const query = filter.value.trim().toLowerCase()
    let count = 0
    for (const group of groups) {
      let visible = false
      for (const entry of group.rows) {
        const matched = entry.searchText.includes(query)
        entry.row.hidden = !matched
        if (matched) {
          visible = true
          count++
        }
      }
      group.section.hidden = !visible
    }
    status.textContent = count === 0
      ? (query === '' ? 'No saved points.' : 'No matching points.')
      : String(count) + (count === 1 ? ' point' : ' points')
  }
  function makeButton(label) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    return button
  }
  function areaEditor(entry) {
    const node = document.createElement('div')
    node.className = 'poi-edit-area'
    const shapeLabel = document.createElement('label')
    shapeLabel.textContent = 'Shape'
    const shape = document.createElement('select')
    shape.innerHTML = '<option value="circle">Circle</option><option value="rectangle">Rectangle</option>'
    shape.value = entry.area?.shape ?? 'circle'
    shapeLabel.append(shape)
    const fields = {}
    for (const [key, max] of [['radius', 250], ['width', 500], ['height', 500]]) {
      const label = document.createElement('label')
      label.textContent = key[0].toUpperCase() + key.slice(1)
      const input = document.createElement('input')
      input.type = 'number'
      input.min = '0'
      input.max = String(max)
      input.step = '1'
      input.value = String(entry.area?.[key] ?? 0)
      label.append(input)
      fields[key] = input
    }
    node.append(shapeLabel, fields.radius, fields.width, fields.height)
    return {
      node,
      read: () => ({
        shape: shape.value,
        radius: Number(fields.radius.value),
        width: Number(fields.width.value),
        height: Number(fields.height.value),
      }),
    }
  }
  function makeRow(entry) {
    const draftKey = entry.pageKey + ':' + entry.id
    const row = document.createElement('article')
    const source = document.createElement('p')
    source.className = 'note-source'
    const url = entry.originalUrl ?? entry.pageUrl
    if (entry.canOpen && url !== null) {
      const link = document.createElement('a')
      link.href = url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = url
      source.append(link)
    } else source.textContent = url ?? 'Unknown page'
    const content = document.createElement('p')
    content.className = 'note-content'
    content.textContent = entry.text
    const coords = document.createElement('code')
    coords.className = 'note-coords'
    coords.textContent = Math.round(entry.x) + ', ' + Math.round(entry.y)
    const field = document.createElement('textarea')
    field.rows = 3
    field.maxLength = 2000
    field.setAttribute('aria-label', 'Instruction')
    const area = areaEditor(entry)
    const actions = document.createElement('div')
    actions.className = 'note-actions'
    const edit = makeButton('Edit')
    const remove = makeButton('Delete')
    remove.title = 'Double-click within 200 ms to delete'
    const save = makeButton('Save')
    const cancel = makeButton('Cancel')
    actions.append(edit, remove, save, cancel)
    row.append(source, content, coords, field, area.node, actions)
    function setEditing(editing, focus = false) {
      field.hidden = !editing
      area.node.hidden = !editing
      save.hidden = !editing
      cancel.hidden = !editing
      edit.hidden = editing
      remove.hidden = editing
      content.hidden = editing
      coords.hidden = editing
      if (editing) {
        field.value = drafts.get(draftKey) ?? entry.text
        if (focus) field.focus()
      }
    }
    async function update(action) {
      if (pending) return
      pending = true
      try {
        const points = await request(action, entry, action === 'save' ? field.value : undefined,
          action === 'save' ? area.read() : undefined)
        drafts.delete(draftKey)
        render(points)
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error)
      } finally {
        pending = false
      }
    }
    let lastClick
    remove.addEventListener('click', event => {
      if (!event.isTrusted || event.button !== 0 || event.detail === 0 || pending) return
      const elapsed = event.timeStamp - lastClick
      if (lastClick === undefined || elapsed < 0 || elapsed > 200) {
        lastClick = event.timeStamp
        status.textContent = 'Click Delete again within 2 seconds to remove this point'
        setTimeout(() => {
          if (lastClick !== undefined) {
            lastClick = undefined
            status.textContent = ''
          }
        }, 2000)
        return
      }
      lastClick = undefined
      status.textContent = ''
      void update('remove')
    })
    edit.addEventListener('click', () => setEditing(true, true))
    cancel.addEventListener('click', () => {
      drafts.delete(draftKey)
      setEditing(false)
    })
    save.addEventListener('click', () => { void update('save') })
    field.addEventListener('input', () => drafts.set(draftKey, field.value))
    setEditing(drafts.has(draftKey))
    return { row, searchText: ((url ?? 'unknown page') + ' ' + entry.text + ' ' + entry.x + ' ' + entry.y).toLowerCase() }
  }
  function render(points) {
    const bySite = new Map()
    for (const entry of points) {
      let group = bySite.get(entry.site)
      if (group === undefined) {
        const section = document.createElement('section')
        const heading = document.createElement('h2')
        heading.textContent = entry.site ?? 'Unknown site'
        section.append(heading)
        group = { section, rows: [] }
        bySite.set(entry.site, group)
      }
      const row = makeRow(entry)
      group.rows.push(row)
      group.section.append(row.row)
    }
    groups = [...bySite.values()]
    list.replaceChildren(...groups.map(group => group.section))
    applyFilter()
  }
  filter.addEventListener('input', applyFilter)
  try {
    render(await request('list'))
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error)
  }
}

const popupParams = new URLSearchParams(location.search)
if (popupParams.has('noteToken')) void initializeNoteEditor(popupParams)
else if (popupParams.get('allNotes') === '1') void initializeAllNotes()
else if (popupParams.has('poiToken')) void initializePoiEditor(popupParams)
else if (popupParams.get('allPois') === '1') void initializeAllPois()
else void refreshStatus()
