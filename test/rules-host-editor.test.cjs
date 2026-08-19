const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const utils = require('../extension/shared-utils.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background', 'rules-host.js'), 'utf8');

function createHarness() {
  let invalidations = 0;
  const recollections = [];
  const original = {
    id: 'demo', name: 'Demo', 'matchers-condition': 'or',
    matchers: [{ type: 'word', part: '', condition: '', negative: false, words: ['old'] }],
  };
  const storage = {
    ruleSets: [
      { id: 'local', name: 'Local', rules: [] },
      { id: 'remote', name: 'Remote', rules: [original] },
    ],
    activeRuleSetId: 'local',
    enabledRuleSetIds: ['remote'],
    ruleSetOverrides: {},
    rules: [original],
    ruleStateRevision: 4,
  };
  const context = {
    console,
    JSON,
    chrome: { storage: { local: {
      get: async (keys) => {
        if (typeof keys === 'string') return { [keys]: storage[keys] };
        return Object.fromEntries(keys.map((key) => [key, storage[key]]));
      },
      set: async (values) => Object.assign(storage, JSON.parse(JSON.stringify(values))),
    }, session: { get: async () => ({}) } },
    tabs: { sendMessage: async (tabId, message) => { recollections.push({ tabId, message }); } } },
    jsyaml: {
      loadAll: (text, callback) => callback(JSON.parse(text)),
      dump: (value) => JSON.stringify(value),
    },
    GoPainterUtils: utils,
    invalidateRuleMatchingCaches: () => { invalidations++; },
    ensureWasm: async () => {},
    goValidateCandidate: (ruleJSON) => {
      const rule = JSON.parse(ruleJSON);
      const normalizedRule = {
        ...rule,
        matchers: rule.matchers.map((matcher) => ({ part: '', condition: '', negative: false, ...matcher })),
      };
      return JSON.stringify({
        valid: true,
        rule: normalizedRule,
        currentPageHits: [{ id: rule.id, name: rule.name, version: '2.0' }],
        runtimeCoverage: { complete: true, missingJsPaths: [], hasUnverifiedDomSelectors: false },
        errors: [],
      });
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'rules-host.js' });
  return {
    handlers: context.GoPainterRulesHost.handlers,
    storage,
    effects: () => ({ invalidations, recollections }),
  };
}

test('live rule editing copies an effective rule into the active set and makes it authoritative', async () => {
  const h = createHarness();
  const editor = await h.handlers.getRuleForEditing({ ruleId: 'demo' });
  assert.equal(editor.sourceRuleSetName, 'Remote');
  assert.equal(editor.editRuleSetName, 'Local');
  assert.equal(editor.copiesToEditSet, true);
  assert.deepEqual(JSON.parse(editor.yaml).matchers, [{ type: 'word', words: ['old'] }]);

  const draft = { id: 'demo', name: 'Edited', 'matchers-condition': 'or', matchers: [{ type: 'word', words: ['new'] }] };
  const saved = await h.handlers.saveRuleDraft({
    yaml: JSON.stringify(draft), tabId: 42, expectedId: 'demo', expectedRevision: 4,
  });
  assert.equal(saved.valid, true);
  assert.equal(saved.copied, true);
  assert.equal(saved.revision, 5);
  assert.deepEqual(h.storage.enabledRuleSetIds, ['remote', 'local']);
  assert.equal(h.storage.ruleSetOverrides.demo, 'local');
  assert.equal(h.storage.rules.find((rule) => rule.id === 'demo').name, 'Edited');
  assert.deepEqual(h.storage.rules.find((rule) => rule.id === 'demo').matchers, [{ type: 'word', words: ['new'] }]);
  assert.equal(h.effects().invalidations, 1);
  assert.equal(h.effects().recollections.length, 1);
  assert.equal(h.effects().recollections[0].tabId, 42);
  assert.equal(h.effects().recollections[0].message.type, 'gopainter:recollect');
});

test('live rule editing rejects a stale revision and a changed rule id', async () => {
  const h = createHarness();
  const changedId = await h.handlers.validateRuleDraft({
    yaml: JSON.stringify({ id: 'other', name: 'Other', 'matchers-condition': 'or', matchers: [{ type: 'word', words: ['x'] }] }),
    expectedId: 'demo',
  });
  assert.equal(changedId.valid, false);
  assert.equal(changedId.errors[0].code, 'id_changed');
  await assert.rejects(h.handlers.saveRuleDraft({
    yaml: JSON.stringify({ id: 'demo', name: 'Demo', 'matchers-condition': 'or', matchers: [{ type: 'word', words: ['x'] }] }),
    expectedId: 'demo', expectedRevision: 3,
  }), /规则状态已更新/);
});
