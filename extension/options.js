import { DEFAULT_DSH_ORIGIN, DOMAIN_FILTER_KEY, normalizeDshOrigin, parseDomainFilterEntries } from './origin.js'
import './overlay.js'

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

const MOTION_EXAMPLES = {
  cursorTravel: [
    ['2 px/ms, 380 ms minimum', { cursorSpeedPxPerMs: 2, cursorMinDurationMs: 380 }],
    ['0.15 px/ms, 850 ms maximum', { cursorSpeedPxPerMs: 0.15, cursorMaxDurationMs: 850 }],
  ],
  cursorCurve: [
    ['Straight path', { cursorArcRatio: 0 }],
    ['0.55 bend, 120 px cap', { cursorArcRatio: 0.55, cursorMaxArcPx: 120 }],
    ['0.55 bend, 28 px cap', { cursorArcRatio: 0.55, cursorMaxArcPx: 28 }],
  ],
  drag: [
    ['200 ms drag', { dragDurationMs: 200 }],
    ['1200 ms drag', { dragDurationMs: 1200 }],
  ],
  sequence: [
    ['0 ms between steps', { sequenceDelayMs: 0 }],
    ['750 ms between steps', { sequenceDelayMs: 750 }],
  ],
}

const GROUPS = [
  {
    title: 'Keystroke timing',
    typing: true,
    description: 'The delay before the next key and the time that key stays pressed are separate settings.',
    sections: [
      {
        title: 'Base delay',
        example: 'baseDelay',
        fields: [
          ['baseFlightDelayMs', 'Base delay before each key', 'Starting delay before pressing a key. A higher value slows typing.', 0, 1000, 10, 'ms'],
        ],
      },
      {
        title: 'Delay variation',
        example: 'delayVariation',
        fields: [
          ['flightJitterMinFactor', 'Delay multiplier minimum', 'Lower bound for the random multiplier. A value of 0.5 allows half the base delay.', 0.1, 2, 0.05, 'x'],
          ['flightJitterMaxFactor', 'Delay multiplier maximum', 'Upper bound for the random multiplier. Set both bounds to 1 for a fixed base delay.', 0.1, 3, 0.05, 'x'],
        ],
      },
      {
        title: 'Key holds',
        example: 'keyHold',
        fields: [
          ['keyHoldMinMs', 'Key hold minimum', 'Shortest time a supported key stays pressed.', 0, 500, 10, 'ms'],
          ['keyHoldVariationMs', 'Extra key hold time', 'Up to this much time is randomly added to the minimum. Set to 0 for a fixed hold.', 0, 500, 10, 'ms'],
        ],
      },
      {
        title: 'Common letter pairs',
        example: 'letterPairs',
        fields: [
          ['commonBigramFactor', 'Letter pair multiplier', 'Scales the delay for supported pairs such as th or he. Values below 1 shorten it.', 0.1, 2, 0.05, 'x'],
        ],
      },
      {
        title: 'Repeated characters',
        example: 'repeatedCharacters',
        fields: [
          ['repeatedKeyFactor', 'Repeat multiplier', 'Scales the delay before the same character is typed again. Values above 1 lengthen it.', 1, 4, 0.05, 'x'],
        ],
      },
    ],
  },
  {
    title: 'Typing pauses',
    typing: true,
    description: 'Adjust pauses at spaces and punctuation, and occasional longer pauses during typing.',
    sections: [
      {
        title: 'Spaces and punctuation',
        example: 'wordPauses',
        fields: [
          ['spacePauseMinFactor', 'Space and punctuation minimum', 'Smallest multiplier before spaces or common punctuation. A value of 1 adds no extra delay.', 1, 8, 0.1, 'x'],
          ['spacePauseMaxFactor', 'Space and punctuation maximum', 'Largest multiplier before spaces or common punctuation.', 1, 10, 0.1, 'x'],
        ],
      },
      {
        title: 'Occasional long pauses',
        example: 'longPauses',
        fields: [
          ['thinkingPauseChancePercent', 'Long pause chance', 'Chance that a long pause replaces the usual delay for each character. Set to 0 to turn it off.', 0, 25, 1, '%'],
          ['thinkingPauseMinMs', 'Long pause minimum', 'Shortest delay when a long pause is selected.', 100, 5000, 50, 'ms'],
          ['thinkingPauseMaxMs', 'Long pause maximum', 'Longest delay when a long pause is selected.', 100, 5000, 50, 'ms'],
        ],
      },
    ],
  },
  {
    title: 'Cursor movement',
    description: 'These values set how the on-page cursor travels between positions.',
    sections: [
      {
        title: 'Travel speed and limits',
        motion: 'cursorTravel',
        fields: [
          ['cursorSpeedPxPerMs', 'Cursor speed', 'Higher values shorten cursor travel time, within the duration limits below.', 0.1, 5, 0.1, 'px/ms'],
          ['cursorMinDurationMs', 'Minimum travel time', 'Keeps short cursor moves from finishing faster than this time.', 50, 2000, 10, 'ms'],
          ['cursorMaxDurationMs', 'Maximum travel time', 'Caps the time the cursor takes to travel across the page.', 50, 5000, 10, 'ms'],
        ],
      },
      {
        title: 'Path curve',
        motion: 'cursorCurve',
        fields: [
          ['cursorArcRatio', 'Curve ratio', 'Scales the path bend with the travel distance. Set to 0 for a straight path.', 0, 0.6, 0.01, ''],
          ['cursorMaxArcPx', 'Maximum path bend', 'Limits the sideways bend on long moves.', 0, 500, 10, 'px'],
        ],
      },
    ],
  },
  {
    title: 'Drag and sequence timing',
    description: 'These defaults apply when an individual action or sequence supplies no timing override.',
    sections: [
      {
        title: 'Drag duration',
        motion: 'drag',
        fields: [
          ['dragDurationMs', 'Default drag duration', 'Time spent moving between the start and end of a drag.', 100, 2000, 25, 'ms'],
        ],
      },
      {
        title: 'Sequence pacing',
        motion: 'sequence',
        fields: [
          ['sequenceDelayMs', 'Delay between sequence steps', 'Pause between actions in a browser sequence. Set to 0 for no added pause.', 0, 1000, 10, 'ms'],
        ],
      },
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
const previewButton = document.querySelector('#typing-preview-play')
const previewOutput = document.querySelector('#typing-preview-output')
const previewStatus = document.querySelector('#typing-preview-status')
const previewKey = document.querySelector('#typing-preview-key')
const previewProgress = document.querySelector('#typing-preview-progress')
const inputs = new Map()
const refreshComparisons = []
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const { buildCursorPath, cursorTravelDurationMs, cursorPointAt } = globalThis.__dshCursorMotion
let savedPairingCode = ''
let activeTypingPreview

const tabs = [...document.querySelectorAll('.settings-tabs [role="tab"]')]
const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')))

function selectTab(index) {
  if (panels[index].id !== 'interaction') activeTypingPreview?.abort()
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
  label.textContent = unit ? title + ' (' + unit + ')' : title
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

function makeSettingsGrid(fields) {
  const grid = document.createElement('div')
  grid.className = 'settings-grid'
  for (const field of fields) grid.append(makeField(field))
  return grid
}

for (const group of GROUPS) {
  const section = document.createElement('section')
  section.className = 'settings-group'
  const heading = document.createElement('h3')
  heading.textContent = group.title
  const description = document.createElement('p')
  description.className = 'group-intro'
  description.textContent = group.description
  section.append(heading, description)
  for (const comparison of group.sections) {
    const subsection = document.createElement('section')
    subsection.className = 'timing-subsection'
    const subheading = document.createElement('h4')
    subheading.textContent = comparison.title
    subsection.append(subheading, makeSettingsGrid(comparison.fields), makeTimingExample(group, comparison))
    section.append(subsection)
  }
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
  for (const refresh of refreshComparisons) refresh()
}

function groupFields(groups) {
  return groups.flatMap(group => group.sections.flatMap(section => section.fields))
}

function readInputs(groups = GROUPS, reportErrors = true) {
  const settings = {}
  let valid = true
  for (const [key] of groupFields(groups)) {
    const input = inputs.get(key)
    input.setCustomValidity('')
    const value = input.valueAsNumber
    if (!Number.isFinite(value) || !input.checkValidity()) {
      valid = false
      if (reportErrors) input.reportValidity()
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
      if (reportErrors) input.reportValidity()
      valid = false
    }
  }
  return valid ? settings : undefined
}

function waitForPreview(ms, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    function abort() {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function bindPreviewButton(button, status, playLabel, stopLabel, play) {
  let run
  button.addEventListener('click', async () => {
    if (run !== undefined) {
      run.abort()
      return
    }
    activeTypingPreview?.abort()
    run = new AbortController()
    activeTypingPreview = run
    const { signal } = run
    button.textContent = stopLabel
    status.dataset.error = 'false'
    try {
      await play(signal)
    } catch (error) {
      status.dataset.error = String(!signal.aborted)
      status.textContent = signal.aborted ? 'Preview stopped.' : error.message
    } finally {
      if (activeTypingPreview === run) activeTypingPreview = undefined
      run = undefined
      button.textContent = playLabel
    }
  })
  return () => run?.abort()
}

function previewDurationMs(steps) {
  return steps.reduce((total, step) => total + step.waitMs + step.holdMs, 0)
}

function keyLabel(character) {
  return character === ' ' ? 'Space' : character
}

async function animatePreview(element, frames, durationMs, signal) {
  signal.throwIfAborted()
  const animation = durationMs > 0 && !reducedMotion.matches
    ? element.animate(frames, { duration: durationMs, fill: 'forwards' })
    : undefined
  if (animation !== undefined) animation.startTime = document.timeline.currentTime
  try {
    await waitForPreview(durationMs, signal)
    Object.assign(element.style, frames.at(-1))
  } finally {
    animation?.cancel()
  }
}

function movePlayhead(playhead, from, to, durationMs, scale, signal) {
  const frames = [from, to].map(value => ({ width: (scale > 0 ? value / scale * 100 : 100) + '%' }))
  return animatePreview(playhead, frames, durationMs, signal)
}

async function playTypingSteps({ steps, output, key, playhead, scale }, signal, prefix = '') {
  let elapsed = 0
  async function wait(ms) {
    await movePlayhead(playhead, elapsed, elapsed + ms, ms, scale, signal)
    elapsed += ms
  }
  output.textContent = ''
  playhead.style.width = '0%'
  playhead.hidden = false
  try {
    for (const { character, waitMs, holdMs } of steps) {
      await wait(waitMs)
      if (holdMs > 0) {
        key.textContent = prefix + keyLabel(character)
        key.hidden = false
        await wait(holdMs)
        key.hidden = true
      }
      output.textContent += character
    }
  } finally {
    key.hidden = true
  }
}

function makeTimingExample(group, { title, fields, example, motion }) {
  const sourceGroups = example !== undefined ? GROUPS.filter(group => group.typing)
    : motion === 'drag' || motion === 'sequence' ? [{ sections: [{ fields }] }] : [group]
  const keys = new Set(groupFields(sourceGroups).map(([key]) => key))
  const details = document.createElement('details')
  details.className = 'timing-example'
  const summary = document.createElement('summary')
  summary.textContent = 'Compare ' + title.toLowerCase()
  const body = document.createElement('div')
  body.className = 'timing-example-body'
  const note = document.createElement('p')
  note.className = 'timing-example-note'
  note.textContent = motion === 'sequence' ? 'The three sample steps show the extra pause between actions.'
    : motion === 'cursorTravel' || motion === 'cursorCurve' ? 'Each lane shows the same 200 px move.'
      : 'Your settings include unsaved changes.'
  body.append(note)
  if (example !== undefined) {
    const legend = document.createElement('div')
    legend.className = 'timing-legend'
    for (const [phase, label] of [['wait', 'Before key'], ['hold', 'Key held']]) {
      const item = document.createElement('span')
      item.className = 'timing-legend-' + phase
      item.textContent = label
      legend.append(item)
    }
    body.append(legend)
  }
  const grid = document.createElement('div')
  grid.className = 'timing-example-grid'
  const actions = document.createElement('div')
  actions.className = 'preview-actions'
  const playButton = document.createElement('button')
  playButton.type = 'button'
  playButton.textContent = 'Play comparison'
  playButton.disabled = true
  const status = document.createElement('p')
  status.className = 'status'
  status.setAttribute('role', 'status')
  actions.append(playButton, status)
  body.append(grid, actions)
  details.append(summary, body)

  async function load() {
    const settings = readInputs(sourceGroups, false)
    if (settings === undefined) throw new Error('Check these timing values to preview your settings.')
    if (motion !== undefined) return { settings, plans: motionExamplePlans(motion, settings) }
    const result = await chrome.runtime.sendMessage({ type: 'DSH_TYPING_PREVIEW', example, settings })
    if (!Array.isArray(result?.plans) || result.plans.length === 0) throw new Error('Could not load the typing comparison.')
    return { settings, plans: result.plans }
  }

  function render({ settings, plans }) {
    grid.replaceChildren()
    return motion === undefined ? renderTimingLanes(grid, plans, fields, settings)
      : renderMotionLanes(grid, motion, plans, fields, settings)
  }

  let refreshId = 0
  let refreshTimer
  const stop = bindPreviewButton(playButton, status, 'Play comparison', 'Stop comparison', async signal => {
    clearTimeout(refreshTimer)
    refreshId++
    const data = await load()
    signal.throwIfAborted()
    const players = render(data)
    status.textContent = 'Playing comparison...'
    await Promise.all(players.map(play => play(signal)))
    status.textContent = 'Comparison complete.'
  })
  async function refresh() {
    if (!details.open) return
    const id = ++refreshId
    status.dataset.error = 'false'
    if (grid.childElementCount === 0) status.textContent = 'Loading comparison...'
    try {
      const data = await load()
      if (id !== refreshId) return
      render(data)
      status.textContent = ''
      playButton.disabled = false
    } catch (error) {
      if (id !== refreshId) return
      grid.replaceChildren()
      playButton.disabled = true
      status.dataset.error = 'true'
      status.textContent = error.message
    }
  }
  details.addEventListener('toggle', () => {
    if (details.open) void refresh()
    else {
      clearTimeout(refreshTimer)
      refreshId++
      stop()
    }
  })
  form.addEventListener('input', event => {
    if (!details.open || !keys.has(event.target.name)) return
    stop()
    refreshId++
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(refresh, 120)
  })
  refreshComparisons.push(refresh)
  return details
}

function makeTimingLane(label, durationMs, fields, settings) {
  const lane = document.createElement('figure')
  lane.className = 'timing-lane'
  const caption = document.createElement('figcaption')
  caption.textContent = label
  if (settings !== undefined) {
    lane.classList.add('timing-lane-current')
    for (const [key, title, , , , , unit] of fields) {
      const value = document.createElement('small')
      value.className = 'timing-value'
      value.textContent = (title + ' ' + settings[key] + ' ' + unit).trimEnd()
      caption.append(value)
    }
  }
  const duration = document.createElement('span')
  duration.className = 'timing-duration'
  duration.textContent = (durationMs / 1000).toFixed(2) + ' s'
  lane.append(caption, duration)
  return lane
}

function makePlayhead() {
  const playhead = document.createElement('span')
  playhead.className = 'preview-playhead'
  playhead.hidden = true
  return playhead
}

function renderTimingLanes(grid, plans, fields, settings) {
  const durations = plans.map(({ steps }) => previewDurationMs(steps))
  const scale = Math.max(...durations)
  return plans.map(({ label, steps }, index) => {
    const lane = makeTimingLane(label, durations[index], fields, index === 0 ? settings : undefined)
    const timeline = document.createElement('div')
    timeline.className = 'timing-timeline'
    timeline.setAttribute('aria-hidden', 'true')
    for (const { character, waitMs, holdMs } of steps) {
      for (const [phase, ms] of [['wait', waitMs], ['hold', holdMs]]) {
        if (ms === 0) continue
        const segment = document.createElement('span')
        segment.className = 'timing-segment-' + phase
        segment.style.flexBasis = (ms / scale * 100) + '%'
        segment.title = keyLabel(character) + (phase === 'wait' ? ' wait: ' : ' held: ') + Math.round(ms) + ' ms'
        timeline.append(segment)
      }
    }
    const playhead = makePlayhead()
    timeline.append(playhead)
    const sample = document.createElement('div')
    sample.className = 'timing-sample'
    const output = document.createElement('pre')
    output.textContent = steps.map(({ character }) => character).join('')
    const key = document.createElement('kbd')
    key.hidden = true
    key.setAttribute('aria-hidden', 'true')
    sample.append(output, key)
    lane.append(timeline, sample)
    grid.append(lane)
    return signal => playTypingSteps({ steps, output, key, playhead, scale }, signal)
  })
}

const MOTION_STAGE = { width: 240, height: 132 }

function motionExamplePlans(motion, currentSettings) {
  return [['Your settings', currentSettings], ...MOTION_EXAMPLES[motion]].map(([label, values], index) => {
    const settings = { ...DEFAULTS, ...values }
    if (motion === 'sequence') {
      const pauseMs = settings.sequenceDelayMs
      return { label, durationMs: pauseMs * 2, pauseMs }
    }
    if (motion === 'drag') {
      const start = { x: 20, y: 66 }
      const end = { x: 220, y: 66 }
      const points = Array.from({ length: 21 }, (_, index) => ({
        x: start.x + (end.x - start.x) * index / 20, y: start.y,
      }))
      const frames = points.map((_, index) => {
        const progress = index / 20
        const eased = progress * progress * (3 - 2 * progress)
        return motionPosition({ x: start.x + (end.x - start.x) * eased, y: start.y })
      })
      return { label, durationMs: settings.dragDurationMs, points, frames }
    }
    const from = { x: 20, y: 20 }
    const to = { x: 220, y: 20 }
    const points = buildCursorPath(from, to, { arcRatio: settings.cursorArcRatio, maxArcPx: settings.cursorMaxArcPx })
    const durationMs = cursorTravelDurationMs(to.x - from.x, {
      speedPxPerMs: settings.cursorSpeedPxPerMs,
      minDurationMs: settings.cursorMinDurationMs,
      maxDurationMs: settings.cursorMaxDurationMs,
    }, motion === 'cursorCurve' && index > 0 ? 550 : undefined)
    const frames = Array.from({ length: 41 }, (_, frame) => motionPosition(cursorPointAt(points, frame / 40)))
    return { label, durationMs, points, frames }
  })
}

function motionPosition({ x, y }) {
  return { left: (x / MOTION_STAGE.width * 100) + '%', top: (y / MOTION_STAGE.height * 100) + '%' }
}

function renderMotionLanes(grid, motion, plans, fields, settings) {
  const scale = Math.max(...plans.map(plan => plan.durationMs))
  return plans.map((plan, index) => {
    const lane = makeTimingLane(plan.label, plan.durationMs, fields, index === 0 ? settings : undefined)
    const track = document.createElement('div')
    track.className = 'preview-track'
    track.setAttribute('aria-hidden', 'true')
    const playhead = makePlayhead()
    track.append(playhead)
    const play = motion === 'sequence' ? makeSequencePlayback(lane, plan, playhead, scale)
      : makePointerPlayback(lane, plan, playhead, scale, motion === 'drag')
    lane.append(track)
    grid.append(lane)
    return play
  })
}

function makePointerPlayback(lane, { points, frames, durationMs }, playhead, scale, drag) {
  const stage = document.createElement('div')
  stage.className = 'motion-stage'
  stage.style.aspectRatio = MOTION_STAGE.width + ' / ' + MOTION_STAGE.height
  stage.setAttribute('aria-hidden', 'true')
  for (const [index, point] of points.entries()) {
    const dot = document.createElement('span')
    dot.className = index === 0 || index === points.length - 1 ? 'motion-endpoint' : 'motion-dot'
    Object.assign(dot.style, motionPosition(point))
    stage.append(dot)
  }
  const marker = document.createElement(drag ? 'span' : 'img')
  marker.className = drag ? 'motion-marker motion-tile' : 'motion-marker'
  if (!drag) {
    marker.alt = ''
    marker.src = 'assets/icons8-select-cursor-16.png'
  }
  Object.assign(marker.style, frames[0])
  stage.append(marker)
  lane.append(stage)
  return async signal => {
    Object.assign(marker.style, frames[0])
    playhead.style.width = '0%'
    playhead.hidden = false
    await Promise.all([
      animatePreview(marker, frames, durationMs, signal),
      movePlayhead(playhead, 0, durationMs, durationMs, scale, signal),
    ])
  }
}

function makeSequencePlayback(lane, { pauseMs }, playhead, scale) {
  const stage = document.createElement('ol')
  stage.className = 'sequence-demo'
  stage.setAttribute('aria-label', 'Sample sequence')
  const steps = ['Click', 'Type', 'Submit'].map(label => {
    const step = document.createElement('li')
    step.textContent = label
    stage.append(step)
    return step
  })
  lane.append(stage)
  return async signal => {
    for (const step of steps) step.classList.remove('sequence-reached')
    playhead.style.width = '0%'
    playhead.hidden = false
    for (const [index, step] of steps.entries()) {
      if (index > 0) await movePlayhead(playhead, (index - 1) * pauseMs, index * pauseMs, pauseMs, scale, signal)
      step.classList.add('sequence-reached')
    }
  }
}

bindPreviewButton(previewButton, previewStatus, 'Play preview', 'Stop preview', async signal => {
  const settings = readInputs(GROUPS.filter(group => group.typing))
  if (settings === undefined) throw new Error('Check the typing settings and try again.')
  previewOutput.textContent = ''
  previewProgress.hidden = true
  previewStatus.textContent = 'Preparing preview...'
  const result = await chrome.runtime.sendMessage({ type: 'DSH_TYPING_PREVIEW', settings })
  signal.throwIfAborted()
  if (!Array.isArray(result?.steps)) throw new Error('Could not start the typing preview.')
  const scale = previewDurationMs(result.steps)
  previewStatus.textContent = 'Estimated total ' + (scale / 1000).toFixed(1) + ' s'
  const startedAt = performance.now()
  await playTypingSteps({ steps: result.steps, output: previewOutput, key: previewKey, playhead: previewProgress, scale }, signal, 'Key held: ')
  previewStatus.textContent = 'Three sentences in ' + ((performance.now() - startedAt) / 1000).toFixed(1) + ' s.'
})

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
    activeTypingPreview?.abort()
    populate(DEFAULTS)
    showStatus('Restored the tested default settings.')
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true)
  }
})

void initialize()
