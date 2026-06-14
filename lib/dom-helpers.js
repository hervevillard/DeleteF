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
