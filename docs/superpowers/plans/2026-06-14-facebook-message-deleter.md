# DeleteF — Facebook Messages Bulk Deleter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Firefox MV3 extension that deletes all conversation threads from `facebook.com/messages` by driving the site's own UI, controlled by an on-page Start/Stop panel.

**Architecture:** A content script injected into `facebook.com/messages` injects a floating control panel and runs a deletion loop (open ⋯ menu → Delete chat → confirm). A tiny background service worker toggles the panel on toolbar-button click. Side-effect-free DOM helpers live in `lib/dom-helpers.js` and are unit-tested with Node's built-in test runner + jsdom.

**Tech Stack:** JavaScript (no build step), Firefox Manifest V3, `node:test` + `node:assert`, `jsdom` for DOM fixtures.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `manifest.json` | MV3 manifest: action button, content scripts, permissions |
| `background.js` | Service worker; sends `TOGGLE_PANEL` to active tab on button click |
| `lib/dom-helpers.js` | Pure helpers: `jitter`, `matchByText`, `waitFor`, `resolveSelector`; dual export (browser global + CommonJS) |
| `content.js` | `LABELS` config, panel injection, deletion loop |
| `panel.css` | Styling for the injected control panel |
| `icons/icon-48.png`, `icons/icon-96.png` | Toolbar icons |
| `test/dom-helpers.test.js` | Unit tests for the pure helpers |
| `package.json` | Dev dependency (`jsdom`) + `npm test` script |
| `README.md` | Purpose, risks, how it's built |
| `DEPLOY.md` | Temporary-install + usage + troubleshooting |

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `manifest.json`
- Create: `.gitignore`
- Create: `icons/icon-48.png`, `icons/icon-96.png`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "deletef",
  "version": "1.0.0",
  "description": "Firefox extension that deletes all Facebook conversation threads via the site UI.",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "test": "node --test"
  },
  "devDependencies": {
    "jsdom": "^24.1.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
*.log
```

- [ ] **Step 3: Create `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "DeleteF — Facebook Messages Deleter",
  "version": "1.0.0",
  "description": "Deletes all conversation threads from facebook.com/messages. Use at your own risk; deletion is permanent.",
  "icons": {
    "48": "icons/icon-48.png",
    "96": "icons/icon-96.png"
  },
  "permissions": ["activeTab", "scripting"],
  "background": {
    "scripts": ["background.js"]
  },
  "action": {
    "default_title": "DeleteF — toggle delete panel",
    "default_icon": {
      "48": "icons/icon-48.png",
      "96": "icons/icon-96.png"
    }
  },
  "content_scripts": [
    {
      "matches": ["https://www.facebook.com/messages/*"],
      "js": ["lib/dom-helpers.js", "content.js"],
      "css": ["panel.css"],
      "run_at": "document_idle"
    }
  ],
  "browser_specific_settings": {
    "gecko": {
      "id": "deletef@local.extension",
      "strict_min_version": "121.0"
    }
  }
}
```

- [ ] **Step 4: Create placeholder icons**

Run (generates two solid-color PNGs so the manifest loads; replace later if desired):

```bash
mkdir -p icons
printf '\x89PNG\r\n\x1a\n' > /dev/null  # sanity: ensure shell supports escapes
node -e "const fs=require('fs');const z=require('zlib');function png(s){const sig=Buffer.from([137,80,78,71,13,10,26,10]);function chunk(t,d){const len=Buffer.alloc(4);len.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);const crcTable=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crcTable[n]=c>>>0;}let crc=0xffffffff;for(const b of td)crc=crcTable[(crc^b)&0xff]^(crc>>>8);crc=(crc^0xffffffff)>>>0;const cb=Buffer.alloc(4);cb.writeUInt32BE(crc>>>0);return Buffer.concat([len,td,cb]);}const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(s,0);ihdr.writeUInt32BE(s,4);ihdr[8]=8;ihdr[9]=2;const row=Buffer.concat([Buffer.from([0]),Buffer.concat(Array.from({length:s},()=>Buffer.from([24,119,210])))]);const raw=Buffer.concat(Array.from({length:s},()=>row));const idat=z.deflateSync(raw);return Buffer.concat([sig,chunk('IHDR',ihdr),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))]);}fs.writeFileSync('icons/icon-48.png',png(48));fs.writeFileSync('icons/icon-96.png',png(96));console.log('icons written');"
```

Expected: `icons written`, and `icons/icon-48.png` + `icons/icon-96.png` exist.

- [ ] **Step 5: Install dev dependency**

Run: `npm install`
Expected: `node_modules/jsdom` exists, no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore manifest.json icons/
git commit -m "chore: scaffold DeleteF extension (manifest, package, icons)"
```

