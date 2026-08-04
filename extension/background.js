// GoPainter service worker
// MV3 的 SW 会被浏览器随时回收，状态要么放 chrome.storage，要么能惰性重建（比如 wasm 实例）。
// 纯计算（匹配/mmh3/HTML 提取/规则规范化）都在 wasm 里，这里只做 I/O 和编排。

importScripts('wasm/wasm_exec.js', 'lib/js-yaml.min.js');

// --- wasm 引擎 ---

let wasmReady = null;

function ensureWasm() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const go = new Go();
      const resp = await fetch(chrome.runtime.getURL('wasm/matcher.wasm'));
      const { instance } = await WebAssembly.instantiateStreaming(resp, go.importObject);
      go.run(instance); // 不会返回，Go 那边 select{} 常驻
      if (typeof globalThis.goMatch !== 'function') {
        throw new Error('wasm 加载了但 goMatch 没注册上');
      }
    })();
    wasmReady.catch(() => { wasmReady = null; }); // 失败了下次重试
  }
  return wasmReady;
}

// --- 响应头采集 ---

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
  chrome.storage.session.remove(`result:${tabId}`);
});

// --- 图标：灰色 = 没命中，彩色 + 角标 = 有命中 ---

const ICONS = (state) => ({
  16: `icons/icon16${state}.png`,
  32: `icons/icon32${state}.png`,
  48: `icons/icon48${state}.png`,
  128: `icons/icon128${state}.png`,
});

async function updateIcon(tabId, hitCount) {
  if (tabId == null || tabId < 0) return;
  const matched = hitCount > 0;
  await chrome.action.setIcon({ tabId, path: ICONS(matched ? '' : '-gray') });
  await chrome.action.setBadgeText({ tabId, text: matched ? String(hitCount) : '' });
  if (matched) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#6366f1' });
  }
}

// 开始跳新页面先回灰色，等 content script 报特征过来再更新
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    updateIcon(tabId, 0).catch(() => {});
  }
});

// --- 特征补全：favicon 哈希 + HTML 提取，都在 wasm 里算 ---

