// 稳态基准：预热后测单次 goMatch 的 min/median/p90/max，观察 GC 抖动。
// 用法：node scripts/bench-steady.mjs [numRules]
import { createMatchFixture, loadMatcherWasm } from './bench-runtime.mjs';

await loadMatcherWasm();

const numRules = Number(process.argv[2] || 8000);
const bodySize = Number(process.env.BODYSIZE || 200_000);

const { body, rulesJSON, featuresJSON } = createMatchFixture(numRules, bodySize);

for (let i = 0; i < 30; i++) JSON.parse(globalThis.goMatch(rulesJSON, featuresJSON)); // 预热（构建规则集缓存 + 稳定 GC）

const ts = [];
for (let i = 0; i < 50; i++) {
  const t0 = process.hrtime.bigint();
  JSON.parse(globalThis.goMatch(rulesJSON, featuresJSON));
  ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
ts.sort((a, b) => a - b);
const p = (q) => ts[Math.min(ts.length - 1, Math.floor(q * ts.length))].toFixed(1);
console.log(`rules=${numRules} body=${(body.length / 1024).toFixed(0)}KB  min=${ts[0].toFixed(1)} median=${p(0.5)} p90=${p(0.9)} max=${ts[ts.length - 1].toFixed(1)} ms`);
