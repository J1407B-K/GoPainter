// Current-tab scan messages and compact result snapshots.
(() => {
  async function collectPageFeatures(msg, sender) {
    const tabId = sender.tab?.id;
    const pageUrl = msg.features?.url;
    const navigationVersion = currentNavigationVersion(tabId);
    if (!(await isCurrentTabPage(tabId, pageUrl, navigationVersion))) {
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
    features.faviconHashes = await hashIcons(icons);
    const result = await appendHashHit(features, await runMatch(features));
    result.hits = await runUserScripts(features, result.hits);

    if (!(await isCurrentTabPage(tabId, pageUrl, navigationVersion))) {
      return { ok: true, stale: true };
    }
    const at = Date.now();
    await chrome.storage.session.set({
      [`result:${tabId}`]: { features, result, at },
      ...popupResultEntry(tabId, features, result, at),
      ...agentPageEntry(tabId, features, at),
    });
    await GoPainterHistoryHost.record(features, result, 'page');
    await updateIcon(tabId, result.hits?.length || 0);
    return { ok: true };
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
    const compact = popupResultSnapshot(stored.features, stored.result, stored.at);
    await chrome.storage.session.set({ [popupKey]: compact });
    return compact;
  }

  globalThis.GoPainterPageHost = Object.freeze({
    handlers: Object.freeze({
      pageFeatures: collectPageFeatures,
      getResult,
      getPopupResult,
    }),
  });
})();
