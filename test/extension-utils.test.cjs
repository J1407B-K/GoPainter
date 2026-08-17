const test = require('node:test');
const assert = require('node:assert/strict');
const {
  confidenceValue, filterAndSortHits, filterRules, crawlRenderSignature, popupResultSnapshot, agentPageSnapshot, faviconHashValues, bytesToBinaryString, mergeRules, planRuleMerge, diffTextLines, mergeConvertedRules,
  normalizeRuleSets, replaceActiveRuleSetRules, ruleSetOverrideInfo, extractYaml, sanitizeImportedRuleDocs,
  extractJson, normalizeAiEvidence, normalizeAiTech, techsFromAiReply, ruleByTechName, sanitizeRuleDocs,
  scanHistoryEntry, mergeScanHistory, normalizeHistoryLimit, scanHistoryReport, scanHistoryCsv,
} = require('../extension/shared-utils.js');

test('confidenceValue only accepts the supported 0-100 range', () => {
  assert.equal(confidenceValue({ confidence: '85' }), 85);
  assert.equal(confidenceValue({ confidence: 0 }), 0);
  assert.equal(confidenceValue({ confidence: '' }), null);
  assert.equal(confidenceValue({ confidence: 101 }), null);
  assert.equal(confidenceValue({ confidence: 'unknown' }), null);
});

test('filterAndSortHits preserves unannotated hits and sorts confidence stably', () => {
  const hits = [
    { id: 'first', confidence: 60 },
    { id: 'plain' },
    { id: 'highest', confidence: 90 },
    { id: 'too-low', confidence: 30 },
    { id: 'same-score', confidence: 60 },
  ];
  const out = filterAndSortHits(hits, { showConfidence: true, confThreshold: 50 });
  assert.deepEqual(out.hits.map((hit) => hit.id), ['highest', 'first', 'same-score', 'plain']);
  assert.equal(out.hidden, 1);
  assert.equal(out.annotated, 4);
  assert.deepEqual(hits.map((hit) => hit.id), ['first', 'plain', 'highest', 'too-low', 'same-score']);
});

test('large UI collections are filtered and compacted without returning the full source', () => {
  const rules = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, name: `Rule ${i}` }));
  const filtered = filterRules(rules, 'rule', 300);
  assert.equal(filtered.total, 1000);
  assert.equal(filtered.items.length, 300);

  const hits = Array.from({ length: 200 }, (_, i) => ({ id: `h${i}`, name: `Hit ${i}`, evidence: Array(30).fill({ detail: 'x'.repeat(1000) }) }));
  const snapshot = popupResultSnapshot({ faviconHashes: Array(30).fill(1) }, { hits }, 123);
  assert.equal(snapshot.result.totalHits, 200);
  assert.equal(snapshot.result.hits.length, 100);
  assert.equal(snapshot.result.hits[0].evidence.length, 20);
  assert.equal(snapshot.result.hits[0].evidence[0].detail.length, 500);
  assert.equal(snapshot.features.faviconHashes.length, 20);
  const agent = agentPageSnapshot({
    url: 'https://example.test', body: 'x'.repeat(200_000),
    meta: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`m${i}`, 'x'.repeat(1000)])),
    js: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`j${i}`, 'x'.repeat(1000)])),
  }, 123);
  assert.equal(agent.body, undefined);
  assert.equal(Object.keys(agent.meta).length, 100);
  assert.equal(Object.keys(agent.js).length, 100);
  assert.equal(agent.meta.m0.length, 500);
  assert.equal(crawlRenderSignature({ results: [{ url: 'a', status: 200, hits: [] }], failed: [] }), '1|0|a|200|0||');
});

test('faviconHashValues removes duplicates and empty values', () => {
  assert.deepEqual(faviconHashValues({ faviconHashes: [0, 12, -8, -8] }), [12, -8]);
});

test('bytesToBinaryString preserves every byte for base64 hashing', () => {
  const bytes = Uint8Array.from([0x00, 0x7f, 0x80, 0x9f, 0xff]);
  const binary = bytesToBinaryString(bytes);
  assert.deepEqual([...binary].map((char) => char.charCodeAt(0)), [...bytes]);
  assert.equal(btoa(binary), 'AH+An/8=');
});

