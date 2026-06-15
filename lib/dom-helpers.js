// DeleteF pure DOM helpers. Side-effect-free and unit-testable.
// Dual export: attaches to the browser content-script global (globalThis.DeleteF)
// and to module.exports when running under Node (tests).
(function (root) {
  'use strict';

  // Random integer delay in [min, max], used to space out clicks like a human.
  function jitter(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  // Return the first node whose visible text OR aria-label contains any candidate
  // string (case-insensitive). `nodes` is an array or NodeList. Returns null if none.
  function matchByText(nodes, candidates) {
    const wants = candidates.map((c) => c.toLowerCase());
    for (const node of Array.from(nodes)) {
      const text = (node.textContent || '').trim().toLowerCase();
      const aria = ((node.getAttribute && node.getAttribute('aria-label')) || '')
        .trim()
        .toLowerCase();
      const haystack = text || aria;
      if (haystack && wants.some((w) => haystack.includes(w))) {
        return node;
      }
    }
    return null;
  }

  // Rank a list of candidate-element label strings against the wanted labels and
  // return the index of the BEST match, or -1. Preference order:
  //   1. exact (trimmed, case-insensitive) equality — e.g. a "Delete" button;
  //   2. startsWith a wanted label, bounded by `maxLen`;
  //   3. contains a wanted label, bounded by `maxLen`.
  // The `maxLen` bound is what stops a contains-match from selecting a whole
  // dialog/container ("Are you sure you want to delete this chat?") instead of
  // the actual short button. Earlier wanted labels win ties, then earlier texts.
  function pickBestMatch(texts, candidates, { maxLen = 40 } = {}) {
    const list = Array.from(texts).map((t) => (t == null ? '' : String(t)).trim().toLowerCase());
    const wants = candidates.map((c) => String(c).toLowerCase());
    const tiers = [
      (t, w) => t === w,
      (t, w) => t.length <= maxLen && t.startsWith(w),
      (t, w) => t.length <= maxLen && t.includes(w),
    ];
    for (const test of tiers) {
      for (const w of wants) {
        for (let i = 0; i < list.length; i++) {
          if (list[i] && test(list[i], w)) return i;
        }
      }
    }
    return -1;
  }

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

  // Serialize an element's STRUCTURE for egress to an AI: keeps tag names,
  // role, aria-label, type, and the first class token; assigns each element a
  // stable `data-df="N"` index (depth-first order) so the AI can return a precise
  // `[data-df="N"]` selector. Bounded by `maxNodes` and `maxDepth` to keep
  // payloads small.
  //
  // By default visible text is stripped (privacy-preserving — used by the local
  // heuristic path). Pass `{ includeText: true }` to also emit each element's OWN
  // direct text (not descendants'), which the agentic `observe` tool needs so the
  // model can read menu/dialog labels and decide what to click. The HTML-escaped
  // text is placed right after the opening tag.
  function redactStructure(element, { maxNodes = 200, maxDepth = 12, includeText = false } = {}) {
    const KEEP_ATTRS = ['role', 'aria-label', 'aria-haspopup', 'type'];
    let count = 0;
    let index = 0;

    const esc = (s) =>
      String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function ownText(node) {
      let t = '';
      for (const child of Array.from(node.childNodes || [])) {
        if (child.nodeType === 3) t += child.textContent || '';
      }
      return t.trim();
    }

    function serialize(node, depth) {
      if (!node || node.nodeType !== 1) return ''; // elements only
      if (count >= maxNodes) return '';
      count += 1;
      const myIndex = index++;
      const tag = node.tagName.toLowerCase();

      let attrs = ` data-df="${myIndex}"`;
      for (const name of KEEP_ATTRS) {
        const val = node.getAttribute && node.getAttribute(name);
        if (val) attrs += ` ${name}="${esc(val)}"`;
      }
      const firstClass = node.classList && node.classList[0];
      if (firstClass) attrs += ` class="${firstClass}"`;

      let text = '';
      if (includeText) {
        const own = ownText(node);
        if (own) text = esc(own);
      }

      let children = '';
      if (depth < maxDepth) {
        for (const child of Array.from(node.children || [])) {
          if (count >= maxNodes) break;
          children += serialize(child, depth + 1);
        }
      }
      return `<${tag}${attrs}>${text}${children}</${tag}>`;
    }

    return serialize(element, 0);
  }

  // Strip a leading "More options for " from a Facebook ⋯-button aria-label,
  // returning the bare conversation/contact name (or "" if unusable). The label
  // looks like "More options for Jane Doe"; the prefix is user-locale English UI.
  function nameFromAriaLabel(label) {
    if (!label || typeof label !== 'string') return '';
    return label.replace(/^more options for\s*/i, '').trim();
  }

  // Build an RFC-4180 CSV string from rows of { name }. Always emits a "Name"
  // header. Fields containing a quote, comma, CR, or LF are wrapped in double
  // quotes with embedded quotes doubled. Lines are joined with CRLF.
  function toCsv(rows) {
    const escapeField = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['Name'];
    for (const row of Array.isArray(rows) ? rows : []) {
      lines.push(escapeField(row && row.name));
    }
    return lines.join('\r\n');
  }

  // Move from a text/content node to the nearest actionable ancestor so clicks
  // target the control that owns the handler.
  function nearestActionable(node, root) {
    if (!node || node.nodeType !== 1) return null;
    const scope = root && root.nodeType === 1 ? root : null;
    const stopAt = scope || node.ownerDocument.documentElement;
    let cur = node;
    while (cur && cur.nodeType === 1) {
      if (
        cur.matches(
          '[role="button"], [role="menuitem"], [role="option"], button, a[href], [tabindex], [aria-haspopup="menu"]'
        )
      ) {
        return cur;
      }
      if (cur === stopAt) break;
      cur = cur.parentElement;
    }
    return node;
  }

  // Parse a DeepSeek/LLM reply into a CSS selector string, or null. Tolerates
  // raw JSON, JSON inside ```code fences```, or JSON embedded in prose.
  function parseSelectorResponse(text) {
    if (!text || typeof text !== 'string') return null;
    const candidates = [];
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) candidates.push(fenced[1]);
    const braces = text.match(/\{[\s\S]*\}/);
    if (braces) candidates.push(braces[0]);
    candidates.push(text);
    for (const c of candidates) {
      try {
        const obj = JSON.parse(c.trim());
        if (obj && typeof obj.selector === 'string' && obj.selector.trim()) {
          return obj.selector.trim();
        }
      } catch (err) {
        // try next candidate
      }
    }
    return null;
  }

  const api = {
    jitter,
    matchByText,
    pickBestMatch,
    waitFor,
    resolveSelector,
    redactStructure,
    parseSelectorResponse,
    nameFromAriaLabel,
    toCsv,
    nearestActionable,
  };

  root.DeleteF = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
