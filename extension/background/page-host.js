// Current-tab scan messages and compact result snapshots.
(() => {
  const MAX_PAGE_SCAN_CONCURRENCY = 3;
  const MAX_PAGE_SCAN_QUEUE = 32;
  let activePageScans = 0;
  const pageScanQueue = [];
  let pageScanSequence = 0;
  const latestPageScan = new Map();

  function staleScan(job) {
    job.resolve({ ok: true, stale: true });
  }

  function drainPageScanQueue() {
    while (activePageScans < MAX_PAGE_SCAN_CONCURRENCY && pageScanQueue.length) {
      const job = pageScanQueue.shift();
      if (latestPageScan.get(job.tabId) !== job.token) {
        staleScan(job);
        continue;
      }
      activePageScans++;
      Promise.resolve().then(() => job.task(job.token)).then(job.resolve, job.reject).finally(() => {
        activePageScans--;
        drainPageScanQueue();
      });
    }
  }

  function queuePageScan(tabId, task) {
    const token = ++pageScanSequence;
    latestPageScan.set(tabId, token);
    return new Promise((resolve, reject) => {
      // A tab's most recent navigation is the only pending scan worth keeping.
      const sameTab = pageScanQueue.findIndex((job) => job.tabId === tabId);
      if (sameTab >= 0) staleScan(pageScanQueue.splice(sameTab, 1)[0]);
      // Do not discard a still-current scan from another tab. The content
      // script retains this compact feature payload and retries after a short
      // backoff, so all newly opened tabs eventually get their first result.
      if (pageScanQueue.length >= MAX_PAGE_SCAN_QUEUE) {
        resolve({ ok: true, retryAfter: 250 });
        return;
      }
      pageScanQueue.push({ tabId, token, task, resolve, reject });
      drainPageScanQueue();
    });
  }

  chrome.tabs.onRemoved.addListener((tabId) => latestPageScan.delete(tabId));

  function sanitizeProbeGlobals(paths, globals) {
    const out = {};
    for (const path of paths) {
      const value = globals?.[path];
      if (value != null) out[path] = String(value).slice(0, 120);
    }
    return out;
  }

  async function probeJs({ paths }, sender) {
    const requested = [...new Set((Array.isArray(paths) ? paths : [])
      .filter((path) => typeof path === 'string' && path.length > 0 && path.length <= 200))].slice(0, 200);
    if (!requested.length || !Number.isInteger(sender.tab?.id)) return { ok: true, globals: {} };
    const injected = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
      world: 'MAIN',
      args: [requested],
      func: (probePaths) => {
        const out = {};
        for (const path of probePaths) {
          try {
            let value = window;
            for (const part of path.split('.')) {
              if (value == null) break;
              value = value[part];
            }
            if (value === undefined || value === null) continue;
            const type = typeof value;
            out[path] = type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint'
              ? String(value) : type;
          } catch { /* getter/proxy may throw; treat it as absent */ }
        }
        return out;
      },
    });
    return { ok: true, globals: sanitizeProbeGlobals(requested, injected[0]?.result) };
  }

  async function collectPageFeaturesNow(msg, sender, token) {
    const tabId = sender.tab?.id;
    const pageUrl = msg.features?.url;
    const navigationVersion = currentNavigationVersion(tabId);
    const isStale = () => latestPageScan.get(tabId) !== token
      || currentNavigationVersion(tabId) !== navigationVersion;
    if (isStale() || !(await isCurrentTabPage(tabId, pageUrl, navigationVersion))) {
      return { ok: true, stale: true };
    }

    const network = responseCache.get(tabId) || { status: 0, headers: {} };
    const features = await enrichFeatures({
      ...msg.features,
      status: network.status,
      headers: network.headers,
    });
    const networkIcons = tabIcons.get(tabId)?.seen || new Set();
    const icons = [features.favicon, ...(features.favicons || []), ...networkIcons].filter(Boolean);
    features.faviconHashes = await hashIcons(icons, isStale);
    const result = await appendHashHit(features, await runMatch(features));

    if (isStale() || !(await isCurrentTabPage(tabId, pageUrl, navigationVersion))) {
      return { ok: true, stale: true };
    }
    const at = Date.now();
    await storePageSession(tabId, features, result, at);
    await GoPainterHistoryHost.record(features, result, 'page');
    await updateIcon(tabId, result.hits?.length || 0);
    return { ok: true };
  }

  function collectPageFeatures(msg, sender) {
    markTabPageFeatureVersion(sender.tab?.id);
    return queuePageScan(sender.tab?.id, (token) => collectPageFeaturesNow(msg, sender, token));
  }

  // Read-only runtime telemetry for DevTools and Chromium load checks.
  function queueStats() {
    return { active: activePageScans, pending: pageScanQueue.length };
  }

  async function getResult({ tabId }) {
    const key = `result:${tabId}`;
    const data = await chrome.storage.session.get(key);
    return data[key] || null;
  }

  async function getPopupResult({ tabId }) {
    const popupKey = `popup:${tabId}`;
    const resultKey = `result:${tabId}`;
    const data = await chrome.storage.session.get([popupKey, resultKey]);
    if (data[popupKey]) return data[popupKey];
    if (!data[resultKey]) return null;
    const stored = data[resultKey];
    // Legacy snapshots may lack popup:${tabId}. Return a transient compact view
    // rather than writing around storePageSession's quota and eviction policy.
    return popupResultSnapshot(stored.features, stored.result, stored.at);
  }

  globalThis.GoPainterPageHost = Object.freeze({
    handlers: Object.freeze({
      pageFeatures: collectPageFeatures,
      probeJs,
      getResult,
      getPopupResult,
    }),
    queueStats,
  });
})();