test('mergeRules updates duplicate ids while retaining existing rule order', () => {
  const out = mergeRules([{ id: 'a', name: 'old' }, { id: 'b' }], [{ id: 'a', name: 'new' }, { id: 'c' }]);
  assert.deepEqual(out, [{ id: 'a', name: 'new' }, { id: 'b' }, { id: 'c' }]);
});

test('rule merge planning requires explicit choices for changed duplicate ids', () => {
  const existing = [{ id: 'same', name: 'Same' }, { id: 'conflict', name: 'Old' }];
  const incoming = [{ id: 'same', name: 'Same' }, { id: 'conflict', name: 'New' }, { id: 'added', name: 'Added' }];
  const pending = planRuleMerge(existing, incoming);
  assert.deepEqual(pending.unresolved.map((item) => item.id), ['conflict']);
  assert.equal(pending.added, 1);
  assert.equal(pending.unchanged, 1);
  assert.deepEqual(pending.rules, [...existing, incoming[2]]);

  const accepted = planRuleMerge(existing, incoming, { conflict: 'incoming' });
  assert.equal(accepted.replaced, 1);
  assert.deepEqual(accepted.rules, [existing[0], incoming[1], incoming[2]]);
  const rejected = planRuleMerge(existing, incoming, { conflict: 'existing' });
  assert.equal(rejected.kept, 1);
  assert.deepEqual(rejected.rules, [...existing, incoming[2]]);
});

test('line diff marks additions and removals while retaining context', () => {
  assert.deepEqual(diffTextLines('id: old\nname: Same\n', 'id: new\nname: Same\n'), [
    { type: 'remove', line: 'id: old' },
    { type: 'add', line: 'id: new' },
    { type: 'same', line: 'name: Same' },
  ]);
});

test('rule sets migrate legacy rules and keep the active rules mirror in sync', () => {
  const initial = normalizeRuleSets(undefined, undefined, [{ id: 'legacy' }]);
  assert.deepEqual(initial, {
    ruleSets: [{ id: 'default', name: '默认规则集', rules: [{ id: 'legacy' }] }],
    activeRuleSetId: 'default', enabledRuleSetIds: ['default'], ruleSetOverrides: {}, rules: [{ id: 'legacy' }],
  });
  const next = replaceActiveRuleSetRules(initial, [{ id: 'new' }]);
  assert.deepEqual(next.rules, [{ id: 'new' }]);
  assert.deepEqual(next.ruleSets[0].rules, [{ id: 'new' }]);
});

test('rule sets merge every enabled set while edits stay scoped to the active set', () => {
  const sets = [
    { id: 'base', name: 'Base', rules: [{ id: 'shared', name: 'Base' }, { id: 'base-only' }] },
    { id: 'extra', name: 'Extra', rules: [{ id: 'shared', name: 'Extra' }, { id: 'extra-only' }] },
  ];
  const state = normalizeRuleSets(sets, 'base', [], ['base', 'extra', 'missing', 'base']);
  assert.deepEqual(state.enabledRuleSetIds, ['base', 'extra']);
  assert.deepEqual(state.rules, [
    { id: 'shared', name: 'Extra' }, { id: 'base-only' }, { id: 'extra-only' },
  ]);

  const next = replaceActiveRuleSetRules(state, [{ id: 'replacement' }]);
  assert.deepEqual(next.ruleSets[0].rules, [{ id: 'replacement' }]);
  assert.deepEqual(next.ruleSets[1].rules, sets[1].rules);
  assert.deepEqual(next.rules, [{ id: 'replacement' }, ...sets[1].rules]);
});

test('rule set override info exposes duplicate sources and the effective winner', () => {
  const sets = [
    { id: 'base', name: 'Base', rules: [{ id: 'shared' }, { id: 'base-only' }] },
    { id: 'off', name: 'Disabled', rules: [{ id: 'shared' }] },
    { id: 'extra', name: 'Extra', rules: [{ id: 'shared' }, { id: 'extra-only' }] },
  ];
  const info = ruleSetOverrideInfo(sets, ['base', 'extra']);
  assert.deepEqual(info.conflicts, [{
    id: 'shared',
    sources: [{ id: 'base', name: 'Base' }, { id: 'extra', name: 'Extra' }],
    winnerId: 'extra', winnerName: 'Extra', explicit: false,
  }]);
  assert.deepEqual(info.perSet, {
    base: { wins: 0, overridden: 1 },
    extra: { wins: 1, overridden: 0 },
  });
});

