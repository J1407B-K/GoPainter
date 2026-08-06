// GoPainter service worker
// MV3 的 SW 会被浏览器随时回收，状态要么放 chrome.storage，要么能惰性重建（比如 wasm 实例）。
// 纯计算（匹配/mmh3/HTML 提取/规则规范化）都在 wasm 里，这里只做 I/O 和编排。

importScripts(
  'wasm/wasm_exec.js',
  'lib/js-yaml.min.js',
  'background/wasm.js',
  'background/browser-state.js',
  'background/matching.js'
);

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
        sendResponse({ ok: true, ...(await getProbeList()) });
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
