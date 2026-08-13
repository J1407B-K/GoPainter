// 无副作用的连通性工具；用来验证模型原生 function calling 与结果回填。
GoPainterAgentTools.register({
  name: 'ping',
  description: '验证 GoPainter 的本地工具调用链路。没有副作用，不读取页面或规则数据。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  effect: 'read',
  permission: 'auto',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  skillIds: ['agent-setup'],
  validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('ping 不接受参数');
    return {};
  },
  async execute() {
    return { ok: true, value: 'pong', at: new Date().toISOString() };
  },
});
