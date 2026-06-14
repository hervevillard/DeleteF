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
