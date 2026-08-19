// Shared off-tab page fetch used by bookmarks and crawl.
(() => {
  const MAX_PAGE_BYTES = 200_000;
  const FETCH_TIMEOUT_MS = 8_000;

  async function readBodyPrefix(response) {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let remaining = MAX_PAGE_BYTES;
    let body = '';
    try {
      while (remaining > 0) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
        body += decoder.decode(chunk, { stream: true });
        remaining -= chunk.byteLength;
        if (chunk.byteLength < value.byteLength || remaining === 0) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
      body += decoder.decode();
      return body;
    } finally {
      reader.releaseLock();
    }
  }

  async function fetchFeatures(url, options = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store',
      });
      const body = await readBodyPrefix(response);
      const headers = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      const features = await enrichFeatures({
        url: response.url || url,
        title: '',
        body,
        headers,
        status: response.status,
      });
      // fetch 无法读取 Set-Cookie；书签和爬虫模式不承诺 cookie 指纹覆盖。
      features.faviconHashes = await hashIcons(features.favicons || [], () => controller.signal.aborted);
      return features;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  globalThis.GoPainterPageFetch = Object.freeze({ fetchFeatures, MAX_PAGE_BYTES });
})();