async function faviconHash(url) {
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

// 从原始 HTML 里补 title/meta/scripts，wasm 挂了也不影响主流程
async function enrichFeatures(features) {
  try {
    await ensureWasm();
    const ex = JSON.parse(globalThis.goExtractFeatures(features.body || ''));
    if (!features.title && ex.title) features.title = ex.title;
    features.meta = ex.meta || {};
    features.scripts = ex.scripts || [];
  } catch {
    features.meta = features.meta || {};
    features.scripts = features.scripts || [];
  }
  return features;
}

// --- 匹配 ---

async function runMatch(features) {
  const { rules = [] } = await chrome.storage.local.get('rules');
  if (rules.length === 0) return { hits: [], note: 'no_rules' };
  await ensureWasm();
  return JSON.parse(globalThis.goMatch(JSON.stringify(rules), JSON.stringify(features)));
}

// favicon 哈希库命中也当成一个指纹，并进 hits（规则命中优先，同名的不重复加）
async function appendHashHit(features, result) {
  if (!features.faviconHash) return result;
  try {
    await ensureWasm();
    const { customHashes = {} } = await chrome.storage.local.get('customHashes');
    const hit = JSON.parse(globalThis.goHashLookup(features.faviconHash, JSON.stringify(customHashes)));
    if (hit.name && !(result.hits || []).some((h) => h.name === hit.name)) {
      result.hits = result.hits || [];
      result.hits.push({
        id: `icon-${features.faviconHash}`,
        name: hit.name,
        evidence: [{ type: 'icon_hash', detail: `mmh3 ${features.faviconHash}（哈希库）` }],
      });
      delete result.note;
    }
  } catch { /* 查库失败不影响规则结果 */ }
  return result;
}

// --- AI：提示词支持自定义，没配就用默认 ---

const DEFAULT_PROMPTS = {
  identify:
    '你是 Web 指纹分析专家。根据用户给出的页面特征（URL、标题、meta 标签、script 路径、响应头、favicon 哈希），判断该站点使用的系统/框架/中间件。' +
    '以 JSON 数组返回，每项含 name（系统名）、confidence（0-1）、evidence（依据的关键特征）。如果没有把握，返回空数组，不要编造。',
  rule: [
    '你是 Web 指纹规则编写专家。根据用户给的页面特征，编写一条 GoPainter 指纹规则，只输出 YAML，不要任何解释。',
    '',
    '格式：',
    '- id: kebab-case 英文标识',
    '  name: 产品/系统名',
    '  matchers-condition: or  # 或 and',
    '  matchers:',
    '    - type: word          # word / regex / status / icon_hash',
    '      part: body          # body / title / url / header / raw / meta / script',
    '      words: ["..."]      # regex 用 regex:，status 用 status: [200]，icon_hash 用 hash: [整数]',
    '      condition: or       # matcher 内部组合，可省',
    '',
    '要求：',
    '- 挑稳定特征：generator meta、框架特有的路径/cookie/响应头、favicon 哈希等，别选随时会变的文案',
    '- faviconHash 非 0 时可以作为一条 icon_hash matcher',
    '- 一个 YAML 文档只写一条规则',
  ].join('\n'),
  bookmark:
    '根据用户给出的页面特征判断该站点使用的系统/框架/中间件，只回复一个名称（如 Nginx、WordPress、Vue），拿不准就回复「未知」，不要任何其他内容。',
};

async function callAI(systemPrompt, features) {
  const cfg = await chrome.storage.local.get(['aiBaseURL', 'aiApiKey', 'aiModel']);
  if (!cfg.aiBaseURL || !cfg.aiApiKey || !cfg.aiModel) {
    throw new Error('请先在设置页配置 AI（baseURL / API Key / 模型）');
  }
  // body 截一下，别把 token 打爆
  const slim = {
    url: features.url,
    title: features.title,
    status: features.status,
    headers: features.headers,
    faviconHash: features.faviconHash,
    meta: features.meta,
    scripts: (features.scripts || []).slice(0, 30),
    body: (features.body || '').slice(0, 8000),
  };
  const resp = await fetch(`${cfg.aiBaseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.aiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.aiModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(slim) },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`AI 请求失败: HTTP ${resp.status}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function customPrompt(key) {
  const cfg = await chrome.storage.local.get(key);
  return cfg[key] || DEFAULT_PROMPTS[key];
}

// 从 AI 回复里抠出 YAML（AI 爱包 ```yaml ... ```）
function extractYaml(text) {
  const m = text.match(/```(?:yaml|yml)?\s*\n([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}

// --- 书签整理：勾选的处理，规则没命中可以选 AI 兜底 ---

async function fetchFeatures(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    const html = (await resp.text()).slice(0, 200_000);
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    return enrichFeatures({ url, title: '', body: html, headers, status: resp.status, faviconHash: 0 });
  } finally {
    clearTimeout(timer);
  }
}

async function getOrCreateFolder(parentId, title) {
  const kids = await chrome.bookmarks.getChildren(parentId);
  const found = kids.find((k) => !k.url && k.title === title);
  return found || (await chrome.bookmarks.create({ parentId, title }));
}

async function organizeBookmarks(onlyIds, useAI) {
  const wanted = onlyIds?.length ? new Set(onlyIds) : null;
  const tree = await chrome.bookmarks.getTree();
  const all = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.url && /^https?:/.test(n.url)) {
        if (!wanted || wanted.has(n.id)) all.push(n);
      }
      if (n.children) walk(n.children);
    }
  };
  walk(tree);

  const summary = { total: all.length, matched: 0, aiMatched: 0, moved: 0, failed: 0, groups: {} };
  const groups = new Map(); // 指纹名 -> [bookmark]
  const bookmarkPrompt = useAI ? await customPrompt('bookmark') : null;

  // 5 路并发抓取
  const queue = [...all];
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (queue.length) {
      const bm = queue.shift();
      try {
        const features = await fetchFeatures(bm.url);
        const result = await runMatch(features);
        let name = result.hits?.[0]?.name; // 多个命中取第一个，书签只能待一个文件夹
        if (name) {
          summary.matched++;
        } else if (bookmarkPrompt) {
          // 规则没命中，AI 兜底
          const answer = (await callAI(bookmarkPrompt, features)).trim();
          if (answer && answer !== '未知' && answer.length < 50) {
            name = answer;
            summary.aiMatched++;
          }
        }
        if (name) {
          if (!groups.has(name)) groups.set(name, []);
          groups.get(name).push(bm);
        }
      } catch {
        summary.failed++;
      }
    }
  }));

  if (groups.size > 0) {
    const bar = tree[0].children.find((c) => c.id === '1') || tree[0].children[0]; // 书签栏
    const root = await getOrCreateFolder(bar.id, '🎨 指纹分类');
    for (const [name, bms] of groups) {
      const folder = await getOrCreateFolder(root.id, name);
      for (const bm of bms) {
        try {
          await chrome.bookmarks.move(bm.id, { parentId: folder.id });
          summary.moved++;
          summary.groups[name] = (summary.groups[name] || 0) + 1;
        } catch { /* 个别挪动失败就算了 */ }
      }
    }
  }
  return summary;
}

// --- 消息路由 ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'pageFeatures': {
        const tabId = sender.tab?.id;
        const net = responseCache.get(tabId) || { status: 0, headers: {} };
        const features = await enrichFeatures({
          ...msg.features,
          status: net.status,
          headers: net.headers,
          faviconHash: await faviconHash(msg.features.favicon),
        });
        const result = await appendHashHit(features, await runMatch(features));
        await chrome.storage.session.set({
          [`result:${tabId}`]: { features, result, at: Date.now() },
        });
        await updateIcon(tabId, result.hits?.length || 0);
        sendResponse({ ok: true });
        break;
      }
      case 'getResult': {
        const data = await chrome.storage.session.get(`result:${msg.tabId}`);
        sendResponse(data[`result:${msg.tabId}`] || null);
        break;
      }
      case 'aiIdentify': {
        const data = await chrome.storage.session.get(`result:${msg.tabId}`);
        const features = data[`result:${msg.tabId}`]?.features || msg.features;
        const answer = await callAI(await customPrompt('identify'), features);
        sendResponse({ ok: true, answer });
        break;
      }
      case 'aiGenerateRule': {
        const data = await chrome.storage.session.get(`result:${msg.tabId}`);
        const features = data[`result:${msg.tabId}`]?.features;
        if (!features) throw new Error('没有当前页面的特征，请先刷新页面');
        const yaml = extractYaml(await callAI(await customPrompt('rule'), features));
        sendResponse({ ok: true, yaml });
        break;
      }
      case 'addRule': {
        // popup 把 AI 给的 YAML 发回来，解析入库（同 id 覆盖）
        const docs = [];
        jsyaml.loadAll(msg.yaml, (d) => docs.push(d));
        await ensureWasm();
        const out = JSON.parse(globalThis.goNormalizeRules(JSON.stringify(docs)));
        if (out.error) throw new Error(out.error);
        if (!out.rules?.length) throw new Error('YAML 里没有有效规则');
        const { rules: existing = [] } = await chrome.storage.local.get('rules');
        const byId = new Map(existing.map((r) => [r.id, r]));
        for (const r of out.rules) byId.set(r.id, r);
        await chrome.storage.local.set({ rules: [...byId.values()] });
        sendResponse({ ok: true, added: out.rules.length });
        break;
      }
      case 'normalizeRules': {
        await ensureWasm();
        const out = JSON.parse(globalThis.goNormalizeRules(msg.docsJSON));
        if (out.error) throw new Error(out.error);
        sendResponse({ ok: true, rules: out.rules });
        break;
      }
      case 'getDefaultPrompts': {
        sendResponse({ ok: true, prompts: DEFAULT_PROMPTS });
        break;
      }
      case 'organizeBookmarks': {
        const summary = await organizeBookmarks(msg.ids, msg.useAI);
        sendResponse({ ok: true, summary });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message type' });
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true; // 异步回包
});
