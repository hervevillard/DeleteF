# DeleteF — Facebook Messages Bulk Deleter (Firefox Extension)

**Date:** 2026-06-14
**Status:** Approved design

## 1. Summary

A Firefox extension (Manifest V3) that deletes **all conversation threads** from
`facebook.com/messages` by automating the site's own UI: for each conversation it
opens the "⋯" (More) menu, clicks **Delete chat**, and confirms **Delete** in the
dialog. The user starts the run with a **Start** button and can **Stop** at any time;
progress is shown live.

There is **no Facebook/Meta API** for this. The extension simulates the clicks a human
would make. This makes it inherently fragile (Meta changes its DOM frequently) and means
it operates only on the user's own logged-in session.

## 2. Requirements

| # | Requirement |
|---|-------------|
| R1 | Delete **whole conversation threads** (Facebook "Delete chat" → confirm), not individual messages. |
| R2 | Target **all** conversations in the inbox. |
| R3 | Deletion runs only after the user presses **Start**. |
| R4 | A **Stop** control halts the run promptly (before the next deletion). |
| R5 | Show live progress: a deleted-count and a status log. |
| R6 | Operate on `https://www.facebook.com/messages/*`. |
| R7 | Installable as a **temporary unsigned add-on** via `about:debugging` (MV3 for Firefox). |
| R8 | A one-time confirmation warns that deletion is permanent and irreversible. |
| R9 | The extension sends no data anywhere; no network or storage permissions. |
| R10 | Build and deployment fully documented (README.md + DEPLOY.md + inline comments). |

### Non-goals (YAGNI)

- No message-by-message deletion or "unsend for everyone".
- No selective/filtered deletion (all-or-stop only).
- No persistence of state across page reloads.
- No support for `messenger.com` (facebook.com only).
- No AMO publication or signing in this iteration.

## 3. Architecture

Three parts:

- **`manifest.json`** — MV3. Declares a toolbar action button, a content script matched
  to `https://www.facebook.com/messages/*`, and the `lib/dom-helpers.js` + `content.js`
  scripts plus `panel.css`. Permissions limited to `activeTab` and `scripting`. No host
  permissions beyond facebook.com; no `storage`, no network access.
- **`background.js`** — minimal service worker. On toolbar-button click, sends a
  `TOGGLE_PANEL` message to the content script in the active tab.
- **`content.js` + `panel.css`** — injects the floating control panel onto the page and
  runs the deletion loop. State is an in-memory object `{ running, deletedCount }`.

```
toolbar click → background.js → (message) → content.js → inject/toggle panel
panel "Start" → content.js deletion loop drives the facebook.com DOM
```

## 4. Components

### 4.1 Floating control panel (injected into the page)

A fixed-position card (top-right, high `z-index`) styled by `panel.css`, containing:

- **Start** button (disabled while running).
- **Stop** button (disabled until running).
- Live counter: `Deleted: N`.
- Scrolling status log showing the last ~8 lines (e.g. "Opening menu…",
  "Confirmed delete", "No more chats — done").
- A close (×) control to dismiss the panel.

The panel and the loop both live in the content script, so the loop keeps running and
stays controllable regardless of focus or clicks elsewhere on the page.

### 4.2 Deletion loop (`content.js`)

On **Start** (after the one-time `confirm()` guardrail), repeat until no conversation
rows remain or `state.running` becomes false:

1. Find the first conversation row in the chat list (prefer `role="row"` /
   `role="gridcell"` within the conversation-list region; ARIA before class names).
2. Hover/click the row to reveal its controls, then click its **More** / "⋯" menu
   (matched by `aria-label` containing "More" / "Menu").
3. In the popup menu (`role="menu"`), click the item whose visible text matches
   **"Delete chat"** / **"Delete"** (from the centralized `LABELS` config).
4. In the confirmation dialog (`role="dialog"`), click the **Delete** confirm button.
5. Wait (bounded) for the row to detach from the DOM, confirming success; increment the
   counter; log the result.
6. Randomized human-like delay (800–1500 ms), then loop.

Each wait uses a bounded helper (`waitFor(fn, timeout)`, default 8 s) so the loop never
hangs. On timeout it logs a warning and stops gracefully.

### 4.3 Pure helpers (`lib/dom-helpers.js`)

Side-effect-free, unit-testable functions:

- `matchByText(nodes, candidates)` — return the first node whose trimmed text/aria-label
  matches one of the candidate strings (case-insensitive).
- `waitFor(fn, { timeout, interval })` — promise that resolves when `fn()` returns truthy,
  rejects on timeout.
- `jitter(min, max)` — random delay duration in ms.
- `resolveSelector(root, candidates)` — try an ordered list of selector strategies
  (ARIA/role/text first, CSS-class fallbacks last) and return the first match.

Centralized config object `LABELS` (default English: More/Menu, "Delete chat", "Delete")
lives at the top of `content.js` so wording/layout updates are a one-line edit.

## 5. Resilience & safety

- **Selector strategy:** ordered candidates, ARIA/role/text first, CSS-class fallbacks
  last. All match strings centralized in `LABELS`.
- **Immediate stop:** the loop checks `state.running` at the top of every iteration and
  before each click.
- **No silent failures:** every unexpected condition is logged to the panel; the loop
  stops rather than thrashing.
- **Irreversibility guardrail:** one-time `confirm()` before the first deletion.
- **Throttling:** randomized delays to look human and reduce rate-limiting/flagging risk.

## 6. Testing strategy

The live-DOM click loop cannot be reliably unit-tested, so tests cover the **pure logic**:

- Unit-test `matchByText`, `waitFor` (resolve and timeout paths), `jitter` (bounds), and
  `resolveSelector` against small jsdom fixture snippets.
- The end-to-end loop is verified **manually on a throwaway/test account**, with the steps
  documented in `DEPLOY.md`.

## 7. Project structure

```
DeleteF/
├── manifest.json
├── background.js
├── content.js          # panel injection + deletion loop
├── panel.css
├── lib/
│   └── dom-helpers.js   # pure, testable helpers
├── icons/              # 48px / 96px toolbar icons
├── test/
│   └── dom-helpers.test.js
├── README.md           # what it does, risks, how it's built
└── DEPLOY.md           # temporary install + usage + troubleshooting
```

## 8. Documentation deliverables

- **README.md** — purpose; exactly what "delete" means here; risks/limitations (Meta ToS,
  DOM fragility, irreversibility); how it's built.
- **DEPLOY.md** — numbered steps: `about:debugging` → "This Firefox" → "Load Temporary
  Add-on" → select `manifest.json`; then open `facebook.com/messages`, click the toolbar
  button, Start; troubleshooting (selectors changed, rate-limited, panel didn't appear).
- Inline comments in `content.js` explaining each loop step.

## 9. Risks & limitations

- **DOM fragility:** Facebook changes its markup often; selectors in `LABELS` may need
  updating. Mitigated by centralizing them and preferring ARIA/text.
- **Terms of Service:** automating Facebook may violate Meta's ToS and could risk account
  flagging. The user runs this at their own risk on their own account.
- **Irreversibility:** "Delete chat" permanently removes the thread from the user's view.
- **Localization:** defaults are English; non-English UIs require editing `LABELS`.
- **Temporary install:** the add-on is removed when Firefox restarts (by design).
