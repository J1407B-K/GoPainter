// Benchmark JS-side costs that can block popup/options/background work.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { filterAndSortHits, filterRules, popupResultSnapshot } = require('../extension/shared-utils.js');

function bench(label, rounds, fn) {
  for (let i = 0; i < 3; i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < rounds; i++) fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / rounds;
  console.log(`${label}=${ms.toFixed(2)}ms/call`);
}

function makeFavicon(kb) {
  const buf = new Uint8Array(kb * 1024);
  for (let i = 0; i < buf.length; i++) buf[i] = i % 251;
  return buf;
}
function makeRules(n) {
  const rules = [];
  for (let i = 0; i < n; i++) {
    rules.push({ id: `r${i}`, name: `T${i}`, 'matchers-condition': 'or',
      matchers: [{ type: 'word', part: 'body', words: [`w${i}a`, `w${i}b`] }] });
  }
  return rules;
}

// 1) old char-by-char conversion
function convCharLoop(buf) {
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return bin;
}
// 2) TextDecoder('latin1')
const dec = new TextDecoder('latin1');
function convTextDecoder(buf) { return dec.decode(buf); }

for (const kb of [10, 30, 100]) {
  const buf = makeFavicon(kb);
  const n = 50;
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) convCharLoop(buf);
  let t1 = process.hrtime.bigint();
  const a = Number(t1 - t0) / 1e6 / n;
  t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) convTextDecoder(buf);
  t1 = process.hrtime.bigint();
  const b = Number(t1 - t0) / 1e6 / n;
  console.log(`favicon ${kb}KB: charLoop=${a.toFixed(2)}ms  TextDecoder=${b.toFixed(3)}ms  (${(a/b).toFixed(0)}x faster)`);
}

for (const n of [1000, 5000, 10000]) {
  const rules = makeRules(n);
  const rounds = 20;
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < rounds; i++) JSON.stringify(rules);
  let t1 = process.hrtime.bigint();
  console.log(`rules=${n} rulesJSON=${(JSON.stringify(rules).length/1024).toFixed(0)}KB  stringify=${(Number(t1-t0)/1e6/rounds).toFixed(2)}ms/call`);
}

for (const n of [10_000, 50_000]) {
  const rules = makeRules(n);
  bench(`ruleFilter rules ${n}`, 30, () => filterRules(rules, 't49', 300));
}

for (const n of [10_000, 50_000]) {
  const hits = Array.from({ length: n }, (_, i) => ({ id: `h${i}`, name: `Hit ${i}`, confidence: i % 7 ? i % 101 : null }));
  bench(`hitFilterSort hits ${n}`, 20, () => filterAndSortHits(hits, { showConfidence: true, confThreshold: 35 }));
}

const largeHits = Array.from({ length: 2000 }, (_, i) => ({
  id: `h${i}`, name: `Hit ${i}`, confidence: i % 101,
  evidence: Array.from({ length: 40 }, (_, j) => ({ type: 'word', part: 'body', detail: `e${j} ${'x'.repeat(1000)}` })),
}));
bench('popupSnapshot hits=2000 evidence=40', 100, () => popupResultSnapshot(
  { url: 'https://example.com', title: 'Large page', headers: { server: 'bench' }, faviconHashes: Array(50).fill(1) },
  { hits: largeHits }, 1,
));

const scriptSources = Array.from({ length: 100 }, (_, i) => `return features.value === ${i} ? hits : [];`);
bench('userScripts compile=100', 100, () => scriptSources.map((code) => new Function('features', 'hits', code)));
const compiledScripts = scriptSources.map((code) => new Function('features', 'hits', code));
bench('userScripts cachedRun=100', 1000, () => compiledScripts.forEach((fn) => fn({ value: -1 }, [])));

const hashes = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [String(i), `Tech ${i}`]));
bench('customHashes stringify=10000', 50, () => JSON.stringify(hashes));
const hashesJSON = JSON.stringify(hashes);
bench('customHashes cachedRead=10000', 100_000, () => hashesJSON.length);

const searchRules = makeRules(50_000);
const ruleQueries = ['t49', 'w1234', 'missing'];
bench('ruleSearch legacy 50000 x3', 5, () => ruleQueries.map((query) =>
  searchRules.filter((rule) => JSON.stringify(rule).toLowerCase().includes(query)).slice(0, 10)
));
const searchIndex = searchRules.map((rule) => ({ rule, text: `${rule.id}\n${rule.name}\n${JSON.stringify(rule.matchers)}`.toLowerCase() }));
bench('ruleSearch indexed 50000 x3', 30, () => ruleQueries.map((query) => {
  const matches = [];
  for (const entry of searchIndex) {
    if (entry.text.includes(query)) matches.push(entry.rule);
    if (matches.length >= 10) break;
  }
  return matches;
}));
