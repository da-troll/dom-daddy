# Chat Exporter

A Manifest V3 Chrome extension that exports conversations from ChatGPT, Claude, and Gemini to Markdown, plain text, JSON, or CSV. Entirely client-side — nothing is sent to any server.

> PDF export is descoped from v0.1. The printable-HTML scaffolding (`exportPrintableHTML` in `extension/src/exporters/exporters.js`) is left in place to re-enable later via a blob URL.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select the `extension/` directory in this repo.
4. Pin the extension to the toolbar.
5. Open a conversation on `chatgpt.com`, `claude.ai`, or `gemini.google.com`, click the icon, choose a format.

Works on any Chromium browser (Chrome, Edge, Brave, Arc, etc.).

## Architecture

```
extension/                 <- the loadable Chrome extension (point "Load unpacked" here)
  manifest.json            MV3 manifest
  src/
    background/            Thin service worker (lifecycle hooks only)
    content/               One content script per supported host
      chatgpt.js           chatgpt.com / chat.openai.com
      claude.js            claude.ai
      gemini.js            gemini.google.com
    lib/
      schema.js            Shared Conversation / Message types
      markdown.js          HTML -> Markdown converter (no deps)
    exporters/
      exporters.js         md / txt / json / csv (printable HTML scaffolded but unwired)
    popup/
      popup.html / .css / .js   User-facing UI
  icons/                   16/48/128 PNG icons
README.md, CLAUDE.md, screenshots, etc. live at the repo root and are not part of the extension bundle.
```

### Data flow

```
Popup opened
  -> popup.js sends { type: 'EXTRACT_CONVERSATION' } to the active tab
  -> matching content script walks the DOM and returns a Conversation object
  -> popup.js passes it through one of the exporters
  -> chrome.downloads or a new printable tab handles delivery
```

The shared schema (`extension/src/lib/schema.js`) is the contract between extractors and exporters. Adding a new site means writing one content script that returns a `Conversation`. Adding a new format means writing one function in `exporters.js`.

### Why dynamic `import()` in content scripts?

Manifest V3 does not let you declare content scripts as ES modules. To still share `markdown.js` and `schema.js` across the three extractors, each content script does `await import(chrome.runtime.getURL('src/lib/...js'))`. The shared files are listed under `web_accessible_resources` so they're loadable from the page context.

## Known limitations

- **Selectors will drift.** ChatGPT/Claude/Gemini reorganize their DOM regularly. When a site stops working, only that site's content script needs to change. Stable selectors used:
  - ChatGPT: `[data-message-author-role]`, `[data-message-id]`
  - Claude: `[data-testid="user-message"]`, `.font-claude-message`
  - Gemini: `user-query`, `model-response` (Angular component tags)
- **Reasoning blocks must be expanded** to be extracted in some UIs. If the "Show thinking" details element is collapsed, the reasoning content may not be in the DOM yet.
- **Long conversations need to be fully scrolled** before exporting — these UIs virtualize lists and unmount messages that are off-screen. A future version can scroll programmatically before extracting.
- **Canvas / Artifacts** (ChatGPT's side panel, Claude's artifacts) live outside the main thread DOM. They aren't currently captured. To add: query the side-panel container and attach the content as a synthetic message or an attachment.
- **Math source extraction** assumes KaTeX. If a site switches to MathJax or raw LaTeX, the extractor in `markdown.js` needs another branch.

## Extending

### Add a new site

1. Add the host to `manifest.json` (`host_permissions`, `content_scripts`, `web_accessible_resources`).
2. Add `SUPPORTED_HOSTS` entry in `extension/src/popup/popup.js`.
3. Copy one of the existing extractors and rewrite the `SELECTORS` block for the new site's DOM.

### Add a new format

Add an `exportXxx(conv, opts)` function in `extension/src/exporters/exporters.js` that returns `{ filename, blob }`, then wire a button in `popup.html` and a `case` in `popup.js`.

## Why this exists

Built as a from-scratch alternative to closed-source export extensions, with the goal of (1) keeping all conversation data inside the browser and (2) being trivially auditable — no minified bundles, no server, no analytics.
