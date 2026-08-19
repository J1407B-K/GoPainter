// Chromium resource-load benchmark for the unpacked extension.
// Usage: node scripts/bench-chromium.mjs
// Optional: CHROME_PATH=/path/to/chrome node scripts/bench-chromium.mjs
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const extensionPath = join(root, 'extension');
const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const chromePath = chromeCandidates.find(existsSync);
const scenarios = [
  { name: '30 tabs', tabs: 30 },
  { name: '50 tabs', tabs: 50 },
  { name: '30 tabs + SPA + close', tabs: 30, spaTabs: 10, closeTabs: 10 },
];

const delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolvePromise, reject) => {
      this.socket.addEventListener('open', resolvePromise, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message} (${pending.method})`));
        else pending.resolve(message.result);
        return;
      }
      this.events.push(message);
    });
    return this;
  }

  call(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { method, resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    for (const pending of this.pending.values()) pending.reject(new Error('CDP closed'));
    this.pending.clear();
    this.socket?.close();
  }
}

async function listenFixture() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    if (url.pathname === '/icon') {
      // Long enough for the sampler to observe real in-flight extension fetches.
      const body = Buffer.alloc(1024, Number(url.searchParams.get('icon')) || 1);
      response.writeHead(200, {
        'content-type': 'image/x-icon',
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      response.write(body.subarray(0, 512));
      setTimeout(() => response.end(body.subarray(512)), 180);
      return;
    }
    if (url.pathname === '/assets/e2e-signal.js') {
      response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
      response.end("window.GoPainterE2E = { version: '1.0.0' };");
      return;
    }
    if (url.pathname === '/e2e') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(`<!doctype html><html><head><title>E2E_TITLE_MARKER</title>
        <meta name="generator" content="E2E_META_MARKER">
        <link rel="icon" href="/icon?e2e=1&icon=42">
        <script src="/assets/e2e-signal.js"></script></head>
        <body><main id="e2e-dom" data-e2e="ready">E2E_BODY_MARKER E2E_DOM_MARKER</main></body></html>`);
      return;
    }
    if (url.pathname !== '/page') {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    const tab = url.searchParams.get('tab') || 'unknown';
    const route = url.searchParams.get('route') || 'initial';
    const icons = Array.from({ length: 10 }, (_, index) =>
      `<link rel="icon" href="/icon?tab=${encodeURIComponent(tab)}&route=${encodeURIComponent(route)}&icon=${index}">`).join('\n');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><html><head><title>GoPainter bench ${tab} ${route}</title>${icons}</head>
      <body data-tab="${tab}" data-route="${route}">benchmark-${tab}-${route}</body></html>`);
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  // The explicit localhost/private-address guard must stay active during this
  // test. Chrome maps this fixture-only hostname to the local server at launch.
  return { server, baseURL: `http://bench.gopainter.test:${port}` };
}

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

async function waitForEndpoint(port, deadline, diagnostics = () => '') {
  while (Date.now() < deadline) {
    try { return await json(`http://127.0.0.1:${port}/json/version`); } catch { await delay(50); }
  }
  const detail = diagnostics();
  throw new Error(`Chrome remote-debugging endpoint did not start${detail ? `; Chrome log: ${detail}` : ''}`);
}

async function loadExtension(browser) {
  try {
    return (await browser.call('Extensions.loadUnpacked', { path: extensionPath })).id;
  } catch (error) {
    throw new Error(`CDP could not load GoPainter from ${extensionPath}: ${error.message}`);
  }
}

