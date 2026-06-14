const { test } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const { jitter, matchByText } = require('../lib/dom-helpers.js');

test('jitter returns an integer within [min, max]', () => {
  for (let i = 0; i < 200; i++) {
    const v = jitter(800, 1500);
    assert.ok(Number.isInteger(v), `expected integer, got ${v}`);
    assert.ok(v >= 800 && v <= 1500, `expected 800..1500, got ${v}`);
  }
});

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