test('a per-rule set override selects that enabled version without changing set order', () => {
  const sets = [
    { id: 'base', name: 'Base', rules: [{ id: 'shared', name: 'Base version' }] },
    { id: 'extra', name: 'Extra', rules: [{ id: 'shared', name: 'Extra version' }] },
  ];
  const state = normalizeRuleSets(sets, 'base', [], ['base', 'extra'], { shared: 'base', stale: 'missing' });
  assert.deepEqual(state.ruleSetOverrides, { shared: 'base' });
  assert.deepEqual(state.rules, [{ id: 'shared', name: 'Base version' }]);
  const info = ruleSetOverrideInfo(sets, state.enabledRuleSetIds, state.ruleSetOverrides);
  assert.equal(info.conflicts[0].winnerId, 'base');
  assert.equal(info.conflicts[0].explicit, true);
  assert.deepEqual(info.perSet, {
    base: { wins: 1, overridden: 0 },
    extra: { wins: 0, overridden: 1 },
  });
});

test('rule sets may all be disabled without falling back to the active set', () => {
  const state = normalizeRuleSets([{ id: 'one', name: 'One', rules: [{ id: 'a' }] }], 'one', [], []);
  assert.deepEqual(state.enabledRuleSetIds, []);
  assert.deepEqual(state.rules, []);
});

test('import sanitizing preserves nuclei templates while cleaning native rules', () => {
  const nuclei = { id: 'nuclei-test', info: { name: 'Nuclei Test' }, http: [{ matchers: [{ type: 'word', words: ['x'] }] }] };
  const out = sanitizeImportedRuleDocs([
    nuclei,
    [{ id: 'native', name: 'Native', matchers: { type: 'word', words: 'hello' } }],
  ]);
  assert.equal(out[0], nuclei);
  assert.deepEqual(out[1], { id: 'native', name: 'Native', matchers: [{ type: 'word', words: ['hello'] }] });
});

test('mergeConvertedRules combines matchers and de-duplicates relations without mutating input', () => {
  const rules = [
    { id: 'wp', matchers: [{ type: 'word' }], implies: ['PHP'], excludes: ['Drupal'] },
    { id: 'wp', matchers: [{ type: 'regex' }], implies: ['PHP', 'MySQL'], excludes: ['Drupal', 'Joomla'] },
  ];
  const out = mergeConvertedRules(rules);
  assert.deepEqual(out, [{
    id: 'wp', matchers: [{ type: 'word' }, { type: 'regex' }], implies: ['PHP', 'MySQL'], excludes: ['Drupal', 'Joomla'],
  }]);
  assert.deepEqual(rules[0].matchers, [{ type: 'word' }]);
});

test('extractYaml removes a YAML fence and leaves ordinary YAML alone', () => {
  assert.equal(extractYaml('text\n```yaml\n- id: wordpress\n```\n'), '- id: wordpress');
  assert.equal(extractYaml('```YML\r\nid: nginx\r\n```'), 'id: nginx');
  assert.equal(extractYaml('  - id: plain  '), '- id: plain');
});

test('scan history stores a compact report and replaces an older scan of the same URL', () => {
  const entry = scanHistoryEntry({ url: 'https://example.com', title: 'Example', status: 200, faviconHashes: [-8] }, {
    hits: [{ id: 'nginx', name: 'Nginx', confidence: 90, evidence: [{ type: 'word', part: 'header', detail: 'server: nginx' }] }],
  }, 'page', 100);
  assert.deepEqual(entry, {
    url: 'https://example.com', title: 'Example', status: 200, faviconHashes: [-8], source: 'page', at: 100,
    hits: [{ id: 'nginx', name: 'Nginx', confidence: 90, evidence: [{ matcher: 'word', location: 'header', matched: 'server: nginx' }] }],
  });
  const out = mergeScanHistory([{ url: 'https://example.com', at: 1 }, { url: 'https://old.example', at: 2 }], entry, 2);
  assert.deepEqual(out.map((item) => item.url), ['https://example.com', 'https://old.example']);
});

