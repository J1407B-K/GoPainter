// GoPainter service worker composition root.
// MV3 会随时回收 Service Worker：持久状态放 storage，可重建状态留在各 Host 模块。
// JS Host 只负责浏览器、网络、模型和生命周期；确定性产品语义由 Go/WASM Core 裁决。

importScripts(
  'shared-utils.js',
  'background/storage-access.js',
  'wasm/wasm_exec.js',
  'lib/js-yaml.min.js',
  'agent/tools/registry.js',
  'agent/tools/page-context.js',
  'agent/tools/inspect-page.js',
  'agent/tools/ping.js',
  'agent/tools/search-page-body.js',
  'agent/tools/search-page-js.js',
  'agent/tools/search-rules.js',
  'agent/tools/test-word-matcher.js',
  'agent/tools/test-regex.js',
  'agent/tools/evaluate-dsl.js',
  'agent/tools/validate-rule.js',
  'agent/tools/web-search.js',
  'agent/tools/fetch-url.js',
  'agent/skills/registry.js',
  'agent/skills/agent-setup/index.js',
  'agent/skills/gopainter-word-matcher/index.js',
  'agent/skills/gopainter-regex-matcher/index.js',
  'agent/skills/gopainter-runtime-matcher/index.js',
  'agent/skills/fingerprint-research/index.js',
  'agent/goals.js',
  'agent/providers.js',
  'agent/loop.js',
  'background/migrations.js',
  'background/wasm.js',
  'background/matching.js',
  'background/history.js',
  'background/page-fetch.js',
  'background/browser-state.js',
  'background/legacy-ai.js',
  'background/bookmarks.js',
  'background/crawl.js',
  'background/batch.js',
  'background/page-host.js',
  'background/rules-host.js',
  'background/source-host.js',
  'background/ai-host.js',
  'background/agent-host.js'
);

const messageHosts = [
  GoPainterPageHost,
  GoPainterRulesHost,
  GoPainterAIHost,
  GoPainterHistoryHost,
  GoPainterBookmarksHost,
  GoPainterCrawlHost,
  GoPainterBatchHost,
  GoPainterSourceHost,
];

function registerMessageHandlers(hosts) {
  const handlers = {};
  for (const host of hosts) {
    for (const [type, handler] of Object.entries(host.handlers)) {
      if (handlers[type]) throw new Error(`duplicate background message handler: ${type}`);
      handlers[type] = handler;
    }
  }
  return Object.freeze(handlers);
}

const messageHandlers = registerMessageHandlers(messageHosts);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = messageHandlers[msg?.type];
  if (!handler) {
    sendResponse({ ok: false, error: 'unknown message type' });
    return false;
  }
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
  return true;
});

// A first-run page gives the extension an immediately testable, local workflow.
// It is deliberately limited to fresh installs; upgrades never interrupt users.
chrome.runtime.onInstalled?.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});
