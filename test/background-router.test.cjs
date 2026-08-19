const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');

function loadRouter(pageHandlers, extraHosts = []) {
  let listener;
  const emptyHost = { handlers: {} };
  const context = {
    importScripts: () => {},
    chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
    GoPainterPageHost: { handlers: pageHandlers },
    GoPainterRulesHost: extraHosts[0] || emptyHost,
    GoPainterAIHost: extraHosts[1] || emptyHost,
    GoPainterHistoryHost: extraHosts[2] || emptyHost,
    GoPainterBookmarksHost: extraHosts[3] || emptyHost,
    GoPainterCrawlHost: extraHosts[4] || emptyHost,
    GoPainterBatchHost: extraHosts[5] || emptyHost,
    GoPainterSourceHost: extraHosts[6] || emptyHost,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'background.js' });
  return listener;
}

function responseFrom(listener, message, sender = {}) {
  return new Promise((resolve) => {
    const async = listener(message, sender, resolve);
    assert.equal(async, true);
  });
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('background router dispatches Host handlers and normalizes asynchronous errors', async () => {
  const listener = loadRouter({
    echo: async (msg, sender) => ({ ok: true, value: msg.value, tabId: sender.tab.id }),
    fail: async () => { throw new Error('broken host'); },
  });
  assert.deepEqual(
    await responseFrom(listener, { type: 'echo', value: 7 }, { tab: { id: 3 } }),
    { ok: true, value: 7, tabId: 3 }
  );
  assert.deepEqual(plain(await responseFrom(listener, { type: 'fail' })), { ok: false, error: 'broken host' });

  let unknown;
  assert.equal(listener({ type: 'missing' }, {}, (value) => { unknown = value; }), false);
  assert.deepEqual(plain(unknown), { ok: false, error: 'unknown message type' });
});

test('background router fails startup when two Hosts claim the same message type', () => {
  assert.throws(
    () => loadRouter({ duplicate: () => null }, [{ handlers: { duplicate: () => null } }]),
    /duplicate background message handler: duplicate/
  );
});
