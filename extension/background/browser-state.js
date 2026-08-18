// Browser event state: response headers and action icon/badge.

// tabId -> { status, headers }，只记主框架
const responseCache = new Map();

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.type !== 'main_frame') return;
    const headers = {};
    for (const h of details.responseHeaders || []) {
      headers[h.name.toLowerCase()] = h.value || '';
    }
    responseCache.set(details.tabId, { status: details.statusCode, headers });
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => {
  responseCache.delete(tabId);
  clearTabIcons(tabId);
  iconJobs.delete(tabId);
  tabNavigationVersions.delete(tabId);
  tabPageFeatureVersions.delete(tabId);
  chrome.storage.session.remove([`result:${tabId}`, `popup:${tabId}`, `agent:${tabId}`]);
});

function popupResultSnapshot(features = {}, result = {}, at = Date.now()) {
  return GoPainterUtils.popupResultSnapshot(features, result, at);
}

function popupResultEntry(tabId, features, result, at = Date.now()) {
  return { [`popup:${tabId}`]: popupResultSnapshot(features, result, at) };
}

function agentPageEntry(tabId, features, at = Date.now()) {
  return { [`agent:${tabId}`]: GoPainterUtils.agentPageSnapshot(features, at) };
}

const SESSION_PAGE_BODY_CHARS = 80_000;
const SESSION_PAGE_ENTRY_LIMIT = 64;
// chrome.storage.session has a 10 MB quota. Leave room for crawl state and
// other session-owned data instead of consuming it with tab snapshots.
const SESSION_PAGE_STORAGE_BUDGET_BYTES = 6_500_000;
let sessionPageWriteQueue = Promise.resolve();

function compactString(value, limit) {
  return String(value ?? '').slice(0, limit);
}

function compactStringList(values, count, length) {
  return (Array.isArray(values) ? values : []).slice(0, count).map((value) => compactString(value, length));
}

function compactObject(values, count, keyLength, valueLength) {
  const out = {};
  for (const [key, value] of Object.entries(values || {}).slice(0, count)) {
    out[compactString(key, keyLength)] = compactString(value, valueLength);
  }
  return out;
}

function compactSessionFeatures(features = {}) {
  return {
    ...features,
    url: compactString(features.url, 4_000),
    title: compactString(features.title, 2_000),
    body: compactString(features.body, SESSION_PAGE_BODY_CHARS),
    favicon: compactString(features.favicon, 4_000),
    headers: compactObject(features.headers, 50, 200, 1_000),
    meta: compactObject(features.meta, 100, 200, 1_000),
    scripts: compactStringList(features.scripts, 100, 2_000),
    links: compactStringList(features.links, 200, 2_000),
    favicons: compactStringList(features.favicons, 64, 2_000),
    faviconHashes: compactStringList(features.faviconHashes, 64, 200),
    js: compactObject(features.js, 200, 300, 1_000),
    domHits: compactObject(features.domHits, 200, 300, 20),
  };
}

function compactSessionResult(result = {}) {
  return {
    note: result.note,
    totalHits: (result.hits || []).length,
  };
}

function sessionPageKeys(tabId) {
  return [`result:${tabId}`, `popup:${tabId}`, `agent:${tabId}`];
}

function sessionBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function serializeSessionPageWrite(operation) {
  const run = () => Promise.resolve(operation()).catch((error) => {
    console.warn('保存页面扫描快照失败:', error);
  });
  sessionPageWriteQueue = sessionPageWriteQueue.then(run, run);
  return sessionPageWriteQueue;
}

