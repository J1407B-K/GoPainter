const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAgent(fetch) {
  const context = { console, Date, Error, Object, JSON, fetch, URLSearchParams };
  context.globalThis = context;
  for (const file of ['tools/registry.js', 'tools/ping.js', 'providers.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'agent', file), 'utf8'), context, { filename: file });
  }
  return context.GoPainterAgentProviders;
}

test('network tools stay blocked until the host grants the specific tool', async () => {
  const context = { console, Date, Error, Object, JSON, URLSearchParams, fetch: async () => { throw new Error('must not fetch'); } };
  context.globalThis = context;
  for (const file of ['tools/registry.js', 'tools/page-context.js', 'tools/web-search.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'agent', file), 'utf8'), context, { filename: file });
  }
  await assert.rejects(context.GoPainterAgentTools.executeTool('web_search', { query: 'nginx' }), /需要用户授权/);
});

test('OpenAI agent ping forces a native call and returns its local result', async () => {
  const requests = [];
  const providers = loadAgent(async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const data = requests.length === 1
      ? { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'call_ping', type: 'function', function: { name: 'ping', arguments: '{}' } }] } }] }
      : { choices: [{ message: { role: 'assistant', content: 'PONG' } }] };
    return { ok: true, json: async () => data };
  });
  const result = await providers.testToolCalling({ baseURL: 'https://example.test/v1/', apiKey: 'key', model: 'test', protocol: 'openai-chat' });
  assert.equal(result.result.value, 'pong');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools[0].function.name, 'ping');
  assert.equal(requests[1].messages.at(-1).role, 'tool');
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).value, 'pong');
});

test('agent loop continues after evidence and stops only after goal status reports completion', async () => {
  let requestCount = 0;
  const chrome = { storage: { local: { get: async (keys) => {
    if (keys.includes('aiBaseURL')) return { aiBaseURL: 'https://example.test/v1', aiApiKey: 'key', aiModel: 'test', agentProtocol: 'openai-chat' };
    return { rules: [{ id: 'wordpress', name: 'WordPress', matchers: [] }], ruleSets: [], activeRuleSetId: '' };
  } }, session: { get: async () => ({}) } } };
  const context = {
    console, Date, Error, Object, JSON, URLSearchParams, chrome,
    fetch: async (_url, init) => {
      requestCount++;
      const request = JSON.parse(init.body);
      if (requestCount === 1) {
        const call = { id: 'search', type: 'function', function: { name: 'search_rules', arguments: '{"query":"wordpress"}' } };
        return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [call] } }] }) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'WordPress evidence found in the existing rule set.' } }] }) };
    },
    GoPainterUtils: { normalizeRuleSets: (_sets, _active, rules) => ({ ruleSets: [{ id: 'default', name: '默认', rules }], activeRuleSetId: 'default', rules }) },
  };
  context.globalThis = context;
  for (const file of [
    'tools/registry.js', 'tools/page-context.js', 'tools/ping.js', 'tools/search-rules.js',
    'skills/registry.js', 'skills/agent-setup/index.js', 'skills/fingerprint-research/index.js',
    'goals.js', 'providers.js', 'loop.js',
  ]) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'agent', file), 'utf8'), context, { filename: file });
  const result = await context.GoPainterAgentLoop.run({ goalId: 'identify-site', tabId: 7 });
  assert.equal(result.status, 'complete');
  assert.equal(result.steps, 2);
  assert.equal(requestCount, 2);
});
