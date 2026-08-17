// Crawl lifecycle owner. Go Core plans BFS/dedup/filtering; this Host performs I/O and persists progress.
(() => {
  const STORAGE_KEY = 'crawl:state';
  const runtime = { active: false, stop: false };

  function save(state) {
    return chrome.storage.session.set({ [STORAGE_KEY]: state });
  }

  async function load() {
    const data = await chrome.storage.session.get(STORAGE_KEY);
    return data[STORAGE_KEY] || { running: false, results: [], failed: [] };
  }

  async function scanUrl(url, results, failed) {
    try {
      const features = await GoPainterPageFetch.fetchFeatures(url);
      const result = await appendHashHit(features, await runMatch(features));
      const hits = result.hits;
      results.push({ url, title: features.title || url, status: features.status, hits });
      await GoPainterHistoryHost.record(features, { ...result, hits }, 'crawl');
      globalThis.goCrawlFeed(url, JSON.stringify(features.links || []));
    } catch (error) {
      failed.push({ url, error: String(error.message || error) });
    }
  }

  async function run(seed, maxPages) {
    await ensureWasm();
    const started = JSON.parse(globalThis.goCrawlStart(seed, maxPages || 0));
    if (started.error) throw new Error(started.error);

    runtime.active = true;
    const results = [];
    const failed = [];
    const runningState = () => ({ running: true, results, failed });
    await save(runningState());
    try {
      while (!runtime.stop) {
        const batch = JSON.parse(globalThis.goCrawlBatch(8));
        if (batch.error) throw new Error(batch.error);
        if (!batch.urls?.length) break;
        await Promise.all(batch.urls.map((url) => scanUrl(url, results, failed)));
        await save(runningState());
      }
    } finally {
      runtime.active = false;
      await save({ running: false, results, failed });
    }
  }

  async function start({ url, maxPages }) {
    if (runtime.active) throw new Error('已有爬取任务在跑');
    const limit = Number.isInteger(maxPages) && maxPages > 0 ? maxPages : null;
    // Reserve the lifecycle slot before the first await in run(), otherwise two quick
    // messages can both pass the guard while WASM is still starting.
    runtime.active = true;
    runtime.stop = false;
    run(url, limit).catch(async (error) => {
      console.warn('爬取出错:', error);
      runtime.active = false;
      await save({ ...(await load()), running: false });
    });
    return { ok: true };
  }

  function stop() {
    runtime.stop = true;
    return { ok: true };
  }

  async function status() {
    const stored = await load();
    const interrupted = stored.running && !runtime.active;
    let visited = stored.results.length;
    let queued = 0;
    if (runtime.active) {
      try {
        const live = JSON.parse(globalThis.goCrawlStatus());
        visited = live.visited;
        queued = live.queued;
      } catch { /* WASM may still be starting; persisted progress remains authoritative. */ }
    }
    return {
      ok: true,
      running: stored.running && runtime.active,
      interrupted,
      visited,
      queued,
      results: stored.results,
      failed: stored.failed || [],
    };
  }

  globalThis.GoPainterCrawlHost = Object.freeze({
    handlers: Object.freeze({
      crawlStart: start,
      crawlStop: stop,
      crawlStatus: status,
    }),
  });
})();
