// 跑在页面的 main world（manifest 里 world: MAIN）。
// 职责：hook 前端路由改 URL 的通道，通知 content.js 重扫。

(() => {
  const fire = () => window.postMessage({ type: 'gopainter:route' }, location.origin);

  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function (...args) {
      const r = orig.apply(this, args);
      fire();
      return r;
    };
  }
  window.addEventListener('popstate', fire);   // 前进/后退
  window.addEventListener('hashchange', fire); // hash 路由

})();
