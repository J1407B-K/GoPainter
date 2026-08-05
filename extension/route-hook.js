// 跑在页面的 main world（manifest 里 world: MAIN）。
// 两个职责：1) hook 前端路由改 URL 的通道，通知 content.js 重扫
//          2) 应答 js 全局变量探测（content script 的隔离世界摸不到页面的 window）

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

  // js 变量探测：content.js 发路径列表过来，我们查 window 再回结果
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.type !== 'gopainter:probe') return;
    const out = {};
    for (const path of e.data.paths || []) {
      try {
        let v = window;
        for (const part of path.split('.')) {
          if (v == null) break;
          v = v[part];
        }
        if (v === undefined || v === null) continue; // 不存在就不进结果
        let summary;
        try {
          if (typeof v === 'string') summary = v;
          else if (typeof v === 'function') summary = 'function';
          else summary = JSON.stringify(v) ?? typeof v;
        } catch {
          summary = typeof v;
        }
        out[path] = String(summary).slice(0, 120); // 截断防巨型对象
      } catch { /* 路径访问炸了（getter 报错之类）就当不存在 */ }
    }
    window.postMessage({ type: 'gopainter:jsResult', globals: out }, '*');
  });
})();
