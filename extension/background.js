// GoPainter service worker
// MV3 的 SW 会被浏览器随时回收，状态要么放 chrome.storage，要么能惰性重建（比如 wasm 实例）。

importScripts('wasm/wasm_exec.js', 'lib/mmh3.js');

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

// --- favicon 的 mmh3（fofa 那个算法） ---

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
    return mmh3_32(b64);
  } catch {
    return 0;
  }
}

// --- 匹配 ---

async function runMatch(features) {
  const { rules = [] } = await chrome.storage.local.get('rules');
  if (rules.length === 0) return { hits: [], note: 'no_rules' };
  await ensureWasm();
  return JSON.parse(globalThis.goMatch(JSON.stringify(rules), JSON.stringify(features)));
}

// --- AI 识别 ---

async function askAI(features) {
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
        {
          role: 'system',
          content: '你是 Web 指纹分析专家。根据用户给出的页面特征（URL、标题、响应头、HTML 片段、favicon 哈希），判断该站点使用的系统/框架/中间件。' +
            '以 JSON 数组返回，每项含 name（系统名）、confidence（0-1）、evidence（依据的关键特征）。如果没有把握，返回空数组，不要编造。',
        },
        { role: 'user', content: JSON.stringify(slim) },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`AI 请求失败: HTTP ${resp.status}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// --- 消息路由 ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'pageFeatures': {
        const tabId = sender.tab?.id;
        const net = responseCache.get(tabId) || { status: 0, headers: {} };
        const features = {
          ...msg.features,
          status: net.status,
          headers: net.headers,
          faviconHash: await faviconHash(msg.features.favicon),
        };
        const result = await runMatch(features);
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
        const answer = await askAI(features);
        sendResponse({ ok: true, answer });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message type' });
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true; // 异步回包
});
