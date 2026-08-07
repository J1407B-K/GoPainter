const test = require('node:test');
const assert = require('node:assert/strict');
const {
  confidenceValue, filterAndSortHits, faviconHashValues, mergeRules, mergeConvertedRules, extractYaml,
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

test('faviconHashValues removes duplicate and empty values', () => {
  assert.deepEqual(faviconHashValues({ faviconHash: 12, faviconHashes: [0, 12, -8, -8] }), [12, -8]);
});

test('mergeRules updates duplicate ids while retaining existing rule order', () => {
  const out = mergeRules([{ id: 'a', name: 'old' }, { id: 'b' }], [{ id: 'a', name: 'new' }, { id: 'c' }]);
  assert.deepEqual(out, [{ id: 'a', name: 'new' }, { id: 'b' }, { id: 'c' }]);
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
