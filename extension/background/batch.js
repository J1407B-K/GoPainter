// Bounded bulk URL scanner. Only compact summaries enter storage.session; page bodies
// stay inside one worker task and are released after matching.
(() => {
  const STORAGE_KEY = 'batch:state';
  const MAX_TARGETS = 500;
  const MAX_URL_LENGTH = 2_048;
  const CONCURRENCY = 4;
  const MAX_HITS_PER_RESULT = 20;
  const STORAGE_BUDGET_BYTES = 2_500_000;
  const runtime = { active: false, runId: 0, controller: null, state: null, inFlight: 0, lastSavedAt: 0 };
  let persistQueue = Promise.resolve();

  function normalizeTargets(rawTargets) {
    const targets = [];
    const seen = new Set();
    let invalid = 0;
    let duplicate = 0;
    for (const raw of Array.isArray(rawTargets) ? rawTargets : []) {
      const text = String(raw || '').trim();
      let parsed;
      try { parsed = new URL(text); } catch { invalid++; continue; }
      parsed.hash = '';
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || parsed.href.length > MAX_URL_LENGTH) {
        invalid++;
        continue;
      }
      if (seen.has(parsed.href)) { duplicate++; continue; }
      seen.add(parsed.href);
      targets.push(parsed.href);
      if (targets.length > MAX_TARGETS) throw new Error(`批量扫描最多 ${MAX_TARGETS} 个 URL`);
    }
    if (!targets.length) throw new Error('没有有效的 http/https URL');
    return { targets, invalid, duplicate };
  }

  function compactHit(hit) {
    const compact = {
      id: String(hit?.id || '').slice(0, 160),
      name: String(hit?.name || hit?.id || '').slice(0, 160),
      confidence: GoPainterUtils.confidenceValue(hit),
    };
    if (hit?.version) compact.version = String(hit.version).slice(0, 120);
    return compact;
  }

  function compactResult(requestedURL, features, result) {
    const hits = Array.isArray(result?.hits) ? result.hits : [];
    return {
      url: String(requestedURL).slice(0, MAX_URL_LENGTH),
      finalUrl: String(features.url || requestedURL).slice(0, MAX_URL_LENGTH),
      title: String(features.title || '').slice(0, 300),
      status: Number.isInteger(features.status) ? features.status : 0,
      totalHits: hits.length,
      hits: hits.slice(0, MAX_HITS_PER_RESULT).map(compactHit),
    };
  }

  function bytes(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }

  function storageSnapshot(state) {
    const snapshot = JSON.parse(JSON.stringify(state));
    if (bytes(snapshot) <= STORAGE_BUDGET_BYTES) return snapshot;
    for (const result of snapshot.results) {
      if (result.hits.length > 5) result.hits = result.hits.slice(0, 5);
    }
    if (bytes(snapshot) <= STORAGE_BUDGET_BYTES) return snapshot;
    for (const result of snapshot.results) {
      result.url = result.url.slice(0, 512);
      result.finalUrl = result.finalUrl.slice(0, 512);
      result.title = result.title.slice(0, 80);
      result.hits = result.hits.slice(0, 2);
    }
    return snapshot;
  }

  function save(state) {
    const snapshot = storageSnapshot(state);
    const operation = () => chrome.storage.session.set({ [STORAGE_KEY]: snapshot });
    persistQueue = persistQueue.then(operation, operation);
    return persistQueue;
  }

  async function load() {
    const data = await chrome.storage.session.get(STORAGE_KEY);
    return data[STORAGE_KEY] || { running: false, total: 0, completed: 0, results: [], failed: [] };
  }

  function publicState(state) {
    const runningCount = runtime.active ? runtime.inFlight : 0;
    return {
      ...state,
      active: runtime.active,
      runningCount,
      pending: Math.max(0, state.total - state.completed - runningCount),
      concurrency: CONCURRENCY,
      limits: { targets: MAX_TARGETS, hitsPerResult: MAX_HITS_PER_RESULT, storageBytes: STORAGE_BUDGET_BYTES },
    };
  }

  async function persistProgress(force = false) {
    const now = Date.now();
    if (!force && runtime.state.completed % CONCURRENCY !== 0 && now - runtime.lastSavedAt < 500) return;
    runtime.lastSavedAt = now;
    try {
      await save(runtime.state);
    } catch (error) {
      runtime.state.storageErrors = (runtime.state.storageErrors || 0) + 1;
      runtime.state.error = String(error?.message || error).slice(0, 500);
    }
  }

  async function scanOne(url, runId) {
    let settled = false;
    runtime.inFlight++;
    try {
      const features = await GoPainterPageFetch.fetchFeatures(url, { signal: runtime.controller.signal });
      if (runId !== runtime.runId || runtime.controller.signal.aborted) return;
      const result = await appendHashHit(features, await runMatch(features));
      if (runId !== runtime.runId || runtime.controller.signal.aborted) return;
      runtime.state.results.push(compactResult(url, features, result));
      settled = true;
      await GoPainterHistoryHost.record(features, result, 'batch').catch((error) => {
        console.warn('保存批量扫描历史失败:', error);
      });
    } catch (error) {
      if (runId !== runtime.runId || runtime.controller.signal.aborted) return;
      runtime.state.failed.push({ url, error: String(error?.message || error).slice(0, 300) });
      settled = true;
    } finally {
      if (runId === runtime.runId) runtime.inFlight = Math.max(0, runtime.inFlight - 1);
      if (runId === runtime.runId && settled) {
        runtime.state.completed++;
        await persistProgress();
      }
    }
  }

  async function run(targets, runId) {
    try {
      await ensureWasm();
      let next = 0;
      const worker = async () => {
        while (runId === runtime.runId && !runtime.controller.signal.aborted) {
          const index = next++;
          if (index >= targets.length) return;
          await scanOne(targets[index], runId);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
    } catch (error) {
      if (runId === runtime.runId) runtime.state.error = String(error?.message || error).slice(0, 500);
    } finally {
      // Never return from finally: that can suppress an exception or pending
      // control flow. A replaced run must simply leave its successor untouched.
      if (runId === runtime.runId) {
        runtime.state.running = false;
        runtime.state.stopped = runtime.controller.signal.aborted;
        runtime.state.finishedAt = Date.now();
        await persistProgress(true);
        runtime.active = false;
      }
    }
  }

  async function start({ urls }) {
    if (runtime.active) throw new Error('已有批量扫描任务在跑');
    const normalized = normalizeTargets(urls);
    const runId = ++runtime.runId;
    runtime.controller = new AbortController();
    runtime.inFlight = 0;
    runtime.lastSavedAt = 0;
    runtime.state = {
      running: true,
      stopped: false,
      total: normalized.targets.length,
      completed: 0,
      invalid: normalized.invalid,
      duplicate: normalized.duplicate,
      results: [],
      failed: [],
      startedAt: Date.now(),
    };
    runtime.active = true;
    try {
      await save(runtime.state);
    } catch (error) {
      if (runId === runtime.runId) {
        runtime.controller.abort();
        runtime.state.running = false;
        runtime.state.error = String(error?.message || error).slice(0, 500);
        runtime.active = false;
      }
      throw error;
    }
    run(normalized.targets, runId).catch((error) => console.warn('批量扫描失败:', error));
    return { ok: true, total: normalized.targets.length, invalid: normalized.invalid, duplicate: normalized.duplicate };
  }

  function stop() {
    if (runtime.active) runtime.controller.abort();
    return { ok: true };
  }

  async function status() {
    if (runtime.active && runtime.state) {
      return { ok: true, ...publicState({ ...runtime.state, running: true, interrupted: false }) };
    }
    const state = await load();
    return { ok: true, ...publicState({ ...state, running: false, interrupted: Boolean(state.running) }) };
  }

  async function clear() {
    if (runtime.active) throw new Error('请先停止批量扫描');
    await chrome.storage.session.remove(STORAGE_KEY);
    return { ok: true };
  }

  globalThis.GoPainterBatchHost = Object.freeze({
    handlers: Object.freeze({ batchStart: start, batchStop: stop, batchStatus: status, batchClear: clear }),
    limits: Object.freeze({ concurrency: CONCURRENCY, pending: MAX_TARGETS, storageBytes: STORAGE_BUDGET_BYTES }),
  });
})();
