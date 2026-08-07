// Feature enrichment, rule matching, hash lookup, user scripts, and rescans.

async function hashIconUrl(url) {
  if (!url || !/^https?:/.test(url)) return 0;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return 0;
    const buf = new Uint8Array(await resp.arrayBuffer());
    let bin = '';
    for (const b of buf) bin += String.fromCharCode(b);
    // fofa 标准是 python codecs.encode 出来的 base64，每 76 个字符折行
    const b64 = btoa(bin).replace(/.{76}/g, '$&\n') + '\n';
    await ensureWasm();
    return globalThis.goMmh3(b64);
  } catch {
    return 0;
  }
}

// 一组 icon URL 全部算哈希，去重去 0。一个站点挂几个 icon 就匹配几个
async function hashIcons(urls) {
  const hashes = new Set();
  const unique = [...new Set(urls)].slice(0, 8); // 防个页面满天飞 icon
  await Promise.all(unique.map(async (u) => {
    const h = await hashIconUrl(u);
    if (h) hashes.add(h);
  }));
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

async function runMatch(features) {
  const { rules = [] } = await chrome.storage.local.get('rules');
  if (rules.length === 0) return { hits: [], note: 'no_rules' };
  await ensureWasm();
  return JSON.parse(globalThis.goMatch(JSON.stringify(rules), JSON.stringify(features)));
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
    const { customHashes = {} } = await chrome.storage.local.get('customHashes');
    result.hits = result.hits || [];
    const seenNames = new Set(result.hits.map((h) => h.name).filter(Boolean));
    for (const hash of hashes) {
      const hit = JSON.parse(globalThis.goHashLookup(hash, JSON.stringify(customHashes)));
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

// 外接脚本：规则匹配之后执行，脚本返回要追加的指纹。
async function runUserScripts(features, hits) {
  const { userScripts = [] } = await chrome.storage.local.get('userScripts');
  const out = [...(hits || [])];
  const seen = new Set(out.map((h) => h.id || h.name).filter(Boolean));
  for (const s of userScripts) {
    if (!s.enabled) continue;
    try {
      const fn = new Function('features', 'hits', s.code);
      const extra = fn(features, out);
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

// 规则/哈希库变动 → 自动重扫所有已打开的 tab。
let rescanTimer = null;
let probeCache = null; // 规则里的 js/dom 探测清单，规则变了就失效

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.rules && !changes.customHashes)) return;
  probeCache = null;
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(rescanAllTabs, 500); // 防抖，连续导入合并成一次
});

async function rescanAllTabs() {
  const all = await chrome.storage.session.get(null);
  for (const [key, val] of Object.entries(all)) {
    if (!key.startsWith('result:') || !val?.features) continue;
    const tabId = Number(key.slice(7));
    try {
      const result = await appendHashHit(val.features, await runMatch(val.features));
      result.hits = await runUserScripts(val.features, result.hits);
      await chrome.storage.session.set({ [key]: { ...val, result } });
      await updateIcon(tabId, result.hits?.length || 0);
    } catch { /* 单个 tab 重扫失败就算了 */ }
  }
}

async function getProbeList() {
  if (!probeCache) {
    const { rules = [] } = await chrome.storage.local.get('rules');
    const paths = new Set(), domMap = new Map(); // sel+条件 JSON → probe
    for (const r of rules) {
      for (const m of r.matchers || []) {
        if (m.type === 'js') for (const p of m.js || []) paths.add(p.path);
        if (m.type === 'dom') {
          for (const s of m.words || []) domMap.set(s, { sel: s });
          for (const p of m.dom || []) domMap.set(JSON.stringify(p), p);
        }
      }
    }
    probeCache = { paths: [...paths], selectors: [...domMap.values()] };
  }
  return probeCache;
}
