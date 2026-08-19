const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'batch.js'), 'utf8');

function harness() {
  const session = {};
  let active = 0;
  let maxActive = 0;
  let history = 0;
  const context = {
    AbortController,
    TextEncoder,
    URL,
    console,
    setTimeout,
    clearTimeout,
    chrome: {
      storage: {
        session: {
          get: async (key) => ({ [key]: session[key] }),
          set: async (values) => Object.assign(session, JSON.parse(JSON.stringify(values))),
          remove: async (key) => { delete session[key]; },
        },
      },
    },
    GoPainterUtils: {
      confidenceValue: (hit) => hit.confidence ?? null,
    },
    GoPainterPageFetch: {
      fetchFeatures: async (url, { signal }) => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 3);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
          });
          return { url, title: url, status: 200, faviconHashes: [] };
        } finally {
          active--;
        }
      },
    },
    ensureWasm: async () => {},
    runMatch: async () => ({ hits: [{ id: 'demo', name: 'Demo', version: '1.2.3', confidence: 90 }] }),
    appendHashHit: async (_features, result) => result,
    GoPainterHistoryHost: { record: async () => { history++; } },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'batch.js' });
  return { handlers: context.GoPainterBatchHost.handlers, limits: context.GoPainterBatchHost.limits, session, stats: () => ({ maxActive, history }) };
}

async function waitDone(handlers) {
  for (let i = 0; i < 200; i++) {
    const state = await handlers.batchStatus({});
    if (!state.running) return state;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('batch scan timeout');
}

test('batch scan deduplicates targets, preserves versions, and never exceeds four workers', async () => {
  const h = harness();
  const urls = Array.from({ length: 20 }, (_, index) => `https://example.test/${index}`);
  const started = await h.handlers.batchStart({
    urls: [...urls, urls[0], `${urls[0]}#fragment`, 'javascript:alert(1)', 'bad'],
  });
  assert.equal(started.total, 20);
  assert.equal(started.duplicate, 2);
  assert.equal(started.invalid, 2);
  const activeState = await h.handlers.batchStatus({});
  assert.equal(activeState.completed + activeState.runningCount + activeState.pending, activeState.total);
  const state = await waitDone(h.handlers);
  assert.equal(state.completed, 20);
  assert.equal(state.results.length, 20);
  assert.equal(state.failed.length, 0);
  assert.equal(state.results[0].hits[0].version, '1.2.3');
  assert.ok(h.stats().maxActive <= 4, `observed ${h.stats().maxActive} concurrent fetches`);
  assert.equal(h.stats().history, 20);
  assert.ok(new TextEncoder().encode(JSON.stringify(h.session['batch:state'])).byteLength <= h.limits.storageBytes);
});

test('batch scan rejects more than 500 accepted targets', async () => {
  const h = harness();
  const urls = Array.from({ length: 501 }, (_, index) => `https://example.test/${index}`);
  await assert.rejects(h.handlers.batchStart({ urls }), /最多 500 个 URL/);
});

test('batch scan reserves the runner before its initial state write completes', async () => {
  const h = harness();
  const first = h.handlers.batchStart({ urls: ['https://example.test/first'] });
  await assert.rejects(
    h.handlers.batchStart({ urls: ['https://example.test/second'] }),
    /已有批量扫描任务在跑/
  );
  await first;
  await waitDone(h.handlers);
});

test('stopping a batch aborts queued work and permits a clean next run', async () => {
  const h = harness();
  await h.handlers.batchStart({
    urls: Array.from({ length: 20 }, (_, index) => `https://example.test/stop-${index}`),
  });
  await h.handlers.batchStop({});
  const stopped = await waitDone(h.handlers);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.runningCount, 0);
  assert.ok(stopped.completed < stopped.total);

  await h.handlers.batchStart({ urls: ['https://example.test/restarted'] });
  const restarted = await waitDone(h.handlers);
  assert.equal(restarted.stopped, false);
  assert.equal(restarted.completed, 1);
  assert.equal(restarted.results.length, 1);
});
