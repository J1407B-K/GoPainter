// Third-party rule sources fetched on the user's behalf: bounded download, conversion, refresh,
// scheduling, metadata, and one-version rollback.
(() => {
  const STORAGE_KEY = 'ruleSources';
  const ALARM_NAME = 'gopainter:rule-source-refresh';
  const MAX_FILE_BYTES = 3 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
  const MAX_FILES = 2_000;
  const MAX_RULES = 25_000;
  const FETCH_CONCURRENCY = 4;
  const FETCH_TIMEOUT_MS = 15_000;
  const MAX_REDIRECTS = 3;
  const ALLOWED_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com', 'github.com']);
  const SOURCE_DEFS = Object.freeze({
    wappalyzer: Object.freeze({
      id: 'wappalyzer', name: 'Wappalyzer 社区版', ruleSetId: 'source:wappalyzer',
      legacyRuleSetIds: ['wappalyzer'], legacyRuleSetNames: ['Wappalyzer Community Edition', 'Wappalyzer'],
      manifest: 'https://api.github.com/repos/enthec/webappanalyzer/contents/src/technologies',
    }),
    ehole: Object.freeze({
      id: 'ehole', name: 'EHole 棱洞', ruleSetId: 'source:ehole',
      legacyRuleSetIds: ['ehole'], legacyRuleSetNames: ['EHole'],
      manifest: 'https://raw.githubusercontent.com/EdgeSecurityTeam/EHole/main/finger.json',
    }),
    nuclei: Object.freeze({
      id: 'nuclei', name: 'nuclei-templates', ruleSetId: 'source:nuclei',
      legacyRuleSetIds: ['nuclei'], legacyRuleSetNames: ['Nuclei Templates'],
      manifest: 'https://api.github.com/repos/projectdiscovery/nuclei-templates/contents/http/technologies',
    }),
  });
  const running = new Map();
  let metadataQueue = Promise.resolve();
  let sourceOperationQueue = Promise.resolve();

  function defaultMeta(def) {
    return {
      id: def.id, name: def.name, ruleSetId: def.ruleSetId,
      legacyRuleSetIds: def.legacyRuleSetIds, legacyRuleSetNames: def.legacyRuleSetNames,
      autoUpdate: false, intervalHours: 24, lastCheckedAt: 0, lastUpdatedAt: 0,
      ruleCount: 0, etag: '', lastModified: '', contentHash: '', lastError: '',
      canRollback: false, lastSummary: null,
    };
  }

  async function loadState() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const current = stored[STORAGE_KEY] || {};
    return Object.fromEntries(Object.values(SOURCE_DEFS).map((def) => [
      def.id,
      { ...defaultMeta(def), ...current[def.id], id: def.id, name: def.name, ruleSetId: def.ruleSetId },
    ]));
  }

  function serializeMetadata(operation) {
    const task = metadataQueue.then(operation, operation);
    metadataQueue = task.catch(() => {});
    return task;
  }

  function patchMeta(sourceId, values) {
    return serializeMetadata(async () => {
      const state = await loadState();
      state[sourceId] = { ...state[sourceId], ...values };
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
      return state[sourceId];
    });
  }

  function serializeSourceOperation(operation) {
    const task = sourceOperationQueue.then(operation, operation);
    sourceOperationQueue = task.catch(() => {});
    return task;
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason || new Error('规则源更新已取消');
  }

  function checkedRemoteURL(raw) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || !ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error('规则源重定向到了不允许的地址');
    }
    return url;
  }

  async function requestSource(url, options, conditional, updateSignal) {
    const controller = new AbortController();
    const abortUpdate = () => controller.abort(updateSignal.reason);
    if (updateSignal?.aborted) abortUpdate();
    else updateSignal?.addEventListener('abort', abortUpdate, { once: true });
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const dispose = () => {
      clearTimeout(timer);
      updateSignal?.removeEventListener('abort', abortUpdate);
    };
    const headers = { Accept: options.accept || 'application/json, text/plain, */*' };
    if (conditional && options.etag) headers['If-None-Match'] = options.etag;
    if (conditional && options.lastModified) headers['If-Modified-Since'] = options.lastModified;
    try {
      const response = await fetch(url.href, {
        signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store', headers,
      });
      return { controller, response, dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  }

  function redirectedSourceURL(response, url, redirect) {
    if (redirect === MAX_REDIRECTS) throw new Error('规则源重定向次数过多');
    const location = response.headers.get('location');
    if (!location) throw new Error('规则源重定向缺少 Location');
    return checkedRemoteURL(new URL(location, url).href);
  }

  async function readBoundedBody(response, budget, maxBytes) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && (declared > maxBytes || budget.bytes + declared > MAX_TOTAL_BYTES)) {
      throw new Error('规则源响应超过大小上限');
    }
    if (!response.body) throw new Error('规则源响应没有正文');
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        budget.bytes += value.byteLength;
        if (length > maxBytes || budget.bytes > MAX_TOTAL_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error('规则源响应超过大小上限');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  async function fetchBounded(rawURL, budget, options = {}, updateSignal) {
    let url = checkedRemoteURL(rawURL);
    const maxBytes = Math.min(options.maxBytes || MAX_FILE_BYTES, MAX_FILE_BYTES);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      throwIfAborted(updateSignal);
      const request = await requestSource(url, options, redirect === 0, updateSignal);
      const { controller, response } = request;
      try {
        if (response.status === 304) return { notModified: true, url: url.href };
        if (response.status >= 300 && response.status < 400) {
          url = redirectedSourceURL(response, url, redirect);
          continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return {
          text: await readBoundedBody(response, budget, maxBytes), url: url.href,
          etag: response.headers.get('etag') || '',
          lastModified: response.headers.get('last-modified') || '',
        };
      } finally {
        controller.abort();
        request.dispose();
      }
    }
    throw new Error('规则源下载失败');
  }

  async function mapConcurrent(items, worker, signal) {
    let nextIndex = 0;
    const out = new Array(items.length);
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, async () => {
      while (nextIndex < items.length) {
        throwIfAborted(signal);
        const index = nextIndex++;
        out[index] = await worker(items[index]);
      }
    }));
    return out;
  }

  function parsedJSON(text, label) {
    try { return JSON.parse(text); } catch (error) { throw new Error(`${label} JSON 无效：${error.message}`); }
  }

  async function convertWappalyzer(entries, signal) {
    const rules = [];
    for (let offset = 0; offset < entries.length; offset += 500) {
      throwIfAborted(signal);
      const chunk = Object.fromEntries(entries.slice(offset, offset + 500));
      const result = await GoPainterRulesHost.handlers.convertWappalyzer({ techJSON: JSON.stringify(chunk) });
      rules.push(...(result.rules || []));
    }
    return rules;
  }

  async function convertEHole(fingers, signal) {
    const rules = [];
    for (let offset = 0; offset < fingers.length; offset += 100) {
      throwIfAborted(signal);
      const result = await GoPainterRulesHost.handlers.convertEHole({
        fingerJSON: JSON.stringify(fingers.slice(offset, offset + 100)),
      });
      rules.push(...(result.rules || []));
    }
    return GoPainterUtils.mergeConvertedRules(rules);
  }

  async function normalizeDocs(docs, signal) {
    const rules = [];
    for (let offset = 0; offset < docs.length; offset += 100) {
      throwIfAborted(signal);
      const result = await GoPainterRulesHost.handlers.normalizeRules({
        docsJSON: JSON.stringify(docs.slice(offset, offset + 100)),
      });
      rules.push(...(result.rules || []));
    }
    return rules;
  }

  async function fetchWappalyzer(def, meta, budget, signal) {
    const manifest = await fetchBounded(def.manifest, budget, {
      maxBytes: 2 * 1024 * 1024, etag: meta.etag, lastModified: meta.lastModified,
    }, signal);
    if (manifest.notModified) return manifest;
    const files = parsedJSON(manifest.text, 'Wappalyzer 目录')
      .filter((entry) => entry.type === 'file' && /^[_a-z]\.json$/i.test(entry.name) && entry.download_url);
    if (!files.length || files.length > 64) throw new Error('Wappalyzer 文件列表异常');
    budget.files += files.length;
    const documents = await mapConcurrent(files, async (file) => {
      const response = await fetchBounded(file.download_url, budget, {}, signal);
      return parsedJSON(response.text, file.name);
    }, signal);
    const technologies = Object.assign({}, ...documents);
    return { ...manifest, rules: await convertWappalyzer(Object.entries(technologies), signal) };
  }

  async function fetchEHole(def, meta, budget, signal) {
    const response = await fetchBounded(def.manifest, budget, {
      etag: meta.etag, lastModified: meta.lastModified,
    }, signal);
    if (response.notModified) return response;
    let fingers = parsedJSON(response.text, 'EHole');
    if (!Array.isArray(fingers)) fingers = fingers?.fingerprint;
    if (!Array.isArray(fingers)) throw new Error('EHole fingerprint 不是数组');
    return { ...response, rules: await convertEHole(fingers, signal) };
  }

  async function fetchNuclei(def, meta, budget, signal) {
    const manifest = await fetchBounded(def.manifest, budget, {
      maxBytes: 2 * 1024 * 1024, etag: meta.etag, lastModified: meta.lastModified,
    }, signal);
    if (manifest.notModified) return manifest;
    const files = parsedJSON(manifest.text, 'nuclei 目录')
      .filter((entry) => entry.type === 'file' && /\.ya?ml$/i.test(entry.name) && entry.download_url);
    if (!files.length || files.length > MAX_FILES) throw new Error('nuclei 文件列表异常');
    budget.files += files.length;
    const documentLists = await mapConcurrent(files, async (file) => {
      const response = await fetchBounded(file.download_url, budget, {}, signal);
      const docs = [];
      jsyaml.loadAll(response.text, (doc) => { if (doc) docs.push(doc); });
      return docs;
    }, signal);
    return { ...manifest, rules: await normalizeDocs(documentLists.flat(), signal) };
  }

  async function contentHash(rules) {
    const bytes = new TextEncoder().encode(JSON.stringify(rules));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  }

  function openBackupDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('gopainter-rule-source-backups', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('backups');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function backupOperation(mode, sourceId, value) {
    const db = await openBackupDB();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('backups', mode);
        const store = transaction.objectStore('backups');
        const request = value === undefined ? store.get(sourceId) : store.put(value, sourceId);
        let result;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error || request.error);
        transaction.onabort = () => reject(transaction.error || new Error('规则源备份事务已中止'));
      });
    } finally {
      db.close();
    }
  }

  function saveBackup(sourceId, rules) {
    return backupOperation('readwrite', sourceId, { rules, at: Date.now() });
  }

  function loadBackup(sourceId) {
    return backupOperation('readonly', sourceId);
  }

  async function performUpdate(sourceId, signal) {
    const def = SOURCE_DEFS[sourceId];
    if (!def) throw new Error('未知规则源');
    await GoPainterRulesHost.handlers.reconcileSourceRuleSet({
      id: def.ruleSetId,
      name: def.name,
      legacyRuleSetIds: def.legacyRuleSetIds,
      legacyRuleSetNames: def.legacyRuleSetNames,
    });
    const state = await loadState();
    const meta = state[sourceId];
    const checkedAt = Date.now();
    const budget = { bytes: 0, files: 1 };
    let fetched;
    if (sourceId === 'wappalyzer') fetched = await fetchWappalyzer(def, meta, budget, signal);
    else if (sourceId === 'ehole') fetched = await fetchEHole(def, meta, budget, signal);
    else fetched = await fetchNuclei(def, meta, budget, signal);
    if (fetched.notModified) {
      const next = await patchMeta(sourceId, { lastCheckedAt: checkedAt, lastError: '' });
      return { ok: true, unchanged: true, source: next };
    }
    const rules = fetched.rules || [];
    if (!rules.length || rules.length > MAX_RULES) throw new Error(`转换后的规则数量异常：${rules.length}`);
    throwIfAborted(signal);
    const hash = await contentHash(rules);
    if (hash === meta.contentHash) {
      const next = await patchMeta(sourceId, {
        lastCheckedAt: checkedAt, lastError: '', etag: fetched.etag, lastModified: fetched.lastModified,
      });
      return { ok: true, unchanged: true, source: next };
    }
    throwIfAborted(signal);
    const applied = await GoPainterRulesHost.replaceSourceRuleSet(
      { id: def.ruleSetId, name: def.name, rules },
      (previousRules) => saveBackup(sourceId, previousRules)
    );
    const next = await patchMeta(sourceId, {
      lastCheckedAt: checkedAt, lastUpdatedAt: Date.now(), lastError: '', ruleCount: rules.length,
      etag: fetched.etag, lastModified: fetched.lastModified, contentHash: hash,
      canRollback: applied.previousCount > 0, lastSummary: applied.summary,
    });
    return { ok: true, unchanged: false, summary: applied.summary, source: next };
  }

  function updateSource(sourceId) {
    if (!SOURCE_DEFS[sourceId]) return Promise.reject(new Error('未知规则源'));
    if (running.has(sourceId)) return running.get(sourceId);
    const controller = new AbortController();
    const operation = serializeSourceOperation(async () => {
      try {
        return await performUpdate(sourceId, controller.signal);
      } catch (error) {
        controller.abort();
        await patchMeta(sourceId, { lastCheckedAt: Date.now(), lastError: String(error.message || error) });
        throw error;
      }
    });
    const task = operation.finally(() => {
      controller.abort();
      running.delete(sourceId);
    });
    running.set(sourceId, task);
    return task;
  }

  async function overview() {
    const state = await loadState();
    return {
      ok: true,
      sources: Object.values(SOURCE_DEFS).map((def) => ({ ...state[def.id], running: running.has(def.id) })),
    };
  }

  async function syncAlarm() {
    const state = await loadState();
    const needed = Object.values(state).some((source) => source.autoUpdate);
    const current = await chrome.alarms.get(ALARM_NAME);
    if (needed && !current) await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 5, periodInMinutes: 60 });
    if (!needed && current) await chrome.alarms.clear(ALARM_NAME);
  }

  async function reconcileKnownSourceRuleSets() {
    for (const def of Object.values(SOURCE_DEFS)) {
      await GoPainterRulesHost.handlers.reconcileSourceRuleSet({
        id: def.ruleSetId,
        name: def.name,
        legacyRuleSetIds: def.legacyRuleSetIds,
        legacyRuleSetNames: def.legacyRuleSetNames,
      });
    }
  }

  async function setAutoUpdate({ sourceId, enabled, intervalHours }) {
    if (!SOURCE_DEFS[sourceId]) throw new Error('未知规则源');
    const interval = Math.min(168, Math.max(6, Number.parseInt(intervalHours, 10) || 24));
    const source = await patchMeta(sourceId, { autoUpdate: Boolean(enabled), intervalHours: interval });
    await syncAlarm();
    return { ok: true, source };
  }

  async function performRollback(sourceId) {
    const def = SOURCE_DEFS[sourceId];
    const backup = await loadBackup(sourceId);
    if (!backup?.rules?.length) throw new Error('没有可回滚的规则版本');
    const applied = await GoPainterRulesHost.replaceSourceRuleSet(
      { id: def.ruleSetId, name: def.name, rules: backup.rules },
      (currentRules) => saveBackup(sourceId, currentRules)
    );
    const hash = await contentHash(backup.rules);
    const source = await patchMeta(sourceId, {
      lastUpdatedAt: Date.now(), lastError: '', ruleCount: backup.rules.length,
      contentHash: hash, canRollback: true, lastSummary: applied.summary,
      etag: '', lastModified: '',
    });
    return { ok: true, summary: applied.summary, source };
  }

  function rollback({ sourceId }) {
    if (!SOURCE_DEFS[sourceId]) return Promise.reject(new Error('未知规则源'));
    return serializeSourceOperation(() => performRollback(sourceId));
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    (async () => {
      const state = await loadState();
      for (const source of Object.values(state)) {
        if (!source.autoUpdate || Date.now() - source.lastCheckedAt < source.intervalHours * 3_600_000) continue;
        await updateSource(source.id).catch(() => {});
      }
    })();
  });

  reconcileKnownSourceRuleSets().catch((error) => console.warn('整理旧规则源规则集失败:', error));
  syncAlarm().catch(() => {});

  globalThis.GoPainterSourceHost = Object.freeze({
    handlers: Object.freeze({
      getRuleSources: overview,
      refreshRuleSource: ({ sourceId }) => updateSource(sourceId),
      setRuleSourceAutoUpdate: setAutoUpdate,
      rollbackRuleSource: rollback,
    }),
  });
})();
