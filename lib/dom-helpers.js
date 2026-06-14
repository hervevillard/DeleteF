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

  // Serialize an element's STRUCTURE for safe egress to an AI: keeps tag names,
  // role, aria-label, type, and the first class token; assigns each element a
  // stable `data-df="N"` index (depth-first order) so the AI can return a precise
  // `[data-df="N"]` selector. Visible text and message content are NOT included.
  // Bounded by `maxNodes` and `maxDepth` to keep payloads small.
  function redactStructure(element, { maxNodes = 200, maxDepth = 12 } = {}) {
    const KEEP_ATTRS = ['role', 'aria-label', 'aria-haspopup', 'type'];
    let count = 0;
    let index = 0;

    function serialize(node, depth) {
      if (!node || node.nodeType !== 1) return ''; // elements only
      if (count >= maxNodes) return '';
      count += 1;
      const myIndex = index++;
      const tag = node.tagName.toLowerCase();

      let attrs = ` data-df="${myIndex}"`;
      for (const name of KEEP_ATTRS) {
        const val = node.getAttribute && node.getAttribute(name);
        if (val) attrs += ` ${name}="${String(val).replace(/"/g, '&quot;')}"`;
      }
      const firstClass = node.classList && node.classList[0];
      if (firstClass) attrs += ` class="${firstClass}"`;

      let children = '';
      if (depth < maxDepth) {
        for (const child of Array.from(node.children || [])) {
          if (count >= maxNodes) break;
          children += serialize(child, depth + 1);
        }
      }
      return `<${tag}${attrs}>${children}</${tag}>`;
    }

    return serialize(element, 0);
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
    waitFor,
    resolveSelector,
    redactStructure,
    parseSelectorResponse,
  };

  root.DeleteF = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
