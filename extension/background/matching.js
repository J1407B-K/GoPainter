// Feature enrichment, rule matching, hash lookup, user scripts, and rescans.

const MAX_ICON_BYTES = 200_000;
const MAX_ICON_URLS = 64;
const MAX_ICON_FETCH_CONCURRENCY = 6;
const MAX_ICON_FETCH_QUEUE = 256;
const MAX_ICON_REDIRECTS = 3;
const ICON_BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);
let activeIconFetches = 0;
const iconFetchQueue = [];

function iconTaskIsStale(isStale) {
  try { return Boolean(isStale?.()); } catch { return true; }
}

function ipv4IsBlocked(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  const [a, b, c] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && [0, 2].includes(c))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function ipAddressIsBlocked(rawAddress) {
  const address = String(rawAddress || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const ipv4 = ipv4IsBlocked(address);
  if (ipv4 !== null) return ipv4;
  if (!address.includes(':')) return true;
  if (address === '::' || address === '::1' || address.startsWith('fc') || address.startsWith('fd')
    || /^fe[89ab]/.test(address) || address.startsWith('ff') || address.startsWith('2001:db8:')
    || address.includes('::ffff:')) return true;
  const embedded = address.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return embedded ? ipv4IsBlocked(embedded) !== false : false;
}

function publicIconURL(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!hostname || ICON_BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa')) return null;
  const ipv4 = ipv4IsBlocked(hostname);
  if (ipv4 === true || (hostname.includes(':') && ipAddressIsBlocked(hostname))) return null;
  return url;
}

function drainIconHashQueue() {
  while (activeIconFetches < MAX_ICON_FETCH_CONCURRENCY && iconFetchQueue.length) {
    const job = iconFetchQueue.shift();
    if (iconTaskIsStale(job.isStale)) {
      job.resolve(0);
      continue;
    }
    activeIconFetches++;
    hashIconUrl(job.url, job.isStale).then(job.resolve, () => job.resolve(0)).finally(() => {
      activeIconFetches--;
      drainIconHashQueue();
    });
  }
}

function discardStaleIconJobs() {
  for (let index = iconFetchQueue.length - 1; index >= 0; index--) {
    const job = iconFetchQueue[index];
    if (!iconTaskIsStale(job.isStale)) continue;
    iconFetchQueue.splice(index, 1);
    job.resolve(0);
  }
}

function queueIconHash(url, isStale) {
  discardStaleIconJobs();
  if (iconTaskIsStale(isStale)) return Promise.resolve(0);
  if (iconFetchQueue.length >= MAX_ICON_FETCH_QUEUE) return Promise.resolve(0);
  return new Promise((resolve) => {
    iconFetchQueue.push({ url, isStale, resolve });
    drainIconHashQueue();
  });
}

async function readBoundedIcon(response, isStale) {
  const contentLength = Number(response.headers.get('content-length'));
  if (iconTaskIsStale(isStale) || (Number.isFinite(contentLength) && contentLength > MAX_ICON_BYTES)) return null;
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      if (iconTaskIsStale(isStale)) {
        await reader.cancel();
        return null;
      }
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_ICON_BYTES) {
        await reader.cancel();
        return null;
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
  return bytes;
}

async function hashIconUrl(url, isStale) {
  let current = publicIconURL(url);
  if (!current || iconTaskIsStale(isStale)) return 0;
  // 坏 icon 域可能一直不响应，没有超时整次扫描会被挂住
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  const staleTimer = isStale && setInterval(() => {
    if (iconTaskIsStale(isStale)) ctrl.abort();
  }, 100);
  try {
    let resp;
    for (let redirects = 0; redirects <= MAX_ICON_REDIRECTS; redirects++) {
      if (iconTaskIsStale(isStale)) return 0;
      resp = await fetch(current.href, { signal: ctrl.signal, redirect: 'manual', credentials: 'omit' });
      if (iconTaskIsStale(isStale)) return 0;
      if (resp.status < 300 || resp.status >= 400) break;
      if (redirects === MAX_ICON_REDIRECTS) return 0;
      const location = resp.headers.get('location');
      if (!location) return 0;
      current = publicIconURL(new URL(location, current).href);
      if (!current) return 0;
    }
    if (!resp.ok) return 0;
    const buf = await readBoundedIcon(resp, isStale);
    if (!buf) return 0;
    // btoa 要求每个字符保留原始字节值；不要用 TextDecoder('latin1')，
    // 浏览器将该标签映射到 Windows-1252，会改写 0x80-0x9f 等字节。
    const bin = GoPainterUtils.bytesToBinaryString(buf);
    // fofa 标准是 python codecs.encode 出来的 base64，每 76 个字符折行
    const b64 = btoa(bin).replace(/.{76}/g, '$&\n') + '\n';
    await ensureWasm();
    return globalThis.goMmh3(b64);
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
    if (staleTimer) clearInterval(staleTimer);
  }
}

// 每个页面只取有限个 icon；匹配是 best-effort，不能让页面把扩展变成无界下载器。
async function hashIcons(urls, isStale) {
  const hashes = new Set();
  const unique = [];
  const seen = new Set();
  for (const url of Array.isArray(urls) ? urls : []) {
    if (unique.length >= MAX_ICON_URLS) break;
    const parsed = typeof url === 'string' ? publicIconURL(url) : null;
    if (!parsed || seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    unique.push(parsed.href);
  }
  const values = await Promise.all(unique.map((url) => queueIconHash(url, isStale)));
  for (const hash of values) if (hash) hashes.add(hash);
  return [...hashes];
}

// 从原始 HTML 里补 title/meta/scripts/favicons，wasm 挂了也不影响主流程
async function enrichFeatures(features) {
  try {
    await ensureWasm();
    const ex = JSON.parse(globalThis.goExtractFeatures(features.body || ''));
    if (!features.title && ex.title) features.title = ex.title;
    // HTML 里的 href 可能是相对路径，全部转绝对
    const favicons = (ex.favicons || [])
      .map((h) => { try { return new URL(h, features.url).href; } catch { return null; } })
      .filter(Boolean);
    features.favicons = [...new Set([...(features.favicons || []), ...favicons])];
    if (!features.favicon) features.favicon = features.favicons[0] || '';
    features.meta = ex.meta || {};
    features.scripts = ex.scripts || [];
    features.links = ex.links || [];
  } catch {
    features.meta = features.meta || {};
    features.scripts = features.scripts || [];
    features.links = features.links || [];
    features.favicons = features.favicons || [];
  }
  return features;
}

// 序列化后的 rules JSON 缓存：重扫/爬虫对同一规则集反复调 goMatch，省得每次
// 都 JSON.stringify 上万条规则。规则一变在 storage.onChanged 里置空。
let rulesJsonCache = null;
let rulesGeneration = 0;

async function getRulesJSON() {
  while (true) {
    const generation = rulesGeneration;
    if (rulesJsonCache?.generation === generation) return rulesJsonCache.json;
    const { rules = [] } = await chrome.storage.local.get('rules');
    // storage.onChanged may have invalidated us while get() was pending. Do not let
    // an old read repopulate the cache; re-read against the new generation instead.
    if (generation !== rulesGeneration) continue;
    const json = JSON.stringify(rules);
    rulesJsonCache = { generation, json };
    return json;
  }
}

// 重复页面匹配缓存：相同 features（完整匹配输入）直接复用 goMatch 输出。
// 正确率优先——key 是传给 goMatch 的完整 featuresJSON 字符串，字符串值相等意味着
// 所有匹配输入（body/title/url/headers/status/meta/scripts/faviconHashes/js/domHits）
// 都相同，输出必然相同，零冲突。规则/哈希库变更时整个清空（storage.onChanged）。
const MATCH_CACHE_MAX = 10;
let matchCache = new Map(); // featuresJSON -> { hits }

async function runMatch(features) {
  const rulesJSON = await getRulesJSON();
  if (rulesJSON === '[]') return { hits: [], note: 'no_rules' };
  await ensureWasm();
  const featuresJSON = JSON.stringify(features);
  // 重复页面：命中返回数组副本（元素只读共享），调用方 push/追加不会污染缓存
  const cached = matchCache.get(featuresJSON);
  if (Array.isArray(cached?.hits)) {
    return { hits: cached.hits.slice() };
  }
  if (cached) matchCache.delete(featuresJSON);
  let out;
  try {
    out = JSON.parse(globalThis.goMatch(rulesJSON, featuresJSON));
  } catch (error) {
    throw new Error(`匹配引擎返回无效 JSON：${error?.message || error}`);
  }
  if (!Array.isArray(out?.hits)) {
    throw new Error(typeof out?.error === 'string' && out.error
      ? out.error
      : '匹配引擎返回无效结果：缺少 hits 数组');
  }
  // 缓存 goMatch 原始输出的副本；调用方 appendHashHit 会改返回的 out.hits。
  matchCache.set(featuresJSON, { hits: out.hits.slice() });
  if (matchCache.size > MATCH_CACHE_MAX) {
    // Map 保持插入序，删最老的
    matchCache.delete(matchCache.keys().next().value);
  }
  return out;
}

// 仅供 Service Worker 控制台手动调用的 regex 后端 A/B 基准，不进入正常扫描路径。
// 用法：await benchRegexBackend()；可选 benchRegexBackend(50, tabId)。
// 它复用该 tab 已采集的完整 features（含 js/dom probe），直接调用 goMatch，绕开
// matchCache，因而测的是 rules JSON + WASM 匹配引擎；不包含网络、DOM 采集或 favicon。
async function benchRegexBackend(rounds = 30, tabId) {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 200) {
    throw new Error('rounds 必须是 1–200 的整数');
  }
  const session = await chrome.storage.session.get(null);
  let stored;
  if (!Number.isInteger(tabId)) {
    // SW DevTools 打开时它会抢走 lastFocusedWindow，不能依赖“当前窗口”。先在所有
    // 浏览器窗口的 active tab 中找已有 features；再回退到最近完成的一次页面扫描。
    const activeTabs = await chrome.tabs.query({ active: true });
    const candidates = activeTabs
      .map((tab) => ({ tabId: tab.id, stored: session[`result:${tab.id}`] }))
      .filter((x) => x.stored?.features);
    if (candidates.length) {
      candidates.sort((a, b) => (b.stored.at || 0) - (a.stored.at || 0));
      ({ tabId, stored } = candidates[0]);
    } else {
      const latest = Object.entries(session)
        .filter(([key, value]) => key.startsWith('result:') && value?.features)
        .sort(([, a], [, b]) => (b.at || 0) - (a.at || 0))[0];
      if (latest) {
        tabId = Number(latest[0].slice('result:'.length));
        stored = latest[1];
      }
    }
  } else {
    stored = session[`result:${tabId}`];
  }
  if (!Number.isInteger(tabId) || !stored?.features) {
    throw new Error('没有已采集的页面 features；先正常扫描一次页面，或传入 tabId');
  }
  const rulesJSON = await getRulesJSON();
  if (rulesJSON === '[]') throw new Error('当前没有规则');
  await ensureWasm();

  const featuresJSON = JSON.stringify(stored.features);
  const one = () => {
    const t0 = performance.now();
    const out = JSON.parse(globalThis.goMatch(rulesJSON, featuresJSON));
    return { ms: performance.now() - t0, hits: out.hits?.length || 0 };
  };
  // first 是本次直接调用的首轮，可能已因正常扫描预热规则缓存；冷启动请重载扩展后立即调用。
  const first = one();
  const samples = [];
  const hitCount = first.hits;
  for (let i = 0; i < rounds; i++) {
    const result = one();
    samples.push(result.ms);
    if (result.hits !== hitCount) {
      throw new Error(`第 ${i + 1} 轮命中数变化：${hitCount} → ${result.hits}`);
    }
  }
  samples.sort((a, b) => a - b);
  const percentile = (q) => samples[Math.round((samples.length - 1) * q)];
  const report = {
    backend: globalThis.goRegexBackend?.() || 'unknown',
    tabId,
    rulesKB: Math.round(rulesJSON.length / 1024),
    bodyKB: Math.round((stored.features.body || '').length / 1024),
    hits: hitCount,
    firstMs: Number(first.ms.toFixed(1)),
    rounds,
    minMs: Number(samples[0].toFixed(1)),
    p50Ms: Number(percentile(0.50).toFixed(1)),
    p90Ms: Number(percentile(0.90).toFixed(1)),
    p99Ms: Number(percentile(0.99).toFixed(1)),
    maxMs: Number(samples[samples.length - 1].toFixed(1)),
  };
  console.info('[regex-backend-bench]', report);
  return report;
}

// favicon 哈希库命中也当成一个指纹，并进 hits（规则命中优先，同名的不重复加）
function faviconHashValues(features) {
  return GoPainterUtils.faviconHashValues(features);
}

async function appendHashHit(features, result) {
  const hashes = faviconHashValues(features);
  if (!hashes.length) return result;
  try {
    await ensureWasm();
    const customHashesJSON = await getCustomHashesJSON();
    result.hits = result.hits || [];
    const seenNames = new Set(result.hits.map((h) => h.name).filter(Boolean));
    for (const hash of hashes) {
      const hit = JSON.parse(globalThis.goHashLookup(hash, customHashesJSON));
      if (hit.name && !seenNames.has(hit.name)) {
        result.hits.push({
          id: `icon-${hash}`,
          name: hit.name,
          source: 'hash',
          evidence: [{ type: 'icon_hash', detail: `mmh3 ${hash}（哈希库）` }],
        });
        seenNames.add(hit.name);
        delete result.note;
      }
    }
  } catch { /* 查库失败不影响规则结果 */ }
  return result;
}

let customHashesJsonCache = null;
async function getCustomHashesJSON() {
  if (customHashesJsonCache === null) {
    const { customHashes = {} } = await chrome.storage.local.get('customHashes');
    customHashesJsonCache = JSON.stringify(customHashes);
  }
  return customHashesJsonCache;
}

// 规则/哈希库变动 → 自动重扫所有已打开的 tab。
let rescanTimer = null;
let probeCache = null; // 规则里的 js/dom 探测清单，规则变了就失效

function invalidateRuleMatchingCaches() {
  rulesGeneration++;
  probeCache = null;
  rulesJsonCache = null;
  matchCache.clear();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.customHashes) customHashesJsonCache = null;
  if (!changes.rules && !changes.customHashes) return;
  if (changes.rules) invalidateRuleMatchingCaches();
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(rescanAllTabs, 500); // 防抖，连续导入合并成一次
});

