(() => {
  const MAX_BYTES = 200_000;
  const MAX_OUTPUT_CHARS = 30_000;
  const MAX_REDIRECTS = 3;
  const TIMEOUT_MS = 15_000;
  const blockedNames = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

  function ipv4Blocked(address) {
    const parts = address.split('.');
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
    const [a, b, c] = parts.map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && [0, 2].includes(c))
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113);
  }

  function addressBlocked(rawAddress) {
    const address = String(rawAddress || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
    const ipv4 = ipv4Blocked(address);
    if (ipv4 !== null) return ipv4;
    if (!address.includes(':')) return true;
    if (address === '::' || address === '::1' || address.startsWith('fc') || address.startsWith('fd')
      || /^fe[89ab]/.test(address) || address.startsWith('ff') || address.startsWith('2001:db8:')
      || address.includes('::ffff:')) return true;
    const embedded = address.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return embedded ? ipv4Blocked(embedded) !== false : false;
  }

  function validateURL(raw) {
    let url;
    try { url = new URL(raw); } catch { throw new Error('url 必须是完整的 HTTPS URL'); }
    if (url.protocol !== 'https:') throw new Error('fetch_url 只允许 HTTPS URL');
    if (url.username || url.password) throw new Error('URL 不允许包含账号凭据');
    if (url.port && url.port !== '443') throw new Error('只允许标准 HTTPS 端口');
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (!hostname || blockedNames.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')
      || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa')) throw new Error('不允许访问本地或内部主机');
    const literal = ipv4Blocked(hostname);
    if (literal === true || (hostname.includes(':') && addressBlocked(hostname))) throw new Error('不允许访问私有、本地或保留地址');
    return url;
  }

  async function readBounded(response, maxBytes) {
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error(`响应体超过 ${maxBytes} 字节上限`);
    if (!response.body?.getReader) {
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) throw new Error(`响应体超过 ${maxBytes} 字节上限`);
      return buffer;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error(`响应体超过 ${maxBytes} 字节上限`);
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  function decodeEntities(text) {
    return text.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#(?:39|x27);/gi, "'").replace(/&#(\d+);/g, (_all, code) => String.fromCodePoint(Number(code)));
  }

  function readableText(raw, contentType) {
    if (!/html|xhtml/i.test(contentType)) return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_OUTPUT_CHARS);
    const title = decodeEntities(raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, ' ') || '').replace(/\s+/g, ' ').trim();
    const body = decodeEntities(raw.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(?:p|div|section|article|main|header|footer|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
      .replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { title, text: body.slice(0, MAX_OUTPUT_CHARS) };
  }

  function originGrant(origin) {
    return `fetch_url:${origin}`;
  }

  async function fetchPublic(startURL, context = {}) {
    const signal = context?.signal;
    let current = validateURL(startURL);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const response = await fetch(current.href, {
          method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: { Accept: 'text/html,text/plain,application/json,application/xml,text/xml;q=0.9,*/*;q=0.1' },
        });
        if (response.status >= 300 && response.status < 400) {
          if (redirects === MAX_REDIRECTS) throw new Error(`重定向超过 ${MAX_REDIRECTS} 次上限`);
          const location = response.headers.get('location');
          if (!location) throw new Error('重定向响应缺少可验证的 Location');
          const next = validateURL(new URL(location, current).href);
          if (next.origin !== current.origin && !context.grants?.includes(originGrant(next.origin))) {
            throw new Error(`跨来源重定向需要单独授权：${next.href}`);
          }
          current = next;
          continue;
        }
        if (!response.ok) throw new Error(`读取失败: HTTP ${response.status}`);
        const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!(contentType.startsWith('text/') || ['application/json', 'application/xml', 'application/xhtml+xml'].includes(contentType))) {
          throw new Error(`不支持的内容类型：${contentType || '(missing)'}`);
        }
        const bytes = await readBounded(response, MAX_BYTES);
        const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        const content = readableText(decoded, contentType);
        return {
          url: current.href, status: response.status, contentType, bytes: bytes.byteLength,
          title: typeof content === 'string' ? '' : content.title,
          text: typeof content === 'string' ? content : content.text,
          untrusted: true,
        };
      }
      throw new Error('重定向处理失败');
    } catch (error) {
      if (controller.signal.aborted) throw new Error(signal?.aborted ? 'Agent 已取消' : `读取 URL 超时（${TIMEOUT_MS / 1000} 秒）`);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  GoPainterAgentTools.register({
    name: 'fetch_url',
    description: '读取公开 HTTPS 页面的有界文本正文，用于核验 web_search 找到的官方资料。拒绝显式本地/私有地址，并尽力降低 SSRF 风险；浏览器 fetch 不提供 DNS pinning。',
    inputSchema: {
      type: 'object', properties: { url: { type: 'string', minLength: 1, maxLength: 2048 } },
      required: ['url'], additionalProperties: false,
    },
    effect: 'network', permission: 'confirm',
    grantScope: ({ url }) => new URL(url).origin,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    skillIds: ['fingerprint-research', 'gopainter-word-matcher', 'gopainter-regex-matcher', 'gopainter-runtime-matcher'],
    validate(input) {
      const url = GoPainterAgentPage.string(input?.url).trim();
      if (!url || url.length > 2048) throw new Error('url 长度无效');
      return { url: validateURL(url).href };
    },
    async execute({ url }, context) { return fetchPublic(url, context); },
  });

  globalThis.GoPainterAgentFetchURL = Object.freeze({ validateURL, addressBlocked, fetchPublic });
})();
