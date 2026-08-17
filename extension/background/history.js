// Scan-history storage owner. Reports contain summaries only, never page HTML or AI config.
(() => {
  const HISTORY_KEY = 'scanHistory';
  const LIMIT_KEY = 'scanHistoryLimit';
  const DEFAULT_LIMIT = 300;
  let writeQueue = Promise.resolve();

  function enqueue(operation, warning) {
    writeQueue = writeQueue.then(operation).catch((error) => console.warn(warning, error));
    return writeQueue;
  }

  function record(features, result, source) {
    return enqueue(async () => {
      const stored = await chrome.storage.local.get([HISTORY_KEY, LIMIT_KEY]);
      const history = stored[HISTORY_KEY] || [];
      const limit = GoPainterUtils.normalizeHistoryLimit(stored[LIMIT_KEY], DEFAULT_LIMIT);
      const entry = GoPainterUtils.scanHistoryEntry(features, result, source);
      await chrome.storage.local.set({
        [HISTORY_KEY]: GoPainterUtils.mergeScanHistory(history, entry, limit),
      });
    }, '保存扫描历史失败:');
  }

  async function setLimit({ limit: value }) {
    const limit = GoPainterUtils.normalizeHistoryLimit(value, DEFAULT_LIMIT);
    await enqueue(async () => {
      const { [HISTORY_KEY]: history = [] } = await chrome.storage.local.get(HISTORY_KEY);
      await chrome.storage.local.set({
        [LIMIT_KEY]: limit,
        [HISTORY_KEY]: (Array.isArray(history) ? history : []).slice(0, limit),
      });
    }, '更新扫描历史上限失败:');
    return { ok: true, limit };
  }

  async function clear() {
    await enqueue(
      () => chrome.storage.local.set({ [HISTORY_KEY]: [] }),
      '清空扫描历史失败:'
    );
    return { ok: true };
  }

  globalThis.GoPainterHistoryHost = Object.freeze({
    record,
    handlers: Object.freeze({
      setScanHistoryLimit: setLimit,
      clearScanHistory: clear,
    }),
  });
})();
