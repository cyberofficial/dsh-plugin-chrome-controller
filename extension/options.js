import { DEFAULT_DSH_ORIGIN, DOMAIN_FILTER_KEY, normalizeDshOrigin, parseDomainFilterEntries } from './origin.js'

const SETTINGS_KEY = 'dshBrowserBehaviorSettings'
const CONNECTION_SETTINGS_KEY = 'dshBrowserConnectionSettings'
const CLIPBOARD_SETTINGS_KEY = 'dshBrowserClipboardSettings'
const PAIRING_SETTINGS_PATH = '/api/dsh-browser-extension/pairing'
const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{24}$/u

const DEFAULTS = {
  baseFlightDelayMs: 110,
  flightJitterMinFactor: 0.55,
  flightJitterMaxFactor: 1.45,
  keyHoldMinMs: 50,
  keyHoldVariationMs: 60,
  thinkingPauseChancePercent: 3,
  thinkingPauseMinMs: 400,
  thinkingPauseMaxMs: 900,
  spacePauseMinFactor: 2.2,
  spacePauseMaxFactor: 3.8,
  commonBigramFactor: 0.8,
  repeatedKeyFactor: 1.25,
  cursorSpeedPxPerMs: 1.4,
  cursorMinDurationMs: 120,
  cursorMaxDurationMs: 700,
  cursorArcRatio: 0.22,
  cursorMaxArcPx: 120,
  dragDurationMs: 350,
  sequenceDelayMs: 120,
}

const GROUPS = [
  {
    title: 'Keystroke timing',
    description: 'The delay before the next key and the time that key stays pressed are separate settings.',
    fields: [
      ['baseFlightDelayMs', 'Base delay before each key', 'Starting delay before pressing a key. A higher value slows typing.', 0, 1000, 10, 'ms'],
      ['flightJitterMinFactor', 'Delay multiplier minimum', 'Lower bound for the random multiplier. A value of 0.5 allows half the base delay.', 0.1, 2, 0.05, 'x'],
      ['flightJitterMaxFactor', 'Delay multiplier maximum', 'Upper bound for the random multiplier. Set both bounds to 1 for a fixed base delay.', 0.1, 3, 0.05, 'x'],
      ['keyHoldMinMs', 'Key hold minimum', 'Shortest time a supported key stays pressed.', 0, 500, 10, 'ms'],
      ['keyHoldVariationMs', 'Extra key hold time', 'Up to this much time is randomly added to the minimum. Set to 0 for a fixed hold.', 0, 500, 10, 'ms'],
      ['commonBigramFactor', 'Common letter pairs', 'Scales the delay for supported pairs such as th or he. Values below 1 shorten it.', 0.1, 2, 0.05, 'x'],
      ['repeatedKeyFactor', 'Repeated characters', 'Scales the delay before the same character is typed again. Values above 1 lengthen it.', 1, 4, 0.05, 'x'],
    ],
  },
  {
    title: 'Typing pauses',
    description: 'Adjust pauses at spaces and punctuation, and occasional longer pauses during typing.',
    fields: [
      ['spacePauseMinFactor', 'Space and punctuation minimum', 'Smallest multiplier before spaces or common punctuation. A value of 1 adds no extra delay.', 1, 8, 0.1, 'x'],
      ['spacePauseMaxFactor', 'Space and punctuation maximum', 'Largest multiplier before spaces or common punctuation.', 1, 10, 0.1, 'x'],
      ['thinkingPauseChancePercent', 'Long pause chance', 'Chance that a long pause replaces the usual delay for each character. Set to 0 to turn it off.', 0, 25, 1, '%'],
      ['thinkingPauseMinMs', 'Long pause minimum', 'Shortest delay when a long pause is selected.', 100, 5000, 50, 'ms'],
      ['thinkingPauseMaxMs', 'Long pause maximum', 'Longest delay when a long pause is selected.', 100, 5000, 50, 'ms'],
    ],
  },
  {
    title: 'Cursor movement',
    description: 'These values set how the on-page cursor travels between positions.',
    fields: [
      ['cursorSpeedPxPerMs', 'Cursor speed', 'Higher values shorten cursor travel time, within the duration limits below.', 0.1, 5, 0.1, 'px/ms'],
      ['cursorMinDurationMs', 'Minimum travel time', 'Keeps short cursor moves from finishing faster than this time.', 50, 2000, 10, 'ms'],
      ['cursorMaxDurationMs', 'Maximum travel time', 'Caps the time the cursor takes to travel across the page.', 50, 5000, 10, 'ms'],
      ['cursorArcRatio', 'Path curve', 'Scales the path bend with the travel distance. Set to 0 for a straight path.', 0, 0.6, 0.01, 'ratio'],
      ['cursorMaxArcPx', 'Maximum path bend', 'Limits the sideways bend on long moves.', 0, 500, 10, 'px'],
    ],
  },
  {
    title: 'Drag and sequence timing',
    description: 'These defaults apply when an individual action or sequence supplies no timing override.',
    fields: [
      ['dragDurationMs', 'Default drag duration', 'Time spent moving between the start and end of a drag.', 100, 2000, 25, 'ms'],
      ['sequenceDelayMs', 'Delay between sequence steps', 'Pause between actions in a browser sequence. Set to 0 for no added pause.', 0, 1000, 10, 'ms'],
    ],
  },
]

