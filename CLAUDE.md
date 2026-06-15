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
Handles two things only: toggle the content-script panel on toolbar-button click, and proxy `AGENT_TURN` messages to the DeepSeek API. Network calls must live here because Facebook's CSP blocks cross-origin fetches from content scripts. It is a **dumb proxy** — `askDeepSeekAgent({messages, tools})` forwards the running OpenAI-format message history plus the tool schemas to DeepSeek and returns the raw assistant message (which may contain `tool_calls`) or `{error}`. It holds no tool logic.

**`content.js` (injected into `facebook.com/messages/*`)**
All deletion logic, the panel UI, CSV export, and the agent loop. Depends on `lib/dom-helpers.js` being loaded first (declared in `manifest.json` `content_scripts` order). Two deletion modes selected by the `aiEnabled` setting:
- **AI off (default):** `runLoop()` walks the list and uses local heuristics only.
- **AI on:** `runAgent(instruction)` runs a DeepSeek tool-calling loop.

Key entry points:
- `LABELS` object at the top — all Facebook UI strings to match against. First thing to update when Facebook changes its UI.
- `performDelete(row)` — **the single shared clicking path** used by BOTH modes: hover row → open "⋯" menu → `waitForMenu()` → click "Delete chat" → confirm in dialog → wait for row to detach. Throws a typed `DeleteError` (`code`: `no_delete_option`, `no_menu`, `no_dialog`, etc.) so callers can distinguish "skip this row" from a real failure.
- `findElement(scope, candidates)` — **local heuristics only** (synchronous): `matchByText()` then `findByText()`. No AI, no network. The agent reasons at a higher level; it does not drive low-level element finding.
- `findByText()` — walks descendants in reverse DOM order, returns the deepest whose trimmed textContent exactly matches a candidate. Needed because Facebook menu items often lack a `role`.
- `waitForMenu()` — after clicking "⋯", polls for BOTH the `aria-controls` target (`getElementById`) AND a `role="menu"`/`role="listbox"` popup, returning whichever appears first. Facebook's `aria-controls` value frequently does not match the mounted menu's `id`, so relying on `getElementById` alone times out even when the menu is visible.
- `runAgent()` / `AGENT_TOOLS` / `executeTool()` — the agent loop. Tool **schemas and executors both live in `content.js`**; each model turn is sent to background via `browser.runtime.sendMessage({type:'AGENT_TURN', payload:{messages, tools}})`, tool calls are executed against the DOM, results are appended as `role:"tool"` messages, repeat. Bounded by `MAX_ITERATIONS` and the Stop button (`state.running`).
- CSV export: `downloadCsv()` builds names of currently-loaded rows via `findAllRows()` + `rowName()` + `toCsv()`, then triggers a Blob download. Fully local; no AI, no network, no `downloads` permission.

**`lib/dom-helpers.js`**
Pure, side-effect-free helpers. Dual-exports: attaches to `globalThis.DeleteF` in the browser, exports via `module.exports` for Node tests. Functions: `jitter`, `matchByText`, `waitFor`, `resolveSelector`, `redactStructure` (supports `{includeText}`), `parseSelectorResponse`, `nameFromAriaLabel`, `toCsv`.

**`options.html` / `options.js`**
Settings page (AI on/off, DeepSeek API key, model). Reads/writes `browser.storage.local`.

## Key design constraints

- **AI IS an agent** — when enabled, a DeepSeek tool-calling loop drives the whole job. The model cannot see or click the page directly; `content.js` is its hands and eyes. The tools are: `list_conversations`, `delete_conversation(id)`, `scroll_conversation_list`, `observe` / `click_element(df)` (self-correction escape hatch), and `finish`. The loop runs in `content.js`; the network turn is proxied through `background.js`.
- **Privacy posture is mode-dependent.** AI off = zero network, nothing leaves the browser. AI on = real contact names and visible text are sent to DeepSeek (the agent needs them to decide who to delete). This is the documented, opt-in tradeoff; there is no redacted-with-AI mode.
- **Selective deletion** comes from a free-text instruction box in the panel. Empty = delete all. The agent reads names via `list_conversations` and applies the instruction.
- **Three-step deletion per conversation** (in `performDelete`): (1) hover row → find `[aria-haspopup="menu"][aria-controls]` button (heuristic fallback `LABELS.moreMenu`) → click; (2) `waitForMenu` → heuristics find "Delete chat" → click; (3) wait for `[role="dialog"]`/`[role="alertdialog"]` → heuristics find confirm button → click; (4) wait for row to detach.
- **Stable row identity for the agent:** `list_conversations` stamps each row with a session-persistent `data-df-id="N"`; `delete_conversation(id)` resolves the row via `[data-df-id="N"]`. Deleted rows simply stop appearing; indices never shift under the model. This is distinct from the `data-df="N"` indices `tagElements`/`redactStructure` stamp for `observe`/`click_element`.
- **Non-conversation rows (Marketplace, channels)** are detected by the absence of a "Delete chat" option (`DeleteError` code `no_delete_option`). In AI-off mode `runLoop` adds the row to `skippedRows` (a `WeakSet`) and `findFirstRow` filters it out. In AI-on mode the tool returns `status:"no_delete_option"` and the agent is told to skip it.
- **`redactStructure({includeText:true})` for the `observe` tool** keeps each element's OWN direct text plus tags/roles/aria so the model can read menu/dialog labels. The default (text-free) form is retained for any privacy-preserving use.
- **Tests run in Node with jsdom** — `lib/dom-helpers.js` is the only testable module (no browser APIs). The agent loop, tool dispatch, and `performDelete` require a browser and are manually verified.
