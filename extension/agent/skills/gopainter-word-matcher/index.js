GoPainterAgentSkills.register({
  id: 'gopainter-word-matcher',
  documentPath: 'agent/skills/gopainter-word-matcher/SKILL.md',
  description: '编写 GoPainter 原生 word、status 与 icon_hash matcher。',
  tools: ['inspect_page', 'search_rules', 'search_page_body', 'test_word_matcher', 'web_search'],
  maxTurns: 8,
});
