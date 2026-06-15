const { test } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const {
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
} = require('../lib/dom-helpers.js');

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

test('pickBestMatch prefers an exact button label over a longer container', () => {
  // A confirm dialog: the body text contains "delete", but the real button is exactly "Delete".
  const texts = ['Are you sure you want to delete this chat?', 'Cancel', 'Delete'];
  assert.equal(pickBestMatch(texts, ['delete chat', 'delete']), 2);
});

test('pickBestMatch matches "Delete chat" exactly when present', () => {
  const texts = ['Cancel', 'Delete chat'];
  assert.equal(pickBestMatch(texts, ['delete chat', 'delete']), 1);
});

test('pickBestMatch falls back to a bounded contains match', () => {
  const texts = ['Mark as read', 'Delete chat now'];
  // No exact match; "Delete chat now" contains "delete chat" and is short enough.
  assert.equal(pickBestMatch(texts, ['delete chat']), 1);
});

test('pickBestMatch rejects an over-long contains match (a container, not a button)', () => {
  const texts = ['Are you sure you want to delete this conversation permanently? This cannot be undone.'];
  assert.equal(pickBestMatch(texts, ['delete']), -1);
});

test('pickBestMatch is case-insensitive and trims', () => {
  assert.equal(pickBestMatch(['  DELETE  '], ['delete']), 0);
});

test('pickBestMatch returns -1 when nothing matches', () => {
  assert.equal(pickBestMatch(['Cancel', 'Archive'], ['delete']), -1);
});

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

test('resolveSelector tries strategies in order, returns first match', () => {
  const dom = new JSDOM(`<div id="root">
    <span class="x_legacy">legacy</span>
    <a role="row">first row</a>
  </div>`);
  const root = dom.window.document.getElementById('root');
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

test('redactStructure keeps tags/roles/aria but strips visible text', () => {
  const dom = new JSDOM(`<div role="menu" aria-label="Options">
    <div role="menuitem">Delete chat for Jane Doe</div>
  </div>`);
  const out = redactStructure(dom.window.document.querySelector('[role="menu"]'));
  assert.match(out, /role="menu"/);
  assert.match(out, /aria-label="Options"/);
  assert.match(out, /role="menuitem"/);
  // The private text content must NOT leak.
  assert.ok(!out.includes('Jane Doe'), 'must not include contact name');
  assert.ok(!out.includes('Delete chat for'), 'must not include message text');
});

test('redactStructure adds a stable data-df index to each element', () => {
  const dom = new JSDOM(`<div><button></button><button></button></div>`);
  const out = redactStructure(dom.window.document.querySelector('div'));
  assert.match(out, /data-df="0"/);
  assert.match(out, /data-df="1"/);
});

test('redactStructure respects maxNodes cap', () => {
  let html = '<div>';
  for (let i = 0; i < 50; i++) html += '<button></button>';
  html += '</div>';
  const dom = new JSDOM(html);
  const out = redactStructure(dom.window.document.querySelector('div'), { maxNodes: 5 });
  const count = (out.match(/<button/g) || []).length;
  assert.ok(count <= 5, `expected <=5 buttons, got ${count}`);
});

test('parseSelectorResponse extracts selector from clean JSON', () => {
  assert.equal(parseSelectorResponse('{"selector": "[data-df=\\"3\\"]"}'), '[data-df="3"]');
});

test('parseSelectorResponse extracts JSON embedded in prose / code fences', () => {
  const reply = 'Sure!\n```json\n{"selector": ".abc button"}\n```';
  assert.equal(parseSelectorResponse(reply), '.abc button');
});

test('parseSelectorResponse returns null on garbage or missing selector', () => {
  assert.equal(parseSelectorResponse('no json here'), null);
  assert.equal(parseSelectorResponse('{"foo": "bar"}'), null);
  assert.equal(parseSelectorResponse(''), null);
});

test('redactStructure includeText emits an element\'s own direct text', () => {
  const dom = new JSDOM(`<div role="menu">
    <div role="menuitem">Delete chat</div>
    <div role="menuitem">Archive</div>
  </div>`);
  const out = redactStructure(dom.window.document.querySelector('[role="menu"]'), { includeText: true });
  assert.match(out, /Delete chat/);
  assert.match(out, /Archive/);
});

test('redactStructure includeText does not duplicate descendant text on the parent', () => {
  const dom = new JSDOM(`<div><span>Leaf</span></div>`);
  const out = redactStructure(dom.window.document.querySelector('div'), { includeText: true });
  // "Leaf" is the span's OWN text; the wrapping div has no direct text of its own,
  // so it must appear exactly once.
  assert.equal((out.match(/Leaf/g) || []).length, 1);
});

test('redactStructure includeText escapes HTML-special characters in text', () => {
  const dom = new JSDOM(`<div>a & b < c > d "e"</div>`);
  const out = redactStructure(dom.window.document.querySelector('div'), { includeText: true });
  assert.match(out, /a &amp; b &lt; c &gt; d &quot;e&quot;/);
});

test('redactStructure stays text-free by default (privacy preserved)', () => {
  const dom = new JSDOM(`<div role="menuitem">Jane Doe</div>`);
  const out = redactStructure(dom.window.document.querySelector('[role="menuitem"]'));
  assert.ok(!out.includes('Jane Doe'));
});

test('nameFromAriaLabel strips the "More options for" prefix (case-insensitive)', () => {
  assert.equal(nameFromAriaLabel('More options for Jane Doe'), 'Jane Doe');
  assert.equal(nameFromAriaLabel('more options for  Bob '), 'Bob');
  assert.equal(nameFromAriaLabel('MORE OPTIONS FOR Work Group'), 'Work Group');
});

test('nameFromAriaLabel handles missing / non-string / no-prefix input', () => {
  assert.equal(nameFromAriaLabel(''), '');
  assert.equal(nameFromAriaLabel(null), '');
  assert.equal(nameFromAriaLabel(undefined), '');
  assert.equal(nameFromAriaLabel('Plain Label'), 'Plain Label');
});

test('toCsv emits a header and one row per name', () => {
  assert.equal(toCsv([{ name: 'Alice' }, { name: 'Bob' }]), 'Name\r\nAlice\r\nBob');
});

test('toCsv quotes fields containing comma, quote, or newline', () => {
  assert.equal(toCsv([{ name: 'Doe, Jane' }]), 'Name\r\n"Doe, Jane"');
  assert.equal(toCsv([{ name: 'a "quoted" name' }]), 'Name\r\n"a ""quoted"" name"');
  assert.equal(toCsv([{ name: 'line1\nline2' }]), 'Name\r\n"line1\nline2"');
});

test('toCsv handles empty / missing input', () => {
  assert.equal(toCsv([]), 'Name');
  assert.equal(toCsv(undefined), 'Name');
  assert.equal(toCsv([{}]), 'Name\r\n');
});

test('nearestActionable promotes a nested text holder to menuitem parent', () => {
  const dom = new JSDOM(`<div role="menu"><div role="menuitem"><span>Delete chat</span></div></div>`);
  const menu = dom.window.document.querySelector('[role="menu"]');
  const span = dom.window.document.querySelector('span');
  const out = nearestActionable(span, menu);
  assert.equal(out.getAttribute('role'), 'menuitem');
});

test('nearestActionable promotes nested span to button ancestor', () => {
  const dom = new JSDOM(`<div role="dialog"><button><span>Delete</span></button></div>`);
  const dialog = dom.window.document.querySelector('[role="dialog"]');
  const span = dom.window.document.querySelector('span');
  const out = nearestActionable(span, dialog);
  assert.equal(out.tagName.toLowerCase(), 'button');
});