test('scanHistoryCsv escapes commas, quotes and newlines for spreadsheet import', () => {
  const csv = scanHistoryCsv([{ at: 0, source: 'page', url: 'https://example.com/a,b', title: 'A "quoted" title', status: 200, faviconHashes: [0],
    hits: [{ name: 'Nginx', confidence: 90, evidence: [{ type: 'word', part: 'header', detail: 'server: nginx\nnext' }] }],
  }]);
  assert.match(csv, /^time,source,url,title,status,favicon_hash,fingerprint_id,fingerprint_name,confidence,matcher,location,matched,expression\r\n/);
  assert.match(csv, /"https:\/\/example\.com\/a,b"/);
  assert.match(csv, /"A ""quoted"" title"/);
  assert.match(csv, /"server: nginx\nnext"/);
});

test('scanHistoryReport separates actual matches from optional rule expressions', () => {
  const report = scanHistoryReport([{ at: 0, source: 'page', url: 'https://example.com', title: '', status: 200, faviconHashes: [],
    hits: [{ id: 'c3-js', name: 'C3.js', confidence: null, evidence: [
      { type: 'regex', part: 'script', detail: 'c3.js', pattern: 'c3(?:\\.min)?\\.js' },
      { type: 'word', part: 'body', detail: 'hello' },
    ] }],
  }], 100);
  const evidence = report.scans[0].detections[0].evidence;
  assert.deepEqual(evidence[0], { matcher: 'regex', location: 'script', matched: 'c3.js', expression: 'c3(?:\\.min)?\\.js' });
  assert.deepEqual(evidence[1], { matcher: 'word', location: 'body', matched: 'hello' });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.generatedAt, '1970-01-01T00:00:00.100Z');
});

test('normalizeHistoryLimit keeps the configurable rolling window in safe bounds', () => {
  assert.equal(normalizeHistoryLimit(50), 50);
  assert.equal(normalizeHistoryLimit('750'), 750);
  assert.equal(normalizeHistoryLimit(10), 50);
  assert.equal(normalizeHistoryLimit(9000), 5000);
  assert.equal(normalizeHistoryLimit('bad', 300), 300);
});

test('extractJson pulls JSON out of fenced or prose-wrapped AI replies', () => {
  assert.deepEqual(extractJson('```json\n[{"name":"Nginx"}]\n```'), { ok: true, value: [{ name: 'Nginx' }] });
  assert.deepEqual(extractJson('根据分析，结果是：[{"name":"Nginx","confidence":0.9}] 以上。'), { ok: true, value: [{ name: 'Nginx', confidence: 0.9 }] });
  assert.deepEqual(extractJson('{\"techs\":[1,2]} 后面有散文'), { ok: true, value: { techs: [1, 2] } });
  assert.deepEqual(extractJson('这里没有 JSON'), { ok: false });
  assert.deepEqual(extractJson(''), { ok: false });
  assert.deepEqual(extractJson('```json\n[broken\n```'), { ok: false });
});

test('ruleByTechName matches rules by id or name case-insensitively', () => {
  const rules = [{ id: 'wordpress', name: 'WordPress' }, { id: 'nginx', name: 'Nginx' }];
  assert.equal(ruleByTechName(rules, 'wordpress').name, 'WordPress');
  assert.equal(ruleByTechName(rules, 'WordPress').id, 'wordpress');
  assert.equal(ruleByTechName(rules, 'NGINX').name, 'Nginx');
  assert.equal(ruleByTechName(rules, 'Nope'), null);
  assert.equal(ruleByTechName(rules, ''), null);
  assert.equal(ruleByTechName([], 'nginx'), null);
});

test('normalizeAiEvidence maps location types to word matchers and keeps others', () => {
  assert.deepEqual(normalizeAiEvidence({ type: 'header', detail: 'server: nginx' }), { type: 'word', part: 'header', detail: 'server: nginx' });
  assert.deepEqual(normalizeAiEvidence({ type: 'status', detail: '状态码 200' }), { type: 'status', detail: '状态码 200' });
  assert.deepEqual(normalizeAiEvidence({ type: 'regex', detail: '/wp-content/', pattern: 'wp-.*' }), { type: 'regex', detail: '/wp-content/', pattern: 'wp-.*' });
  assert.equal(normalizeAiEvidence(null), null);
  assert.equal(normalizeAiEvidence({ type: 'word' }), null);
});

