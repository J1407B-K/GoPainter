// 采集页面特征发给 background。响应头/状态码那边有 webRequest 管，这里只管 DOM 能拿到的。

(() => {
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
})();
