// 稳态基准：预热后测单次 goMatch 的 min/median/p90/max，观察 GC 抖动。
// 用法：node scripts/bench-steady.mjs [numRules]
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
const bodySize = Number(process.env.BODYSIZE || 200_000);

const filler = 'x'.repeat(bodySize / 2);
const body = `<html><head><title>Test Site</title></head><body>${filler}<div class="wordpress-content">hello world wp-content theme</div><script src="/wp-includes/js/jquery.js"></script></body></html>`;
const common = ['jquery', 'wp-content', 'wp-includes', 'bootstrap', 'nginx', 'react', 'vue', 'api', 'cdn', 'theme', 'css', 'js'];

const rules = [];
for (let i = 0; i < numRules; i++) {
  const part = ['body', 'body', 'body', 'meta', 'script', 'title', 'header'][i % 7];
  const words = [`sig${i}`, common[i % common.length], `tech-${i % 50}`].slice(0, 1 + (i % 3));
  rules.push({ id: `rule-${i}`, name: `Tech ${i}`, 'matchers-condition': 'or', matchers: [{ type: 'word', part, words }] });
}
const features = {
  url: 'https://blog.example.com/',
  title: 'Test Site',
  body,
  headers: { server: 'nginx', 'content-type': 'text/html' },
  status: 200,
  meta: { generator: 'TestCMS', viewport: 'width=device-width' },
  scripts: ['/wp-includes/js/jquery.js', '/assets/app.js'],
  faviconHashes: [],
};

const rj = JSON.stringify(rules);
const fj = JSON.stringify(features);

for (let i = 0; i < 30; i++) JSON.parse(globalThis.goMatch(rj, fj)); // 预热（构建规则集缓存 + 稳定 GC）

const ts = [];
for (let i = 0; i < 50; i++) {
  const t0 = process.hrtime.bigint();
  JSON.parse(globalThis.goMatch(rj, fj));
  ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
ts.sort((a, b) => a - b);
const p = (q) => ts[Math.min(ts.length - 1, Math.floor(q * ts.length))].toFixed(1);
console.log(`rules=${numRules} body=${(body.length / 1024).toFixed(0)}KB  min=${ts[0].toFixed(1)} median=${p(0.5)} p90=${p(0.9)} max=${ts[ts.length - 1].toFixed(1)} ms`);
