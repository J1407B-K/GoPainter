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

function currentNavigationVersion(tabId) {
  return tabNavigationVersions.get(tabId) || 0;
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
  let st = tabIcons.get(tabId);
  if (!st) {
    st = { seen: new Set(), pending: new Set(), timer: null };
    tabIcons.set(tabId, st);
  }
  if (st.seen.has(url)) return;
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
  const st = tabIcons.get(tabId);
  if (!st || !st.pending.size) return;
  const urls = [...st.pending];
  st.pending.clear();

  const key = `result:${tabId}`;
  const data = await chrome.storage.session.get(key);
  const stored = data[key];
  if (!stored) return; // 页面还没上报特征，pageFeatures 流程会带上这些 icon
  if (!(await isCurrentTabPage(tabId, stored.features?.url, navigationVersion))) return;

  const newHashes = await hashIcons(urls);
  if (!newHashes.length) return;

  // 只挑出没见过的新哈希；没有就省了这次重匹配
  const existing = new Set((stored.features.faviconHashes || []).filter(Boolean));
  const fresh = newHashes.filter((h) => !existing.has(h));
  if (!fresh.length) return;

  stored.features.faviconHashes = [...existing, ...fresh];

  // 有新哈希就完整重跑一遍匹配（规则 + 哈希库 + 脚本），毫秒级
  const result = await appendHashHit(stored.features, await runMatch(stored.features));
  result.hits = await runUserScripts(stored.features, result.hits);
  // 哈希和匹配期间可能已经发生导航，再确认一次才提交。
  if (!(await isCurrentTabPage(tabId, stored.features?.url, navigationVersion))) return;
  stored.result = result;
  await chrome.storage.session.set({
    [key]: stored,
    ...popupResultEntry(tabId, stored.features, result, stored.at),
    ...agentPageEntry(tabId, stored.features, stored.at),
  });
  await GoPainterHistoryHost.record(stored.features, result, 'page');
  await updateIcon(tabId, result.hits?.length || 0);
}
