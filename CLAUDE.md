# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Manifest V3 Chrome extension that exports ChatGPT / Claude / Gemini conversations to Markdown, TXT, JSON, CSV, or print-to-PDF. Pure client-side, no build step, no dependencies.

## Running / testing

There is no build, no test suite, no linter. The loadable extension lives in `extension/` — point "Load unpacked" at that folder, not the repo root. Repo-level files (README, CLAUDE.md, screenshots) live at the root and are intentionally outside the extension bundle. Reload the extension after edits; content-script changes also require reloading the target tab (`chatgpt.com`, `claude.ai`, `gemini.google.com`).

## Architecture

The contract between every layer is the `Conversation` schema in `extension/src/lib/schema.js`. Extractors produce one; exporters consume one. Keep that boundary clean — extractor-specific quirks should not leak into exporters, and vice versa.

**Message flow:** popup → `chrome.tabs.sendMessage({type: 'EXTRACT_CONVERSATION'})` → site-specific content script walks DOM → returns `Conversation` → popup runs an `exportXxx` function → `chrome.downloads` (or new tab for PDF).

**Three layers:**
- `extension/src/content/{chatgpt,claude,gemini}.js` — one extractor per host. Each owns its own `SELECTORS` block. When a site's DOM changes, only its extractor changes.
- `extension/src/lib/{schema,markdown}.js` — shared by extractors. `markdown.js` is a hand-rolled HTML→Markdown converter (no deps); it has site-aware branches (e.g. KaTeX math source extraction).
- `extension/src/exporters/exporters.js` — pure functions `(conv, opts) => { filename, blob }`. PDF is special: it builds a printable HTML document and opens a new tab that calls `window.print()` — there is no PDF library bundled.

**MV3 module sharing constraint:** Content scripts in MV3 cannot be declared as ES modules. The three extractors share `lib/*.js` via runtime `await import(chrome.runtime.getURL('src/lib/...js'))`. That's why `extension/src/lib/*.js` is listed under `web_accessible_resources` in `manifest.json`. The popup and service worker, by contrast, are real ES modules.

**Service worker** (`extension/src/background/service-worker.js`) is intentionally thin — lifecycle hooks only. Don't put extraction or export logic there; the popup drives both.

## Adding things

- **New host:** update `extension/manifest.json` (host_permissions, content_scripts, web_accessible_resources matches), add to `SUPPORTED_HOSTS` in `extension/src/popup/popup.js`, copy an existing extractor and rewrite its `SELECTORS`.
- **New format:** add `exportXxx` to `extension/src/exporters/exporters.js` returning `{filename, blob}`, then wire up a button in `popup.html` and a case in `popup.js`.

## Known DOM fragility

Selectors drift; this is expected. Stable anchors currently relied on:
- ChatGPT: `[data-message-author-role]`, `[data-message-id]`
- Claude: `[data-testid="user-message"]`, `.font-claude-message`
- Gemini: `user-query`, `model-response` (Angular component tags)

Virtualized message lists (all three sites unmount off-screen messages) and collapsed "Show thinking" details are the most common reasons an extraction returns partial data — scroll/expand before exporting. Canvas/Artifacts panels are not currently captured.
