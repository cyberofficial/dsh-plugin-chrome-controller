# Chrome Controller for DeepSeek Harness

https://github.com/user-attachments/assets/ce72343e-1abb-431f-9be5-6c90a1bb6c60

Put your DeepSeek Harness agent to work in the Chrome window you already use. Watch it fill a form, check a worksheet, or trace a broken request in the tabs and apps where you're signed in.

[Get started](#get-started) | [What you can do](#what-you-can-do) | [Release downloads](https://github.com/cyberofficial/dsh-plugin-chrome-controller/releases) | [Browser skill](skills/chrome-browser/SKILL.md)

## How it works

- The **Chrome extension** pairs your Chrome profile to DSH Web and carries out actions through Chrome's debugger API. You can see the virtual cursor sweep between controls along a Bézier arc and watch text appear keystroke by keystroke.
- The **DSH plugin** adds the browser tools, pairing settings, and the `/chrome-browser` skill to DeepSeek Harness. Actions on a tab run in order, and work on different tabs can run in parallel. DSH sessions share the paired browser.

## What you can do

| Workflow | What it looks like |
| --- | --- |
| **Forms and review** | Fill drafts across tabs and stage up to four Save or Submit clicks for review in DSH Web. Choose **Approve once**, **Skip**, or **Needs changes** for each tab. |
| **Browser dialogs** | When a JavaScript confirmation or prompt interrupts a tab, review the dialog in DSH Web and choose how Chrome should respond. |
| **Workbooks** | Check the active sheet and select cells or ranges in Excel Online and Google Sheets. In Excel Online, read ranges when the editor exposes a compatible API, or watch the formula bar with cell addresses. |
| **Notes and click targets** | Attach instructions to an element with **Note Mode**, or mark a place for the agent to click with **Points of Interest**. Browse saved notes and points for the current site or across all sites. |
| **Embedded apps and live updates** | Inspect and scroll inside accessible frames, including cross-origin frames. Watch several elements in one iframe, or arm a main-page wait before triggering a change. |
| **Automation and debugging** | Run a sequence of clicks, typing, scrolling, and waits. Take screenshots, inspect page content, or capture console errors and network activity during a reproduction. |
| **Signed-in downloads** | Save supported files of up to 10 MiB from a signed-in tab to your DSH session workspace. A credentialed cross-origin retry requires approval. Regular Chrome downloads go to the browser's computer. |

Form review covers the staged click on a standard HTML form in the main document. The extension rechecks the form and button before clicking. Some sites autosave during entry. Recognized sensitive values are masked in the review, and other previewed values may appear in the DSH session transcript.

## Get started

You'll need **Chrome 116 or later** and **DeepSeek Harness Web**. [DeepSeek Harness setup](https://github.com/deepseek-ai/deepseek-harness#run)

1. **Install the DSH plugin.** Clone or download this repository on the machine running DSH. Replace the example path with the full path to your checkout.

   ```sh
   dsh plugin --profile web add "link:C:/path/to/dsh-plugin-chrome-controller"
   ```

   Restart DSH Web and reload its page.
2. **Load the Chrome extension.** On the computer running Chrome, open `chrome://extensions`, turn on **Developer mode**, and use **Load unpacked** to select the repository's `extension` folder.
3. **Copy the pairing details.** In signed-in DSH Web, open **Settings** > **Chrome browser** and copy the **DSH Web origin** and **Pairing code**. You can also open `/api/dsh-browser-extension/pairing` on the DSH Web origin.
4. **Connect from Chrome.** Open **Settings** in the extension popup, enter the origin and code in **Connection**, and click **Save connection**. Return to the popup and click **Connect to DSH Web**. The popup shows **Connected to DSH Web** when pairing succeeds, and the connection runs in the background.

### Remote DSH Web

The default local origin is `http://127.0.0.1:3080`. For remote DSH Web, use an HTTPS origin reachable from Chrome. DSH must trust that host, which you can configure with `--trusted-host <host>`. If you use a reverse proxy, preserve the original `Host` header and forward both `/api/dsh-browser-extension/` and `/dsh-browser-extension/` on that origin to DSH. [DSH deployment guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/public-deployments.md)

## Try it in DSH Web

Ask the agent to use `/chrome-browser`. Give it the tab titles and the details to enter, then set a review checkpoint.

> Use my open request tabs. Read my saved page notes, then fill the forms with the details below. Show me the pending Save clicks in DSH Web so I can review each tab. After I decide, verify the outcome for each form I approved.

The included skill has examples for choosing the right tab and frame, watching changes, working in spreadsheets, and verifying what a site did after an action. [Read the browser skill](skills/chrome-browser/SKILL.md)

## Extension settings

- In **Connection**, turn on **Connect automatically** to pair at Chrome startup or extension reload and retry after interruptions. To replace a pairing code, rotate it in DSH Web, then save the new one in the extension.
- In **Site access**, set a **Whitelist** or **Blacklist** to control which domains DSH can open or operate on. The filter is off by default. It checks top-level tab addresses and tool-requested destinations. Entries include subdomains, and permitted pages can still use embedded frames.
- System **Clipboard** access is off by default. Acknowledge and enable it to let DSH read or replace the clipboard and paste with Ctrl+V. The paste tool can fall back to fast typing when clipboard access is off or the paste fails.
- In **Interaction timing**, adjust typing pauses, cursor movement, drag duration, and the spacing between sequence steps. Play previews to see how your settings feel before saving.

For long typing tasks, raise `operationTimeoutMs` in the DSH plugin configuration. Standard browser operations default to 30 seconds. For example, `300000` sets a five-minute bridge timeout. Change waits have a separate 10-minute default. A shorter DSH execution deadline can end either kind of operation.

## License

Released under the MIT License.
