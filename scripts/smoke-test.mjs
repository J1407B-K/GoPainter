// 冒烟测试：在 Node 里加载 matcher.wasm 调 goMatch，验证引擎行为。
// 跑之前先 make build。
// 用法: node scripts/smoke-test.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

await import(join(ROOT, 'extension/wasm/wasm_exec.js')); // 挂全局 Go

const go = new globalThis.Go();
const bytes = readFileSync(join(ROOT, 'extension/wasm/matcher.wasm'));
const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
go.run(instance);

const rules = [
  {
    id: 'wordpress',
    name: 'WordPress',
    'matchers-condition': 'or',
    matchers: [{ type: 'word', part: 'body', words: ['/wp-content/', '/wp-includes/'] }],
  },
  {
    id: 'nginx-server',
    name: 'Nginx',
    matchers: [{ type: 'word', part: 'header', words: ['server: nginx'] }],
  },
  {
    id: 'jenkins',
    name: 'Jenkins',
    matchers: [
      { type: 'word', part: 'header', words: ['x-jenkins:'] },
      { type: 'regex', part: 'title', regex: ['Jenkins'] },
    ],
  },
  {
    id: 'gitea',
    name: 'Gitea',
    matchers: [{ type: 'icon_hash', hash: [-1234567890] }],
  },
];

const features = {
  url: 'https://blog.example.com/',
  title: 'My Blog',
  body: '<html><script src="/wp-content/themes/x.js"></script></html>',
  headers: { server: 'nginx', 'content-type': 'text/html' },
  status: 200,
  faviconHash: 42,
};

const out = JSON.parse(globalThis.goMatch(JSON.stringify(rules), JSON.stringify(features)));
console.log(JSON.stringify(out, null, 2));

const names = (out.hits || []).map((h) => h.name);
const wp = (out.hits || []).find((h) => h.id === 'wordpress');
const evidenceOk = wp?.evidence?.some((e) => e.type === 'word' && e.detail === '/wp-content/');

const pass =
  names.includes('WordPress') &&
  names.includes('Nginx') &&
  !names.includes('Jenkins') &&
  !names.includes('Gitea') &&
  evidenceOk;

console.log(pass ? '✅ 冒烟测试通过' : '❌ 结果不符合预期');
process.exit(pass ? 0 : 1);
