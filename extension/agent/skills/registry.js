// Skill 是指令、工具白名单与轮数预算组成的可执行能力包；工具端仍独立校验 skillIds。
(() => {
  const skills = new Map();
  const loaded = new Map();
  function register(skill) {
    if (!skill?.id || !Array.isArray(skill.tools) || !skill.documentPath) throw new Error('无效 Agent skill 声明');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.id)) throw new Error(`无效 Agent skill ID：${skill.id}`);
    if (skill.documentPath !== `agent/skills/${skill.id}/SKILL.md`) throw new Error(`skill ${skill.id} 的 documentPath 与 ID 不一致`);
    if (skill.tools.some((name) => typeof name !== 'string' || !name) || new Set(skill.tools).size !== skill.tools.length) {
      throw new Error(`skill ${skill.id} 的工具列表无效`);
    }
    if (skill.includes !== undefined && (!Array.isArray(skill.includes)
      || skill.includes.some((id) => typeof id !== 'string' || !id) || new Set(skill.includes).size !== skill.includes.length)) {
      throw new Error(`skill ${skill.id} 的 includes 无效`);
    }
    if (skill.includes?.includes(skill.id)) throw new Error(`skill ${skill.id} 不能包含自身`);
    if (!Number.isInteger(skill.maxTurns) || skill.maxTurns < 1) {
      throw new Error(`skill ${skill.id} 的 maxTurns 无效`);
    }
    if (skills.has(skill.id)) throw new Error(`重复注册 Agent skill：${skill.id}`);
    skills.set(skill.id, Object.freeze({
      ...skill,
      tools: Object.freeze([...skill.tools]),
      ...(skill.includes ? { includes: Object.freeze([...skill.includes]) } : {}),
    }));
  }

  function parseDocument(text, expectedName) {
    const match = String(text || '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]+)$/);
    if (!match) throw new Error(`skill ${expectedName} 的 SKILL.md 缺少有效 frontmatter`);
    const metadata = {};
    for (const line of match[1].split(/\r?\n/)) {
      const field = line.match(/^([a-z-]+):\s*(.+)$/);
      if (!field) throw new Error(`skill ${expectedName} 的 frontmatter 字段无效：${line}`);
      if (!['name', 'description'].includes(field[1])) throw new Error(`skill ${expectedName} 包含未支持的 frontmatter 字段：${field[1]}`);
      if (metadata[field[1]]) throw new Error(`skill ${expectedName} 重复声明 ${field[1]}`);
      metadata[field[1]] = field[2].trim().replace(/^['"]|['"]$/g, '');
    }
    if (metadata.name !== expectedName) throw new Error(`skill 目录/注册 ID 与 name 不一致：${expectedName} != ${metadata.name || '(empty)'}`);
    if (!metadata.description) throw new Error(`skill ${expectedName} 缺少 description`);
    const instructions = match[2].trim();
    if (!instructions) throw new Error(`skill ${expectedName} 没有正文指令`);
    return { description: metadata.description, instructions };
  }

  async function loadOne(skill) {
    if (loaded.has(skill.id)) return loaded.get(skill.id);
    const promise = (async () => {
      if (!globalThis.chrome?.runtime?.getURL) return { ...skill, instructions: '' }; // Node 单测可只验证 registry 元数据。
      const response = await fetch(chrome.runtime.getURL(skill.documentPath), { cache: 'no-cache' });
      if (!response.ok) throw new Error(`读取 skill ${skill.id} 失败（HTTP ${response.status}）`);
      return Object.freeze({ ...skill, ...parseDocument(await response.text(), skill.id) });
    })();
    loaded.set(skill.id, promise);
    try { return await promise; } catch (error) { loaded.delete(skill.id); throw error; }
  }

  async function load(id) {
    const skill = skills.get(id);
    if (!skill) return null;
    const base = await loadOne(skill);
    const included = [];
    for (const includedId of skill.includes || []) {
      const includedSkill = skills.get(includedId);
      if (!includedSkill) throw new Error(`skill ${id} 引用了未知 skill：${includedId}`);
      included.push(await loadOne(includedSkill));
    }
    return Object.freeze({
      ...base,
      // 被包含的 skill 只提供领域约束，不能扩大主 skill 的工具白名单。
      instructions: [...included, base].map((item) => item.instructions).filter(Boolean).join('\n\n'),
    });
  }
  globalThis.GoPainterAgentSkills = Object.freeze({ register, get: (id) => skills.get(id) || null, load, parseDocument });
})();
