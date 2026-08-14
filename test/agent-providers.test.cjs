const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAgent(fetch) {
  const context = { console, Date, Error, Object, JSON, fetch, URLSearchParams, AbortController, setTimeout, clearTimeout };
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
  await assert.rejects(context.GoPainterAgentTools.executeTool('web_search', { query: 'nginx' }, {
    skillId: 'fingerprint-research', allowedTools: ['web_search'],
  }), /需要用户授权/);
});

test('tool execution enforces skillIds and the active tool allowlist', async () => {
  const context = { console, Date, Error, Object, JSON };
  context.globalThis = context;
  for (const file of ['tools/registry.js', 'tools/ping.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'agent', file), 'utf8'), context, { filename: file });
  }
  await assert.rejects(context.GoPainterAgentTools.executeTool('ping', {}), /缺少 skill 上下文/);
  await assert.rejects(context.GoPainterAgentTools.executeTool('ping', {}, {
    skillId: 'fingerprint-research', allowedTools: ['ping'],
  }), /不允许执行工具 ping/);
  await assert.rejects(context.GoPainterAgentTools.executeTool('ping', {}, {
    skillId: 'agent-setup', allowedTools: [],
  }), /未在本次会话中启用/);
  const result = await context.GoPainterAgentTools.executeTool('ping', {}, {
    skillId: 'agent-setup', allowedTools: ['ping'],
  });
  assert.equal(result.value, 'pong');
});

test('goal completion requires the evidence tools relevant to each workflow', () => {
  const context = { console };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'lib', 'js-yaml.min.js'), 'utf8'), context, { filename: 'js-yaml.min.js' });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'shared-utils.js'), 'utf8'), context, { filename: 'shared-utils.js' });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'agent', 'goals.js'), 'utf8'), context, { filename: 'goals.js' });
  const state = (...tools) => ({
    evidenceCalls: tools.length,
    successfulTools: new Set(tools),
    successfulCalls: tools.map((name) => ({
      name,
      input: name === 'search_rules' ? { query: 'react' } : {},
      output: name === 'web_search'
        ? { results: [{ url: 'https://react.dev/' }] }
        : name === 'search_rules' ? { matches: [{ rule: { id: 'react' } }] } : {},
    })),
  });
  assert.equal(context.GoPainterAgentGoals.get('identify-site').isComplete(state('search_rules')), false);
  assert.equal(context.GoPainterAgentGoals.get('identify-site').isComplete(state('inspect_page')), false);
  assert.equal(context.GoPainterAgentGoals.get('identify-site').isComplete(state('inspect_page', 'search_rules')), true);
  assert.equal(context.GoPainterAgentGoals.get('research-rule').isComplete(state('search_rules')), false);
  assert.equal(context.GoPainterAgentGoals.get('research-rule').isComplete(state('search_rules', 'web_search')), true);
  assert.equal(context.GoPainterAgentGoals.get('optimize-rule').isComplete(state('inspect_page')), false);
  assert.equal(context.GoPainterAgentGoals.get('optimize-rule').isComplete(state('search_rules')), false);
  assert.equal(context.GoPainterAgentGoals.get('optimize-rule').isComplete(state('search_rules', 'web_search'), 'react'), true);
  assert.equal(context.GoPainterAgentGoals.get('optimize-rule').isComplete(state('search_rules', 'web_search'), 'react-router'), false);
  const valid = '## 可导入规则\n```yaml\nid: react\nname: React\nmatchers-condition: or\nmatchers:\n  - type: word\n    words: [react]\n```';
  assert.equal(context.GoPainterAgentGoals.get('research-rule').isOutputComplete(valid), true);
  assert.equal(context.GoPainterAgentGoals.get('research-rule').isOutputComplete('只有研究结论'), false);
  assert.equal(context.GoPainterAgentGoals.get('optimize-rule').isOutputComplete(valid, 'react'), true);
  assert.equal(context.GoPainterAgentGoals.get('optimize-rule').isOutputComplete(valid, 'react-router'), false);
  const partlyInvalid = '```yaml\nid: react\nname: React\nmatchers-condition: or\nmatchers:\n  - type: js\n    condition: "Object.keys(window)"\n  - type: regex\n    regex: [data-reactroot]\n```';
  assert.equal(context.GoPainterAgentGoals.get('research-rule').isOutputComplete(partlyInvalid), false);
});

