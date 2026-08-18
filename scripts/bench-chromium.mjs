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
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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

async function waitForEndpoint(port, deadline) {
  while (Date.now() < deadline) {
    try { return await json(`http://127.0.0.1:${port}/json/version`); } catch { await delay(50); }
  }
  throw new Error('Chrome remote-debugging endpoint did not start');
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

async function runScenario(baseURL, scenario) {
  const profile = await mkdtemp(join(tmpdir(), 'gopainter-chromium-bench-'));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging',
    '--host-resolver-rules=MAP bench.gopainter.test 127.0.0.1',
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--enable-logging=stderr', '--v=1', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeLogText = '';
  const captureChromeLog = (chunk) => {
    chromeLogText = `${chromeLogText}${chunk}`.slice(-12_000);
  };
  child.stdout.on('data', captureChromeLog);
  child.stderr.on('data', captureChromeLog);
  let browser;
  try {
    const version = await waitForEndpoint(port, Date.now() + 15_000);
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
    child.kill('SIGTERM');
    await rm(profile, { recursive: true, force: true });
  }
}

if (!existsSync(chromePath)) throw new Error(`Chrome not found: ${chromePath}. Set CHROME_PATH.`);
if (!existsSync(join(extensionPath, 'wasm', 'matcher.wasm'))) throw new Error('Missing extension/wasm/matcher.wasm; run make build first.');

const fixture = await listenFixture();
try {
  for (const scenario of scenarios) await runScenario(fixture.baseURL, scenario);
  console.log('✅ Chromium resource benchmark passed');
} finally {
  await new Promise((resolvePromise) => fixture.server.close(resolvePromise));
}
