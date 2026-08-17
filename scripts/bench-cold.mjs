// 冷启动曲线：连续计时首次 N 次 goMatch，看规则集构建 + GC 停顿 + 收敛到稳态。
// 用法：node scripts/bench-cold.mjs [numRules] [numCalls]
import { createMatchFixture, loadMatcherWasm } from './bench-runtime.mjs';

await loadMatcherWasm();

const numRules = Number(process.argv[2] || 8000);
const numCalls = Number(process.argv[3] || 12);
const bodySize = Number(process.env.BODYSIZE || 200_000);

const { rulesJSON, featuresJSON } = createMatchFixture(numRules, bodySize);

const lat = [];
for (let i = 0; i < numCalls; i++) {
  const t0 = process.hrtime.bigint();
  JSON.parse(globalThis.goMatch(rulesJSON, featuresJSON));
  lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
console.log(lat.map((l, i) => `#${i + 1}: ${l.toFixed(0)}ms`).join('  '));
