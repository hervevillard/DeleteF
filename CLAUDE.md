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
- `findElement()` — tries `matchByText` (role/button/aria-label selectors) first, then `findByText()` (exact text on any element, deepest match first), then `findWithAi()` if AI is enabled.
- `findByText()` — walks all descendant elements in reverse DOM order and returns the deepest whose trimmed textContent exactly matches a candidate. Needed because Facebook menu items often have no `role` attribute.
- `waitForMenu()` — after clicking the "⋯" button, waits for the menu it controls to appear using `aria-controls` (→ `getElementById`) before falling back to `role="menu"`. This ensures the AI fallback gets a focused DOM subtree, not the entire page body.
- `findWithAi()` — checks `aiCache`, then asks background via `browser.runtime.sendMessage({type:'ASK_AI'})`. On success, derives a stable selector via `deriveStableSelector()` and stores it in `aiCache` so DeepSeek is only called a handful of times per session.

**`lib/dom-helpers.js`**
Pure, side-effect-free helpers. Dual-exports: attaches to `globalThis.DeleteF` in the browser, exports via `module.exports` for Node tests. Functions: `jitter`, `matchByText`, `waitFor`, `resolveSelector`, `redactStructure`, `parseSelectorResponse`.

**`options.html` / `options.js`**
Settings page (AI on/off, DeepSeek API key, model). Reads/writes `browser.storage.local`.

## Key design constraints

- **Element matching is ARIA/role/text-first**, not CSS-class-first. Facebook obfuscates class names; ARIA attributes and visible text are stable. `matchByText` checks `textContent` and `aria-label`; `resolveSelector` takes an ordered list of strategies (function or CSS string) and returns the first match.
- **`redactStructure` for AI calls** strips all visible text (contact names, message previews) before anything leaves the browser. Only tag names, `role`, `aria-label`, `aria-haspopup`, `type`, and the first CSS class are sent. `data-df="N"` index attributes are stamped on live elements (`tagElements`) before calling, matching the indices in the serialized structure so the returned `[data-df="N"]` selector resolves correctly.
- **Tests run in Node with jsdom** — `lib/dom-helpers.js` is the only testable module (no browser APIs). `content.js` and `background.js` cannot be unit-tested without a browser environment.
