const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('legacy direct-AI module preserves bounded requests outside the Agent loop', async () => {
  let request = null;
  const context = {
    console, Object, JSON,
    chrome: { storage: { local: { get: async (keys) => {
      if (keys === 'aiPromptIdentify') return { aiPromptIdentify: 'custom identify' };
      return { aiBaseURL: 'https://model.test/v1', aiApiKey: 'key', aiModel: 'model' };
    } } } },
    matchedDomSelectors: async () => Array.from({ length: 45 }, (_, index) => `.item-${index}`),
    GoPainterUtils: { extractYaml: (value) => `yaml:${value}` },
    fetch: async (_url, init) => {
      request = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'answer' } }] }) };
    },
  };
  context.globalThis = context;
  const file = path.join(__dirname, '..', 'extension', 'background', 'legacy-ai.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: 'background/legacy-ai.js' });

  assert.deepEqual(Object.keys(context.GoPainterLegacyAI.DEFAULT_PROMPTS).sort(), ['bookmark', 'identify', 'optimize', 'rule']);
  assert.equal(await context.GoPainterLegacyAI.prompt('identify'), 'custom identify');
  const reply = await context.GoPainterLegacyAI.call('system', {
    url: 'https://example.test/', body: 'x'.repeat(9000),
    js: Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`path${index}`, 'value'])),
    scripts: Array.from({ length: 35 }, (_, index) => `/script-${index}.js`),
  });
  assert.equal(reply, 'answer');
  const user = JSON.parse(request.messages[1].content);
  assert.equal(user.body.length, 8000);
  assert.equal(Object.keys(user.js).length, 40);
  assert.equal(user.scripts.length, 30);
  assert.equal(user.dom.length, 40);
  assert.equal(context.GoPainterLegacyAI.extractYaml('rule'), 'yaml:rule');
});
