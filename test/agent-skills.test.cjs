const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const skillsRoot = path.join(root, 'extension', 'agent', 'skills');
const toolsRoot = path.join(root, 'extension', 'agent', 'tools');
const read = (file) => fs.readFileSync(file, 'utf8');
const skillIds = fs.readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function loadRegistries() {
  const context = {
    console, Object, Number, Set, Map,
    chrome: { storage: { onChanged: { addListener: () => {} } } },
  };
  context.globalThis = context;
  vm.runInNewContext(read(path.join(skillsRoot, 'registry.js')), context, { filename: 'skills/registry.js' });
  for (const id of skillIds) {
    vm.runInNewContext(read(path.join(skillsRoot, id, 'index.js')), context, { filename: `skills/${id}/index.js` });
  }
  vm.runInNewContext(read(path.join(toolsRoot, 'registry.js')), context, { filename: 'tools/registry.js' });
  for (const name of fs.readdirSync(toolsRoot).filter((name) => name.endsWith('.js') && name !== 'registry.js').sort()) {
    vm.runInNewContext(read(path.join(toolsRoot, name)), context, { filename: `tools/${name}` });
  }
  return context;
}

function metadataOf(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, 'SKILL.md must start with YAML frontmatter');
  return Object.fromEntries(match[1].split(/\r?\n/).map((line) => {
    const field = line.match(/^([a-z-]+):\s*(.+)$/);
    assert.ok(field, `invalid frontmatter line: ${line}`);
    return [field[1], field[2].trim()];
  }));
}

