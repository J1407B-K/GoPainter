const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const loopSource = fs.readFileSync(path.join(__dirname, '..', 'extension', 'agent', 'loop.js'), 'utf8');

test('Agent session remembers scoped grants only for the same origin', async () => {
  const calls = [
    { id: 'a1', name: 'scoped_fetch', input: { url: 'https://docs.example/a' } },
    { id: 'a2', name: 'scoped_fetch', input: { url: 'https://docs.example/b' } },
    { id: 'b1', name: 'scoped_fetch', input: { url: 'https://cdn.example/c' } },
  ];
  let round = 0;
  const permissionRequests = [];
  const executionGrants = [];
  const tool = { name: 'scoped_fetch', permission: 'confirm', effect: 'network' };
  const session = {
    next: async () => (round < calls.length
      ? { text: '', calls: [calls[round++]] }
      : { text: 'complete', calls: [] }),
    addToolResults: () => {},
    addAssistantReply: () => {},
    addUserText: () => {},
  };
  const context = {
    console, Object, JSON, Set, Map, Promise,
    chrome: { storage: { local: { get: async () => ({}) } } },
    GoPainterAgentGoals: { get: () => ({
      skillId: 'test-skill', maxTurns: 4, prompt: 'test', isOutputComplete: () => true,
    }) },
    GoPainterAgentSkills: { load: async () => ({ id: 'test-skill', maxTurns: 4, tools: ['scoped_fetch'], instructions: '' }) },
    GoPainterAgentProviders: { createSession: () => session },
    GoPainterAgentPage: { getOverview: async () => ({ url: 'https://page.example', title: 'Page' }) },
    GoPainterAgentTools: {
      list: () => [tool],
      getTool: () => tool,
      grantKey: (_name, input) => `scoped_fetch:${new URL(input.url).origin}`,
      executeTool: async (_name, _input, executionContext) => {
        executionGrants.push([...executionContext.grants]);
        return { ok: true };
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(loopSource, context, { filename: 'agent/loop.js' });

  const result = await context.GoPainterAgentLoop.run({
    goalId: 'test', tabId: 1,
    onPermissionRequest: async (request) => {
      permissionRequests.push(request);
      return { granted: true, remember: true };
    },
  });

  assert.equal(result.status, 'complete');
  assert.deepEqual(permissionRequests.map((request) => request.scope), [
    'https://docs.example',
    'https://cdn.example',
  ]);
  assert.deepEqual(executionGrants, [
    ['scoped_fetch:https://docs.example'],
    ['scoped_fetch:https://docs.example'],
    ['scoped_fetch:https://docs.example', 'scoped_fetch:https://cdn.example'],
  ]);
});
