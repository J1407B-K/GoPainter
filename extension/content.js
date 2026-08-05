// 采集页面特征发给 background。响应头/状态码那边有 webRequest 管，这里只管 DOM 能拿到的。
// SPA 路由变化（pushState/replaceState/popstate/hashchange）时重采重扫。

(() => {
  function report() {
    let favicon = '';
    const link = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"]');
    if (link?.href) favicon = link.href;

    chrome.runtime.sendMessage(
      {
        type: 'pageFeatures',
        features: {
          url: location.href,
          title: document.title || '',
          // 截断防超大页面，关键词一般都在前面
          body: document.documentElement.outerHTML.slice(0, 200_000),
          favicon,
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