test('skill packages use one canonical format and matching registry metadata', () => {
  const context = loadRegistries();
  for (const id of skillIds) {
    const dir = path.join(skillsRoot, id);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['SKILL.md', 'index.js'], `${id} contains unexpected package files`);
    const markdown = read(path.join(dir, 'SKILL.md'));
    const metadata = metadataOf(markdown);
    assert.deepEqual(Object.keys(metadata).sort(), ['description', 'name']);
    assert.equal(metadata.name, id);
    assert.ok(metadata.description.length > 20, `${id} needs a useful trigger description`);
    for (const heading of ['## Workflow', '## Tools', '## Completion']) {
      assert.ok(markdown.includes(heading), `${id} is missing ${heading}`);
    }

    const skill = context.GoPainterAgentSkills.get(id);
    assert.ok(skill, `${id} is not registered`);
    assert.equal(skill.id, id);
    assert.equal(skill.documentPath, `agent/skills/${id}/SKILL.md`);
    assert.ok(Number.isInteger(skill.maxTurns) && skill.maxTurns > 0, `${id} needs maxTurns`);
    const documentedTools = [...markdown.matchAll(/^- `([^`]+)`:/gm)].map((match) => match[1]);
    assert.deepEqual(documentedTools, [...skill.tools], `${id} tool documentation differs from its allowlist`);
  }
});

test('skill includes and bidirectional tool permissions stay consistent', () => {
  const context = loadRegistries();
  for (const id of skillIds) {
    const skill = context.GoPainterAgentSkills.get(id);
    for (const includedId of skill.includes || []) {
      assert.ok(context.GoPainterAgentSkills.get(includedId), `${id} includes unknown skill ${includedId}`);
    }
    for (const name of skill.tools) {
      const tool = context.GoPainterAgentTools.getTool(name);
      assert.ok(tool, `${id} references unknown tool ${name}`);
      assert.ok(tool.skillIds.includes(id), `${name} does not authorize ${id}`);
    }
  }

  for (const file of fs.readdirSync(toolsRoot).filter((name) => name.endsWith('.js') && !['registry.js', 'page-context.js'].includes(name))) {
    const name = read(path.join(toolsRoot, file)).match(/\bname:\s*'([^']+)'/)?.[1];
    assert.ok(name, `${file} does not register a named tool`);
    const tool = context.GoPainterAgentTools.getTool(name);
    assert.ok(tool, `${file} failed to register ${name}`);
    for (const id of tool.skillIds) {
      const skill = context.GoPainterAgentSkills.get(id);
      assert.ok(skill, `${name} authorizes unknown skill ${id}`);
      assert.ok(skill.tools.includes(name), `${name} authorizes ${id}, but its allowlist omits the tool`);
    }
  }
});

test('background loads every skill and tool package file', () => {
  const background = read(path.join(root, 'extension', 'background.js'));
  const imports = new Set([...background.matchAll(/'([^']+\.js)'/g)].map((match) => match[1]));
  assert.ok(imports.has('agent/skills/registry.js'));
  for (const id of skillIds) assert.ok(imports.has(`agent/skills/${id}/index.js`), `background omits ${id}`);
  for (const file of fs.readdirSync(toolsRoot).filter((name) => name.endsWith('.js'))) {
    assert.ok(imports.has(`agent/tools/${file}`), `background omits tool module ${file}`);
  }
});

test('Go-backed skill tools reference exports registered by the WASM bridge', () => {
  const bridge = read(path.join(root, 'wasm', 'bridge.go'));
  for (const file of fs.readdirSync(toolsRoot).filter((name) => name.endsWith('.js'))) {
    const source = read(path.join(toolsRoot, file));
    for (const match of source.matchAll(/globalThis\.(go[A-Z][A-Za-z0-9]*)/g)) {
      assert.ok(bridge.includes(`g.Set("${match[1]}"`), `${file} references missing WASM export ${match[1]}`);
    }
  }
});

test('skill registry rejects drift-prone declarations and frontmatter', () => {
  const context = { console, Object, Number, Set, Map };
  context.globalThis = context;
  vm.runInNewContext(read(path.join(skillsRoot, 'registry.js')), context, { filename: 'skills/registry.js' });
  assert.throws(() => context.GoPainterAgentSkills.register({
    id: 'bad-skill', documentPath: 'wrong/SKILL.md', tools: [], maxTurns: 1,
  }), /documentPath/);
  assert.throws(() => context.GoPainterAgentSkills.register({
    id: 'bad-skill', documentPath: 'agent/skills/bad-skill/SKILL.md', tools: [], maxTurns: 0,
  }), /maxTurns/);
  assert.throws(() => context.GoPainterAgentSkills.register({
    id: 'bad-skill', documentPath: 'agent/skills/bad-skill/SKILL.md', tools: [], includes: ['bad-skill'], maxTurns: 1,
  }), /包含自身/);
  assert.throws(() => context.GoPainterAgentSkills.parseDocument(
    '---\nname: bad-skill\ndescription: useful description\nlicense: MIT\n---\n\n# Instructions', 'bad-skill',
  ), /frontmatter/);
});

test('registered tool permissions cannot be mutated after startup', () => {
  const context = loadRegistries();
  const tool = context.GoPainterAgentTools.getTool('web_search');
  assert.equal(Object.isFrozen(tool), true);
  assert.equal(Object.isFrozen(tool.skillIds), true);
  assert.equal(Object.isFrozen(tool.inputSchema), true);
  assert.throws(() => vm.runInNewContext("GoPainterAgentTools.getTool('web_search').skillIds.push('agent-setup')", context), /extensible|frozen|read only/i);
  assert.equal(tool.skillIds.includes('agent-setup'), false);
  assert.throws(() => context.GoPainterAgentTools.register({
    name: 'unsafe-network', inputSchema: {}, skillIds: ['agent-setup'], effect: 'network', permission: 'auto',
    validate: (input) => input, execute: async () => ({}),
  }), /必须经过用户确认/);
});

test('validate_rule rejects silently normalized or unsupported candidates', async () => {
  const features = { url: 'https://example.test/', body: '<div data-reactroot></div>' };
  const context = {
    console, Object, Number, Set, Map, JSON,
    chrome: { storage: { session: { get: async () => ({ 'result:7': { features } }) } } },
    ensureWasm: async () => {},
    goAgentRegexTest: (patternsJSON) => JSON.stringify({
      backend: 'go-re2',
      results: JSON.parse(patternsJSON).map((pattern) => ({ pattern, valid: pattern !== '([broken', ...(pattern === '([broken' ? { error: 'missing ]' } : {}) })),
    }),
    goDslEval: (expressionsJSON) => JSON.stringify({ results: JSON.parse(expressionsJSON).map(() => true), errors: JSON.parse(expressionsJSON).map(() => '') }),
    goNormalizeRules: (docsJSON) => JSON.stringify({ rules: JSON.parse(docsJSON) }),
    goMatch: () => JSON.stringify({ hits: [] }),
  };
  context.globalThis = context;
  for (const file of ['registry.js', 'page-context.js', 'validate-rule.js']) {
    vm.runInNewContext(read(path.join(toolsRoot, file)), context, { filename: `tools/${file}` });
  }
  const tool = context.GoPainterAgentTools.getTool('validate_rule');
  const base = {
    id: 'react', name: 'React', 'matchers-condition': 'or',
    matchers: [{ type: 'regex', regex: ['data-reactroot'] }],
  };
  assert.throws(() => tool.validate({ rule: { ...base, matchers: [...base.matchers, { type: 'javascript', code: 'return true' }] } }), /matcher 类型无效/);
  assert.throws(() => tool.validate({ rule: { ...base, 'matchers-condition': 'maybe' } }), /matchers-condition/);
  assert.throws(() => tool.validate({ rule: { ...base, matchers: [{ type: 'js', condition: 'Object.keys(window)', js: [{ path: 'React' }] }] } }), /condition 无效/);
  await assert.rejects(context.GoPainterAgentTools.executeTool('validate_rule', {
    rule: { ...base, matchers: [{ type: 'regex', regex: ['([broken'] }] },
  }, { tabId: 7, skillId: 'fingerprint-research', allowedTools: ['validate_rule'] }), /Go RE2/);
  const result = await context.GoPainterAgentTools.executeTool('validate_rule', { rule: base }, {
    tabId: 7, skillId: 'fingerprint-research', allowedTools: ['validate_rule'],
  });
  assert.equal(result.valid, true);
  assert.equal(result.rule.id, 'react');
  assert.equal(result.runtimeCoverage.complete, true);
});