const form = document.querySelector('#settings-form')
const connectionForm = document.querySelector('#connection-form')
const originInput = document.querySelector('#dsh-origin')
const pairingCodeInput = document.querySelector('#dsh-pairing-code')
const pairingPageNode = document.querySelector('#pairing-page-url')
const autoConnectInput = document.querySelector('#dsh-autoconnect')
const connectionStatusNode = document.querySelector('#connection-status')
const domainFilterForm = document.querySelector('#domain-filter-form')
const domainFilterMode = document.querySelector('#domain-filter-mode')
const domainFilterEntries = document.querySelector('#domain-filter-entries')
const domainFilterStatus = document.querySelector('#domain-filter-status')
const clipboardForm = document.querySelector('#clipboard-form')
const clipboardAcknowledgeInput = document.querySelector('#clipboard-acknowledge')
const clipboardEnabledInput = document.querySelector('#clipboard-enabled')
const clipboardStatusNode = document.querySelector('#clipboard-status')
const groupsNode = document.querySelector('#settings-groups')
const statusNode = document.querySelector('#status')
const resetButton = document.querySelector('#reset')
const inputs = new Map()
let savedPairingCode = ''

const tabs = [...document.querySelectorAll('.settings-tabs [role="tab"]')]
const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')))

function selectTab(index) {
  tabs.forEach((tab, tabIndex) => {
    const selected = tabIndex === index
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
    panels[tabIndex].hidden = !selected
  })
}

function selectTabFromHash() {
  const index = panels.findIndex(panel => '#' + panel.id === location.hash)
  selectTab(index < 0 ? 0 : index)
}

function openTab(index) {
  selectTab(index)
  history.replaceState(null, '', '#' + panels[index].id)
  tabs[index].focus({ preventScroll: true })
  window.scrollTo(0, 0)
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => openTab(index))
  tab.addEventListener('keydown', event => {
    let next
    switch (event.key) {
      case 'ArrowLeft': next = (index + tabs.length - 1) % tabs.length; break
      case 'ArrowRight': next = (index + 1) % tabs.length; break
      case 'Home': next = 0; break
      case 'End': next = tabs.length - 1; break
      default: return
    }
    event.preventDefault()
    openTab(next)
  })
})
window.addEventListener('hashchange', selectTabFromHash)
selectTabFromHash()

function makeField([key, title, description, min, max, step, unit]) {
  const wrapper = document.createElement('div')
  wrapper.className = 'setting'
  const inputId = 'setting-' + key
  const label = document.createElement('label')
  label.htmlFor = inputId
  label.textContent = title + ' (' + unit + ')'
  const input = document.createElement('input')
  input.id = inputId
  input.name = key
  input.type = 'number'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.required = true
  const help = document.createElement('p')
  help.id = inputId + '-help'
  help.textContent = description + ' Default ' + DEFAULTS[key] + '. Range ' + min + ' to ' + max + '.'
  input.setAttribute('aria-describedby', help.id)
  wrapper.append(label, input, help)
  inputs.set(key, input)
  return wrapper
}

