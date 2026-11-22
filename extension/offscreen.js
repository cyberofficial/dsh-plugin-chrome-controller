// Offscreen document that performs the actual system-clipboard read/write for
// the service worker. The worker cannot touch navigator.clipboard directly, so
// it relays DSH_CLIPBOARD messages here. Only created when the user enabled
// clipboard access in extension Settings (gated in background.js).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.dshClipboard !== true) return false
  ;(async () => {
    try {
      if (message.action === 'read') {
        const text = await navigator.clipboard.readText()
        sendResponse({ ok: true, text, totalChars: text.length })
        return
      }
      if (message.action === 'write') {
        const text = String(message.text ?? '')
        let usedFallback = false
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          // Some Chrome builds expose clipboard write only via execCommand.
          const ta = document.createElement('textarea')
          ta.value = text
          ta.setAttribute('readonly', '')
          ta.style.position = 'fixed'
          ta.style.top = '0'
          ta.style.left = '0'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.focus()
          ta.select()
          const ok = document.execCommand('copy')
          ta.remove()
          if (!ok) throw new Error('Could not write to the clipboard')
          usedFallback = true
        }
        sendResponse({ ok: true, chars: text.length, fallback: usedFallback })
        return
      }
      sendResponse({ ok: false, error: 'Unknown clipboard action' })
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
  return true
})
