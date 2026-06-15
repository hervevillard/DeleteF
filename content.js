// DeleteF content script. Injected into facebook.com/messages.
// Depends on globalThis.DeleteF from lib/dom-helpers.js (loaded first).
//
// Flow per conversation: open the "⋯" menu -> click "Delete chat" -> confirm "Delete".
// Element-finding tries resilient heuristics first; if those fail AND the user has
// enabled the DeepSeek AI fallback in settings, it asks the AI (via background.js)
// which element to click, then caches a stable selector for the rest of the session.
(function () {
  'use strict';

  const { jitter, matchByText, waitFor, resolveSelector, redactStructure, parseSelectorResponse } =
    globalThis.DeleteF;

  // ---- Centralized config: update these when Facebook changes wording/markup. ----
  // Defaults assume an ENGLISH Facebook UI.
  const LABELS = {
    moreMenu: ['more options', 'more', 'options'], // aria-label="More options for [Name]"
    deleteChat: ['delete chat'],                    // menu item and confirm dialog button
    confirmDelete: ['delete chat', 'delete'],       // confirm button inside the dialog
  };

  const state = { running: false, deletedCount: 0, aiEnabled: false };
  const aiCache = {}; // target -> stable CSS selector discovered by the AI this session

  let logEl, countEl, aiEl, startBtn, stopBtn;

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

  // ---------------------------- Panel ----------------------------

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
      <div class="deletef-ai"></div>
      <div class="deletef-log"></div>`;
    document.body.appendChild(panel);

    countEl = panel.querySelector('.deletef-count');
    aiEl = panel.querySelector('.deletef-ai');
    logEl = panel.querySelector('.deletef-log');
    startBtn = panel.querySelector('.deletef-start');
    stopBtn = panel.querySelector('.deletef-stop');

    panel.querySelector('.deletef-close').addEventListener('click', () => panel.remove());
    startBtn.addEventListener('click', onStart);
    stopBtn.addEventListener('click', onStop);

    refreshAiStatus();
    log('Ready. Click Start to delete all conversations.');
    return panel;
  }

  function togglePanel() {
    const existing = document.getElementById('deletef-panel');
    if (existing) existing.remove();
    else buildPanel();
  }

  async function refreshAiStatus() {
    try {
      const cfg = await browser.storage.local.get({ aiEnabled: false });
      state.aiEnabled = cfg.aiEnabled === true;
    } catch (err) {
      state.aiEnabled = false;
    }
    if (aiEl) aiEl.textContent = state.aiEnabled ? 'AI fallback: ON (DeepSeek)' : 'AI fallback: off';
  }

  // ---------------------------- Run control ----------------------------

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
    refreshAiStatus();
    setRunning(true);
    log('Starting…');
    runLoop().catch((err) => {
      log('Error: ' + err.message);
      setRunning(false);
    });
  }

  // ---------------------------- Element finding ----------------------------

  function findChatList() {
    return resolveSelector(document, [
      (r) => r.querySelector('[aria-label="Chats"] [role="grid"]'),
      (r) => r.querySelector('[role="navigation"] [role="grid"]'),
      (r) => r.querySelector('[role="grid"]'),
      '[role="grid"]',
      // Fallback: derive the list container from the first visible conversation row.
      (r) => {
        const cell = r.querySelector('[role="gridcell"]');
        return cell ? cell.parentElement : null;
      },
    ]);
  }

  function findFirstRow() {
    const list = findChatList();
    if (list) {
      const found = resolveSelector(list, [
        (r) => r.querySelector('[role="row"]'),
        (r) => r.querySelector('[role="gridcell"]'),
        (r) => r.querySelector('a[role="link"]'),
      ]);
      if (found) return found;
    }
    // Direct fallback: find any conversation row by its "More options" button.
    const btn = document.querySelector('[aria-haspopup="menu"][aria-label]');
    if (!btn) return null;
    return btn.closest('[role="gridcell"]') || btn.closest('[role="row"]') || btn.parentElement;
  }

  // Tag live elements with data-df indices using the SAME depth-first traversal
  // (and caps) as redactStructure, so an AI-returned `[data-df="N"]` selector
  // resolves against the real DOM.
  function tagElements(root, { maxNodes = 200, maxDepth = 12 } = {}) {
    let count = 0;
    let index = 0;
    (function walk(node, depth) {
      if (!node || node.nodeType !== 1 || count >= maxNodes) return;
      count += 1;
      node.setAttribute('data-df', String(index++));
      if (depth < maxDepth) {
        for (const child of Array.from(node.children || [])) {
          if (count >= maxNodes) break;
          walk(child, depth + 1);
        }
      }
    })(root, 0);
  }

  // Build a reusable, more-stable selector from an element's own attributes,
  // so we can cache it and skip future AI calls for the same target.
  function deriveStableSelector(el) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return `[aria-label="${aria.replace(/"/g, '\\"')}"]`;
    const role = el.getAttribute && el.getAttribute('role');
    const cls = el.classList && el.classList[0];
    if (role && cls) return `[role="${role}"].${CSS.escape(cls)}`;
    if (role) return `[role="${role}"]`;
    if (cls) return `.${CSS.escape(cls)}`;
    return null;
  }

  // AI fallback: ask DeepSeek (via background) which element in `container` is `target`.
  // Returns the live element or null. Caches a stable selector on success.
  async function findWithAi(container, target) {
    if (!state.aiEnabled) return null;

    // Try a cached selector first (no network call).
    if (aiCache[target]) {
      const cached = safeQuery(container, aiCache[target]);
      if (cached) return cached;
    }

    log('AI: locating ' + target + '…');
    tagElements(container);
    const structure = redactStructure(container);
    let response;
    try {
      response = await browser.runtime.sendMessage({
        type: 'ASK_AI',
        payload: { target, structure },
      });
    } catch (err) {
      log('AI error: ' + err.message);
      return null;
    }
    if (!response || response.error) {
      log('AI unavailable: ' + ((response && response.error) || 'no response'));
      return null;
    }
    const selector = parseSelectorResponse(response.content);
    if (!selector) {
      log('AI returned no usable selector.');
      return null;
    }
    const node = safeQuery(container, selector);
    if (node) {
      const stable = deriveStableSelector(node);
      if (stable) aiCache[target] = stable;
      log('AI located ' + target + '.');
    } else {
      log('AI selector did not match.');
    }
    return node;
  }

  function safeQuery(root, selector) {
    try {
      return root.querySelector(selector);
    } catch (err) {
      return null;
    }
  }

  // Find the deepest element in `root` whose trimmed, case-insensitive textContent
  // exactly equals one of `candidates`. Returns null if none found.
  // Used when Facebook omits role attributes on menu items.
  function findByText(root, candidates) {
    const wants = candidates.map((c) => c.toLowerCase());
    const all = root.querySelectorAll('*');
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i];
      const text = (el.textContent || '').trim().toLowerCase();
      if (text && wants.some((w) => text === w)) return el;
    }
    return null;
  }

  // After clicking the "⋯" button, wait for its controlled menu to appear.
  // Uses aria-controls first (exact match), then falls back to role="menu".
  function waitForMenu(moreBtn) {
    const menuId = moreBtn && moreBtn.getAttribute('aria-controls');
    if (menuId) {
      return waitFor(() => document.getElementById(menuId), { timeout: 4000, interval: 100 })
        .catch(() => null);
    }
    return waitFor(
      () => document.querySelector('[role="menu"]') || document.querySelector('[role="listbox"]'),
      { timeout: 4000, interval: 100 }
    ).catch(() => null);
  }

  // Find an element by heuristic text match, falling back to the AI if enabled.
  async function findElement({ scope, candidates, aiTarget }) {
    const hit = matchByText(scope.querySelectorAll('[role="button"], [role="menuitem"], button, [aria-label]'), candidates);
    if (hit) return hit;
    // Facebook sometimes omits role attributes on menu items — fall back to exact text match.
    const byText = findByText(scope, candidates);
    if (byText) return byText;
    return findWithAi(scope, aiTarget);
  }

  // ---------------------------- Deletion ----------------------------

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function fireMouseEnter(el) {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  }

  async function deleteOne(row) {
    fireMouseEnter(row);
    await sleep(jitter(300, 600));

    // 1. Open the "⋯" menu on this row.
    const moreBtn = await findElement({
      scope: row,
      candidates: LABELS.moreMenu,
      aiTarget: 'the More / options (⋯) menu button for this conversation row',
    });
    if (!moreBtn) throw new Error('Could not find the "More" (⋯) menu on a conversation.');
    moreBtn.click();

    // 2. Click "Delete chat" in the popup menu.
    // Use aria-controls to find the specific menu this button opened — avoids passing
    // the entire document body to the AI fallback when role="menu" is absent.
    const menuRoot = await waitForMenu(moreBtn);
    if (!menuRoot) throw new Error('The "More options" menu did not appear.');
    const deleteHit = await findElement({
      scope: menuRoot,
      candidates: LABELS.deleteChat,
      aiTarget: 'the "Delete chat" menu item',
    });
    if (!deleteHit) throw new Error('Could not find the "Delete chat" menu item.');
    deleteHit.click();

    // 3. Confirm in the dialog.
    const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), {
      timeout: 6000,
      interval: 150,
    });
    const confirmBtn = await findElement({
      scope: dialog,
      candidates: LABELS.confirmDelete,
      aiTarget: 'the confirm "Delete" button inside the dialog',
    });
    if (!confirmBtn) throw new Error('Could not find the confirm "Delete" button.');
    confirmBtn.click();

    // 4. Wait for the row to detach (deletion completed).
    await waitFor(() => !row.isConnected, { timeout: 8000, interval: 150 });
    return true;
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

  // ---------------------------- Messaging ----------------------------

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'TOGGLE_PANEL') togglePanel();
  });
})();
