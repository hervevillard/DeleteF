# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install dev deps (jsdom for tests)
npm test           # run all unit tests via Node's built-in test runner
node --test test/dom-helpers.test.js  # run a single test file
```

There is no build step. The extension is loaded directly into Firefox from source.

**Load in Firefox:**
1. Go to `about:debugging` → This Firefox → Load Temporary Add-on
2. Select `manifest.json`

## Architecture

This is a Manifest V3 Firefox extension with no bundler or transpiler. Three execution contexts:

**`background.js` (service worker)**
Handles two things only: toggle the content-script panel on toolbar-button click, and proxy `ASK_AI` messages to the DeepSeek API. Network calls must live here because Facebook's CSP blocks cross-origin fetches from content scripts.

**`content.js` (injected into `facebook.com/messages/*`)**
All deletion logic. Depends on `lib/dom-helpers.js` being loaded first (declared in `manifest.json` `content_scripts` order). Key entry points:
- `LABELS` object at the top — all Facebook UI strings to match against. This is the first thing to update when Facebook changes its UI.
- `runLoop()` → `deleteOne(row)` — the deletion loop: hover row → open "⋯" menu → wait for its menu via `waitForMenu()` → click "Delete chat" → confirm in dialog → wait for row to detach from DOM.
- `findElement()` — **AI-primary when enabled**: calls `findWithAi()` first (cache check then API), falls back to `matchByText()` and `findByText()` when AI is off or fails. At most 3 API calls happen per session (one per step on the first conversation); all subsequent iterations hit the cache.
- `findByText()` — walks all descendant elements in reverse DOM order and returns the deepest whose trimmed textContent exactly matches a candidate. Needed because Facebook menu items often have no `role` attribute.
- `waitForMenu()` — after clicking the "⋯" button, waits for the menu it controls to appear using `aria-controls` → `getElementById` before falling back to `role="menu"`. Gives AI a tight, focused DOM subtree (the specific menu, not the whole page).
- `findWithAi()` — checks `aiCache`, then asks background via `browser.runtime.sendMessage({type:'ASK_AI'})`. On success, calls `deriveStableSelector()` and stores the result in `aiCache`.
- `deriveStableSelector()` — derives a cached selector from the found element. Prefers structural attributes (`aria-controls`, `aria-haspopup`) over content-bearing ones (`aria-label`). The "⋯" button's `aria-label` is user-specific ("More options for [Name]") and would break on the next row; its `aria-controls` is structural and reusable.

**`lib/dom-helpers.js`**
Pure, side-effect-free helpers. Dual-exports: attaches to `globalThis.DeleteF` in the browser, exports via `module.exports` for Node tests. Functions: `jitter`, `matchByText`, `waitFor`, `resolveSelector`, `redactStructure`, `parseSelectorResponse`.

**`options.html` / `options.js`**
Settings page (AI on/off, DeepSeek API key, model). Reads/writes `browser.storage.local`.

## Key design constraints

- **AI is NOT a browser agent** — it is a one-shot LLM call. The extension sends a redacted DOM snapshot (no visible text, tags/roles/aria-labels only) and gets back a CSS selector. The extension then does the actual clicking. DeepSeek cannot navigate, observe results, or retry.
- **Three-step deletion per conversation**: (1) hover row → AI/heuristics find `[aria-haspopup="menu"][aria-controls]` button → click it; (2) `waitForMenu` finds the opened menu via `aria-controls` → AI/heuristics find "Delete chat" → click it; (3) wait for `[role="dialog"]` or `[role="alertdialog"]` → AI/heuristics find confirm "Delete chat" button → click it; (4) wait for row to detach.
- **Non-conversation rows (Marketplace, channels)** are detected by the absence of a "Delete chat" option. `runLoop` catches that error, adds the row to `skippedRows` (a `WeakSet`), dispatches Escape to close the open menu, and continues. `findFirstRow` filters `skippedRows` so the same row is never retried.
- **Conversation count** is logged at the start of each run via `findAllRows()`, which counts distinct gridcells/rows that own a `[aria-haspopup="menu"][aria-controls]` button.
- **`redactStructure` for AI calls** strips all visible text (contact names, message previews) before anything leaves the browser. Only tag names, `role`, `aria-label`, `aria-haspopup`, `type`, and the first CSS class are sent. `data-df="N"` index attributes are stamped on live elements (`tagElements`) so the returned `[data-df="N"]` selector resolves against the real DOM.
- **Caching prevents repeated API calls** — `aiCache` maps each `aiTarget` string to the stable selector derived from the AI-found element. After the first conversation, all three steps use cached selectors with no network calls.
- **Tests run in Node with jsdom** — `lib/dom-helpers.js` is the only testable module (no browser APIs). `content.js` and `background.js` cannot be unit-tested without a browser environment.