async function workerSession(browser, extensionId, chromeLog) {
  await browser.call('Target.setDiscoverTargets', { discover: true });
  const deadline = Date.now() + 15_000;
  let lastTargets = [];
  while (Date.now() < deadline) {
    const { targetInfos } = await browser.call('Target.getTargets');
    lastTargets = targetInfos;
    // Chromium has reported MV3 workers as both service_worker and worker
    // targets across releases. The extension URL is the stable identifier.
    const worker = targetInfos.find((target) => target.url.startsWith(`chrome-extension://${extensionId}/`)
      && target.url.includes('/background.js'));
    if (worker) {
      const attached = await browser.call('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
      await browser.call('Runtime.enable', {}, attached.sessionId);
      await browser.call('Log.enable', {}, attached.sessionId);
      return attached.sessionId;
    }
    await delay(50);
  }
  const summary = lastTargets.map((target) => ({ type: target.type, url: target.url, title: target.title }));
  throw new Error(`GoPainter (${extensionId}) service worker did not start; discovered targets: ${JSON.stringify(summary)}; Chrome log: ${chromeLog()}`);
}

async function evaluate(browser, sessionId, expression) {
  const result = await browser.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
  return result.result.value;
}

const statsExpression = `Promise.all([
  Promise.resolve(GoPainterPageHost.queueStats()),
  Promise.resolve({ active: activeIconFetches, pending: iconFetchQueue.length }),
  chrome.storage.session.getBytesInUse(null),
]).then(([scan, favicon, sessionBytes]) => ({ scan, favicon, sessionBytes }))`;

const resultsExpression = `(async () => {
  const tabs = (await chrome.tabs.query({})).filter((tab) => tab.url?.startsWith('__BASE_URL__/page'));
  const all = await chrome.storage.session.get(null);
  const live = tabs.map((tab) => {
    const stored = all[\`result:\${tab.id}\`];
    return { tabId: tab.id, url: tab.url, storedURL: stored?.features?.url || '', hasResult: Boolean(stored) };
  });
  const fixtureKeys = Object.keys(all).filter((key) => /^(?:result|popup|agent):\\d+$/.test(key));
  const liveIds = new Set(tabs.map((tab) => String(tab.id)));
  const orphanKeys = fixtureKeys.filter((key) => !liveIds.has(key.split(':')[1]));
  return { live, orphanKeys };
})()`;

async function attachPage(browser, targetId) {
  return browser.call('Target.attachToTarget', { targetId, flatten: true });
}

const TARGET_FILTER_WITH_TABS = [{ type: 'browser', exclude: true }, { exclude: false }];

async function targetsIncludingTabs(browser) {
  return browser.call('Target.getTargets', { filter: TARGET_FILTER_WITH_TABS });
}

async function cleanupChrome(child, profile) {
  const waitForExit = (timeout) => new Promise((resolvePromise) => {
    if (child.exitCode !== null) return resolvePromise();
    const timer = setTimeout(resolvePromise, timeout);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  await waitForExit(5_000);
  if (child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await waitForExit(1_000);
  }
  // Chrome can finish a last profile write just after its exit event on macOS.
  // Cleanup must never mask the useful E2E/benchmark assertion result.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === 4) console.warn(`临时 Chrome profile 未能清理: ${error.message}`);
      else await delay(150);
    }
  }
}

const E2E_RULES = [
  { id: 'e2e-body', name: 'E2E body', matchers: [{ type: 'word', part: 'body', words: ['E2E_BODY_MARKER'] }] },
  { id: 'e2e-title', name: 'E2E title', matchers: [{ type: 'word', part: 'title', words: ['E2E_TITLE_MARKER'] }] },
  { id: 'e2e-meta', name: 'E2E meta', matchers: [{ type: 'word', part: 'meta', words: ['E2E_META_MARKER'] }] },
  { id: 'e2e-script', name: 'E2E script', matchers: [{ type: 'word', part: 'script', words: ['/assets/e2e-signal.js'] }] },
  { id: 'e2e-js', name: 'E2E JS', matchers: [{ type: 'js', js: [{ path: 'GoPainterE2E.version', pattern: '^1\\.0\\.0$' }] }] },
  { id: 'e2e-dom', name: 'E2E DOM', matchers: [{ type: 'dom', dom: [{ sel: '#e2e-dom', text: 'E2E_DOM_MARKER' }] }] },
  { id: 'e2e-spa', name: 'E2E SPA', matchers: [{ type: 'word', part: 'body', words: ['E2E_SPA_MARKER'] }] },
];
const E2E_INITIAL_IDS = E2E_RULES.filter((rule) => rule.id !== 'e2e-spa').map((rule) => rule.id);

function e2eStateExpression(baseURL) {
  return `(async () => {
    const tab = (await chrome.tabs.query({})).find((item) => item.url === ${JSON.stringify(`${baseURL}/e2e`)} || item.url === ${JSON.stringify(`${baseURL}/e2e?spa=1`)});
    if (!tab) return null;
    const stored = await chrome.storage.session.get([\`result:\${tab.id}\`, \`popup:\${tab.id}\`]);
    const result = stored[\`result:\${tab.id}\`];
    const popup = stored[\`popup:\${tab.id}\`];
    return { tab, result, popup, hitIds: (popup?.result?.hits || []).map((hit) => hit.id) };
  })()`;
}

function e2eDebugExpression(baseURL) {
  return `(async () => {
    const tabs = (await chrome.tabs.query({})).filter((item) => item.url?.startsWith(${JSON.stringify(`${baseURL}/e2e`)}));
    const stored = await chrome.storage.session.get(null);
    const rules = await chrome.storage.local.get('rules');
    return {
      tabs: tabs.map(({ id, url, status }) => ({ id, url, status })),
      ruleCount: Array.isArray(rules.rules) ? rules.rules.length : null,
      snapshots: tabs.map((tab) => ({
        result: stored[\`result:\${tab.id}\`],
        popup: stored[\`popup:\${tab.id}\`],
      })),
      queue: GoPainterPageHost.queueStats(),
    };
  })()`;
}

async function waitFor(browser, sessionId, predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function runBrowserE2E(baseURL) {
  const profile = await mkdtemp(join(tmpdir(), 'gopainter-browser-e2e-'));
  const port = 40_000 + Math.floor(Math.random() * 10_000);
  const child = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging',
    '--host-resolver-rules=MAP bench.gopainter.test 127.0.0.1',
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-dev-shm-usage', '--enable-logging=stderr', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeLogText = '';
  let chromeExit = '';
  const captureChromeLog = (chunk) => {
    chromeLogText = `${chromeLogText}${chunk}`.slice(-12_000);
  };
  child.stdout.on('data', captureChromeLog);
  child.stderr.on('data', captureChromeLog);
  child.once('exit', (code, signal) => { chromeExit = `Chrome exited (code=${code}, signal=${signal || 'none'})`; });
  let browser;
  try {
    const version = await waitForEndpoint(port, Date.now() + 15_000, () => chromeLogText || chromeExit || '(no Chrome log output)');
    browser = await new CDP(version.webSocketDebuggerUrl).connect();
    const extensionId = await loadExtension(browser);
    // Start the worker on a throwaway document.  The page under test must be
    // its first real navigation only after the rule storage has been seeded;
    // otherwise its document_idle content script can collect an empty probe
    // plan before the E2E rules exist.
    const warmup = await browser.call('Target.createTarget', { url: `${baseURL}/page?tab=e2e-warmup` });
    const worker = await workerSession(browser, extensionId, () => '(no Chrome log output)');
    // Discovering a worker target is earlier than completing background.js.
    // Wait for page-host (loaded last) and responseCache (browser-state) so
    // webRequest has registered before the E2E main-frame request begins.
    await waitFor(browser, worker, () => evaluate(browser, worker,
      'Boolean(globalThis.GoPainterPageHost && typeof responseCache !== "undefined")'), 'service worker initialization');
    // Extensions.setStorageItems is not associated with a browser context in
    // some Chromium builds. Populate the rules through the extension's own
    // storage API instead, which also exercises the real runtime path.
    await evaluate(browser, worker,
      `chrome.storage.local.set({ rules: ${JSON.stringify(E2E_RULES)} })`);
    const seeded = await evaluate(browser, worker, 'chrome.storage.local.get("rules")');
    if (seeded?.rules?.length !== E2E_RULES.length) throw new Error('failed to seed E2E rules in extension storage');
    await browser.call('Target.closeTarget', { targetId: warmup.targetId });
    // Open the test document through the extension's normal tabs API.
    const e2eTab = await evaluate(browser, worker, `chrome.tabs.create({ url: ${JSON.stringify(`${baseURL}/e2e`)} })`);
    if (!Number.isInteger(e2eTab?.id)) throw new Error('extension failed to create E2E tab');
    const targets = await waitFor(browser, worker, async () => {
      const { targetInfos } = await targetsIncludingTabs(browser);
      const page = targetInfos.find((item) => item.type === 'page' && item.url === `${baseURL}/e2e`);
      const tab = targetInfos.find((item) => item.type === 'tab' && item.url === `${baseURL}/e2e`);
      return page && tab ? { page, tab } : null;
    }, 'E2E tab target');
    const page = await attachPage(browser, targets.page.targetId);
    await browser.call('Page.enable', {}, page.sessionId);
    // Do one controlled navigation after the extension is fully initialized.
    // chrome.tabs.create begins its first request before it resolves; a reload
    // makes the main-frame webRequest observation deterministic on Chromium.
    await waitFor(browser, page.sessionId, () => evaluate(browser, page.sessionId,
      'document.readyState === "complete"'), 'initial E2E document load');
    await browser.call('Page.reload', { ignoreCache: true }, page.sessionId);
    let lastInitialState = null;
    let state;
    try {
      state = await waitFor(browser, worker, async () => {
        const value = await evaluate(browser, worker, e2eStateExpression(baseURL));
        lastInitialState = value;
        return value?.result && value?.popup && E2E_INITIAL_IDS.every((id) => value.hitIds.includes(id)) ? value : null;
      }, 'initial page result');
    } catch (error) {
      const debug = await evaluate(browser, worker, e2eDebugExpression(baseURL)).catch(() => lastInitialState);
      console.error(`E2E initial-result diagnostics: ${JSON.stringify(debug)}`);
      throw error;
    }
    const features = state.result.features;
    if (features.js?.['GoPainterE2E.version'] !== '1.0.0' || !Object.keys(features.domHits || {}).length
      || !(features.faviconHashes || []).length) {
      throw new Error('feature collection did not retain JS, DOM, and favicon evidence');
    }

    await browser.call('Extensions.triggerAction', { id: extensionId, targetId: targets.tab.targetId });
    const popupTarget = await waitFor(browser, worker, async () => {
      const { targetInfos } = await browser.call('Target.getTargets');
      return targetInfos.find((item) => item.type === 'page' && item.url === `chrome-extension://${extensionId}/popup.html`) || null;
    }, 'extension popup target');
    const popup = await attachPage(browser, popupTarget.targetId);
    await waitFor(browser, worker, async () => {
      const names = await evaluate(browser, popup.sessionId,
        `Array.from(document.querySelectorAll('#hits .hit .name')).map((item) => item.textContent.trim())`);
      return E2E_INITIAL_IDS.every((id) => names.includes(E2E_RULES.find((rule) => rule.id === id).name)) ? names : null;
    }, 'popup rendering');

    await browser.call('Runtime.evaluate', {
      expression: `history.pushState({}, '', '/e2e?spa=1'); document.querySelector('#e2e-dom').textContent = 'E2E_SPA_MARKER E2E_DOM_MARKER';`,
    }, page.sessionId);
    const spaState = await waitFor(browser, worker, async () => {
      const value = await evaluate(browser, worker, e2eStateExpression(baseURL));
      return value?.hitIds.includes('e2e-spa') && !value.hitIds.includes('e2e-body') ? value : null;
    }, 'SPA replacement result');
    if (spaState.result.features.url !== `${baseURL}/e2e?spa=1`) throw new Error('SPA result retained the old URL');
    console.log(JSON.stringify({
      e2e: 'passed',
      initialHits: E2E_INITIAL_IDS.length,
      spaHit: 'e2e-spa',
      faviconHashes: features.faviconHashes.length,
      popupRendered: true,
    }));
  } finally {
    browser?.close();
    await cleanupChrome(child, profile);
  }
}

async function runScenario(baseURL, scenario) {
  const profile = await mkdtemp(join(tmpdir(), 'gopainter-chromium-bench-'));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging',
    '--host-resolver-rules=MAP bench.gopainter.test 127.0.0.1',
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-dev-shm-usage', '--enable-logging=stderr', '--v=1', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeLogText = '';
  let chromeExit = '';
  const captureChromeLog = (chunk) => {
    chromeLogText = `${chromeLogText}${chunk}`.slice(-12_000);
  };
  child.stdout.on('data', captureChromeLog);
  child.stderr.on('data', captureChromeLog);
  child.once('exit', (code, signal) => { chromeExit = `Chrome exited (code=${code}, signal=${signal || 'none'})`; });
  let browser;
  try {
    const version = await waitForEndpoint(port, Date.now() + 15_000, () => chromeLogText || chromeExit || '(no Chrome log output)');
    browser = await new CDP(version.webSocketDebuggerUrl).connect();
    const extensionId = await loadExtension(browser);
    // Start one tab first, so its document_idle content script wakes the MV3
    // worker before the actual concurrent tab burst begins.
    const first = await browser.call('Target.createTarget', { url: `${baseURL}/page?tab=0` });
    await delay(500);
    const worker = await workerSession(browser, extensionId, () => chromeLogText || '(no Chrome log output)');
    const created = [{ index: 0, targetId: first.targetId }, ...(await Promise.all(
      Array.from({ length: scenario.tabs - 1 }, async (_, offset) => {
        const index = offset + 1;
        const target = await browser.call('Target.createTarget', { url: `${baseURL}/page?tab=${index}` });
        return { index, targetId: target.targetId };
      })
    ))];
    const sessions = new Map();
    for (const item of created) sessions.set(item.index, (await attachPage(browser, item.targetId)).sessionId);

    if (scenario.spaTabs) {
      await Promise.all(created.slice(0, scenario.spaTabs).map(async (item) => {
        const sessionId = sessions.get(item.index);
        for (let route = 1; route <= 3; route++) {
          await browser.call('Runtime.evaluate', {
            expression: `history.pushState({}, '', '/page?tab=${item.index}&route=${route}'); document.title = 'route-${route}';`,
          }, sessionId);
        }
      }));
    }
    if (scenario.closeTabs) {
      await Promise.all(created.slice(scenario.spaTabs, scenario.spaTabs + scenario.closeTabs)
        .map((item) => browser.call('Target.closeTarget', { targetId: item.targetId })));
    }

    const maxima = { scanRunning: 0, scanPending: 0, faviconRunning: 0, faviconPending: 0, sessionBytes: 0 };
    const deadline = Date.now() + 45_000;
    let quietSince = null;
    while (Date.now() < deadline) {
      const stats = await evaluate(browser, worker, statsExpression);
      maxima.scanRunning = Math.max(maxima.scanRunning, stats.scan.active);
      maxima.scanPending = Math.max(maxima.scanPending, stats.scan.pending);
      maxima.faviconRunning = Math.max(maxima.faviconRunning, stats.favicon.active);
      maxima.faviconPending = Math.max(maxima.faviconPending, stats.favicon.pending);
      maxima.sessionBytes = Math.max(maxima.sessionBytes, stats.sessionBytes);
      if (!stats.scan.active && !stats.scan.pending && !stats.favicon.active && !stats.favicon.pending) {
        quietSince ||= Date.now();
        if (Date.now() - quietSince >= 1_000) break;
      } else quietSince = null;
      await delay(20);
    }
    if (Date.now() >= deadline) throw new Error(`${scenario.name} did not settle within 45 seconds`);

    const outcome = await evaluate(browser, worker, resultsExpression.replaceAll('__BASE_URL__', baseURL));
    const staleResults = outcome.live.filter((item) => !item.hasResult || item.url !== item.storedURL);
    const storageErrors = browser.events.filter((event) => {
      if (event.method === 'Runtime.exceptionThrown') return true;
      if (event.method !== 'Runtime.consoleAPICalled' || !['error', 'warning'].includes(event.params.type)) return false;
      return event.params.args.some((arg) => String(arg.value || arg.description || '').includes('保存页面扫描快照失败'));
    });
    const summary = {
      scenario: scenario.name,
      liveTabs: outcome.live.length,
      maxima,
      storageErrors: storageErrors.length,
      staleResultCommit: staleResults.length,
      orphanSessionKeys: outcome.orphanKeys.length,
      latestTabsWithResults: outcome.live.length - staleResults.length,
      limits: { scanRunning: 3, scanPending: 32, faviconRunning: 6, faviconPending: 256, sessionBytes: 6_500_000 },
    };
    const failed = maxima.scanRunning > 3 || maxima.scanPending > 32 || maxima.faviconRunning > 6
      || maxima.faviconPending > 256 || maxima.sessionBytes > 6_500_000 || summary.storageErrors
      || summary.staleResultCommit || summary.orphanSessionKeys || summary.latestTabsWithResults !== summary.liveTabs;
    console.log(JSON.stringify(summary));
    if (failed) throw new Error(`${scenario.name} exceeded an asserted resource or correctness bound`);
  } finally {
    browser?.close();
    await cleanupChrome(child, profile);
  }
}

if (!chromePath) throw new Error(`Chrome not found. Checked: ${chromeCandidates.join(', ')}. Set CHROME_PATH.`);
if (!existsSync(join(extensionPath, 'wasm', 'matcher.wasm'))) throw new Error('Missing extension/wasm/matcher.wasm; run make build first.');

const fixture = await listenFixture();
try {
  if (process.argv.includes('--e2e')) {
    await runBrowserE2E(fixture.baseURL);
    console.log('✅ Chromium browser E2E passed');
  } else {
    for (const scenario of scenarios) await runScenario(fixture.baseURL, scenario);
    console.log('✅ Chromium resource benchmark passed');
  }
} finally {
  await new Promise((resolvePromise) => fixture.server.close(resolvePromise));
}
