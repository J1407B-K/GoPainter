// Feature enrichment, rule matching, hash lookup, user scripts, and rescans.

async function hashIconUrl(url) {
  if (!url || !/^https?:/.test(url)) return 0;
  // 坏 icon 域可能一直不响应，没有超时整次扫描会被挂住
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return 0;
    const buf = new Uint8Array(await resp.arrayBuffer());
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
  }
}

// 一组 icon URL 全部算哈希，去重去 0。不能限制数量：网络中后到的任一图标
// 都可能正好是规则或哈希库要命中的那个。
async function hashIcons(urls) {
  const hashes = new Set();
  const unique = [...new Set(urls)];
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const u = unique[next++];
      const h = await hashIconUrl(u);
      if (h) hashes.add(h);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, unique.length) }, worker));
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

async function getRulesJSON() {
  if (rulesJsonCache === null) {
    const { rules = [] } = await chrome.storage.local.get('rules');
    rulesJsonCache = JSON.stringify(rules);
  }
  return rulesJsonCache;
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
  if (cached) {
    return { hits: cached.hits.slice() };
  }
  const out = JSON.parse(globalThis.goMatch(rulesJSON, featuresJSON));
  // 缓存 goMatch 原始输出的副本；调用方（appendHashHit/userScripts）会改返回的 out.hits
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

// 外接脚本：规则匹配之后执行，脚本返回要追加的指纹。
async function runUserScripts(features, hits) {
  const scripts = await getCompiledUserScripts();
  const out = [...(hits || [])];
  const seen = new Set(out.map((h) => h.id || h.name).filter(Boolean));
  for (const s of scripts) {
    try {
      const extra = s.fn(features, out);
      if (Array.isArray(extra)) {
        for (const h of extra) {
          const key = h?.id || h?.name;
          if (h?.id && h?.name && !seen.has(key)) {
            out.push(h);
            seen.add(key);
          }
        }
      }
    } catch (e) {
      console.warn(`用户脚本「${s.name}」执行失败:`, e);
    }
  }
  return out;
}

let compiledUserScriptsCache = null;
async function getCompiledUserScripts() {
  if (compiledUserScriptsCache) return compiledUserScriptsCache;
  const { userScripts = [] } = await chrome.storage.local.get('userScripts');
  compiledUserScriptsCache = userScripts.filter((s) => s.enabled).flatMap((s) => {
    try {
      return [{ id: s.id, name: s.name, fn: new Function('features', 'hits', s.code) }];
    } catch (e) {
      console.warn(`用户脚本「${s.name}」编译失败:`, e);
      return [];
    }
  });
  return compiledUserScriptsCache;
}

// 规则/哈希库变动 → 自动重扫所有已打开的 tab。
let rescanTimer = null;
let probeCache = null; // 规则里的 js/dom 探测清单，规则变了就失效

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.userScripts) compiledUserScriptsCache = null;
  if (changes.customHashes) customHashesJsonCache = null;
  if (!changes.rules && !changes.customHashes && !changes.userScripts) return;
  if (changes.rules) {
    probeCache = null;
    rulesJsonCache = null;
    matchCache.clear();
  }
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(rescanAllTabs, 500); // 防抖，连续导入合并成一次
});

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
      result.hits = await runUserScripts(val.features, result.hits);
      if (!(await isCurrentTabPage(tabId, val.features.url, navigationVersion))) continue;
      await chrome.storage.session.set({
        [key]: { ...val, result },
        ...popupResultEntry(tabId, val.features, result, val.at),
      });
      await updateIcon(tabId, result.hits?.length || 0);
    } catch { /* 单个 tab 重扫失败就算了 */ }
  }
}

async function getProbeList() {
  if (!probeCache) {
    const { rules = [] } = await chrome.storage.local.get('rules');
    const paths = new Set(), probeMap = new Map(); // probe id → probe（含 id）
    const add = (p) => {
      const id = probeId(p);
      if (!probeMap.has(id)) probeMap.set(id, { id, ...p });
    };
    for (const r of rules) {
      for (const m of r.matchers || []) {
        if (m.type === 'js') for (const p of m.js || []) paths.add(p.path);
        if (m.type === 'dom') {
          for (const s of m.words || []) add({ sel: s });
          for (const p of m.dom || []) add(p);
        }
      }
    }
    const probes = [...probeMap.values()];
    probeCache = { paths: [...paths], probes, byId: new Map(probes.map((p) => [p.id, p.sel])) };
  }
  return probeCache;
}

// dom probe → 稳定 id。与 wasm 侧 probeID 用同一套字节序列 + FNV-1a，
// 两边算出的 id 必须一致，content.js 才认。attrs 键排序后拼，顺序不影响 id。
function probeId(p) {
  const keys = Object.keys(p.attrs || {}).sort();
  const s = p.sel + '\u0000' + (p.text || '') + '\u0000' +
    keys.map((k) => `${k}=${p.attrs[k]}`).join('\u0001');
  const bytes = new TextEncoder().encode(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'dom:' + h.toString(16).padStart(8, '0');
}

// 命中的 probe id 反查回选择器，给 AI 用（id 是黑盒，AI 看不懂）
async function matchedDomSelectors(features) {
  if (!features?.domHits) return [];
  const list = await getProbeList();
  return Object.keys(features.domHits)
    .map((id) => list.byId.get(id))
    .filter(Boolean);
}
