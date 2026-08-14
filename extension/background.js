// GoPainter service worker
// MV3 的 SW 会被浏览器随时回收，状态要么放 chrome.storage，要么能惰性重建（比如 wasm 实例）。
// 纯计算（匹配/mmh3/HTML 提取/规则规范化）都在 wasm 里，这里只做 I/O 和编排。

importScripts(
  'shared-utils.js',
  'wasm/wasm_exec.js',
  'lib/js-yaml.min.js',
  'agent/tools/registry.js',
  'agent/tools/page-context.js',
  'agent/tools/inspect-page.js',
  'agent/tools/ping.js',
  'agent/tools/search-page-body.js',
  'agent/tools/search-page-js.js',
  'agent/tools/search-rules.js',
  'agent/tools/web-search.js',
  'agent/skills/registry.js',
  'agent/skills/agent-setup/index.js',
  'agent/skills/fingerprint-research/index.js',
  'agent/goals.js',
  'agent/providers.js',
  'agent/loop.js',
  'background/wasm.js',
  'background/browser-state.js',
  'background/matching.js'
);

// --- AI：提示词支持自定义，没配就用默认 ---

const DEFAULT_PROMPTS = {
  identify: [
    '你是 Web 技术栈指纹分析专家。根据页面特征（URL/标题/状态码/响应头/meta/script/favicon哈希/body/js全局变量/dom选择器）识别站点使用的技术栈（框架、CMS、中间件、Web服务器、语言、前端库、统计工具等）。',
    '只输出一个 JSON 数组，不要任何解释、不要 markdown 代码块。',
    '数组每项结构：{"name":"技术名","confidence":0到100整数,"evidence":[{"type":"...","detail":"..."}]}',
    'evidence.type 只允许：word / regex / header / meta / script / js / dom / status / icon_hash',
    '  - header/meta/script 表示命中位置，detail 写具体内容，如 "server: nginx"、"generator: ZenTao"、"/media/system/js/core.js"',
    '  - js 写 "window.React.version"；dom 写选择器；status 写 "状态码 200"；icon_hash 写 "mmh3 <数字>"',
    'confidence 越高越确定；没有把握的技术不要列。',
    '',
    '【示范】用户特征 {"url":"https://demo.example.com","title":"登录 - 禅道","meta":{"generator":"ZenTao"}}',
    '应返回：[{"name":"ZenTao","confidence":92,"evidence":[{"type":"meta","detail":"generator: ZenTao"}]}]',
  ].join('\n'),
  rule: [
    '你是 Web 指纹规则编写专家。根据用户给的页面特征，为一个 Web 技术编写一条 GoPainter 指纹规则，只输出 YAML，不要任何解释。',
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
    '      hash: [整数]           # type=icon_hash 用，直接用用户给的 faviconHashes 数字，别自己编',
    '      condition: and 或 or   # matcher 内部多条件组合，默认 or',
    '      negative: true         # 可选，取反',
    '      confidence: 0-100      # 可选，这条 matcher 的信号强度；没把握就别写，弱信号给低点',
    '',
    '【示范】用户给的页面特征 → 应输出的完整规则：',
    '用户特征：',
    '  url: https://demo.example.com',
    '  title: Demo - Joomla!',
    '  faviconHashes: [-452104223]',
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
    '- faviconHashes 非空时可以作为一条 icon_hash matcher，hash 直接用里面的数字',
    '- 一个 YAML 文档只写一条规则（以 "- id:" 开头）',
    '- 只输出 YAML，不要 ```yaml 代码块，不要解释文字',
    '- 别写 JS 表达式/DSL，只用上面列出的字段',
  ].join('\n'),
  optimize: [
    '你是 Web 指纹规则优化专家。下面「用户消息」里会给出：页面特征 + 当前规则的 YAML。',
    '请基于该页面特征优化这条规则：',
    '- 保持 id 不变（同 id 覆盖入库），可微调 name；保留当前已有 matcher，不要删除或替换它们',
    '- 从当前页面尚未使用的稳定特征中补充 1-2 条 matcher：优先 generator meta、框架特有 script 路径、响应头、favicon 哈希（hash 直接用页面 faviconHashes 数字）、js 全局变量（window.x）、dom 选择器；没有可靠的新特征时保持原规则不变',
    '- 只输出一个 YAML 文档（以 "- id:" 开头），不要 ```yaml 代码块，不要解释文字',
    '- 严格照抄 schema 字段：type(word|regex|status|icon_hash|js|dom) / part(body|title|url|header|raw|meta|script) / words / regex / status / hash / js(数组,{path,pattern}) / dom(数组,{sel,text,attrs}) / condition / negative / confidence(0-100)',
    '- 别写 JS 表达式/DSL',
  ].join('\n'),
  bookmark:
    '根据用户给出的页面特征判断该站点使用的系统/框架/中间件，只回复一个名称（如 Nginx、WordPress、Vue），拿不准就回复「未知」，不要任何其他内容。',
};

