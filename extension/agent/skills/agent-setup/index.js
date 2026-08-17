GoPainterAgentSkills.register({
  id: 'agent-setup',
  documentPath: 'agent/skills/agent-setup/SKILL.md',
  description: '验证模型与 GoPainter 本地工具的调用、执行和结果回填链路。',
  tools: ['ping'],
  maxTurns: 2,
});
