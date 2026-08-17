GoPainterAgentSkills.register({
  id: 'gopainter-runtime-matcher',
  documentPath: 'agent/skills/gopainter-runtime-matcher/SKILL.md',
  description: '编写 GoPainter 原生 js、dom 与 dsl matcher。',
  tools: ['inspect_page', 'search_rules', 'search_page_js', 'evaluate_dsl', 'web_search', 'fetch_url'],
  maxTurns: 8,
});