for (const group of GROUPS) {
  const section = document.createElement('section')
  section.className = 'settings-group'
  const heading = document.createElement('h3')
  heading.textContent = group.title
  const description = document.createElement('p')
  description.className = 'group-intro'
  description.textContent = group.description
  const grid = document.createElement('div')
  grid.className = 'settings-grid'
  for (const field of group.fields) grid.append(makeField(field))
  section.append(heading, description, grid)
  groupsNode.append(section)
}

function showStatus(message, isError = false) {
  statusNode.textContent = message
  statusNode.dataset.error = String(isError)
}

function populate(settings) {
  for (const [key, input] of inputs) {
    input.value = String(Number.isFinite(settings?.[key]) ? settings[key] : DEFAULTS[key])
    input.setCustomValidity('')
  }
}

function readInputs() {
  const settings = {}
  let valid = true
  for (const [key, input] of inputs) {
    input.setCustomValidity('')
    const value = input.valueAsNumber
    if (!Number.isFinite(value) || !input.checkValidity()) {
      valid = false
      input.reportValidity()
    }
    settings[key] = value
  }
  const orderChecks = [
    ['flightJitterMinFactor', 'flightJitterMaxFactor', 'Flight variation maximum must be at least its minimum.'],
    ['thinkingPauseMinMs', 'thinkingPauseMaxMs', 'Long pause maximum must be at least its minimum.'],
    ['spacePauseMinFactor', 'spacePauseMaxFactor', 'Word and punctuation pause maximum must be at least its minimum.'],
    ['cursorMinDurationMs', 'cursorMaxDurationMs', 'Cursor animation maximum must be at least its minimum.'],
  ]
  for (const [minKey, maxKey, message] of orderChecks) {
    if (settings[maxKey] < settings[minKey]) {
      const input = inputs.get(maxKey)
      input.setCustomValidity(message)
      input.reportValidity()
      valid = false
    }
  }
  return valid ? settings : undefined
}

async function initialize() {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true)
    return
  }
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY)
    populate({ ...DEFAULTS, ...(stored[SETTINGS_KEY] ?? {}) })
  } catch (error) {
    populate(DEFAULTS)
    showStatus(error instanceof Error ? error.message : String(error), true)
  }
  try {
    const connection = await chrome.storage.local.get(CONNECTION_SETTINGS_KEY)
    originInput.value = connection?.[CONNECTION_SETTINGS_KEY]?.origin ?? DEFAULT_DSH_ORIGIN
    const code = connection?.[CONNECTION_SETTINGS_KEY]?.pairingCode
    savedPairingCode = typeof code === 'string' ? code : ''
    pairingCodeInput.placeholder = savedPairingCode === '' ? 'Paste the code from DSH Web' : 'Saved code (leave blank to keep)'
    autoConnectInput.checked = connection?.[CONNECTION_SETTINGS_KEY]?.autoConnect !== false
  } catch {
    originInput.value = DEFAULT_DSH_ORIGIN
    savedPairingCode = ''
    autoConnectInput.checked = true
  }
  try {
    const stored = (await chrome.storage.local.get(DOMAIN_FILTER_KEY))[DOMAIN_FILTER_KEY]
    domainFilterMode.value = ['whitelist', 'blacklist'].includes(stored?.mode) ? stored.mode : 'off'
    domainFilterEntries.value = Array.isArray(stored?.domains) ? stored.domains.join('\n') : ''
  } catch (error) {
    domainFilterStatus.textContent = 'Could not load the domain filter: ' + error.message
    domainFilterStatus.dataset.error = 'true'
  }
  try {
    const clipboard = await chrome.storage.local.get(CLIPBOARD_SETTINGS_KEY)
    const saved = clipboard?.[CLIPBOARD_SETTINGS_KEY]
    clipboardAcknowledgeInput.checked = saved?.acknowledged === true
    clipboardEnabledInput.checked = saved?.enabled === true && saved?.acknowledged === true
    updateClipboardGate()
  } catch {
    clipboardAcknowledgeInput.checked = false
    clipboardEnabledInput.checked = false
    updateClipboardGate()
  }
  updatePairingPage()
}

