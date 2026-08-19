const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const browserStateCode = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'background', 'browser-state.js'),
  'utf8'
);

test('main-frame capture preserves repeated response headers as matchable lines', () => {
  const beforeRequestListeners = [];
  const headerListeners = [];
  const completedListeners = [];
  const context = vm.createContext({
    chrome: {
      tabs: {
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
      },
      webRequest: {
        onBeforeRequest: { addListener: (listener) => beforeRequestListeners.push(listener) },
        onHeadersReceived: { addListener: (listener) => headerListeners.push(listener) },
        onCompleted: { addListener: (listener) => completedListeners.push(listener) },
      },
    },
    console,
    TextEncoder,
  });
  vm.runInContext(browserStateCode, context, { filename: 'browser-state.js' });

  headerListeners[0]({
    tabId: 7,
    type: 'main_frame',
    requestId: 'main-1',
    statusCode: 200,
    responseHeaders: [
      { name: 'Set-Cookie', value: 'target=COOKIE_MARKER; Path=/' },
      { name: 'Set-Cookie', value: 'unrelated=1; Path=/' },
      { name: 'Server', value: 'fixture' },
    ],
  });

  const snapshot = JSON.parse(vm.runInContext('JSON.stringify(responseCache.get(7))', context));
  assert.deepEqual(snapshot, {
    status: 200,
    headers: {
      'set-cookie': 'target=COOKIE_MARKER; Path=/\nset-cookie: unrelated=1; Path=/',
      server: 'fixture',
    },
  });
  assert.equal(beforeRequestListeners.length, 1);
  assert.equal(completedListeners.length, 2);
});

test('session feature compaction preserves matcher input types and heals old snapshots', () => {
  const context = vm.createContext({
    chrome: {
      tabs: {
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
      },
      webRequest: {
        onBeforeRequest: { addListener: () => {} },
        onHeadersReceived: { addListener: () => {} },
        onCompleted: { addListener: () => {} },
      },
    },
    console,
    TextEncoder,
  });
  vm.runInContext(browserStateCode, context, { filename: 'browser-state.js' });

  const snapshot = JSON.parse(vm.runInContext(`JSON.stringify(compactSessionFeatures({
    faviconHashes: [-1725010651, '1861433915', 'bad', 2147483648],
    domHits: { first: true, second: false, legacy: 'true', invalid: 'yes' }
  }))`, context));
  assert.deepEqual(snapshot.faviconHashes, [-1725010651, 1861433915]);
  assert.deepEqual(snapshot.domHits, { first: true, second: false, legacy: true });
  assert.equal(typeof snapshot.faviconHashes[0], 'number');
  assert.equal(typeof snapshot.domHits.first, 'boolean');
});

test('a late response from an older main-frame request cannot replace current navigation state', () => {
  const beforeRequestListeners = [];
  const headerListeners = [];
  const context = vm.createContext({
    chrome: {
      tabs: {
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
      },
      webRequest: {
        onBeforeRequest: { addListener: (listener) => beforeRequestListeners.push(listener) },
        onHeadersReceived: { addListener: (listener) => headerListeners.push(listener) },
        onCompleted: { addListener: () => {} },
      },
      action: {
        setIcon: async () => {},
        setBadgeText: async () => {},
        setBadgeBackgroundColor: async () => {},
      },
    },
    console,
    TextEncoder,
  });
  vm.runInContext(browserStateCode, context, { filename: 'browser-state.js' });

  beforeRequestListeners[0]({ tabId: 9, type: 'main_frame', requestId: 'old' });
  beforeRequestListeners[0]({ tabId: 9, type: 'main_frame', requestId: 'new' });
  headerListeners[0]({
    tabId: 9,
    type: 'main_frame',
    requestId: 'new',
    statusCode: 200,
    responseHeaders: [{ name: 'Server', value: 'current' }],
  });
  headerListeners[0]({
    tabId: 9,
    type: 'main_frame',
    requestId: 'old',
    statusCode: 503,
    responseHeaders: [{ name: 'Server', value: 'stale' }],
  });

  const snapshot = JSON.parse(vm.runInContext('JSON.stringify(responseCache.get(9))', context));
  assert.deepEqual(snapshot, { status: 200, headers: { server: 'current' } });
  assert.equal(vm.runInContext('currentNavigationVersion(9)', context), 2);
});