test('normalizeAiTech normalizes confidence and drops unnamed techs', () => {
  assert.deepEqual(normalizeAiTech({ name: 'ZenTao', confidence: 0.92, evidence: [{ type: 'meta', detail: 'generator: ZenTao' }] }), {
    name: 'ZenTao', confidence: 92, evidence: [{ type: 'word', part: 'meta', detail: 'generator: ZenTao' }],
  });
  assert.equal(normalizeAiTech({ name: 'Nginx', confidence: 92 }).confidence, 92);
  assert.equal(normalizeAiTech({ name: 'X', confidence: 'high' }).confidence, null);
  assert.equal(normalizeAiTech({ name: 'X' }).confidence, null);
  assert.equal(normalizeAiTech({ name: 'Y', confidence: 250 }).confidence, 100);
  assert.equal(normalizeAiTech({ name: '' }), null);
  assert.equal(normalizeAiTech(null), null);
});

test('techsFromAiReply accepts arrays or wrapped objects and falls back to raw text', () => {
  const ok = techsFromAiReply('[{"name":"Nginx","confidence":1}]');
  assert.equal(ok.raw, '');
  assert.equal(ok.techs.length, 1);
  assert.equal(ok.techs[0].confidence, 100);

  const wrapped = techsFromAiReply('{"techs":[{"name":"React"}]}');
  assert.equal(wrapped.techs.length, 1);
  assert.equal(wrapped.techs[0].name, 'React');

  const bad = techsFromAiReply('Nginx，置信度 0.9，依据是 server 头');
  assert.deepEqual(bad.techs, []);
  assert.equal(bad.raw, 'Nginx，置信度 0.9，依据是 server 头');
});

test('sanitizeRuleDocs fixes AI output shapes that would drop the whole rule', () => {
  // 单条规则对象（jsyaml.loadAll 对 "- id:" 文档会包一层数组）
  const single = sanitizeRuleDocs([[{
    id: 'wp', name: 'WordPress', 'matchers-condition': 'or',
    matchers: [{ type: 'word', words: 'wp-content', confidence: 0.8 }],
  }]]);
  assert.equal(single.length, 1);
  assert.deepEqual(single[0].matchers[0].words, ['wp-content']);
  assert.equal(single[0].matchers[0].confidence, 80); // 0-1 → 0-100

  // 规则级浮点 confidence → 0-100 整数
  const rc = sanitizeRuleDocs([{ id: 'a', name: 'A', confidence: 0.92, matchers: [{ type: 'word', words: ['x'] }] }]);
  assert.equal(rc[0].confidence, 92);

  // 单 matcher 不装数组、hash 标量、implies 标量
  const shapes = sanitizeRuleDocs([{
    id: 'b', name: 'B', implies: 'React',
    matchers: { type: 'icon_hash', hash: -123 },
  }]);
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].matchers.length, 1);
  assert.deepEqual(shapes[0].matchers[0].hash, [-123]);
  assert.deepEqual(shapes[0].implies, ['React']);

  // 不支持的 matcher 类型丢掉，其余保留
  const mixed = sanitizeRuleDocs([{
    id: 'c', name: 'C',
    matchers: [
      { type: 'binary', words: ['x'] },
      { type: 'word', words: ['ok'] },
    ],
  }]);
  assert.equal(mixed[0].matchers.length, 1);
  assert.equal(mixed[0].matchers[0].type, 'word');

  // 无 id / 无有效 matcher 的规则被丢弃
  assert.deepEqual(sanitizeRuleDocs([{ name: 'NoId', matchers: [{ type: 'word', words: ['x'] }] }]), []);
  assert.deepEqual(sanitizeRuleDocs([{ id: 'd', name: 'D', matchers: [] }]), []);
  assert.deepEqual(sanitizeRuleDocs([]), []);

  // 越界 confidence 视为未标注（与引擎 validConfidence 一致）
  const badConf = sanitizeRuleDocs([{ id: 'e', name: 'E', confidence: 150, matchers: [{ type: 'word', words: ['x'] }] }]);
  assert.equal(badConf[0].confidence, undefined);
});