// 扫描历史只存报告需要的摘要，不存页面 HTML、响应头或 AI 配置。
const SCAN_HISTORY_KEY = 'scanHistory';
const SCAN_HISTORY_LIMIT_KEY = 'scanHistoryLimit';
const DEFAULT_SCAN_HISTORY_LIMIT = 300;
let historyWrite = Promise.resolve();

function recordScanHistory(features, result, source) {
  historyWrite = historyWrite.then(async () => {
    const stored = await chrome.storage.local.get([SCAN_HISTORY_KEY, SCAN_HISTORY_LIMIT_KEY]);
    const history = stored[SCAN_HISTORY_KEY] || [];
    const limit = GoPainterUtils.normalizeHistoryLimit(stored[SCAN_HISTORY_LIMIT_KEY], DEFAULT_SCAN_HISTORY_LIMIT);
    const entry = GoPainterUtils.scanHistoryEntry(features, result, source);
    const next = GoPainterUtils.mergeScanHistory(history, entry, limit);
    await chrome.storage.local.set({ [SCAN_HISTORY_KEY]: next });
  }).catch((error) => console.warn('保存扫描历史失败:', error));
  return historyWrite;
}

function setScanHistoryLimit(value) {
  const limit = GoPainterUtils.normalizeHistoryLimit(value, DEFAULT_SCAN_HISTORY_LIMIT);
  historyWrite = historyWrite.then(async () => {
    const { [SCAN_HISTORY_KEY]: history = [] } = await chrome.storage.local.get(SCAN_HISTORY_KEY);
    await chrome.storage.local.set({
      [SCAN_HISTORY_LIMIT_KEY]: limit,
      [SCAN_HISTORY_KEY]: (Array.isArray(history) ? history : []).slice(0, limit),
    });
  }).catch((error) => console.warn('更新扫描历史上限失败:', error));
  return historyWrite.then(() => limit);
}

function clearScanHistory() {
  historyWrite = historyWrite.then(() => chrome.storage.local.set({ [SCAN_HISTORY_KEY]: [] }))
    .catch((error) => console.warn('清空扫描历史失败:', error));
  return historyWrite;
}

async function callAI(systemPrompt, features, extraUserText = '') {
  const cfg = await chrome.storage.local.get(['aiBaseURL', 'aiApiKey', 'aiModel']);
  if (!cfg.aiBaseURL || !cfg.aiApiKey || !cfg.aiModel) {
    throw new Error('请先在设置页配置 AI（baseURL / API Key / 模型）');
  }
  // body 截一下，别把 token 打爆；js/dom 是页面运行时探测的，也一并给 AI 判断
  const jsEntries = Object.entries(features.js || {}).slice(0, 40);
  // domHits 里是 probe id，AI 看不懂，反查回选择器
  const domSelectors = (await matchedDomSelectors(features)).slice(0, 40);
  const slim = {
    url: features.url,
    title: features.title,
    status: features.status,
    headers: features.headers,
    faviconHashes: features.faviconHashes || [],
    meta: features.meta,
    scripts: (features.scripts || []).slice(0, 30),
    js: Object.fromEntries(jsEntries),
    dom: domSelectors,
    body: (features.body || '').slice(0, 8000),
  };
  const userContent = [
    JSON.stringify(slim),
    extraUserText && `\n\n${extraUserText}`,
  ].filter(Boolean).join('');
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
        { role: 'user', content: userContent },
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
    optimize: 'aiPromptOptimize',
    bookmark: 'aiPromptBookmark',
  };
  const storageKey = storageKeys[key];
  const cfg = await chrome.storage.local.get(storageKey);
  return cfg[storageKey] || DEFAULT_PROMPTS[key];
}

