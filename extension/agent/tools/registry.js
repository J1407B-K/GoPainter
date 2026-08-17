// 工具注册与宿主权限边界。每个工具各自一个文件，在启动时向这里注册。
(() => {
  const tools = new Map();

  function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
  }

  function register(tool) {
    if (!tool?.name || typeof tool.execute !== 'function' || typeof tool.validate !== 'function' || !tool.inputSchema
      || !Array.isArray(tool.skillIds) || !tool.skillIds.length) throw new Error('无效 Agent 工具声明');
    if (tool.skillIds.some((id) => typeof id !== 'string' || !id) || new Set(tool.skillIds).size !== tool.skillIds.length) {
      throw new Error(`Agent 工具 ${tool.name} 的 skillIds 无效`);
    }
    if (!['auto', 'confirm'].includes(tool.permission) || !['read', 'network', 'write'].includes(tool.effect)) {
      throw new Error(`Agent 工具 ${tool.name} 的权限分级无效`);
    }
    if (tool.effect !== 'read' && tool.permission !== 'confirm') {
      throw new Error(`Agent 工具 ${tool.name} 的 ${tool.effect} 操作必须经过用户确认`);
    }
    if (tool.grantScope != null && typeof tool.grantScope !== 'function') {
      throw new Error(`Agent 工具 ${tool.name} 的授权作用域无效`);
    }
    if (tools.has(tool.name)) throw new Error(`重复注册 Agent 工具：${tool.name}`);
    tools.set(tool.name, Object.freeze({
      ...tool,
      skillIds: Object.freeze([...tool.skillIds]),
      inputSchema: deepFreeze(tool.inputSchema),
      annotations: deepFreeze({ ...tool.annotations }),
    }));
  }

  function grantKeyFor(tool, validatedInput) {
    const scope = String(tool.grantScope?.(validatedInput) || '').trim();
    return scope ? `${tool.name}:${scope}` : tool.name;
  }

  function grantKey(name, input) {
    const tool = getTool(name);
    if (!tool) throw new Error(`未知 Agent 工具：${name}`);
    return grantKeyFor(tool, tool.validate(input));
  }

  function getTool(name) { return tools.get(name) || null; }
  function list(names, skillId) {
    return names.map((name) => {
      const tool = getTool(name);
      if (!tool) throw new Error(`skill ${skillId} 引用了未知工具：${name}`);
      if (!tool.skillIds.includes(skillId)) throw new Error(`工具 ${name} 未授权给 skill ${skillId}`);
      return tool;
    });
  }

  async function executeTool(name, input, context = {}) {
    const tool = getTool(name);
    if (!tool) throw new Error(`未知 Agent 工具：${name}`);
    if (!context.skillId) throw new Error(`执行工具 ${name} 缺少 skill 上下文`);
    if (!tool.skillIds.includes(context.skillId)) throw new Error(`skill ${context.skillId} 不允许执行工具 ${name}`);
    if (context.allowedTools && !context.allowedTools.includes(name)) throw new Error(`工具 ${name} 未在本次会话中启用`);
    const validatedInput = tool.validate(input);
    const requiredGrant = grantKeyFor(tool, validatedInput);
    if (tool.permission !== 'auto' && !context.grants?.includes(requiredGrant)) {
      throw new Error(`工具 ${name} 需要用户授权`);
    }
    return tool.execute(validatedInput, context);
  }

  globalThis.GoPainterAgentTools = Object.freeze({ register, getTool, list, grantKey, executeTool });
})();