async function storePageSession(tabId, features, result, at = Date.now()) {
  return serializeSessionPageWrite(async () => {
    try { await chrome.tabs.get(tabId); } catch { return; }
    const storedFeatures = compactSessionFeatures(features);
    const entries = {
      [`result:${tabId}`]: { features: storedFeatures, result: compactSessionResult(result), at },
      ...popupResultEntry(tabId, storedFeatures, result, at),
      ...agentPageEntry(tabId, storedFeatures, at),
    };
    const current = await chrome.storage.session.get(null);
    const replacing = new Set(sessionPageKeys(tabId));
    let total = sessionBytes(entries);
    const candidates = new Map();
    for (const [key, value] of Object.entries(current)) {
      if (replacing.has(key)) continue;
      total += sessionBytes({ [key]: value });
      const match = /^(?:result|popup|agent):(\d+)$/.exec(key);
      if (!match) continue;
      const oldTabId = Number(match[1]);
      if (!Number.isInteger(oldTabId)) continue;
      const previous = candidates.get(oldTabId);
      candidates.set(oldTabId, { tabId: oldTabId, at: Math.max(previous?.at || 0, Number(value?.at) || 0) });
    }
    const orderedCandidates = [...candidates.values()].sort((a, b) => a.at - b.at);
    const evict = [];
    let pageCount = orderedCandidates.length + 1;
    for (const candidate of orderedCandidates) {
      if (total <= SESSION_PAGE_STORAGE_BUDGET_BYTES && pageCount <= SESSION_PAGE_ENTRY_LIMIT) break;
      const keys = sessionPageKeys(candidate.tabId);
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(current, key)) total -= sessionBytes({ [key]: current[key] });
      }
      evict.push(...keys);
      pageCount--;
    }
    if (evict.length) await chrome.storage.session.remove(evict);
    await chrome.storage.session.set(entries);
  });
}

const ICONS = (state) => ({
  16: `icons/icon16${state}.png`,
  32: `icons/icon32${state}.png`,
  48: `icons/icon48${state}.png`,
  128: `icons/icon128${state}.png`,
});

const iconJobs = new Map(); // tabId -> { pendingHitCount, running }
// 同 URL 刷新时只比较 URL 不够：旧文档和新文档的地址相同。每次 loading
// 增加版本号，让所有已开始的异步任务都能识别自己是否已过期。
const tabNavigationVersions = new Map();
// This advances for every content-script report as well as browser navigation,
// so favicon work for a prior SPA route can be cancelled before it commits.
const tabPageFeatureVersions = new Map();

function currentNavigationVersion(tabId) {
  return tabNavigationVersions.get(tabId) || 0;
}

function currentTabPageFeatureVersion(tabId) {
  return tabPageFeatureVersions.get(tabId) || 0;
}

function markTabPageFeatureVersion(tabId) {
  if (!Number.isInteger(tabId)) return 0;
  const next = currentTabPageFeatureVersion(tabId) + 1;
  tabPageFeatureVersions.set(tabId, next);
  return next;
}

// 指纹计算会包含网络请求（例如 favicon 哈希）。在它完成之前标签页可能已经
// 导航到另一张页面；旧页面的结果绝不能再覆盖新页面的图标或缓存。
async function isCurrentTabPage(tabId, url, navigationVersion = currentNavigationVersion(tabId)) {
  if (tabId == null || tabId < 0 || !url) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url === url && currentNavigationVersion(tabId) === navigationVersion;
  } catch {
    return false;
  }
}

async function applyIcon(tabId, hitCount) {
  if (tabId == null || tabId < 0) return;
  const matched = hitCount > 0;
  await chrome.action.setIcon({ tabId, path: ICONS(matched ? '' : '-gray') });
  await chrome.action.setBadgeText({ tabId, text: matched ? String(hitCount) : '' });
  if (matched) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#6366f1' });
  }
}

