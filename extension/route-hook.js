// 跑在页面的 main world（manifest 里 world: MAIN），hook 前端路由改 URL 的通道。
// 隔离世界的 content script 拦不到页面自己的 pushState，所以得来这里拦，
// 拦到了就 postMessage 通知 content.js 重新扫。

(() => {
  const fire = () => window.postMessage({ type: 'gopainter:route' }, '*');

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
