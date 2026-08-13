// 连续扫描基准：模拟批量扫描不同页面（规则集缓存复用），测 per-scan 尾延迟分布。
// 用法：node scripts/bench-scan.mjs [numRules] [numPages]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
await import(join(ROOT, 'extension/wasm/wasm_exec.js'));
const go = new globalThis.Go();
const bytes = readFileSync(join(ROOT, 'extension/wasm/matcher.wasm'));
const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
go.run(instance);

const numRules = Number(process.argv[2] || 8000);
const numPages = Number(process.argv[3] || 200);

// 8000 条 word 规则，规则集只建一次（对应扩展里 rulesJsonCache / rulesetFor 缓存）
const common = ['jquery', 'wp-content', 'wp-includes', 'bootstrap', 'nginx', 'react', 'vue', 'api', 'cdn', 'theme', 'css', 'js'];
const rules = [];
for (let i = 0; i < numRules; i++) {
  const part = ['body', 'body', 'body', 'meta', 'script', 'title', 'header'][i % 7];
  const words = [`sig${i}`, common[i % common.length], `tech-${i % 50}`].slice(0, 1 + (i % 3));
  rules.push({ id: `rule-${i}`, name: `Tech ${i}`, 'matchers-condition': 'or', matchers: [{ type: 'word', part, words }] });
}
const rj = JSON.stringify(rules);

// 生成 N 个「不同页面」：body 大小循环变化，命中词集合也不同（命中数从 ~几百 到 ~几千）
const sizes = [20, 50, 100, 200, 400]; // KB
const pageFeatures = [];
for (let p = 0; p < numPages; p++) {
  const kb = sizes[p % sizes.length];
  const filler = 'x'.repeat(kb * 1024);
  // 随机挑几个命中词，让命中数随页面浮动
  const hits = common.filter(() => (p * 7919 + common.length) % 5 !== 0).join(' ');
  const body = `<html><head><title>Site ${p}</title></head><body>${filler}<div>${hits} theme wp-content</div><script src="/wp-includes/js/jquery.js"></script></body></html>`;
  pageFeatures.push(JSON.stringify({
    url: `https://page${p}.example.com/`,
    title: `Site ${p}`,
    body,
    headers: { server: 'nginx', 'content-type': 'text/html', 'x-powered-by': 'php' },
    status: 200,
    meta: { generator: 'TestCMS', viewport: 'width=device-width' },
    scripts: ['/wp-includes/js/jquery.js', `/assets/app${p}.js`],
    faviconHashes: [],
  }));
}

// 预热：建规则集 + 稳定 GC
for (let i = 0; i < 10; i++) JSON.parse(globalThis.goMatch(rj, pageFeatures[i % numPages]));

// 连续扫描，记录每页耗时
const lat = [];
for (let p = 0; p < numPages; p++) {
  const t0 = process.hrtime.bigint();
  JSON.parse(globalThis.goMatch(rj, pageFeatures[p]));
  lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
lat.sort((a, b) => a - b);
const q = (x) => lat[Math.min(lat.length - 1, Math.floor(x * lat.length))].toFixed(1);
console.log(`rules=${numRules} pages=${numPages}  p50=${q(0.5)} p90=${q(0.9)} p99=${q(0.99)} max=${lat[lat.length - 1].toFixed(1)} ms`);
