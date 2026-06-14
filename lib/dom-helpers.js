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

  const api = { jitter, matchByText, waitFor, resolveSelector };

  root.DeleteF = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
