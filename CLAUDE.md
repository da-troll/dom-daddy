# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Manifest V3 Chrome extension (DOM Daddy) that extracts structured data from sites that fight scraping. Today it covers four LLM chat hosts (ChatGPT / Claude / Gemini / Perplexity) and LinkedIn experience pages. Pure client-side, no build step, no dependencies. PDF export is descoped — `exportPrintableHTML` in `exporters.js` is left as scaffolding but is not wired into the popup.

## Running / testing

There is no build, no test suite, no linter. The loadable extension lives in `extension/` — point "Load unpacked" at that folder, not the repo root. Reload the extension after edits; content-script changes also require reloading the target tab.

## Architecture

The contract between every layer is the schema in `extension/src/lib/schema.js`. There are two shapes today, discriminated by `kind`:

- `Conversation` (`kind: 'conversation'`) — for the four chat hosts. Has `messages[]`.
- `Profile` (`kind: 'profile'`) — for LinkedIn (and future profile-style hosts). Has `experiences[].roles[]`.

Extractors produce one; exporters consume one. Keep that boundary clean — extractor-specific quirks should not leak into exporters, and vice versa.

**Message flow:** popup → `chrome.tabs.sendMessage({ type: 'EXTRACT' })` → site-specific content script walks the DOM → returns `{ ok: true, data: <Conversation | Profile> }` → popup branches on `data.kind` and runs the right exporter → `chrome.downloads`.

**Three layers:**
- `extension/src/content/{chatgpt,claude,gemini,perplexity,linkedin}.js` — one extractor per host.
- `extension/src/lib/{schema,markdown}.js` — shared. `markdown.js` is a hand-rolled HTML→Markdown converter with site-aware branches (e.g. KaTeX math source extraction).
- `extension/src/exporters/exporters.js` — pure functions `(data, opts) => { filename, blob }`. Conversation: `exportMarkdown / Text / JSON / CSV`. Profile: `exportProfileMarkdown / JSON / CSV`. Both branches share the `filename()` helper, which keys off `data.kind`.

**Popup** (`extension/src/popup/popup.js`) holds the host registry (`SITES`). Each entry declares `source`, `kind`, content-script path, and optional `pageReady`/`pageHint`/`pageHintAction` for sub-page-only extractors (LinkedIn). The popup branches its UI off `kind` — profiles hide the Text format and the reasoning toggle.

**MV3 module sharing constraint:** Content scripts in MV3 cannot be declared as ES modules. All extractors share `lib/*.js` via runtime `await import(chrome.runtime.getURL('src/lib/...js'))`. That's why `extension/src/lib/*.js` is listed under `web_accessible_resources` in `manifest.json`. The popup and service worker are real ES modules.

**Service worker** (`extension/src/background/service-worker.js`) is intentionally thin — lifecycle hooks only. Don't put extraction or export logic there; the popup drives both.

## Adding things

- **New conversation host:** update `manifest.json` (host_permissions, content_scripts, web_accessible_resources), add a `SITES` entry in `popup.js` with `kind: 'conversation'`, copy an existing chat extractor and rewrite its `SELECTORS`.
- **New profile-style host:** same manifest updates plus a `SITES` entry with `kind: 'profile'` and (if the data lives on a sub-page) `pageReady` / `pageHint` / `pageHintAction`. Extractor calls `makeProfile(...)`. If the new host's data isn't profile-shaped, define a new schema shape with its own `kind` and add matching exporters.
- **New format:** add `exportXxx` in `exporters.js` returning `{filename, blob}`, then wire a button in `popup.html` and a case in `runExport()` in `popup.js`.

## Known DOM fragility

Selectors drift; this is expected. Stable anchors currently relied on:

- ChatGPT: `[data-message-author-role]`, `[data-message-id]`
- Claude: `[data-testid="user-message"]`, `.font-claude-message`
- Gemini: `user-query`, `model-response` (Angular component tags)
- Perplexity: `[class~="group/query"]` for user queries, `.prose` for assistant answers
- LinkedIn: `[componentkey^="entity-collection-item-"]` for one entry per company. The hashed CSS classes (e.g. `cf1bc804 d85601f3 ...`) churn weekly — **don't write CSS-class-based selectors**. The new SDUI framework also renders text only once (no `aria-hidden`/`visually-hidden` duplication), so the linkedin extractor parses `innerText` line-by-line into a small state machine. Two text shapes (grouped multi-role at one company vs. flat single role) are documented at the top of `linkedin.js`.

Virtualized message lists (the four chat sites unmount off-screen messages) and collapsed "Show thinking" details / LinkedIn `…see more` are the most common reasons an extraction returns partial data — scroll/expand before exporting. Canvas/Artifacts panels are not currently captured. LinkedIn's `+N skills` overflow can't be read without clicking the chip; we record `hiddenSkillCount` so the export is honest about the gap.

## Filenames and other download-manager extensions

- Conversations: `{source}-YYYYMMDD-{sessionId}.{ext}`. Date is `exportedAt` (export moment) — none of the chat hosts expose chat creation date or per-message timestamps in the DOM. `sessionId` is parsed from `location.pathname` per extractor (`/c/{id}`, `/chat/{id}`, `/app/{id}`, `/search/{id}`).
- Profiles: `{source}-{slug}-YYYYMMDD.{ext}`. `slug` is the `/in/{slug}/` URL slug.

Both branches live in `filename()` in `exporters.js`, switched on `obj.kind`.

If a user reports that the Save As dialog shows a *different* filename than what we suggested, it is almost always another installed extension hooking `chrome.downloads.onDeterminingFilename` (e.g. download managers; "Suno Tracks Exporter" was the confirmed culprit once). Chrome only honors the most recently installed listener and exposes no override — there is no fix on our side. The popup waits for `chrome.downloads.onChanged` to report `complete` and surfaces the *actual* on-disk filename in the "Saved …" status, so you can tell whether a rewrite happened by comparing dialog-suggestion vs. status-line.
