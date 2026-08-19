const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'page-fetch.js'), 'utf8');

test('off-tab page fetch streams only the bounded body prefix', async () => {
  const payload = new TextEncoder().encode('x'.repeat(250_000));
  let delivered = false;
  let cancelled = 0;
  let options;
  const context = {
    AbortController,
    TextDecoder,
    console,
    setTimeout,
    clearTimeout,
    fetch: async (_url, input) => {
      options = input;
      return {
        url: 'https://example.test/final',
        status: 200,
        headers: { forEach: (callback) => callback('fixture', 'server') },
        body: { getReader: () => ({
          read: async () => delivered ? { done: true } : (delivered = true, { done: false, value: payload }),
          cancel: async () => { cancelled++; },
          releaseLock: () => {},
        }) },
      };
    },
    enrichFeatures: async (features) => ({ ...features, favicons: [] }),
    hashIcons: async () => [],
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'page-fetch.js' });
  const features = await context.GoPainterPageFetch.fetchFeatures('https://example.test/start');
  assert.equal(features.body.length, 200_000);
  assert.equal(features.url, 'https://example.test/final');
  assert.equal(features.headers.server, 'fixture');
  assert.equal(cancelled, 1);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store');
});

test('off-tab page fetch forwards caller cancellation to the network request', async () => {
  let fetchSignal;
  const context = {
    AbortController,
    TextDecoder,
    console,
    setTimeout,
    clearTimeout,
    fetch: async (_url, options) => {
      fetchSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
    enrichFeatures: async (features) => features,
    hashIcons: async () => [],
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'page-fetch.js' });
  const caller = new AbortController();
  const pending = context.GoPainterPageFetch.fetchFeatures('https://example.test/slow', { signal: caller.signal });
  caller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(fetchSignal.aborted, true);
});
