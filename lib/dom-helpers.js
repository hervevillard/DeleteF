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

  const api = { jitter, matchByText };

  root.DeleteF = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
