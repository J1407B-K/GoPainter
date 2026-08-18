// 采集页面特征发给 background。响应头/状态码那边有 webRequest 管，这里管 DOM 能拿到的
// 加上两个探测：js 全局变量（background 从 MAIN world 读取）和 dom 选择器（自己就能查）。
// SPA 路由变化（pushState/replaceState/popstate/hashchange）时重采重扫。

(() => {
  const BODY_LIMIT = 200_000;

  function appendBounded(parts, value, state) {
    if (state.length >= state.limit || !value) return false;
    const remaining = state.limit - state.length;
    const chunk = String(value);
    parts.push(chunk.length > remaining ? chunk.slice(0, remaining) : chunk);
    state.length += Math.min(chunk.length, remaining);
    return state.length < state.limit;
  }

  function escapeText(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(value) {
    return escapeText(value).replace(/"/g, '&quot;');
  }

  // outerHTML.slice() still serializes the whole document first. This walker stops as soon
  // as the matcher input budget is full, so very large/infinite-feed pages cannot freeze it.
  function serializeDocumentPrefix(limit = BODY_LIMIT) {
    const root = document.documentElement;
    if (!root || limit <= 0) return '';
    const parts = [];
    const state = { length: 0, limit };
    const stack = [{ node: root, closing: false }];
    const voidTags = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);

    while (stack.length && state.length < state.limit) {
      const item = stack.pop();
      const node = item.node;
      if (item.closing) {
        appendBounded(parts, `</${node.localName}>`, state);
        continue;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement?.tagName;
        appendBounded(parts, parent === 'SCRIPT' || parent === 'STYLE' ? node.data : escapeText(node.data), state);
        continue;
      }
      if (node.nodeType === Node.COMMENT_NODE) {
        appendBounded(parts, `<!--${node.data}-->`, state);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      if (!appendBounded(parts, `<${node.localName}`, state)) break;
      for (const attr of node.attributes) {
        if (!appendBounded(parts, ` ${attr.name}="${escapeAttr(attr.value)}"`, state)) break;
      }
      if (!appendBounded(parts, '>', state)) break;
      if (voidTags.has(node.tagName)) continue;
      stack.push({ node, closing: true });
      for (let child = node.lastChild; child; child = child.previousSibling) {
        stack.push({ node: child, closing: false });
      }
    }
    return parts.join('');
  }

  const DOM_YIELD_EVERY = 100;

  function yieldToBrowser() {
    if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  // 全局变量仍是页面可控证据；但结果通过 chrome.scripting 从 MAIN world 直接返回
  // background，避免与页面共享可伪造的 window.postMessage 协议。
  async function probeJs(paths) {
    if (!paths.length) return {};
    try {
      const response = await chrome.runtime.sendMessage({ type: 'probeJs', paths });
      return response?.ok && response.globals && typeof response.globals === 'object' ? response.globals : {};
    } catch {
      return {};
    }
  }

  function domAttributesMatch(element, patterns) {
    return patterns.every(([name, pattern]) => {
      const value = element.getAttribute(name);
      return value != null && pattern.test(value);
    });
  }

  async function domProbeMatches(probe) {
    let selector = probe.sel;
    // 有属性条件但选择器是 * 或裸标签时，把属性名拼成预筛选择器，
    // 不然 querySelector('*') 只会检查第一个元素的属性，语义错了。
    if (probe.attrs && !selector.includes('[')) {
      selector += Object.keys(probe.attrs).map((name) => `[${CSS.escape(name)}]`).join('');
    }
    if (!probe.text && !probe.attrs) return Boolean(document.querySelector(selector));
    const elements = document.querySelectorAll(selector);
    const textPattern = probe.text ? new RegExp(probe.text, 'i') : null;
    const attrPatterns = Object.entries(probe.attrs || {}).map(([name, pattern]) => [name, new RegExp(pattern, 'i')]);
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index];
      const textMatches = !textPattern || textPattern.test(element.textContent || '');
      const attrsMatch = textMatches && domAttributesMatch(element, attrPatterns);
      if (attrsMatch) return true;
      // 完整匹配不能再静默截断；长列表中让出主线程，避免一次扫描变成长任务。
      if (index && index % DOM_YIELD_EVERY === 0) await yieldToBrowser();
    }
    return false;
  }

  async function probeDom(probes) {
    const hit = [];
    for (const probe of probes) {
      try {
        if (await domProbeMatches(probe)) hit.push(probe.id); // 背景按 Core 生成的 id 对应
      } catch { /* 坏选择器/坏正则跳过 */ }
    }
    return hit;
  }

  async function report() {
    let favicon = '';
    const link = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"]');
    if (link?.href) favicon = link.href;

    // 规则里要探哪些 js 路径和 dom probe，问 background 要
    let js = {}, domHits = {};
    try {
      const probes = await chrome.runtime.sendMessage({ type: 'getProbes' });
      if (probes?.ok) {
        [js, domHits] = await Promise.all([
          probeJs(probes.paths || []),
          probeDom(probes.probes || []).then((ids) =>
            Object.fromEntries(ids.map((id) => [id, true]))
          ),
        ]);
      }
    } catch { /* background 没起来就裸采 */ }

    sendFeatures({
      url: location.href,
      title: document.title || '',
      // 真正有界的序列化；不能先 outerHTML 再 slice，否则超大页面仍会阻塞主线程。
      body: serializeDocumentPrefix(),
      favicon,
      js,
      domHits,
    });
  }

  function sendFeatures(features) {
    chrome.runtime.sendMessage({ type: 'pageFeatures', features }, (response) => {
      if (chrome.runtime.lastError || !response?.retryAfter) return;
      // The background kept its bounded queue full of still-current tabs.
      // Reuse the already bounded snapshot rather than re-running DOM/JS
      // probes. If SPA navigation changed the URL meanwhile, collect anew.
      setTimeout(() => {
        if (location.href === features.url) sendFeatures(features);
        else report();
      }, response.retryAfter);
    });
  }

  report();

  // SPA 换页：URL 变了但浏览器不刷新，得手动再扫。
  // 路由事件由 route-hook.js（main world）hook 后 postMessage 过来
  let lastUrl = location.href;
  let timer = null;
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || e.data?.type !== 'gopainter:route') return;
    if (location.href === lastUrl) return; // pushState 有时也会原地打
    lastUrl = location.href;
    clearTimeout(timer);
    // 等几百 ms 让框架把新页面画出来再采
    timer = setTimeout(report, 600);
  });
})();