// Live rule editing needs deterministic invalidation before it asks the current
// tab to collect newly introduced JS paths or DOM selectors. storage.onChanged
// remains the fallback for every other mutation path.
globalThis.invalidateRuleMatchingCaches = invalidateRuleMatchingCaches;

async function rescanAllTabs() {
  const tabs = await chrome.tabs.query({});
  const keys = tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => `result:${tab.id}`);
  if (!keys.length) return;
  const stored = await chrome.storage.session.get(keys);
  for (const key of keys) {
    const val = stored[key];
    if (!val?.features) continue;
    const tabId = Number(key.slice(7));
    const navigationVersion = currentNavigationVersion(tabId);
    try {
      // 不要用上一次导航留下的缓存去改当前页面的图标。
      if (!(await isCurrentTabPage(tabId, val.features.url, navigationVersion))) continue;
      const result = await appendHashHit(val.features, await runMatch(val.features));
      if (!(await isCurrentTabPage(tabId, val.features.url, navigationVersion))) continue;
      await storePageSession(tabId, val.features, result, val.at);
      await updateIcon(tabId, result.hits?.length || 0);
    } catch { /* 单个 tab 重扫失败就算了 */ }
  }
}

async function getProbeList() {
  while (true) {
    const generation = rulesGeneration;
    if (probeCache?.generation === generation) return probeCache.plan;
    const { rules = [] } = await chrome.storage.local.get('rules');
    await ensureWasm();
    const planned = JSON.parse(globalThis.goPlanRequiredProbes(JSON.stringify(rules)));
    if (planned.error) throw new Error(planned.error);
    const paths = Array.isArray(planned.paths) ? planned.paths : [];
    const probes = Array.isArray(planned.probes) ? planned.probes : [];
    if (generation !== rulesGeneration) continue;
    const plan = { paths, probes, byId: new Map(probes.map((p) => [p.id, p.sel])) };
    probeCache = { generation, plan };
    return plan;
  }
}

// 命中的 probe id 反查回选择器，给 AI 用（id 是黑盒，AI 看不懂）
async function matchedDomSelectors(features) {
  if (!features?.domHits) return [];
  const list = await getProbeList();
  return Object.keys(features.domHits)
    .map((id) => list.byId.get(id))
    .filter(Boolean);
}