// 从 AI 回复里抠出 YAML（AI 爱包 ```yaml ... ```）
function extractYaml(text) {
  return GoPainterUtils.extractYaml(text);
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
    const features = await enrichFeatures({ url, title: '', body: html, headers, status: resp.status });
    // 页面里挂的 icon 全部算哈希，icon_hash 规则和哈希库对书签/爬取也能生效。
    // 注意：fetch 拿不到 Set-Cookie（API 硬限制），cookie 类指纹对书签无效
    features.faviconHashes = await hashIcons(features.favicons || []);
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

  // 8 路并发抓取
  const queue = [...all];
  await Promise.all(Array.from({ length: 8 }, async () => {
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
      const batch = JSON.parse(globalThis.goCrawlBatch(8));
      if (batch.error) throw new Error(batch.error);
      if (!batch.urls?.length) break; // 没 URL 可取了（队列空或到上限）
      await Promise.all(batch.urls.map(async (url) => {
        try {
          const features = await fetchFeatures(url);
          const result = await appendHashHit(features, await runMatch(features));
          const hits = await runUserScripts(features, result.hits);
          results.push({ url, title: features.title || url, status: features.status, hits });
          await recordScanHistory(features, { ...result, hits }, 'crawl');
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

// Agent 的每个可见步骤通过长连接实时回传；不包含模型私有推理，只发送工具编排事件。
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'gopainter-agent') return;
  const controller = new AbortController();
  let pendingPermission = null;
  let running = false;
  const answerPermission = (decision) => {
    if (!pendingPermission) return;
    pendingPermission(decision);
    pendingPermission = null;
  };
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'keepalive') {
      port.postMessage({ type: 'keepaliveAck' });
      return;
    }
    if (msg?.type === 'permissionResponse') {
      answerPermission({ granted: Boolean(msg.granted), remember: Boolean(msg.remember) });
      return;
    }
    if (msg?.type !== 'runAgent') return;
    if (running) {
      port.postMessage({ type: 'error', error: 'Agent 已在执行中' });
      return;
    }
    running = true;
    try {
      const result = await GoPainterAgentLoop.run({
        goalId: msg.goalId,
        tabId: msg.tabId,
        input: msg.input || '',
        grants: [],
        signal: controller.signal,
        onTrace: (item) => port.postMessage({ type: 'trace', item }),
        onPermissionRequest: (request) => new Promise((resolve) => {
          pendingPermission = resolve;
          port.postMessage({ type: 'permission', request });
        }),
      });
      port.postMessage({ type: 'complete', result });
    } catch (error) {
      port.postMessage({ type: 'error', error: String(error.message || error) });
    } finally {
      running = false;
    }
  });
  port.onDisconnect.addListener(() => {
    controller.abort();
    answerPermission({ granted: false, remember: false });
  });
});

// --- 消息路由 ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'pageFeatures': {
        const tabId = sender.tab?.id;
        const pageUrl = msg.features?.url;
        const navigationVersion = currentNavigationVersion(tabId);
        // content script 的上报可能在异步 favicon 哈希期间过期。
        // 先挡一次，避免已经离开的页面启动无意义的计算。
        if (!(await isCurrentTabPage(tabId, pageUrl, navigationVersion))) {
          sendResponse({ ok: true, stale: true });
          break;
        }
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
        const result = await appendHashHit(features, await runMatch(features));
        result.hits = await runUserScripts(features, result.hits);
        // 上面的哈希请求可能很慢；页面已变化时不写旧缓存、不更新图标。
        if (!(await isCurrentTabPage(tabId, pageUrl, navigationVersion))) {
          sendResponse({ ok: true, stale: true });
          break;
        }
        const at = Date.now();
        await chrome.storage.session.set({
          [`result:${tabId}`]: { features, result, at },
          ...popupResultEntry(tabId, features, result, at),
          ...agentPageEntry(tabId, features, at),
        });
        await recordScanHistory(features, result, 'page');
        await updateIcon(tabId, result.hits?.length || 0);
        sendResponse({ ok: true });
        break;
      }
      case 'getResult': {
        const data = await chrome.storage.session.get(`result:${msg.tabId}`);
        sendResponse(data[`result:${msg.tabId}`] || null);
        break;
      }
      case 'getPopupResult': {
        const popupKey = `popup:${msg.tabId}`;
        const data = await chrome.storage.session.get([popupKey, `result:${msg.tabId}`]);
        let compact = data[popupKey] || null;
        if (!compact && data[`result:${msg.tabId}`]) {
          const stored = data[`result:${msg.tabId}`];
          compact = popupResultSnapshot(stored.features, stored.result, stored.at);
          await chrome.storage.session.set({ [popupKey]: compact });
        }
        sendResponse(compact);
        break;
      }
      case 'getRuleSetOverview': {
        const stored = await chrome.storage.local.get(['rules', 'ruleSets', 'activeRuleSetId', 'enabledRuleSetIds']);
        const state = GoPainterUtils.normalizeRuleSets(stored.ruleSets, stored.activeRuleSetId, stored.rules, stored.enabledRuleSetIds);
        sendResponse({
          activeRuleSetId: state.activeRuleSetId,
          enabledRuleSetIds: state.enabledRuleSetIds,
          ruleSets: state.ruleSets.map((set) => ({
            id: set.id, name: set.name, count: set.rules.length, enabled: state.enabledRuleSetIds.includes(set.id),
          })),
        });
        break;
      }
      case 'getActiveRuleSummaries': {
        const stored = await chrome.storage.local.get(['rules', 'ruleSets', 'activeRuleSetId', 'enabledRuleSetIds']);
        const state = GoPainterUtils.normalizeRuleSets(stored.ruleSets, stored.activeRuleSetId, stored.rules, stored.enabledRuleSetIds);
        const active = state.ruleSets.find((set) => set.id === state.activeRuleSetId);
        sendResponse({ rules: (active?.rules || []).map((rule) => ({ id: rule.id, name: rule.name })) });
        break;
      }
      case 'setActiveRuleSet': {
        const stored = await chrome.storage.local.get(['rules', 'ruleSets', 'activeRuleSetId', 'enabledRuleSetIds']);
        const state = GoPainterUtils.normalizeRuleSets(stored.ruleSets, stored.activeRuleSetId, stored.rules, stored.enabledRuleSetIds);
        const next = state.ruleSets.find((set) => set.id === msg.ruleSetId);
        if (!next) throw new Error('规则集不存在');
        await chrome.storage.local.set({ activeRuleSetId: next.id });
        sendResponse({ ok: true });
        break;
      }
      case 'setEnabledRuleSets': {
        const stored = await chrome.storage.local.get(['rules', 'ruleSets', 'activeRuleSetId', 'enabledRuleSetIds']);
        const state = GoPainterUtils.normalizeRuleSets(
          stored.ruleSets, stored.activeRuleSetId, stored.rules, msg.enabledRuleSetIds
        );
        await chrome.storage.local.set({ enabledRuleSetIds: state.enabledRuleSetIds, rules: state.rules });
        sendResponse({ ok: true, enabledRuleSetIds: state.enabledRuleSetIds, ruleCount: state.rules.length });
        break;
      }
      case 'aiIdentify': {
        // 技术栈识别：AI 返回结构化候选（name/confidence/evidence），解析失败回 raw 文本兜底
        const data = await chrome.storage.session.get(`result:${msg.tabId}`);
        const features = data[`result:${msg.tabId}`]?.features || msg.features;
        const answer = await callAI(await customPrompt('identify'), features);
        const parsed = GoPainterUtils.techsFromAiReply(answer);
        sendResponse({ ok: true, ...parsed });
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
      case 'aiCreateRule': {
        // 新建缺失规则：name 可选（AI 候选一键转带技术名，或手动输入）
        const data = await chrome.storage.session.get(`result:${msg.tabId}`);
        const features = data[`result:${msg.tabId}`]?.features;
        if (!features) throw new Error('没有当前页面的特征，请先刷新页面');
        const name = String(msg.name || '').trim();
        const extra = name
          ? `目标技术名：${name}。请为这个技术生成一条规则，id 用 kebab-case（如 ${name} 的小写短横线形式），只输出 YAML。`
          : '请为站点上检测到的新技术生成一条规则，只输出 YAML。';
        const yaml = extractYaml(await callAI(await customPrompt('rule'), features, extra));
        sendResponse({ ok: true, yaml });
        break;
      }
      case 'aiOptimizeRule': {
        // 优化现有规则：找规则 + 站点特征一起给 AI，返回规范化后强制同 id 的 YAML
        const data = await chrome.storage.session.get(`result:${msg.tabId}`);
        const features = data[`result:${msg.tabId}`]?.features;
        if (!features) throw new Error('没有当前页面的特征，请先刷新页面');
        const stored = await chrome.storage.local.get(['rules', 'ruleSets', 'activeRuleSetId', 'enabledRuleSetIds']);
        const state = GoPainterUtils.normalizeRuleSets(
          stored.ruleSets, stored.activeRuleSetId, stored.rules, stored.enabledRuleSetIds
        );
        const activeRules = state.ruleSets.find((set) => set.id === state.activeRuleSetId)?.rules || [];
        const rule = activeRules.find((r) => r.id === msg.ruleId);
        if (!rule) throw new Error(`规则 ${msg.ruleId} 不存在`);
        const extra = `页面特征已给出。\n当前规则(YAML)：\n${jsyaml.dump(rule)}\n\n请基于该页面特征优化此规则，保持 id 不变，只输出优化后的 YAML。`;
        const yaml = extractYaml(await callAI(await customPrompt('optimize'), features, extra));
        // 先清洗 + 规范化再强制同 id，保证「覆盖入库」语义，预览即入库真身
        const docs = [];
        jsyaml.loadAll(yaml, (d) => docs.push(d));
        const clean = GoPainterUtils.sanitizeRuleDocs(docs);
        if (!clean.length) throw new Error('优化结果里没有有效规则');
        await ensureWasm();
        const out = JSON.parse(globalThis.goNormalizeRules(JSON.stringify(clean)));
        if (out.error) throw new Error(out.error);
        const optimized = (out.rules || []).map((r) => ({ ...r, id: rule.id }));
        if (!optimized.length) throw new Error('优化结果里没有有效规则');
        sendResponse({ ok: true, yaml: jsyaml.dump(optimized), ruleName: rule.name });
        break;
      }
      case 'addRule': {
        // popup 把 AI 给的 YAML 发回来；同 id 内容变化时先返回冲突，确认后才原子写入。
        // 先清洗再走 wasm：AI 输出常见标量/浮点/单对象偏差，goNormalizeRules 一处不对就丢整条规则
        const docs = [];
        jsyaml.loadAll(msg.yaml, (d) => docs.push(d));
        const clean = GoPainterUtils.sanitizeRuleDocs(docs);
        if (!clean.length) throw new Error('YAML 里没有有效规则');
        await ensureWasm();
        const out = JSON.parse(globalThis.goNormalizeRules(JSON.stringify(clean)));
        if (out.error) throw new Error(out.error);
        if (!out.rules?.length) throw new Error('YAML 里没有有效规则');
        if (msg.requireSingle && out.rules.length !== 1) throw new Error('Agent 必须交付且只能交付一条完整规则');
        const expectedId = String(msg.expectedId || '').trim();
        if (expectedId && out.rules.some((rule) => rule.id !== expectedId)) {
          throw new Error(`优化规则必须保留原 id：${expectedId}`);
        }
        const storedRules = await chrome.storage.local.get(['rules', 'ruleSets', 'activeRuleSetId', 'enabledRuleSetIds']);
        const state = GoPainterUtils.normalizeRuleSets(
          storedRules.ruleSets, storedRules.activeRuleSetId, storedRules.rules, storedRules.enabledRuleSetIds
        );
        const existing = state.ruleSets.find((set) => set.id === state.activeRuleSetId)?.rules || [];
        const merge = GoPainterUtils.planRuleMerge(existing, out.rules, msg.resolutions || {});
        if (merge.unresolved.length) {
          sendResponse({
            ok: true,
            needsResolution: true,
            conflicts: merge.unresolved.map((conflict) => ({
              id: conflict.id,
              name: conflict.name,
              existingYaml: jsyaml.dump(conflict.existing, { noRefs: true, lineWidth: -1 }),
              incomingYaml: jsyaml.dump(conflict.incoming, { noRefs: true, lineWidth: -1 }),
            })),
          });
          break;
        }
        if (merge.added || merge.replaced) {
          await chrome.storage.local.set(GoPainterUtils.replaceActiveRuleSetRules(state, merge.rules));
        }
        sendResponse({
          ok: true,
          added: merge.added,
          replaced: merge.replaced,
          kept: merge.kept,
          unchanged: merge.unchanged,
        });
        break;
      }
      case 'normalizeRules': {
        // 文件导入也先清洗（YAML 手写常有标量/数组混淆）
        let rawDocs = msg.docsJSON;
        try {
          const parsed = JSON.parse(rawDocs);
          if (Array.isArray(parsed)) {
            const clean = GoPainterUtils.sanitizeImportedRuleDocs(parsed);
            rawDocs = JSON.stringify(clean);
          }
        } catch { /* 不是合法 JSON 就让 wasm 报错 */ }
        await ensureWasm();
        const out = JSON.parse(globalThis.goNormalizeRules(rawDocs));
        if (out.error) throw new Error(out.error);
        sendResponse({ ok: true, rules: out.rules });
        break;
      }
      case 'testAgentTools': {
        const result = await GoPainterAgentProviders.testToolCalling(msg.config);
        sendResponse({ ok: true, result });
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
      case 'setScanHistoryLimit': {
        const limit = await setScanHistoryLimit(msg.limit);
        sendResponse({ ok: true, limit });
        break;
      }
      case 'clearScanHistory': {
        await clearScanHistory();
        sendResponse({ ok: true });
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
