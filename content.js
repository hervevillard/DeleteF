// DeleteF content script. Injected into facebook.com/messages.
// Depends on globalThis.DeleteF from lib/dom-helpers.js (loaded first).
//
// Two ways to delete a conversation thread:
//   • AI OFF (default, private, no network): runLoop() walks the list and uses
//     local heuristics (matchByText/findByText) to drive a 3-step delete.
//   • AI ON (agentic): runAgent() runs a DeepSeek tool-calling loop. The model
//     decides which conversations to delete (optionally filtered by the user's
//     free-text instruction), calls tools we execute against the DOM, observes
//     the results, and self-corrects. The extension is the model's hands/eyes;
//     the network call is proxied through background.js (Facebook CSP).
//
// Both paths share performDelete(row) — the single, real clicking path.
(function () {
  'use strict';

  const {
    jitter,
    matchByText,
    pickBestMatch,
    waitFor,
    resolveSelector,
    redactStructure,
    nameFromAriaLabel,
    toCsv,
    nearestActionable,
  } =
    globalThis.DeleteF;

  // ---- Centralized config: update these when Facebook changes wording/markup. ----
  // Defaults assume an ENGLISH Facebook UI.
  const LABELS = {
    moreMenu: ['more options', 'more', 'options'], // aria-label="More options for [Name]"
    deleteChat: ['delete chat'],                    // menu item
    confirmDelete: ['delete chat', 'delete'],       // confirm button inside the dialog
  };

  const MAX_ITERATIONS = 100; // agent loop / cost backstop

  const state = { running: false, deletedCount: 0, aiEnabled: false, finished: false, debug: false };
  const skippedRows = new WeakSet(); // rows with no "Delete chat" option (Marketplace, etc.)

  // Agent state: stable row identity + last-observed root for click_element.
  const agentRows = new Map(); // id (string) -> row element
  let agentRowSeq = 0;
  let lastObserveRoot = null;
  let lastObserveKind = 'none';

  let logEl, countEl, aiEl, startBtn, stopBtn, csvBtn, debugBtn, copyLogBtn, instrEl;
  let aiToggleEl, aiKeyEl, aiModelEl, aiFieldsEl, showKeyBtn;

  function log(msg) {
    if (!logEl) return;
    const line = document.createElement('div');
    line.textContent = msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    while (logEl.childNodes.length > 50) logEl.removeChild(logEl.firstChild);
  }

  function debugLog(msg) {
    if (!state.debug) return;
    log('[debug] ' + msg);
  }

  function describeElement(el) {
    if (!el) return '(null)';
    const tag = (el.tagName || '').toLowerCase() || '?';
    const role = el.getAttribute && el.getAttribute('role');
    const aria = el.getAttribute && el.getAttribute('aria-label');
    const id = el.id ? '#' + el.id : '';
    const cls = el.classList && el.classList[0] ? '.' + el.classList[0] : '';
    const text = ((el.textContent || '').trim() || '').slice(0, 42);
    return `${tag}${id}${cls}${role ? ` role=${role}` : ''}${aria ? ` aria="${aria}"` : ''}${text ? ` text="${text}"` : ''}`;
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
        <button class="deletef-action deletef-csv">Download CSV</button>
        <button class="deletef-action deletef-debug">Debug: Off</button>
        <button class="deletef-action deletef-copy-log">Copy Debug Log</button>
      </div>
      <textarea class="deletef-instr" rows="2"
        placeholder="Instructions (AI mode only). Empty = delete all. e.g. delete everyone except Mom"></textarea>
      <label class="deletef-ai-row">
        <input type="checkbox" class="deletef-ai-toggle" />
        <span>Use AI (DeepSeek) — sends contact names to DeepSeek</span>
      </label>
      <div class="deletef-ai-fields" hidden>
        <div class="deletef-key-row">
          <input type="password" class="deletef-ai-key" placeholder="DeepSeek API key (sk-…)" autocomplete="off" />
          <button type="button" class="deletef-ai-showkey" title="Show/hide key">👁</button>
        </div>
        <select class="deletef-ai-model">
          <option value="deepseek-chat">deepseek-chat (fast, cheap)</option>
          <option value="deepseek-reasoner">deepseek-reasoner (stronger)</option>
        </select>
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
    csvBtn = panel.querySelector('.deletef-csv');
    debugBtn = panel.querySelector('.deletef-debug');
    copyLogBtn = panel.querySelector('.deletef-copy-log');
    instrEl = panel.querySelector('.deletef-instr');
    aiToggleEl = panel.querySelector('.deletef-ai-toggle');
    aiKeyEl = panel.querySelector('.deletef-ai-key');
    aiModelEl = panel.querySelector('.deletef-ai-model');
    aiFieldsEl = panel.querySelector('.deletef-ai-fields');
    showKeyBtn = panel.querySelector('.deletef-ai-showkey');

    panel.querySelector('.deletef-close').addEventListener('click', () => panel.remove());
    startBtn.addEventListener('click', onStart);
    stopBtn.addEventListener('click', onStop);
    csvBtn.addEventListener('click', downloadCsv);
    debugBtn.addEventListener('click', onToggleDebug);
    copyLogBtn.addEventListener('click', onCopyDebugLog);
    aiToggleEl.addEventListener('change', saveAiConfig);
    aiKeyEl.addEventListener('change', saveAiConfig);
    aiModelEl.addEventListener('change', saveAiConfig);
    showKeyBtn.addEventListener('click', () => {
      aiKeyEl.type = aiKeyEl.type === 'password' ? 'text' : 'password';
    });

    refreshAiStatus();
    log('Ready. Click Start to delete conversations.');
    return panel;
  }

  function onToggleDebug() {
    state.debug = !state.debug;
    if (debugBtn) debugBtn.textContent = state.debug ? 'Debug: On' : 'Debug: Off';
    log(state.debug ? 'Debug logging enabled.' : 'Debug logging disabled.');
  }

  async function onCopyDebugLog() {
    if (!logEl) return;
    const lines = Array.from(logEl.childNodes)
      .map((n) => (n.textContent || '').trim())
      .filter(Boolean);
    const debugLines = lines.filter((line) => line.startsWith('[debug]'));
    const payload = (debugLines.length ? debugLines : lines).join('\n');
    if (!payload) {
      log('No log lines to copy yet.');
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(payload);
        log(`Copied ${debugLines.length || lines.length} log line(s) to clipboard.`);
        return;
      }
      throw new Error('Clipboard API unavailable.');
    } catch (err) {
      // Fallback for contexts where navigator.clipboard is unavailable.
      const ta = document.createElement('textarea');
      ta.value = payload;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) {
        log(`Copied ${debugLines.length || lines.length} log line(s) to clipboard.`);
      } else {
        log('Could not copy log to clipboard.');
      }
    }
  }

  function togglePanel() {
    const existing = document.getElementById('deletef-panel');
    if (existing) existing.remove();
    else buildPanel();
  }

  // Short status line under the controls, derived from current settings.
  function aiStatusText(enabled, hasKey) {
    if (!enabled) return 'AI: off (local heuristics, no network)';
    return hasKey ? 'AI: agentic (DeepSeek)' : 'AI: on — but no API key set';
  }

  // Read settings from storage into state + the panel controls. Called on panel
  // build and again at the start of each run so state.aiEnabled is authoritative.
  async function refreshAiStatus() {
    let cfg = { aiEnabled: false, deepseekApiKey: '', deepseekModel: 'deepseek-chat' };
    try {
      cfg = await browser.storage.local.get(cfg);
    } catch (err) {
      /* keep defaults */
    }
    state.aiEnabled = cfg.aiEnabled === true;
    if (aiToggleEl) aiToggleEl.checked = state.aiEnabled;
    // Don't clobber the key field if the user is mid-edit.
    if (aiKeyEl && document.activeElement !== aiKeyEl) aiKeyEl.value = cfg.deepseekApiKey || '';
    if (aiModelEl) aiModelEl.value = cfg.deepseekModel || 'deepseek-chat';
    if (aiFieldsEl) aiFieldsEl.hidden = !state.aiEnabled;
    if (aiEl) aiEl.textContent = aiStatusText(state.aiEnabled, !!cfg.deepseekApiKey);
  }

  // Persist the in-panel AI controls to storage.local (the same keys background.js
  // reads). Runs on every change so there's no separate Save button.
  async function saveAiConfig() {
    const payload = {
      aiEnabled: aiToggleEl ? aiToggleEl.checked : false,
      deepseekApiKey: aiKeyEl ? aiKeyEl.value.trim() : '',
      deepseekModel: aiModelEl ? aiModelEl.value : 'deepseek-chat',
    };
    try {
      await browser.storage.local.set(payload);
    } catch (err) {
      log('Could not save AI settings: ' + err.message);
      return;
    }
    state.aiEnabled = payload.aiEnabled;
    if (aiFieldsEl) aiFieldsEl.hidden = !payload.aiEnabled;
    if (aiEl) aiEl.textContent = aiStatusText(payload.aiEnabled, !!payload.deepseekApiKey);
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

  async function onStart() {
    if (state.running) return;
    await refreshAiStatus();

    const instruction = instrEl ? instrEl.value.trim() : '';
    const what = state.aiEnabled && instruction ? `conversations matching: "${instruction}"` : 'ALL conversations';
    const ok = window.confirm(
      `This permanently deletes ${what} from your view on Facebook. This cannot be undone. Continue?`
    );
    if (!ok) {
      log('Cancelled.');
      return;
    }

    state.deletedCount = 0;
    updateCount();
    setRunning(true);

    if (state.aiEnabled) {
      log('Starting agent…');
      runAgent(instruction).catch((err) => {
        log('Error: ' + err.message);
        setRunning(false);
      });
    } else {
      log('Starting…');
      runLoop().catch((err) => {
        log('Error: ' + err.message);
        setRunning(false);
      });
    }
  }

  // ---------------------------- CSV export ----------------------------

  // Download the names of currently-loaded conversations as CSV. Local-only:
  // no AI, no network, independent of the AI setting and run state.
  function downloadCsv() {
    const rows = findAllRows().map((r) => ({ name: rowName(r) }));
    if (!rows.length) {
      log('No conversations loaded to export.');
      return;
    }
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'deletef-conversations.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log(`Exported ${rows.length} name(s) to CSV.`);
  }

  // ---------------------------- Row helpers ----------------------------

  // Identify a conversation row by its "More options" (⋯) button.
  function rowFromMoreButton(btn) {
    return btn.closest('[role="gridcell"]') || btn.closest('[role="row"]') || btn.parentElement;
  }

  // Return all visible conversation rows (deduped).
  function findAllRows() {
    const rows = [];
    const seen = new Set();
    for (const btn of document.querySelectorAll('[aria-haspopup="menu"][aria-controls]')) {
      const row = rowFromMoreButton(btn);
      if (row && !seen.has(row)) {
        seen.add(row);
        rows.push(row);
      }
    }
    return rows;
  }

  // Best-effort display name for a row: the ⋯ button's aria-label
  // ("More options for [Name]") with the prefix stripped, else the row's link text.
  function rowName(row) {
    const btn = row.querySelector('[aria-haspopup="menu"][aria-controls]');
    const fromLabel = btn ? nameFromAriaLabel(btn.getAttribute('aria-label') || '') : '';
    if (fromLabel) return fromLabel;
    const link = row.querySelector('a[role="link"], a[href]');
    const t = link && (link.textContent || '').trim();
    return t || 'conversation';
  }

  function findChatList() {
    return resolveSelector(document, [
      (r) => r.querySelector('[aria-label="Chats"] [role="grid"]'),
      (r) => r.querySelector('[role="navigation"] [role="grid"]'),
      // Anchor on the "More options" button (aria-controls is structural) and walk
      // up to its grid/list — guarantees the conversation list, not the thread view.
      (r) => {
        const btn = r.querySelector('[aria-haspopup="menu"][aria-controls]');
        if (!btn) return null;
        return btn.closest('[role="grid"]') || btn.closest('[role="list"]') || btn.closest('[role="navigation"]');
      },
      (r) => r.querySelector('[role="grid"]'),
      '[role="grid"]',
    ]);
  }

  function findFirstRow() {
    const list = findChatList();
    const scope = list || document;
    for (const btn of scope.querySelectorAll('[aria-haspopup="menu"][aria-controls]')) {
      const row = rowFromMoreButton(btn);
      if (row && !skippedRows.has(row)) return row;
    }
    if (list) {
      const found = resolveSelector(list, [
        (r) => r.querySelector('[role="row"]'),
        (r) => r.querySelector('[role="gridcell"]'),
        (r) => r.querySelector('a[role="link"]'),
      ]);
      if (found && !skippedRows.has(found)) return found;
    }
    return null;
  }

  // Tag live elements with data-df indices using the SAME depth-first traversal
  // (and caps) as redactStructure, so a returned `[data-df="N"]` resolves against
  // the real DOM. Used by the agent's observe/click_element tools.
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

  // ---------------------------- Element finding (heuristics) ----------------------------

  // Find the deepest element in `root` whose trimmed, case-insensitive textContent
  // exactly equals one of `candidates`. Needed because Facebook menu items often
  // have no role attribute.
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

  // Click like a human: hover, a beat, press, a beat, release, click — with small
  // randomized gaps so React's pointer handlers fire in order and the control is
  // interactive by the time the real `click` lands. Async; callers should await.
  async function clickElement(el) {
    if (!el) return false;
    debugLog('click target -> ' + describeElement(el));
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (e) {
      /* ignore */
    }
    const opts = { bubbles: true, cancelable: true, view: window };
    const pointer = (type) => {
      try {
        el.dispatchEvent(new PointerEvent(type, opts));
      } catch (e) {
        // PointerEvent may be unavailable in older contexts; mouse events still fire.
      }
    };
    pointer('pointerover');
    pointer('pointerenter');
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    await sleep(jitter(60, 160));
    pointer('pointerdown');
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    await sleep(jitter(50, 130));
    pointer('pointerup');
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
    return true;
  }

  // Local, synchronous element finder: aria/role/text contains-match first, then
  // an exact-text deep match. No network, no AI.
  function findElement(scope, candidates) {
    const nodes = Array.from(
      scope.querySelectorAll('[role="button"], [role="menuitem"], [role="option"], button, a, [aria-label], [tabindex]')
    );
    const labels = nodes.map((n) => ((n.textContent || '').trim() || (n.getAttribute && n.getAttribute('aria-label')) || '').trim());
    const best = pickBestMatch(labels, candidates, { maxLen: 64 });
    if (best >= 0) {
      const picked = nearestActionable(nodes[best], scope);
      debugLog(`findElement(${candidates.join(' | ')}) via ranked match -> ${describeElement(picked)}`);
      return picked;
    }

    const hit = matchByText(nodes, candidates);
    if (hit) {
      const picked = nearestActionable(hit, scope);
      debugLog(`findElement(${candidates.join(' | ')}) via text/aria contains -> ${describeElement(picked)}`);
      return picked;
    }
    const picked = nearestActionable(findByText(scope, candidates), scope);
    debugLog(`findElement(${candidates.join(' | ')}) via exact fallback -> ${describeElement(picked)}`);
    return picked;
  }

  function normalizeText(s) {
    return String(s || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  // Fallback used mostly for confirm dialogs where actionable nodes sometimes
  // have weak role/aria semantics.
  function findElementByNormalizedText(scope, candidates) {
    const wants = (candidates || []).map(normalizeText).filter(Boolean);
    if (!wants.length) return null;

    const all = Array.from(scope.querySelectorAll('*'));
    const shortNodes = [];
    const labels = [];
    for (const el of all) {
      const text = normalizeText(el.textContent);
      if (!text || text.length > 64) continue;
      shortNodes.push(el);
      labels.push(text);
    }

    const best = pickBestMatch(labels, wants, { maxLen: 64 });
    if (best >= 0) {
      const picked = nearestActionable(shortNodes[best], scope);
      debugLog(`findElementByNormalizedText(${wants.join(' | ')}) -> ${describeElement(picked)}`);
      return picked;
    }
    return null;
  }

  function waitForDialog() {
    return waitFor(
      () => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).filter(isVisible);
        if (!dialogs.length) return null;
        return dialogs[dialogs.length - 1];
      },
      { timeout: 6000, interval: 150 }
    ).catch(() => null);
  }

  function rootText(root) {
    if (!root) return '';
    const aria = root.getAttribute ? (root.getAttribute('aria-label') || '') : '';
    return normalizeText((root.textContent || '') + ' ' + aria);
  }

  function isDeleteRecoveryRoot(root) {
    const t = rootText(root);
    if (!t) return false;
    return (
      t.includes('delete') ||
      t.includes('delete chat') ||
      t.includes('remove') ||
      t.includes('cancel') ||
      t.includes('confirm') ||
      t.includes('are you sure')
    );
  }

  function isDeleteRecoveryElement(el) {
    const t = rootText(el);
    if (!t) return false;
    return (
      t.includes('delete') ||
      t.includes('delete chat') ||
      t.includes('remove') ||
      t.includes('cancel') ||
      t.includes('confirm') ||
      t.includes('close') ||
      t.includes('more options')
    );
  }

  // After clicking the "⋯" button, wait for its menu. Polls for BOTH the
  // aria-controls target AND a role="menu"/"listbox" popup — Facebook's
  // aria-controls value often does not match the mounted menu's id.
  function waitForMenu(moreBtn) {
    const menuId = moreBtn && moreBtn.getAttribute('aria-controls');
    return waitFor(
      () => {
        const controlled = menuId && document.getElementById(menuId);
        if (isVisible(controlled)) {
          debugLog('waitForMenu -> using aria-controls target ' + describeElement(controlled));
          return controlled;
        }

        const cands = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"]')).filter(isVisible);
        if (!cands.length) return null;

        if (moreBtn && typeof moreBtn.getBoundingClientRect === 'function') {
          const b = moreBtn.getBoundingClientRect();
          let best = null;
          let bestDist = Infinity;
          for (const c of cands) {
            const r = c.getBoundingClientRect();
            const dx = (r.left + r.width / 2) - (b.left + b.width / 2);
            const dy = (r.top + r.height / 2) - (b.top + b.height / 2);
            const d = Math.hypot(dx, dy);
            if (d < bestDist) {
              bestDist = d;
              best = c;
            }
          }
          if (best) return best;
        }

        if (cands[0]) debugLog('waitForMenu -> using nearest visible menu ' + describeElement(cands[0]));
        return cands[0] || null;
      },
      { timeout: 4000, interval: 100 }
    ).catch(() => null);
  }

  // Collect the visible text of items in an open menu — used to explain a
  // failed delete back to the agent (menuItemsSeen).
  function menuItemsText(root) {
    const out = [];
    const seen = new Set();
    for (const el of root.querySelectorAll('[role="menuitem"], [role="button"], a, span, div')) {
      const t = (el.textContent || '').trim();
      if (t && t.length < 60 && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    return out.slice(0, 25);
  }

  // ---------------------------- Deletion ----------------------------

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function fireMouseEnter(el) {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  }

  function dispatchEscape() {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true })
    );
  }

  // Typed error so callers can distinguish "not deletable" (skip) from real failures.
  class DeleteError extends Error {
    constructor(code, message, menuItemsSeen) {
      super(message);
      this.code = code;
      this.menuItemsSeen = menuItemsSeen;
    }
  }

  // The single, shared deletion path: hover row → open ⋯ menu → click "Delete
  // chat" → confirm → wait for the row to detach. Throws DeleteError on failure.
  async function performDelete(row) {
    fireMouseEnter(row);
    await sleep(jitter(200, 400));
    debugLog('performDelete row -> ' + describeElement(row));

    // 1. Open the "⋯" menu (structural selector first, text heuristic as backup).
    const moreBtn =
      row.querySelector('[aria-haspopup="menu"][aria-controls]') || findElement(row, LABELS.moreMenu);
    if (!moreBtn) throw new DeleteError('no_more_button', 'Could not find the "More" (⋯) menu on this row.');
    debugLog('performDelete moreBtn -> ' + describeElement(moreBtn));
    await clickElement(nearestActionable(moreBtn, row));

    // 2. Click "Delete chat" in the opened menu (let it settle so items render).
    const menuRoot = await waitForMenu(moreBtn);
    if (!menuRoot) throw new DeleteError('no_menu', 'The "More options" menu did not appear.');
    await sleep(jitter(250, 500));
    const deleteHit = findElement(menuRoot, LABELS.deleteChat);
    if (!deleteHit) {
      throw new DeleteError('no_delete_option', 'No "Delete chat" item in this row\'s menu.', menuItemsText(menuRoot));
    }
    debugLog('performDelete deleteHit -> ' + describeElement(deleteHit));
    await clickElement(nearestActionable(deleteHit, menuRoot));

    // 3. Confirm in the dialog. Pause first: the dialog animates in and its button
    //    is not interactive on the same frame it mounts — clicking too early no-ops.
    const dialog = await waitForDialog();
    if (!dialog) throw new DeleteError('no_dialog', 'The confirm dialog did not appear.');
    await sleep(jitter(400, 800));
    let confirmBtn = findElement(dialog, LABELS.confirmDelete);
    if (!confirmBtn) {
      debugLog('confirm lookup fallback: dialog text="' + normalizeText(dialog.textContent).slice(0, 120) + '"');
      confirmBtn = findElementByNormalizedText(dialog, LABELS.confirmDelete);
    }
    if (!confirmBtn) throw new DeleteError('no_confirm', 'Could not find the confirm "Delete" button.');
    debugLog('performDelete confirmBtn -> ' + describeElement(confirmBtn));
    await clickElement(nearestActionable(confirmBtn, dialog));

    // 4. Wait for the row to detach. If it doesn't, the first confirm click likely
    //    landed before the button was wired — re-find the dialog and click once more.
    try {
      await waitFor(() => !row.isConnected, { timeout: 5000, interval: 150 });
    } catch (e) {
      const retryDialog = await waitForDialog();
      let retryBtn = retryDialog && findElement(retryDialog, LABELS.confirmDelete);
      if (!retryBtn && retryDialog) retryBtn = findElementByNormalizedText(retryDialog, LABELS.confirmDelete);
      if (retryBtn) {
        debugLog('performDelete retry confirm -> ' + describeElement(retryBtn));
        await sleep(jitter(300, 600));
        await clickElement(nearestActionable(retryBtn, retryDialog));
      }
      await waitFor(() => !row.isConnected, { timeout: 6000, interval: 150 });
    }
    return true;
  }

  // ---------------------------- Heuristic loop (AI off) ----------------------------

  async function runLoop() {
    const initialCount = findAllRows().length;
    log(`Found ${initialCount} conversation(s). Starting…`);

    while (state.running) {
      const row = findFirstRow();
      if (!row) {
        log('No more conversations. Done.');
        setRunning(false);
        return;
      }
      const name = rowName(row);
      log(`Processing: ${name}`);
      try {
        await performDelete(row);
        state.deletedCount += 1;
        updateCount();
        log(`Deleted #${state.deletedCount}.`);
      } catch (err) {
        if (err.code === 'no_delete_option' || err.code === 'no_menu') {
          // Not a conversation (Marketplace icon, channel, etc.) — close menu and skip.
          skippedRows.add(row);
          dispatchEscape();
          await sleep(400);
          log('Skipped (' + err.message + ').');
        } else {
          log('Stopped: ' + err.message);
          setRunning(false);
          return;
        }
      }
      // Human-scale pause between conversations.
      await sleep(jitter(1500, 3500));
    }
  }

  // ---------------------------- Agentic loop (AI on) ----------------------------

  const AGENT_SYSTEM_PROMPT = [
    'You are an autonomous agent that deletes Facebook Messenger conversations inside a browser extension.',
    'The user has ALREADY confirmed the deletion — do NOT ask for confirmation.',
    'You cannot see or click the page directly. You act ONLY through these tools:',
    '- list_conversations: list currently loaded rows (id + name).',
    '- delete_conversation(id): delete the row with that id.',
    '- scroll_conversation_list: load more rows (the list is virtualized; not all rows load at once).',
    '- observe / click_element(df): inspect raw structure (with text) and click a data-df element to recover from an unexpected dialog or a delete that failed.',
    '- finish(summary): call when the task is complete.',
    '',
    'Process:',
    '1. Call list_conversations.',
    "2. Decide which to delete from the user's instruction. If it is empty or says 'all', delete every conversation.",
    '3. Delete them one at a time with delete_conversation.',
    '4. If delete_conversation returns status "no_delete_option", that row is not a deletable conversation (Marketplace, a channel, etc.) — skip it, do not retry it.',
    '5. If it returns status "error", try observe + click_element to recover, otherwise skip and continue.',
    '6. Re-list after deleting several rows or after scrolling. Call scroll_conversation_list to load more. When no deletable conversations remain and scrolling loads nothing new, call finish.',
    '',
    'Be efficient. Never delete the same id twice. Keep going without pausing for the user.',
  ].join('\n');

  const AGENT_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'list_conversations',
        description: 'List currently loaded conversation rows, each with a stable id and the contact/chat name.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_conversation',
        description: 'Delete the conversation row with the given id (opens its ⋯ menu, clicks Delete chat, confirms).',
        parameters: {
          type: 'object',
          properties: { id: { type: 'integer', description: 'The id from list_conversations.' } },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'scroll_conversation_list',
        description: 'Scroll the conversation list to load more rows. The list is virtualized.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'observe',
        description:
          'Return the structure (including visible text) of the currently open menu or dialog, or the conversation list if none is open. Each element has a data-df index usable with click_element.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'click_element',
        description: 'Click the element with the given data-df index from the most recent observe call.',
        parameters: {
          type: 'object',
          properties: { df: { type: 'integer', description: 'The data-df index from observe.' } },
          required: ['df'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'finish',
        description: 'End the run with a short summary of what was done.',
        parameters: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
      },
    },
  ];

  // ---- Tool implementations ----

  function toolListConversations() {
    const out = [];
    for (const row of findAllRows()) {
      let id = row.getAttribute('data-df-id');
      if (!id) {
        id = String(agentRowSeq++);
        row.setAttribute('data-df-id', id);
      }
      agentRows.set(id, row);
      out.push({ id: Number(id), name: rowName(row) });
    }
    return { conversations: out };
  }

  async function toolDeleteConversation(args) {
    const id = String(args && args.id);
    let row = agentRows.get(id);
    if (!row || !row.isConnected) row = document.querySelector(`[data-df-id="${id}"]`);
    if (!row || !row.isConnected) {
      return { status: 'error', detail: 'No live conversation with that id (it may already be deleted). Call list_conversations again.' };
    }
    const name = rowName(row);
    try {
      await performDelete(row);
      agentRows.delete(id);
      state.deletedCount += 1;
      updateCount();
      log(`Deleted #${state.deletedCount}: ${name}`);
      return { status: 'deleted', name };
    } catch (err) {
      dispatchEscape();
      await sleep(300);
      if (err.code === 'no_delete_option') {
        log(`Skipped (no delete option): ${name}`);
        return { status: 'no_delete_option', detail: err.message, menuItemsSeen: err.menuItemsSeen };
      }
      return { status: 'error', detail: err.message, menuItemsSeen: err.menuItemsSeen };
    }
  }

  async function toolScroll() {
    const list = findChatList();
    const before = findAllRows().length;
    const scroller = list || document.scrollingElement || document.body;
    try {
      scroller.scrollTop = scroller.scrollHeight;
    } catch (e) {
      /* ignore */
    }
    await sleep(jitter(700, 1200));
    const after = findAllRows().length;
    return { loadedCount: after, gained: after - before };
  }

  function toolObserve() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).filter(isVisible);
    const menus = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"]')).filter(isVisible);
    let root = null;
    let kind = 'none';

    const deleteDialog = dialogs.find(isDeleteRecoveryRoot);
    const deleteMenu = menus.find(isDeleteRecoveryRoot);
    if (deleteDialog) {
      root = deleteDialog;
      kind = 'overlay';
    } else if (deleteMenu) {
      root = deleteMenu;
      kind = 'overlay';
    } else {
      root = findChatList();
      kind = root ? 'chatlist' : 'none';
    }

    if (!root) {
      lastObserveRoot = null;
      lastObserveKind = 'none';
      return {
        status: 'no_context',
        detail: 'No dialog/menu/chat list available. Use list_conversations or delete_conversation.',
      };
    }

    lastObserveRoot = root;
    lastObserveKind = kind;
    tagElements(root);
    return { kind, structure: redactStructure(root, { includeText: true }) };
  }

  async function toolClickElement(args) {
    const df = String(args && args.df);
    const root = lastObserveRoot;
    if (!root) return { ok: false, detail: 'No observe context. Call observe first.' };
    if (lastObserveKind !== 'overlay') {
      return {
        ok: false,
        detail: 'click_element is restricted to delete-recovery dialogs/menus. Use delete_conversation for normal actions.',
      };
    }
    const el = root.querySelector(`[data-df="${df}"]`);
    if (!el) return { ok: false, detail: 'No element with that data-df. Call observe first.' };
    if (!isDeleteRecoveryElement(el)) {
      return {
        ok: false,
        detail: 'Blocked click: target is not delete-recovery related.',
      };
    }
    debugLog('tool click_element df=' + df + ' -> ' + describeElement(el));
    await clickElement(nearestActionable(el, root));
    return { ok: true };
  }

  function parseToolArgs(raw) {
    if (!raw) return { ok: true, args: {} };
    try {
      return { ok: true, args: JSON.parse(raw) };
    } catch (e) {
      return { ok: false, args: {}, error: 'Malformed tool arguments JSON.' };
    }
  }

  function validateToolArgs(name, args) {
    if (name === 'delete_conversation') {
      if (!args || (typeof args.id !== 'number' && typeof args.id !== 'string')) {
        return { ok: false, detail: 'delete_conversation requires numeric id from list_conversations.' };
      }
    }
    if (name === 'click_element') {
      if (!args || (typeof args.df !== 'number' && typeof args.df !== 'string')) {
        return { ok: false, detail: 'click_element requires numeric df from observe.' };
      }
    }
    return { ok: true };
  }

  async function executeTool(name, args) {
    debugLog('executeTool ' + name + ' args=' + JSON.stringify(args || {}));
    try {
      switch (name) {
        case 'list_conversations':
          return toolListConversations();
        case 'delete_conversation':
          return await toolDeleteConversation(args);
        case 'scroll_conversation_list':
          return await toolScroll();
        case 'observe':
          return toolObserve();
        case 'click_element':
          return toolClickElement(args);
        case 'finish':
          state.finished = true;
          return { done: true };
        default:
          return { error: 'Unknown tool: ' + name };
      }
    } catch (err) {
      return { status: 'error', detail: err.message };
    }
  }

  async function runAgent(instruction) {
    agentRows.clear();
    agentRowSeq = 0;
    lastObserveRoot = null;
    lastObserveKind = 'none';
    state.finished = false;

    const task =
      instruction && instruction.trim()
        ? `User instruction: "${instruction.trim()}". Use list_conversations to read names and decide which to delete.`
        : 'Delete ALL conversations in the list.';

    const messages = [
      { role: 'system', content: AGENT_SYSTEM_PROMPT },
      { role: 'user', content: task },
    ];

    let noToolStreak = 0;
    for (let i = 0; i < MAX_ITERATIONS && state.running && !state.finished; i++) {
      let resp;
      try {
        resp = await browser.runtime.sendMessage({ type: 'AGENT_TURN', payload: { messages, tools: AGENT_TOOLS } });
      } catch (err) {
        log('AI error: ' + err.message);
        break;
      }
      if (!resp || resp.error) {
        log('AI stopped: ' + ((resp && resp.error) || 'no response'));
        break;
      }

      const assistant = resp.message;
      messages.push(assistant);

      if (assistant.tool_calls && assistant.tool_calls.length) {
        noToolStreak = 0;
        for (const tc of assistant.tool_calls) {
          const parsed = parseToolArgs(tc.function.arguments);
          if (!parsed.ok) {
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ status: 'bad_arguments', detail: parsed.error }) });
            continue;
          }
          const args = parsed.args;
          const validation = validateToolArgs(tc.function.name, args);
          if (!validation.ok) {
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ status: 'bad_arguments', detail: validation.detail }) });
            continue;
          }
          if (tc.function.name === 'finish') log('AI: ' + (args.summary || 'done'));
          const result = await executeTool(tc.function.name, args);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
          if (!state.running) break;
        }
      } else {
        if (assistant.content) log('AI: ' + assistant.content);
        noToolStreak += 1;
        if (noToolStreak >= 3) {
          log('AI stopped: model returned no tool calls repeatedly.');
          break;
        }
        messages.push({
          role: 'user',
          content:
            'Continue using tools only. Do not stop yet. Start with list_conversations, then delete_conversation / scroll_conversation_list as needed, and call finish only when truly done.',
        });
      }
    }

    log(`Agent finished. Deleted ${state.deletedCount}.`);
    setRunning(false);
  }

  // ---------------------------- Messaging ----------------------------

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'TOGGLE_PANEL') togglePanel();
  });
})();
