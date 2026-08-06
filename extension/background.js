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
  tabIcons.delete(tabId);
  iconJobs.delete(tabId);
  chrome.storage.session.remove(`result:${tabId}`);
});

// --- 图标：灰色 = 没命中，彩色 + 角标 = 有命中 ---

const ICONS = (state) => ({
  16: `icons/icon16${state}.png`,
  32: `icons/icon32${state}.png`,
  48: `icons/icon48${state}.png`,
  128: `icons/icon128${state}.png`,
});

const iconJobs = new Map(); // tabId -> { pendingHitCount, running }

async function applyIcon(tabId, hitCount) {
  if (tabId == null || tabId < 0) return;
  const matched = hitCount > 0;
  await chrome.action.setIcon({ tabId, path: ICONS(matched ? '' : '-gray') });
  await chrome.action.setBadgeText({ tabId, text: matched ? String(hitCount) : '' });
  if (matched) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#6366f1' });
  }
}

function updateIcon(tabId, hitCount) {
  if (tabId == null || tabId < 0) return Promise.resolve();
  let job = iconJobs.get(tabId);
  if (!job) {
    job = { pendingHitCount: hitCount, running: false };
    iconJobs.set(tabId, job);
  }
  job.pendingHitCount = hitCount;
  if (job.running) return Promise.resolve();

  job.running = true;
  return (async () => {
    while (job.pendingHitCount != null) {
      const next = job.pendingHitCount;
      job.pendingHitCount = null;
      await applyIcon(tabId, next);
    }
  })().finally(() => {
    job.running = false;
    if (job.pendingHitCount != null) {
      updateIcon(tabId, job.pendingHitCount).catch(() => {});
    }
  });
}

async function shouldKeepExistingHitIcon(tabId) {
  try {
    const [tab, data] = await Promise.all([
      chrome.tabs.get(tabId),
      chrome.storage.session.get(`result:${tabId}`),
    ]);
    const stored = data[`result:${tabId}`];
    return stored?.features?.url === tab.url && (stored.result?.hits?.length || 0) > 0;
  } catch {
    return false;
  }
}

// 开始跳新页面先回灰色；同 URL 已命中时不抢着置灰，避免命中图标一闪后被 loading 事件盖掉
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    shouldKeepExistingHitIcon(tabId).then((keep) => {
      if (!keep) updateIcon(tabId, 0).catch(() => {});
    });
  }
});

// --- 特征补全：favicon 哈希 + HTML 提取，都在 wasm 里算 ---

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

// --- 网络包里的 icon：页面加载过程中所有带 icon/favicon 字样的图片请求都收 ---

const tabIcons = new Map(); // tabId -> { seen:Set, pending:Set, timer }

function trackIconRequest(tabId, url) {
  let st = tabIcons.get(tabId);
  if (!st) {
    st = { seen: new Set(), pending: new Set(), timer: null };
    tabIcons.set(tabId, st);
  }
  if (st.seen.has(url)) return;
  st.seen.add(url);
  st.pending.add(url);
  // 页面已有的 icon 可能晚于 content script 上报，攒一批重新匹配
  clearTimeout(st.timer);
  st.timer = setTimeout(() => flushIcons(tabId), 800);
}

chrome.webRequest.onCompleted.addListener(
  (d) => { if (d.tabId >= 0) trackIconRequest(d.tabId, d.url); },
  { urls: ['*://*/*favicon*', '*://*/*icon*'], types: ['image', 'other'] }
);

