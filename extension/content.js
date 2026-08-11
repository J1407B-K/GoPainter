// 采集页面特征发给 background。响应头/状态码那边有 webRequest 管，这里管 DOM 能拿到的
// 加上两个探测：js 全局变量（找 MAIN world 的 route-hook 帮忙）和 dom 选择器（自己就能查）。
// SPA 路由变化（pushState/replaceState/popstate/hashchange）时重采重扫。

(() => {
  // js 探测：路径列表 postMessage 给 main world，等它回结果，超时就当没有
  function probeJs(paths) {
    return new Promise((resolve) => {
      if (!paths.length) return resolve({});
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({});
      }, 1500);
      function onMsg(e) {
        if (e.source !== window || e.data?.type !== 'gopainter:jsResult') return;
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve(e.data.globals || {});
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'gopainter:probe', paths }, '*');
    });
  }

  function probeDom(probes) {
    const hit = [];
    for (const p of probes) {
      try {
        let sel = p.sel;
        // 有属性条件但选择器是 * 或裸标签时，把属性名拼成预筛选择器，
        // 不然 querySelector('*') 只会检查第一个元素的属性，语义错了
        if (p.attrs && !sel.includes('[')) {
          sel += Object.keys(p.attrs).map((k) => `[${CSS.escape(k)}]`).join('');
        }
        const els = document.querySelectorAll(sel);
        // 任一元素满足条件就算中（第一个匹配元素不一定是对的那个，
        // 比如 link[type*='application'] 第一个可能是 oembed 而不是 RSS）
        let ok = false;
        for (const el of [...els].slice(0, 50)) {
          if (p.text && !(new RegExp(p.text, 'i')).test(el.textContent || '')) continue;
          if (p.attrs) {
            let attrOk = true;
            for (const [k, re] of Object.entries(p.attrs)) {
              const v = el.getAttribute(k);
              if (v == null || !(new RegExp(re, 'i')).test(v)) { attrOk = false; break; }
            }
            if (!attrOk) continue;
          }
          ok = true;
          break;
        }
        if (!ok) continue;
        hit.push(p.id); // 推 probe id，背景那边按 id 对
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
          Promise.resolve(probeDom(probes.probes || [])).then((ids) =>
            Object.fromEntries(ids.map((id) => [id, true]))
          ),
        ]);
      }
    } catch { /* background 没起来就裸采 */ }

    chrome.runtime.sendMessage(
      {
        type: 'pageFeatures',
        features: {
          url: location.href,
          title: document.title || '',
          // 截断防超大页面，关键词一般都在前面
          body: document.documentElement.outerHTML.slice(0, 200_000),
          favicon,
          js,
          domHits,
        },
      },
      () => void chrome.runtime.lastError // SW 没起来之类的就不管了
    );
  }

  report();

  // SPA 换页：URL 变了但浏览器不刷新，得手动再扫。
  // 路由事件由 route-hook.js（main world）hook 后 postMessage 过来
  let lastUrl = location.href;
  let timer = null;
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.type !== 'gopainter:route') return;
    if (location.href === lastUrl) return; // pushState 有时也会原地打
    lastUrl = location.href;
    clearTimeout(timer);
    // 等几百 ms 让框架把新页面画出来再采
    timer = setTimeout(report, 600);
  });
})();
