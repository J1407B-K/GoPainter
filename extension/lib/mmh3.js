// MurmurHash3 x86_32，算 fofa 的 favicon 哈希用。
// importScripts 加载，暴露全局 mmh3_32(str, seed = 0)。

/* eslint-disable no-bitwise */
function mmh3_32(key, seed = 0) {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  let h1 = seed >>> 0;
  const len = key.length;
  const roundedEnd = len & ~3;

  for (let i = 0; i < roundedEnd; i += 4) {
    let k1 =
      (key.charCodeAt(i) & 0xff) |
      ((key.charCodeAt(i + 1) & 0xff) << 8) |
      ((key.charCodeAt(i + 2) & 0xff) << 16) |
      ((key.charCodeAt(i + 3) & 0xff) << 24);

    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);

    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
  }

  let k1 = 0;
  const tail = len & 3;
  if (tail === 3) k1 ^= (key.charCodeAt(roundedEnd + 2) & 0xff) << 16;
  if (tail >= 2) k1 ^= (key.charCodeAt(roundedEnd + 1) & 0xff) << 8;
  if (tail >= 1) {
    k1 ^= key.charCodeAt(roundedEnd) & 0xff;
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }

  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;

  // 转成有符号 int32，跟 python mmh3.hash 对齐（fofa 语法里就是负数形式）
  return h1 | 0;
}