---

## Task 2: `jitter` helper (TDD)

**Files:**
- Create: `lib/dom-helpers.js`
- Test: `test/dom-helpers.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/dom-helpers.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { jitter } = require('../lib/dom-helpers.js');

test('jitter returns an integer within [min, max]', () => {
  for (let i = 0; i < 200; i++) {
    const v = jitter(800, 1500);
    assert.ok(Number.isInteger(v), `expected integer, got ${v}`);
    assert.ok(v >= 800 && v <= 1500, `expected 800..1500, got ${v}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/dom-helpers.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/dom-helpers.js`:

```js
// DeleteF pure DOM helpers. Side-effect-free and unit-testable.
// Dual export: attaches to the browser content-script global (globalThis.DeleteF)
// and to module.exports when running under Node (tests).
(function (root) {
  'use strict';

  // Random integer delay in [min, max], used to space out clicks like a human.
  function jitter(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  const api = { jitter };

  root.DeleteF = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add lib/dom-helpers.js test/dom-helpers.test.js
git commit -m "feat: add jitter delay helper with tests"
```

---

## Task 3: `matchByText` helper (TDD)

**Files:**
- Modify: `lib/dom-helpers.js`
- Test: `test/dom-helpers.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/dom-helpers.test.js`:

```js
const { JSDOM } = require('jsdom');
const { matchByText } = require('../lib/dom-helpers.js');

test('matchByText returns first node containing a candidate (case-insensitive)', () => {
  const dom = new JSDOM(`<div role="menu">
    <div role="menuitem">Mark as read</div>
    <div role="menuitem">Delete chat</div>
    <div role="menuitem">Archive</div>
  </div>`);
  const items = dom.window.document.querySelectorAll('[role="menuitem"]');
  const hit = matchByText(items, ['delete chat', 'delete']);
  assert.equal(hit.textContent, 'Delete chat');
});

test('matchByText matches via aria-label when text is empty', () => {
  const dom = new JSDOM(`<button aria-label="More options"></button>`);
  const btns = dom.window.document.querySelectorAll('button');
  const hit = matchByText(btns, ['more']);
  assert.equal(hit.getAttribute('aria-label'), 'More options');
});

test('matchByText returns null when nothing matches', () => {
  const dom = new JSDOM(`<div>hello</div>`);
  const nodes = dom.window.document.querySelectorAll('div');
  assert.equal(matchByText(nodes, ['delete']), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `matchByText is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/dom-helpers.js`, add the function above the `api` object:

```js
  // Return the first node whose visible text OR aria-label contains any candidate
  // string (case-insensitive). `nodes` is an array or NodeList. Returns null if none.
  function matchByText(nodes, candidates) {
    const wants = candidates.map((c) => c.toLowerCase());
    for (const node of Array.from(nodes)) {
      const text = (node.textContent || '').trim().toLowerCase();
      const aria = (node.getAttribute && node.getAttribute('aria-label') || '')
        .trim()
        .toLowerCase();
      const haystack = text || aria;
      if (haystack && wants.some((w) => haystack.includes(w))) {
        return node;
      }
    }
    return null;
  }
```

And update the export line:

```js
  const api = { jitter, matchByText };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/dom-helpers.js test/dom-helpers.test.js
git commit -m "feat: add matchByText helper with tests"
```

---

## Task 4: `waitFor` helper (TDD)

**Files:**
- Modify: `lib/dom-helpers.js`
- Test: `test/dom-helpers.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/dom-helpers.test.js`:

```js
const { waitFor } = require('../lib/dom-helpers.js');

test('waitFor resolves with the truthy value once the condition holds', async () => {
  let flips = 0;
  const value = await waitFor(() => (++flips >= 3 ? 'ready' : null), {
    timeout: 1000,
    interval: 10,
  });
  assert.equal(value, 'ready');
});

test('waitFor rejects on timeout', async () => {
  await assert.rejects(
    () => waitFor(() => false, { timeout: 50, interval: 10 }),
    /timed out/i
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `waitFor is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/dom-helpers.js`, add:

```js
  // Poll `fn` every `interval` ms until it returns a truthy value (resolve with it),
  // or reject after `timeout` ms. Bounds every DOM wait so the loop never hangs.
  function waitFor(fn, { timeout = 8000, interval = 200 } = {}) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        let result;
        try {
          result = fn();
        } catch (err) {
          return reject(err);
        }
        if (result) return resolve(result);
        if (Date.now() - start >= timeout) {
          return reject(new Error('waitFor timed out'));
        }
        setTimeout(poll, interval);
      })();
    });
  }
```

And update the export line:

```js
  const api = { jitter, matchByText, waitFor };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/dom-helpers.js test/dom-helpers.test.js
git commit -m "feat: add bounded waitFor helper with tests"
```

---

## Task 5: `resolveSelector` helper (TDD)

**Files:**
- Modify: `lib/dom-helpers.js`
- Test: `test/dom-helpers.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/dom-helpers.test.js`:

```js
const { resolveSelector } = require('../lib/dom-helpers.js');

test('resolveSelector tries strategies in order, returns first match', () => {
  const dom = new JSDOM(`<div id="root">
    <span class="x_legacy">legacy</span>
    <a role="row">first row</a>
  </div>`);
  const root = dom.window.document.getElementById('root');
  // ARIA strategy (function) first, CSS-class fallback last.
  const node = resolveSelector(root, [
    (r) => r.querySelector('[role="row"]'),
    '.x_legacy',
  ]);
  assert.equal(node.textContent, 'first row');
});

test('resolveSelector falls back to later strategies', () => {
  const dom = new JSDOM(`<div id="root"><span class="x_legacy">legacy</span></div>`);
  const root = dom.window.document.getElementById('root');
  const node = resolveSelector(root, [
    (r) => r.querySelector('[role="row"]'),
    '.x_legacy',
  ]);
  assert.equal(node.textContent, 'legacy');
});

test('resolveSelector returns null when no strategy matches', () => {
  const dom = new JSDOM(`<div id="root"></div>`);
  const root = dom.window.document.getElementById('root');
  assert.equal(resolveSelector(root, ['.nope', (r) => r.querySelector('em')]), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `resolveSelector is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/dom-helpers.js`, add:

```js
  // Try an ordered list of strategies and return the first matching element.
  // A strategy is either a CSS selector string (root.querySelector) or a
  // function(root) => Element|null. Put resilient ARIA/role/text strategies
  // first and brittle CSS-class fallbacks last.
  function resolveSelector(root, strategies) {
    for (const strategy of strategies) {
      let node = null;
      try {
        node = typeof strategy === 'function' ? strategy(root) : root.querySelector(strategy);
      } catch (err) {
        node = null;
      }
      if (node) return node;
    }
    return null;
  }
```

And update the export line:

```js
  const api = { jitter, matchByText, waitFor, resolveSelector };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/dom-helpers.js test/dom-helpers.test.js
git commit -m "feat: add resolveSelector helper with tests"
```

---

## Task 6: Panel styling

**Files:**
- Create: `panel.css`

- [ ] **Step 1: Create `panel.css`**

```css
#deletef-panel {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 2147483647;
  width: 280px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  color: #1c1e21;
  background: #ffffff;
  border: 1px solid #ccd0d5;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  padding: 12px;
}
#deletef-panel * { box-sizing: border-box; }
#deletef-panel .deletef-title {
  font-weight: 700;
  margin: 0 0 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
#deletef-panel .deletef-close {
  cursor: pointer;
  border: none;
  background: transparent;
  font-size: 16px;
  line-height: 1;
}
#deletef-panel .deletef-buttons { display: flex; gap: 8px; margin-bottom: 8px; }
#deletef-panel button.deletef-action {
  flex: 1;
  padding: 8px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font-weight: 600;
  color: #fff;
}
#deletef-panel button.deletef-start { background: #d23f57; }
#deletef-panel button.deletef-stop { background: #606770; }
#deletef-panel button:disabled { opacity: 0.5; cursor: not-allowed; }
#deletef-panel .deletef-count { font-weight: 700; margin-bottom: 6px; }
#deletef-panel .deletef-log {
  height: 120px;
  overflow-y: auto;
  background: #f0f2f5;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  white-space: pre-wrap;
}
```

- [ ] **Step 2: Commit**

```bash
git add panel.css
git commit -m "feat: add control panel styling"
```

---

## Task 7: Background service worker

**Files:**
- Create: `background.js`

- [ ] **Step 1: Create `background.js`**

```js
// On toolbar-button click, ask the content script in the active tab to toggle
// the floating delete panel. (browser.* is the Firefox WebExtension namespace.)
browser.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await browser.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  } catch (err) {
    // Content script not present (wrong page). Nudge the user to the right URL.
    console.warn('DeleteF: open https://www.facebook.com/messages first.', err);
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add background.js
git commit -m "feat: add background worker to toggle panel on toolbar click"
```

---

## Task 8: Content script — panel injection

**Files:**
- Create: `content.js`

- [ ] **Step 1: Create `content.js` with LABELS, state, and panel injection**

```js
// DeleteF content script. Injected into facebook.com/messages.
// Depends on globalThis.DeleteF from lib/dom-helpers.js (loaded first).
(function () {
  'use strict';

  const { jitter, matchByText, waitFor, resolveSelector } = globalThis.DeleteF;

  // ---- Centralized config: update these when Facebook changes wording/markup. ----
  // Defaults assume an ENGLISH Facebook UI.
  const LABELS = {
    moreMenu: ['more', 'menu', 'options'], // the "⋯" button on a conversation row
    deleteChat: ['delete chat', 'delete'], // menu item that opens the confirm dialog
    confirmDelete: ['delete'],             // confirm button inside the dialog
  };

  const state = { running: false, deletedCount: 0 };

  let logEl, countEl, startBtn, stopBtn;

  function log(msg) {
    if (!logEl) return;
    const line = document.createElement('div');
    line.textContent = msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    while (logEl.childNodes.length > 50) logEl.removeChild(logEl.firstChild);
  }

  function updateCount() {
    if (countEl) countEl.textContent = `Deleted: ${state.deletedCount}`;
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'deletef-panel';
    panel.innerHTML = `
      <div class="deletef-title">DeleteF
        <button class="deletef-close" title="Close">&times;</button>
      </div>
      <div class="deletef-buttons">
        <button class="deletef-action deletef-start">Start</button>
        <button class="deletef-action deletef-stop" disabled>Stop</button>
      </div>
      <div class="deletef-count">Deleted: 0</div>
      <div class="deletef-log"></div>`;
    document.body.appendChild(panel);

    countEl = panel.querySelector('.deletef-count');
    logEl = panel.querySelector('.deletef-log');
    startBtn = panel.querySelector('.deletef-start');
    stopBtn = panel.querySelector('.deletef-stop');

    panel.querySelector('.deletef-close').addEventListener('click', () => panel.remove());
    startBtn.addEventListener('click', onStart);
    stopBtn.addEventListener('click', onStop);
    log('Ready. Click Start to delete all conversations.');
    return panel;
  }

  function togglePanel() {
    const existing = document.getElementById('deletef-panel');
    if (existing) existing.remove();
    else buildPanel();
  }

  // onStart / onStop / the deletion loop are added in Task 9.
  function onStart() {}
  function onStop() {}

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'TOGGLE_PANEL') togglePanel();
  });
})();
```

- [ ] **Step 2: Manual smoke check (verify it loads without errors)**

Run: `node --check content.js`
Expected: no output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add content.js
git commit -m "feat: inject floating control panel into facebook.com/messages"
```

---

## Task 9: Content script — deletion loop

**Files:**
- Modify: `content.js`

- [ ] **Step 1: Replace the `onStart`, `onStop`, and add loop functions**

In `content.js`, replace the two stub lines:

```js
  function onStart() {}
  function onStop() {}
```

with:

```js
  function setRunning(running) {
    state.running = running;
    if (startBtn) startBtn.disabled = running;
    if (stopBtn) stopBtn.disabled = !running;
  }

  function onStop() {
    if (!state.running) return;
    setRunning(false);
    log('Stopping after current step…');
  }

  function onStart() {
    if (state.running) return;
    const ok = window.confirm(
      'This permanently deletes ALL conversations from your view on Facebook. ' +
      'This cannot be undone. Continue?'
    );
    if (!ok) {
      log('Cancelled.');
      return;
    }
    setRunning(true);
    log('Starting…');
    runLoop().catch((err) => {
      log('Error: ' + err.message);
      setRunning(false);
    });
  }

  // Find the conversation list container. ARIA/role first, CSS fallback last.
  function findChatList() {
    return resolveSelector(document, [
      (r) => r.querySelector('[aria-label="Chats"] [role="grid"]'),
      (r) => r.querySelector('[role="navigation"] [role="grid"]'),
      (r) => r.querySelector('[role="grid"]'),
      '[role="grid"]',
    ]);
  }

  // First conversation row inside the list.
  function findFirstRow() {
    const list = findChatList();
    if (!list) return null;
    return resolveSelector(list, [
      (r) => r.querySelector('[role="row"]'),
      (r) => r.querySelector('[role="gridcell"]'),
      (r) => r.querySelector('a[role="link"]'),
    ]);
  }

  function fireMouseEnter(el) {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  }

  // Delete a single conversation row; resolves true on success.
  async function deleteOne(row) {
    fireMouseEnter(row);
    await sleep(jitter(300, 600));

    // 1. Open the "⋯" menu on this row.
    const moreBtn = matchByText(row.querySelectorAll('[role="button"], [aria-label]'), LABELS.moreMenu);
    if (!moreBtn) throw new Error('Could not find the "More" (⋯) menu on a conversation.');
    moreBtn.click();

    // 2. Click "Delete chat" in the popup menu.
    const deleteItem = await waitFor(() => {
      const menus = document.querySelectorAll('[role="menu"], [role="menuitem"]');
      const items = document.querySelectorAll('[role="menuitem"]');
      return menus.length ? matchByText(items, LABELS.deleteChat) : null;
    }, { timeout: 6000, interval: 150 });
    deleteItem.click();

    // 3. Confirm in the dialog.
    const confirmBtn = await waitFor(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return null;
      return matchByText(dialog.querySelectorAll('[role="button"], button'), LABELS.confirmDelete);
    }, { timeout: 6000, interval: 150 });
    confirmBtn.click();

    // 4. Wait for the row to detach (deletion completed).
    await waitFor(() => !row.isConnected, { timeout: 8000, interval: 150 });
    return true;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function runLoop() {
    while (state.running) {
      const row = findFirstRow();
      if (!row) {
        log('No more conversations. Done.');
        setRunning(false);
        return;
      }
      try {
        await deleteOne(row);
        state.deletedCount += 1;
        updateCount();
        log(`Deleted #${state.deletedCount}.`);
      } catch (err) {
        log('Stopped: ' + err.message);
        setRunning(false);
        return;
      }
      await sleep(jitter(800, 1500));
    }
  }
```

- [ ] **Step 2: Syntax check**

Run: `node --check content.js`
Expected: no output (syntax OK).

- [ ] **Step 3: Run unit tests (ensure helpers still pass)**

Run: `npm test`
Expected: PASS (9 tests).

- [ ] **Step 4: Commit**

```bash
git add content.js
git commit -m "feat: implement conversation deletion loop with stop + guardrail"
```

---

## Task 10: Documentation

**Files:**
- Create: `README.md`
- Create: `DEPLOY.md`

- [ ] **Step 1: Create `README.md`**

```markdown
# DeleteF — Facebook Messages Bulk Deleter (Firefox)

Deletes **all conversation threads** from `facebook.com/messages` by automating
Facebook's own UI: for each conversation it opens the "⋯" menu, clicks **Delete chat**,
and confirms. Controlled by an on-page panel with **Start**/**Stop** and live progress.

## What "delete" means here
This performs Facebook's **Delete chat**, which removes the conversation **from your
view**. It is **permanent and cannot be undone**. It does not "unsend" messages for the
other person.

## How it works
- Manifest V3 Firefox extension, no build step, no network access, no data collection.
- `content.js` injects a floating panel and runs the deletion loop on `facebook.com/messages`.
- `background.js` toggles the panel when you click the toolbar button.
- `lib/dom-helpers.js` holds pure, unit-tested helpers (`jitter`, `matchByText`,
  `waitFor`, `resolveSelector`).
- Element matching prefers ARIA roles/labels and visible text over CSS class names, so it
  survives Facebook's frequent markup changes. All match strings live in the `LABELS`
  object at the top of `content.js`.

## Risks & limitations
- **Irreversible:** deleted conversations cannot be recovered.
- **Terms of Service:** automating Facebook may violate Meta's ToS and could risk account
  flagging. Use on your own account, at your own risk.
- **Fragile:** if Facebook changes its UI, update the `LABELS` strings in `content.js`.
- **English UI:** defaults assume English ("Delete chat" / "Delete").
- **Temporary install:** removed when Firefox restarts (see DEPLOY.md).

## Development
```bash
npm install
npm test
```

See [DEPLOY.md](DEPLOY.md) for install and usage.
```

- [ ] **Step 2: Create `DEPLOY.md`**

```markdown
# Deploying & Using DeleteF

## Install (temporary, unsigned)
1. Open Firefox and go to `about:debugging`.
2. Click **This Firefox** in the left sidebar.
3. Click **Load Temporary Add-on…**.
4. Select the `manifest.json` file in this project folder.
5. The DeleteF icon appears in the toolbar. (Temporary add-ons are removed when Firefox
   restarts — repeat these steps to reload.)

## Use
1. Go to `https://www.facebook.com/messages` and make sure you are logged in.
2. Click the **DeleteF** toolbar icon — a panel appears top-right.
3. Click **Start**, read the warning, and confirm.
4. Watch progress in the panel. Click **Stop** at any time to halt before the next delete.

> ⚠️ Deletion is permanent. Test on a throwaway/secondary account first if unsure.

## Troubleshooting
- **Panel doesn't appear:** Make sure the URL is under `facebook.com/messages`. Reload the
  page, then click the toolbar icon. Check the toolbar button isn't hidden in the overflow (»).
- **"Could not find the More (⋯) menu" / stops immediately:** Facebook likely changed its
  markup or your UI isn't in English. Open `content.js` and update the `LABELS` strings to
  match the menu/button wording you see, then reload the add-on in `about:debugging`.
- **Stops after a few deletes / nothing happens:** Facebook may be rate-limiting. Wait a few
  minutes and Start again. Increase the delays in `content.js` (`jitter(800, 1500)`).
- **Verify it loaded:** In `about:debugging` → This Firefox, find DeleteF and click
  **Inspect** to view the content script console for errors.
```

- [ ] **Step 3: Commit**

```bash
git add README.md DEPLOY.md
git commit -m "docs: add README and deployment/usage guide"
```

---

## Task 11: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS (9 tests), exit code 0.

- [ ] **Step 2: Syntax-check all scripts**

Run: `node --check background.js && node --check content.js && node --check lib/dom-helpers.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Validate manifest is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest OK')"`
Expected: `manifest OK`.

- [ ] **Step 4: Confirm required files exist**

Run: `ls manifest.json background.js content.js panel.css lib/dom-helpers.js icons/icon-48.png icons/icon-96.png README.md DEPLOY.md`
Expected: all listed, no "No such file".

- [ ] **Step 5: Manual end-to-end test (documented, not automated)**

Follow `DEPLOY.md` to load the add-on, open `facebook.com/messages` on a test account, and
confirm Start deletes a conversation and Stop halts the loop. Record the result.

- [ ] **Step 6: Final commit (if any tracked changes remain)**

```bash
git add -A
git commit -m "chore: final verification pass" --allow-empty
```

---

## Self-Review notes

- **Spec coverage:** R1 (Delete chat) → Task 9; R2/R3 (all + Start) → Task 9 `runLoop`/`onStart`; R4 (Stop) → Task 9 `onStop`/`setRunning`; R5 (progress) → Task 8 log/count; R6 (site match) → Task 1 manifest; R7 (temp install MV3) → Task 1 + DEPLOY.md; R8 (confirm guardrail) → Task 9 `onStart`; R9 (no data egress) → Task 1 permissions; R10 (docs) → Task 10. All covered.
- **Type/name consistency:** `state`, `LABELS`, `setRunning`, `runLoop`, `deleteOne`, `findFirstRow`, `findChatList`, `log`, `updateCount`, and helper names (`jitter`/`matchByText`/`waitFor`/`resolveSelector`) are consistent across Tasks 2–9.
- **No placeholders:** every code step includes complete code; the Task 8 `onStart`/`onStop` stubs are explicitly replaced in Task 9.
