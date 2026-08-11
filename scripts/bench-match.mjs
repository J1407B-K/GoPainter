// Benchmark goMatch with realistic large ruleset + large body.
// Usage: node scripts/bench-match.mjs [numRules]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
await import(join(ROOT, 'extension/wasm/wasm_exec.js'));
const go = new globalThis.Go();
const bytes = readFileSync(join(ROOT, 'extension/wasm/matcher.wasm'));
const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
go.run(instance);

const numRules = Number(process.argv[2] || 3000);
const bodySize = Number(process.env.BODYSIZE || 200_000);

// 200KB 假 HTML body，一半内容是真词命中不了，模拟真实扫描
const filler = 'x'.repeat(bodySize / 2);
const body = `<html><head><title>Test Site</title></head><body>${filler}<div class="wordpress-content">hello world wp-content theme</div><script src="/wp-includes/js/jquery.js"></script></body></html>`;

// 模拟 Wappalyzer 规模：每条规则 1-3 个短 word，body 里会命中一批常见词
const realistic = process.env.REALISTIC === '1';
const rules = [];
if (realistic) {
  const common = ['jquery', 'wp-content', 'wp-includes', 'bootstrap', 'nginx', 'react', 'vue', 'api', 'cdn', 'theme', 'css', 'js'];
  for (let i = 0; i < numRules; i++) {
    const part = ['body', 'body', 'body', 'meta', 'script', 'title', 'header'][i % 7];
    const words = [`sig${i}`, common[i % common.length], `tech-${i % 50}`].slice(0, 1 + (i % 3));
    rules.push({
      id: `rule-${i}`,
      name: `Tech ${i}`,
      'matchers-condition': 'or',
      matchers: [{ type: 'word', part, words }],
    });
  }
  // 早期命中：真实页面会匹配到不少常见词，规则循环里 map 查询为主
} else {
  for (let i = 0; i < numRules; i++) {
    const part = ['body', 'body', 'body', 'meta', 'script', 'title', 'header'][i % 7];
    const words = [`tech-${i}-unique`, `sig-${i}`, 'nothing-here'].slice(0, 1 + (i % 3));
    rules.push({
      id: `rule-${i}`,
      name: `Tech ${i}`,
      'matchers-condition': 'or',
      matchers: [{ type: 'word', part, words }],
    });
  }
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

const rulesJSON = JSON.stringify(rules);
const featuresJSON = JSON.stringify(features);
console.log(`rules=${numRules} body=${(body.length / 1024).toFixed(0)}KB rulesJSON=${(rulesJSON.length / 1024).toFixed(0)}KB`);

// warm up
JSON.parse(globalThis.goMatch(rulesJSON, featuresJSON));

const N = 5;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  JSON.parse(globalThis.goMatch(rulesJSON, featuresJSON));
}
const t1 = process.hrtime.bigint();
const perCall = Number(t1 - t0) / 1e6 / N;
console.log(`goMatch: ${perCall.toFixed(1)}ms/call`);

// 单独测 ToLower 部分：都是 body word 匹配时看是否有差异