async function flushIcons(tabId) {
  const st = tabIcons.get(tabId);
  if (!st || !st.pending.size) return;
  const urls = [...st.pending];
  st.pending.clear();

  const key = `result:${tabId}`;
  const data = await chrome.storage.session.get(key);
  const stored = data[key];
  if (!stored) return; // 页面还没上报特征，pageFeatures 流程会带上这些 icon

  const newHashes = await hashIcons(urls);
  if (!newHashes.length) return;

  // 只挑出没见过的新哈希；没有就省了这次重匹配
  const existing = new Set([...(stored.features.faviconHashes || []), stored.features.faviconHash].filter(Boolean));
  const fresh = newHashes.filter((h) => !existing.has(h));
  if (!fresh.length) return;

  stored.features.faviconHashes = [...existing, ...fresh];

  // 有新哈希就完整重跑一遍匹配（规则 + 哈希库 + 脚本），毫秒级
  const result = await appendHashHit(stored.features, await runMatch(stored.features));
  result.hits = await runUserScripts(stored.features, result.hits);
  stored.result = result;
  await chrome.storage.session.set({ [key]: stored });
  await updateIcon(tabId, result.hits?.length || 0);
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

// --- 匹配 ---

async function runMatch(features) {
  const { rules = [] } = await chrome.storage.local.get('rules');
  if (rules.length === 0) return { hits: [], note: 'no_rules' };
  await ensureWasm();
  return JSON.parse(globalThis.goMatch(JSON.stringify(rules), JSON.stringify(features)));
}

// favicon 哈希库命中也当成一个指纹，并进 hits（规则命中优先，同名的不重复加）
function faviconHashValues(features) {
  return [...new Set([features.faviconHash, ...(features.faviconHashes || [])].filter(Boolean))];
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

// --- 外接脚本：规则匹配之后执行，脚本返回要追加的指纹 ---
// 脚本体 = 函数体，参数 (features, hits)，返回 [{id, name, evidence?}, ...] 或空

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

// --- 规则/哈希库变动 → 自动重扫所有已打开的 tab ---
// 之前导入规则后 popup 还显示旧结果，就是因为没有这个

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

// --- AI：提示词支持自定义，没配就用默认 ---

const DEFAULT_PROMPTS = {
  identify: [
    '你是 Web 指纹分析专家。根据用户给出的页面特征（URL、标题、meta 标签、script 路径、响应头、favicon 哈希），判断该站点使用的系统/框架/中间件。',
    '用自然语言分条返回：第一行「系统名，置信度」，下面是命中的关键特征依据。没有把握就说「未知」，不要编造。',
    '',
    '【示范】',
    '用户特征：{"url":"https://demo.example.com","title":"登录 - 禅道","meta":{"generator":"ZenTao"}}',
    '应返回：',
    'ZenTao（禅道），置信度 0.92',
    '依据：',
    '- meta generator = ZenTao',
    '- 标题含「登录」',
    '',
    '硬性要求：不要 ``` 代码块，不要 JSON 数组，纯文本即可。',
  ].join('\n'),
  rule: [
    '你是 Web 指纹规则编写专家。根据用户给的页面特征，编写一条 GoPainter 指纹规则，只输出 YAML，不要任何解释。',
    '',
    '支持的 schema（严格照抄字段名，别自创）：',
    '- id: kebab-case 英文标识（必填）',
    '- name: 产品/系统名（必填）',
    '- matchers-condition: and 或 or（多个 matcher 之间的组合，默认 or）',
    '- matchers: 一个或多个 matcher',
    '    - type: word | regex | status | icon_hash',
    '      part: body | title | url | header | raw | meta | script（默认 body）',
    '      words: [字符串]        # type=word 用',
    '      regex: [字符串]        # type=regex 用',
    '      status: [整数]         # type=status 用',
    '      hash: [整数]           # type=icon_hash 用，直接用用户给的 faviconHash 数字，别自己编',
    '      condition: and 或 or   # matcher 内部多条件组合，默认 or',
    '      negative: true         # 可选，取反',
    '      confidence: 0-100      # 可选，这条 matcher 的信号强度；没把握就别写，弱信号给低点',
    '',
    '【示范】用户给的页面特征 → 应输出的完整规则：',
    '用户特征：',
    '  url: https://demo.example.com',
    '  title: Demo - Joomla!',
    '  faviconHash: -452104223',
    '  meta: {"generator": "Joomla! - Open Source Content Management"}',
    '  scripts: ["/media/system/js/core.js", "/media/vendor/jquery/js/jquery.min.js"]',
    '应输出：',
    '- id: joomla',
    '  name: Joomla',
    '  matchers-condition: or',
    '  matchers:',
    '    - type: word',
    '      part: meta',
    '      words:',
    '        - "generator: Joomla"',
    '    - type: word',
    '      part: script',
    '      words:',
    '        - "/media/system/js/core.js"',
    '    - type: icon_hash',
    '      hash:',
    '        - -452104223',
    '',
    '要求：',
    '- 挑稳定特征：generator meta、框架特有路径/script、响应头、favicon 哈希，别选随时会变的文案',
    '- faviconHash 非 0 时可以作为一条 icon_hash matcher，hash 直接用该数字',
    '- 一个 YAML 文档只写一条规则（以 "- id:" 开头）',
    '- 只输出 YAML，不要 ```yaml 代码块，不要解释文字',
    '- 别写 JS 表达式/DSL，只用上面列出的字段',
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
  const storageKeys = {
    identify: 'aiPromptIdentify',
    rule: 'aiPromptRule',
    bookmark: 'aiPromptBookmark',
  };
  const storageKey = storageKeys[key];
  const cfg = await chrome.storage.local.get(storageKey);
  return cfg[storageKey] || DEFAULT_PROMPTS[key];
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
    const features = await enrichFeatures({ url, title: '', body: html, headers, status: resp.status, faviconHash: 0 });
    // 页面里挂的 icon 全部算哈希，icon_hash 规则和哈希库对书签/爬取也能生效。
    // 注意：fetch 拿不到 Set-Cookie（API 硬限制），cookie 类指纹对书签无效
    features.faviconHashes = await hashIcons(features.favicons || []);
    features.faviconHash = features.faviconHashes[0] || 0;
    return features;
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
        const result = await appendHashHit(features, await runMatch(features));
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

// --- 站点爬取：BFS/去重/过滤都在 wasm（crawl.go），这里只 fetch 和存结果 ---
// 结果持久化在 storage.session：SW 被杀结果也不丢，重开设置页还能看到

const crawl = { active: false, stop: false }; // 内存只管当前任务
const CRAWL_KEY = 'crawl:state';

async function saveCrawlState(state) {
  await chrome.storage.session.set({ [CRAWL_KEY]: state });
}

async function loadCrawlState() {
  const data = await chrome.storage.session.get(CRAWL_KEY);
  return data[CRAWL_KEY] || { running: false, results: [], failed: [] };
}

async function crawlSite(seed, maxPages) {
  await ensureWasm();
  const start = JSON.parse(globalThis.goCrawlStart(seed, maxPages || 0));
  if (start.error) throw new Error(start.error);

  crawl.active = true;
  crawl.stop = false;
  const results = [];
  const failed = [];
  const state = () => ({ running: true, results, failed });
  await saveCrawlState(state());
  try {
    for (;;) {
      if (crawl.stop) break;
      const batch = JSON.parse(globalThis.goCrawlBatch(5));
      if (batch.error) throw new Error(batch.error);
      if (!batch.urls?.length) break; // 没 URL 可取了（队列空或到上限）
      await Promise.all(batch.urls.map(async (url) => {
        try {
          const features = await fetchFeatures(url);
          const result = await appendHashHit(features, await runMatch(features));
          const hits = await runUserScripts(features, result.hits);
          results.push({ url, title: features.title || url, status: features.status, hits });
          // 页面里发现的链接喂回 wasm，过滤去重它管
          globalThis.goCrawlFeed(url, JSON.stringify(features.links || []));
        } catch (e) {
          failed.push({ url, error: String(e.message || e) });
        }
      }));
      await saveCrawlState(state()); // 每批落一次盘
    }
  } finally {
    crawl.active = false;
    await saveCrawlState({ running: false, results, failed });
  }
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
        });
        // DOM 里的 icon + 网络包里抓到的 icon，全部算哈希
        const netIcons = tabIcons.get(tabId)?.seen || new Set();
        const candidates = [features.favicon, ...(features.favicons || []), ...netIcons].filter(Boolean);
        features.faviconHashes = await hashIcons(candidates);
        features.faviconHash = features.faviconHashes[0] || 0;
        const result = await appendHashHit(features, await runMatch(features));
        result.hits = await runUserScripts(features, result.hits);
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
      case 'convertWappalyzer': {
        await ensureWasm();
        const out = JSON.parse(globalThis.goConvertWappalyzer(msg.techJSON));
        if (out.error) throw new Error(out.error);
        sendResponse({ ok: true, rules: out.rules });
        break;
      }
      case 'convertEHole': {
        await ensureWasm();
        const out = JSON.parse(globalThis.goConvertEHole(msg.fingerJSON));
        if (out.error) throw new Error(out.error);
        sendResponse({ ok: true, rules: out.rules });
        break;
      }
      case 'getProbes': {
        // content.js 问：规则里要探哪些 js 全局路径和 dom 选择器
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
        sendResponse({ ok: true, ...probeCache });
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
      case 'crawlStart': {
        if (crawl.active) throw new Error('已有爬取任务在跑');
        // maxPages 为空 = null = 不限，爬到没有新链接为止
        const maxPages = Number.isInteger(msg.maxPages) && msg.maxPages > 0 ? msg.maxPages : null;
        crawlSite(msg.url, maxPages).catch(async (e) => {
          console.warn('爬取出错:', e);
          crawl.active = false;
          const st = await loadCrawlState();
          await saveCrawlState({ ...st, running: false });
        });
        sendResponse({ ok: true });
        break;
      }
      case 'crawlStop': {
        crawl.stop = true;
        sendResponse({ ok: true });
        break;
      }
      case 'crawlStatus': {
        const st = await loadCrawlState();
        // storage 说在跑但内存里没任务 = SW 被杀过，任务中断了
        const interrupted = st.running && !crawl.active;
        let visited = st.results.length, queued = 0;
        if (crawl.active) {
          try {
            const s = JSON.parse(globalThis.goCrawlStatus());
            visited = s.visited;
            queued = s.queued;
          } catch { /* wasm 还没起 */ }
        }
        sendResponse({
          ok: true,
          running: st.running && crawl.active,
          interrupted,
          visited,
          queued,
          results: st.results,
          failed: st.failed || [],
        });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message type' });
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true; // 异步回包
});