function updateIcon(tabId, hitCount) {
  if (tabId == null || tabId < 0) return Promise.resolve();
  let job = iconJobs.get(tabId);
  if (!job) {
    job = { pendingHitCount: hitCount, running: false };
    iconJobs.set(tabId, job);
  }
  job.pendingHitCount = hitCount;
  if (job.running) return Promise.resolve();

  job.running = true;
  return (async () => {
    while (job.pendingHitCount != null) {
      const next = job.pendingHitCount;
      job.pendingHitCount = null;
      await applyIcon(tabId, next);
    }
  })().finally(() => {
    job.running = false;
    if (job.pendingHitCount != null) {
      updateIcon(tabId, job.pendingHitCount).catch(() => {});
    }
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    // 每次导航都是一张新页面；不能把上一页网络包里的 icon 带进来参与匹配。
    responseCache.delete(tabId);
    tabNavigationVersions.set(tabId, currentNavigationVersion(tabId) + 1);
    markTabPageFeatureVersion(tabId);
    clearTabIcons(tabId);
    // 这里必须同步排队：异步读取旧缓存后再置灰，可能反过来覆盖新页面的命中。
    updateIcon(tabId, 0).catch(() => {});
  }
});

// 网络包里的 icon：页面加载过程中所有带 icon/favicon 字样的图片请求都收。
const tabIcons = new Map(); // tabId -> { seen:Set, pending:Set, timer }

function clearTabIcons(tabId) {
  const st = tabIcons.get(tabId);
  if (st?.timer) clearTimeout(st.timer);
  tabIcons.delete(tabId);
}

function trackIconRequest(tabId, url) {
  if (!publicIconURL(url)) return;
  let st = tabIcons.get(tabId);
  if (!st) {
    st = { seen: new Set(), pending: new Set(), timer: null };
    tabIcons.set(tabId, st);
  }
  if (st.seen.has(url) || st.seen.size >= MAX_ICON_URLS) return;
  st.seen.add(url);
  st.pending.add(url);
  // 页面已有的 icon 可能晚于 content script 上报，攒一批重新匹配
  clearTimeout(st.timer);
  st.timer = setTimeout(() => flushIcons(tabId), 800);
}

chrome.webRequest.onCompleted.addListener(
  (d) => { if (d.tabId >= 0) trackIconRequest(d.tabId, d.url); },
  { urls: ['*://*/*favicon*', '*://*/*icon*'], types: ['image', 'other'] }
);

async function flushIcons(tabId) {
  const navigationVersion = currentNavigationVersion(tabId);
  const pageFeatureVersion = currentTabPageFeatureVersion(tabId);
  const st = tabIcons.get(tabId);
  if (!st || !st.pending.size) return;
  const isStale = () => currentNavigationVersion(tabId) !== navigationVersion
    || currentTabPageFeatureVersion(tabId) !== pageFeatureVersion || tabIcons.get(tabId) !== st;
  const urls = [...st.pending];
  st.pending.clear();

  const key = `result:${tabId}`;
  const data = await chrome.storage.session.get(key);
  const stored = data[key];
  if (!stored) return; // 页面还没上报特征，pageFeatures 流程会带上这些 icon
  if (!(await isCurrentTabPage(tabId, stored.features?.url, navigationVersion))) return;

  const newHashes = await hashIcons(urls, isStale);
  if (!newHashes.length) return;

  // 只挑出没见过的新哈希；没有就省了这次重匹配
  const existing = new Set((stored.features.faviconHashes || []).filter(Boolean));
  const fresh = newHashes.filter((h) => !existing.has(h));
  if (!fresh.length) return;

  stored.features.faviconHashes = [...existing, ...fresh];

  // 有新哈希就完整重跑一遍匹配（规则 + 哈希库 + 脚本），毫秒级
  const result = await appendHashHit(stored.features, await runMatch(stored.features));
  // 哈希和匹配期间可能已经发生导航，再确认一次才提交。
  if (!(await isCurrentTabPage(tabId, stored.features?.url, navigationVersion))) return;
  await storePageSession(tabId, stored.features, result, stored.at);
  await GoPainterHistoryHost.record(stored.features, result, 'page');
  await updateIcon(tabId, result.hits?.length || 0);
}
