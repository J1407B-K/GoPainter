// Current-tab scan messages and compact result snapshots.
(() => {
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
            try {
              out[path] = typeof value === 'string' ? value
                : typeof value === 'function' ? 'function' : JSON.stringify(value) ?? typeof value;
            } catch {
              out[path] = typeof value;
            }
          } catch { /* getter/proxy may throw; treat it as absent */ }
        }
        return out;
      },
    });
    return { ok: true, globals: sanitizeProbeGlobals(requested, injected[0]?.result) };
  }

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
      probeJs,
      getResult,
      getPopupResult,
    }),
  });
})();