test('exact rule search returns the complete selected rule while fuzzy search stays compact', async () => {
  const rules = [
    { id: 'react', name: 'React', 'matchers-condition': 'or', matchers: [{ type: 'word', words: ['react'] }] },
    { id: 'react-router', name: 'React Router', 'matchers-condition': 'or', matchers: [{ type: 'word', words: ['router'] }] },
  ];
  const context = {
    console, Date, Error, Object, JSON,
    chrome: { storage: { local: { get: async () => ({ rules, ruleSets: [], activeRuleSetId: '' }) } } },
    GoPainterUtils: {
      normalizeRuleSets: (_sets, _active, legacy) => ({
        ruleSets: [{ id: 'default', name: '默认', rules: legacy }], activeRuleSetId: 'default', rules: legacy,
      }),
    },
  };
  context.globalThis = context;
  for (const file of ['tools/registry.js', 'tools/page-context.js', 'tools/search-rules.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'agent', file), 'utf8'), context, { filename: file });
  }
  const execution = { skillId: 'fingerprint-research', allowedTools: ['search_rules'], cache: {} };
  const exact = await context.GoPainterAgentTools.executeTool('search_rules', { query: 'react' }, execution);
  assert.equal(exact.matches[0].rule.id, 'react');
  assert.equal(exact.matches[0].rule.matchers.length, 1);
  assert.equal(exact.matches[1].rule, undefined);
  const fuzzy = await context.GoPainterAgentTools.executeTool('search_rules', { query: 'router' }, execution);
  assert.equal(fuzzy.matches[0].id, 'react-router');
  assert.equal(fuzzy.matches[0].rule, undefined);
});

test('rule workflow retries synthesis once when the first report has no importable YAML', async () => {
  let aiRequests = 0;
  const chrome = { storage: { local: { get: async (keys) => {
    if (keys.includes('aiBaseURL')) return { aiBaseURL: 'https://model.test/v1', aiApiKey: 'key', aiModel: 'test', agentProtocol: 'openai-chat' };
    return { rules: [], ruleSets: [], activeRuleSetId: '' };
  } }, session: { get: async (key) => ({ [key]: { features: { url: 'https://example.test/', title: 'Example' } } }) } } };
  const context = {
    console, Date, Error, Object, JSON, URLSearchParams, AbortController, setTimeout, clearTimeout, chrome,
    fetch: async (url, init) => {
      if (String(url).includes('duckduckgo.com')) return {
        ok: true,
        text: async () => '<a class="result__a" href="https://react.dev/">React</a><a class="result__snippet">React documentation</a>',
      };
      aiRequests++;
      if (aiRequests === 1) {
        const calls = [
          { id: 'rules', type: 'function', function: { name: 'search_rules', arguments: '{"query":"React"}' } },
          { id: 'web', type: 'function', function: { name: 'web_search', arguments: '{"query":"React stable fingerprint"}' } },
        ];
        return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: calls } }] }) };
      }
      const content = aiRequests === 2
        ? '## 结论\n可以编写 React 规则。'
        : '## 结论\n完成\n## 证据依据\n公开资料\n## 可导入规则\n```yaml\nid: react\nname: React\nmatchers-condition: or\nmatchers:\n  - type: word\n    words: [react]\n```\n## 风险与限制\n需复核';
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
    },
    GoPainterUtils: { normalizeRuleSets: (_sets, _active, rules) => ({ ruleSets: [{ id: 'default', name: '默认', rules }], activeRuleSetId: 'default', rules }) },
  };
  context.globalThis = context;
  for (const file of [
    'tools/registry.js', 'tools/page-context.js', 'tools/inspect-page.js', 'tools/ping.js',
    'tools/search-page-body.js', 'tools/search-page-js.js', 'tools/search-rules.js', 'tools/web-search.js',
    'skills/registry.js', 'skills/agent-setup/index.js', 'skills/fingerprint-research/index.js',
    'goals.js', 'providers.js', 'loop.js',
  ]) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'agent', file), 'utf8'), context, { filename: file });
  const result = await context.GoPainterAgentLoop.run({ goalId: 'research-rule', tabId: 7, input: 'React', grants: ['web_search'] });
  assert.equal(result.status, 'complete');
  assert.equal(aiRequests, 3);
  assert.match(result.summary, /```yaml/);
  assert.ok(result.trace.some((item) => item.message.includes('正在自动修正')));
});

test('session permission remembers a confirmed network tool for later rounds', async () => {
  let aiRequests = 0;
  let permissionRequests = 0;
  const chrome = { storage: { local: { get: async (keys) => {
    if (keys.includes('aiBaseURL')) return { aiBaseURL: 'https://model.test/v1', aiApiKey: 'key', aiModel: 'test', agentProtocol: 'openai-chat' };
    return { rules: [], ruleSets: [], activeRuleSetId: '' };
  } }, session: { get: async (key) => ({ [key]: { features: { url: 'https://example.test/', title: 'Example' } } }) } } };
  const context = {
    console, Date, Error, Object, JSON, URLSearchParams, AbortController, setTimeout, clearTimeout, chrome,
    fetch: async (url, init) => {
      if (String(url).includes('duckduckgo.com')) return {
        ok: true,
        text: async () => '<a class="result__a" href="https://react.dev/">React</a><a class="result__snippet">React docs</a>',
      };
      aiRequests++;
      if (aiRequests === 1) {
        const call = { id: 'web1', type: 'function', function: { name: 'web_search', arguments: '{"query":"React fingerprint"}' } };
        return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [call] } }] }) };
      }
      if (aiRequests === 2) {
        const calls = [
          { id: 'rules', type: 'function', function: { name: 'search_rules', arguments: '{"query":"React"}' } },
          { id: 'web2', type: 'function', function: { name: 'web_search', arguments: '{"query":"React data-reactroot"}' } },
        ];
        return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: calls } }] }) };
      }
      const content = '## 结论\n完成\n## 证据依据\n公开资料\n## 可导入规则\n```yaml\nid: react\nname: React\nmatchers-condition: or\nmatchers:\n  - type: regex\n    regex: [data-reactroot]\n```\n## 风险与限制\n旧版本特征';
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
    },
    GoPainterUtils: { normalizeRuleSets: (_sets, _active, rules) => ({ ruleSets: [{ id: 'default', name: '默认', rules }], activeRuleSetId: 'default', rules }) },
  };
  context.globalThis = context;
  for (const file of [
    'tools/registry.js', 'tools/page-context.js', 'tools/inspect-page.js', 'tools/ping.js',
    'tools/search-page-body.js', 'tools/search-page-js.js', 'tools/search-rules.js', 'tools/web-search.js',
    'skills/registry.js', 'skills/agent-setup/index.js', 'skills/fingerprint-research/index.js',
    'goals.js', 'providers.js', 'loop.js',
  ]) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'agent', file), 'utf8'), context, { filename: file });
  const result = await context.GoPainterAgentLoop.run({
    goalId: 'research-rule', tabId: 7, input: 'React',
    onPermissionRequest: async () => {
      permissionRequests++;
      return { granted: true, remember: true };
    },
  });
  assert.equal(result.status, 'complete');
  assert.equal(permissionRequests, 1);
  assert.ok(result.trace.some((item) => item.message.includes('本次会话已始终允许：web_search')));
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

test('agent model requests fail instead of hanging after the configured timeout', async () => {
  const providers = loadAgent(async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const session = providers.createSession({
    baseURL: 'https://example.test/v1', apiKey: 'key', model: 'test', protocol: 'openai-chat',
    system: 'test', user: 'test', tools: [], requestTimeoutMs: 5,
  });
  await assert.rejects(session.next({ noTools: true }), /AI 请求超时/);
});

test('agent loop stops tool calls and synthesizes as soon as goal evidence is complete', async () => {
  let requestCount = 0;
  let synthesisHadTools = null;
  let synthesisEvidence = '';
  const chrome = { storage: { local: { get: async (keys) => {
    if (keys.includes('aiBaseURL')) return { aiBaseURL: 'https://example.test/v1', aiApiKey: 'key', aiModel: 'test', agentProtocol: 'openai-chat' };
    return { rules: [{ id: 'wordpress', name: 'WordPress', matchers: [] }], ruleSets: [], activeRuleSetId: '' };
  } }, session: { get: async (key) => ({ [key]: { features: { url: 'https://example.test/', title: 'Example', headers: { server: 'nginx' } } } }) } } };
  const context = {
    console, Date, Error, Object, JSON, URLSearchParams, AbortController, setTimeout, clearTimeout, chrome,
    fetch: async (_url, init) => {
      requestCount++;
      const request = JSON.parse(init.body);
      if (requestCount === 1) {
        const call = { id: 'inspect', type: 'function', function: { name: 'inspect_page', arguments: '{}' } };
        return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [call] } }] }) };
      }
      if (requestCount === 2) {
        const calls = [
          { id: 'rules', type: 'function', function: { name: 'search_rules', arguments: '{"query":"nginx"}' } },
          { id: 'js', type: 'function', function: { name: 'search_page_js', arguments: '{"query":"nginx"}' } },
        ];
        return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: calls } }] }) };
      }
      synthesisHadTools = Object.hasOwn(request, 'tools');
      synthesisEvidence = request.messages.map((message) => message.content || '').join('\n');
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'WordPress evidence found in the existing rule set.' } }] }) };
    },
    GoPainterUtils: { normalizeRuleSets: (_sets, _active, rules) => ({ ruleSets: [{ id: 'default', name: '默认', rules }], activeRuleSetId: 'default', rules }) },
  };
  context.globalThis = context;
  for (const file of [
    'tools/registry.js', 'tools/page-context.js', 'tools/inspect-page.js', 'tools/ping.js',
    'tools/search-page-body.js', 'tools/search-page-js.js', 'tools/search-rules.js', 'tools/web-search.js',
    'skills/registry.js', 'skills/agent-setup/index.js', 'skills/fingerprint-research/index.js',
    'goals.js', 'providers.js', 'loop.js',
  ]) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'agent', file), 'utf8'), context, { filename: file });
  const result = await context.GoPainterAgentLoop.run({ goalId: 'identify-site', tabId: 7 });
  assert.equal(result.status, 'complete');
  assert.equal(result.steps, 2);
  assert.equal(requestCount, 3);
  assert.equal(synthesisHadTools, false);
  assert.match(synthesisEvidence, /successful_tool_evidence/);
  assert.match(synthesisEvidence, /search_rules/);
  assert.ok(result.trace.some((item) => item.message.includes('并发执行 2 个自动只读工具（并发上限 5）')));
});
