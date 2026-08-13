// 工具注册与宿主权限边界。每个工具各自一个文件，在启动时向这里注册。
(() => {
  const tools = new Map();

  function register(tool) {
    if (!tool?.name || typeof tool.execute !== 'function' || typeof tool.validate !== 'function' || !tool.inputSchema) throw new Error('无效 Agent 工具声明');
    if (tools.has(tool.name)) throw new Error(`重复注册 Agent 工具：${tool.name}`);
    tools.set(tool.name, Object.freeze(tool));
  }

  function getTool(name) { return tools.get(name) || null; }
  function list(names) { return names.map(getTool).filter(Boolean); }

  async function executeTool(name, input, context = {}) {
    const tool = getTool(name);
    if (!tool) throw new Error(`未知 Agent 工具：${name}`);
    if (tool.permission !== 'auto' && !context.grants?.includes(name)) throw new Error(`工具 ${name} 需要用户授权`);
    return tool.execute(tool.validate(input), context);
  }

  globalThis.GoPainterAgentTools = Object.freeze({ register, getTool, list, executeTool });
})();
