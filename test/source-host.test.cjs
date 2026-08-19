const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const sourceCode = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'background', 'source-host.js'),
  'utf8'
);

const WAPP_MANIFEST = 'https://api.github.com/repos/enthec/webappanalyzer/contents/src/technologies';
const EHOLE_MANIFEST = 'https://raw.githubusercontent.com/EdgeSecurityTeam/EHole/main/finger.json';

function bodyResponse(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let delivered = false;
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          return { done: false, value: bytes };
        },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
}

function createHarness({ failWappFile = false } = {}) {
  const storage = {};
  const events = [];
  const appliedRuleSets = [];
  let activeFetches = 0;
  let maxFetches = 0;
  let abortedFetches = 0;

  const wappFiles = Array.from({ length: 8 }, (_, index) => {
    const name = `${String.fromCharCode(97 + index)}.json`;
    return {
      type: 'file',
      name,
      download_url: `https://raw.githubusercontent.com/enthec/webappanalyzer/main/src/technologies/${name}`,
    };
  });

  function fetchMock(rawURL, options = {}) {
    const url = String(rawURL);
    events.push(url);
    activeFetches++;
    maxFetches = Math.max(maxFetches, activeFetches);

    return new Promise((resolve, reject) => {
      let settled = false;
      const signal = options.signal;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        activeFetches--;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        callback(value);
      };
      const onAbort = () => {
        abortedFetches++;
        finish(reject, signal.reason || new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      let delay = 2;
      let value;
      let error;
      if (url === WAPP_MANIFEST) value = wappFiles;
      else if (url === EHOLE_MANIFEST) value = [{ cms: 'EHole test', location: 'body', keyword: ['ehole'] }];
      else {
        const file = url.split('/').pop();
        value = { [`Technology ${file}`]: { html: `marker-${file}` } };
        const fileIndex = file.charCodeAt(0) - 97;
        delay = failWappFile && file !== 'a.json' ? 1_000 : (8 - fileIndex) * 3;
        if (failWappFile && file === 'a.json') error = new Error('synthetic Wappalyzer file failure');
      }
      const timer = setTimeout(() => {
        if (error) finish(reject, error);
        else finish(resolve, bodyResponse(value));
      }, delay);
      if (signal?.aborted) onAbort();
    });
  }

  const chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === 'string') return { [keys]: storage[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storage[key]]));
          return { ...storage };
        },
        set: async (values) => Object.assign(storage, values),
      },
    },
    alarms: {
      get: async () => null,
      create: async () => {},
      clear: async () => {},
      onAlarm: { addListener: () => {} },
    },
  };

  const context = {
    AbortController,
    DOMException,
    TextDecoder,
    TextEncoder,
    URL,
    chrome,
    console,
    crypto: webcrypto,
    fetch: fetchMock,
    indexedDB: { open: () => { throw new Error('unexpected backup access'); } },
    jsyaml: { loadAll: () => { throw new Error('unexpected YAML conversion'); } },
    setTimeout,
    clearTimeout,
    GoPainterUtils: { mergeConvertedRules: (rules) => rules },
    GoPainterRulesHost: {
      handlers: {
        convertWappalyzer: async ({ techJSON }) => ({
          rules: Object.keys(JSON.parse(techJSON)).map((name) => ({ id: `wapp-${name}`, name })),
        }),
        convertEHole: async () => ({ rules: [{ id: 'ehole-test', name: 'EHole test' }] }),
        normalizeRules: async () => ({ rules: [] }),
      },
      replaceSourceRuleSet: async ({ rules }) => {
        appliedRuleSets.push(rules.map((rule) => rule.id));
        return {
          previousCount: 0,
          ruleCount: rules.length,
          summary: { added: rules.length, updated: 0, removed: 0 },
        };
      },
    },
  };

  vm.runInNewContext(sourceCode, context, { filename: 'source-host.js' });
  return {
    handlers: context.GoPainterSourceHost.handlers,
    stats: () => ({
      activeFetches, maxFetches, abortedFetches,
      events: [...events], appliedRuleSets: appliedRuleSets.map((rules) => [...rules]),
    }),
  };
}

test('different third-party sources share one four-request download limit', async () => {
  const harness = createHarness();
  const [wapp, ehole] = await Promise.all([
    harness.handlers.refreshRuleSource({ sourceId: 'wappalyzer' }),
    harness.handlers.refreshRuleSource({ sourceId: 'ehole' }),
  ]);

  const stats = harness.stats();
  const eholeStart = stats.events.indexOf(EHOLE_MANIFEST);
  const lastWappFile = Math.max(...stats.events
    .map((url, index) => (url.includes('/src/technologies/') && url !== WAPP_MANIFEST ? index : -1)));
  assert.equal(wapp.ok, true);
  assert.equal(ehole.ok, true);
  assert.ok(stats.maxFetches <= 4, `observed ${stats.maxFetches} concurrent downloads`);
  assert.ok(eholeStart > lastWappFile, 'the second source started before the first source finished downloading');
  assert.deepEqual(stats.appliedRuleSets[0], Array.from(
    { length: 8 },
    (_, index) => `wapp-Technology ${String.fromCharCode(97 + index)}.json`
  ));
  assert.equal(stats.activeFetches, 0);
});

test('one failed source file aborts the remaining downloads in that update', async () => {
  const harness = createHarness({ failWappFile: true });
  const update = harness.handlers.refreshRuleSource({ sourceId: 'wappalyzer' });
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('source update cancellation timed out')), 500);
  });

  try {
    await assert.rejects(Promise.race([update, timeout]), /synthetic Wappalyzer file failure/);
  } finally {
    clearTimeout(timeoutId);
  }
  const stats = harness.stats();
  assert.ok(stats.abortedFetches >= 1, 'no sibling download observed the update abort');
  assert.equal(stats.activeFetches, 0);
  assert.ok(stats.maxFetches <= 4, `observed ${stats.maxFetches} concurrent downloads`);
});
