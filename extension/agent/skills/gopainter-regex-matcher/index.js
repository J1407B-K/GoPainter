GoPainterAgentSkills.register({
  id: 'gopainter-regex-matcher',
  documentPath: 'agent/skills/gopainter-regex-matcher/SKILL.md',
  description: '编写可由 GoPainter Go RE2 后端执行的原生 regex matcher。',
  tools: ['inspect_page', 'search_rules', 'search_page_body', 'test_regex', 'web_search'],
  maxTurns: 8,
});