domainFilterForm.addEventListener('submit', async event => {
  event.preventDefault()
  try {
    const mode = domainFilterMode.value
    const domains = parseDomainFilterEntries(domainFilterEntries.value)
    await chrome.storage.local.set({ [DOMAIN_FILTER_KEY]: { mode, domains } })
    domainFilterEntries.value = domains.join('\n')
    domainFilterStatus.textContent = mode === 'off' ? 'Domain filter is off.'
      : mode === 'whitelist' && domains.length === 0 ? 'Whitelist saved. DSH cannot access any tabs until you add a domain.'
        : 'Domain filter saved.'
    domainFilterStatus.dataset.error = 'false'
  } catch (error) {
    domainFilterStatus.textContent = error instanceof Error ? error.message : String(error)
    domainFilterStatus.dataset.error = 'true'
  }
})

/** The enable toggle stays disabled until the risk acknowledgement is checked. */
function updateClipboardGate() {
  clipboardEnabledInput.disabled = !clipboardAcknowledgeInput.checked
  if (!clipboardAcknowledgeInput.checked) clipboardEnabledInput.checked = false
}

clipboardAcknowledgeInput.addEventListener('change', updateClipboardGate)

clipboardForm.addEventListener('submit', async event => {
  event.preventDefault()
  const acknowledged = clipboardAcknowledgeInput.checked
  const enabled = acknowledged && clipboardEnabledInput.checked
  try {
    await chrome.storage.local.set({
      [CLIPBOARD_SETTINGS_KEY]: { acknowledged, enabled },
    })
    clipboardStatusNode.textContent = enabled
      ? 'Clipboard access enabled. DSH can now read the clipboard and paste into pages.'
      : 'Clipboard access saved as disabled. DSH clipboard tools will return an error until you enable it here.'
    clipboardStatusNode.dataset.error = 'false'
    updateClipboardGate()
  } catch (error) {
    clipboardStatusNode.textContent = error instanceof Error ? error.message : String(error)
    clipboardStatusNode.dataset.error = 'true'
  }
})

/** Normalize the origin field; empty resets to the default. */
function readOrigin() {
  const raw = originInput.value.trim()
  return raw === '' ? DEFAULT_DSH_ORIGIN : normalizeDshOrigin(raw)
}

function updatePairingPage() {
  const origin = readOrigin()
  pairingPageNode.textContent = origin === undefined ? 'Enter a loopback or HTTPS address' : origin + PAIRING_SETTINGS_PATH
}

originInput.addEventListener('input', updatePairingPage)

connectionForm.addEventListener('submit', async event => {
  event.preventDefault()
  const origin = readOrigin()
  if (origin === undefined) {
    originInput.setCustomValidity('Enter a loopback address such as http://127.0.0.1:3080, or an HTTPS address such as https://dsh.example.com')
    originInput.reportValidity()
    return
  }
  originInput.setCustomValidity('')
  const pairingCode = pairingCodeInput.value.trim() || savedPairingCode
  if (pairingCode !== '' && !PAIRING_CODE_PATTERN.test(pairingCode)) {
    pairingCodeInput.setCustomValidity('Enter the 24-character pairing code shown in DSH Web')
    pairingCodeInput.reportValidity()
    return
  }
  pairingCodeInput.setCustomValidity('')
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    await chrome.storage.local.set({ [CONNECTION_SETTINGS_KEY]: { origin, pairingCode, autoConnect: autoConnectInput.checked } })
    savedPairingCode = pairingCode
    pairingCodeInput.value = ''
    pairingCodeInput.placeholder = pairingCode === '' ? 'Paste the code from DSH Web' : 'Saved code (leave blank to keep)'
    originInput.value = origin
    updatePairingPage()
    connectionStatusNode.textContent = pairingCode === ''
      ? 'Address saved. Add the pairing code to connect.'
      : 'Connection saved. Click Connect in the popup now. Automatic connection follows the checkbox above.'
    connectionStatusNode.dataset.error = 'false'
  } catch (error) {
    connectionStatusNode.textContent = error instanceof Error ? error.message : String(error)
    connectionStatusNode.dataset.error = 'true'
  }
})

form.addEventListener('submit', async event => {
  event.preventDefault()
  const settings = readInputs()
  if (settings === undefined) return
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings })
    showStatus('Settings saved. They take effect on the next browser action.')
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true)
  }
})

resetButton.addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULTS } })
    populate(DEFAULTS)
    showStatus('Restored the tested default settings.')
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true)
  }
})

void initialize()
