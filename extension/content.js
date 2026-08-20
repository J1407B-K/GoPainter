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

  let evidenceCleanup = null;

  function clearEvidenceLocation() {
    evidenceCleanup?.();
    evidenceCleanup = null;
  }

  function showEvidenceToast(message) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.setAttribute('role', 'status');
    Object.assign(toast.style, {
      all: 'initial', position: 'fixed', top: '18px', right: '18px', zIndex: '2147483647',
      maxWidth: 'min(360px, calc(100vw - 36px))', padding: '10px 13px', borderRadius: '9px',
      color: '#fff', background: 'rgba(15, 43, 66, .94)', boxShadow: '0 8px 24px rgba(0,0,0,.22)',
      font: '600 13px/1.45 system-ui, sans-serif', letterSpacing: 'normal', textAlign: 'left',
    });
    (document.documentElement || document.body).append(toast);
    return toast;
  }

  function ensureEvidenceStyles() {
    if (document.getElementById('gopainter-evidence-styles')) return;
    const style = document.createElement('style');
    style.id = 'gopainter-evidence-styles';
    style.textContent = `.gopainter-evidence-target { outline: 3px solid #16a878 !important; outline-offset: 3px !important; box-shadow: 0 0 0 6px rgba(22, 168, 120, .2) !important; }`;
    (document.head || document.documentElement).append(style);
  }

  function highlightElements(elements, label) {
    clearEvidenceLocation();
    ensureEvidenceStyles();
    const targets = elements.slice(0, 20);
    for (const element of targets) element.classList.add('gopainter-evidence-target');
    targets[0]?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    const toast = showEvidenceToast(label);
    const timer = setTimeout(clearEvidenceLocation, 3_600);
    evidenceCleanup = () => {
      clearTimeout(timer);
      for (const element of targets) element.classList.remove('gopainter-evidence-target');
      toast.remove();
    };
    return { ok: true, count: targets.length };
  }

  function highlightText(detail) {
    const raw = String(detail || '').trim();
    const needle = (raw.endsWith('…') ? raw.slice(0, -1) : raw).toLocaleLowerCase();
    if (!needle || !document.body) return { ok: false };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return node.data.toLocaleLowerCase().includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const node = walker.nextNode();
    if (!node) return { ok: false };
    const start = node.data.toLocaleLowerCase().indexOf(needle);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + needle.length);
    const marks = [];
    for (const rect of range.getClientRects()) {
      const mark = document.createElement('div');
      Object.assign(mark.style, {
        all: 'initial', position: 'absolute', zIndex: '2147483647', pointerEvents: 'none',
        top: `${rect.top + scrollY - 2}px`, left: `${rect.left + scrollX - 2}px`,
        width: `${rect.width + 4}px`, height: `${rect.height + 4}px`, borderRadius: '3px',
        background: 'rgba(250, 204, 21, .42)', outline: '2px solid rgba(202, 138, 4, .82)',
      });
      document.documentElement.append(mark);
      marks.push(mark);
    }
    if (!marks.length) return { ok: false };
    clearEvidenceLocation();
    node.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    const toast = showEvidenceToast('GoPainter located matching page text');
    const timer = setTimeout(clearEvidenceLocation, 3_600);
    evidenceCleanup = () => {
      clearTimeout(timer);
      marks.forEach((mark) => mark.remove());
      toast.remove();
    };
    return { ok: true, count: 1 };
  }

  function locateEvidence(evidence) {
    const type = evidence?.type;
    if (type === 'dom') {
      try {
        const elements = [...document.querySelectorAll(String(evidence.detail || ''))];
        return elements.length ? highlightElements(elements, `GoPainter located ${elements.length} matching element${elements.length === 1 ? '' : 's'}`) : { ok: false };
      } catch {
        return { ok: false };
      }
    }
    if ((type === 'word' || type === 'regex') && (!evidence.part || evidence.part === 'body' || evidence.part === 'raw')) {
      return highlightText(evidence.detail);
    }
    return { ok: false };
  }

  report();

  // A live rule edit may introduce probes that were not part of the original
  // page snapshot. Only the extension can send this runtime message.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'gopainter:recollect') {
      report().catch(() => {});
      return false;
    }
    if (message?.type === 'gopainter:locateEvidence') {
      try { locateEvidence(message.evidence); } catch { /* a stale page may have been torn down */ }
      return false;
    }
    return false;
  });

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
