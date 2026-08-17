// Shared off-tab page fetch used by bookmarks and crawl.
(() => {
  async function fetchFeatures(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      const body = (await response.text()).slice(0, 200_000);
      const headers = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      const features = await enrichFeatures({
        url,
        title: '',
        body,
        headers,
        status: response.status,
      });
      // fetch 无法读取 Set-Cookie；书签和爬虫模式不承诺 cookie 指纹覆盖。
      features.faviconHashes = await hashIcons(features.favicons || []);
      return features;
    } finally {
      clearTimeout(timer);
    }
  }

  globalThis.GoPainterPageFetch = Object.freeze({ fetchFeatures });
})();
