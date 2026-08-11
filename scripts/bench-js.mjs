// Benchmark JS-side costs: favicon byte→binary-string conversion and rules JSON.stringify
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
