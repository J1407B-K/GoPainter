GoPainterAgentSkills.register({
  id: 'fingerprint-research',
  documentPath: 'agent/skills/fingerprint-research/SKILL.md',
  description: '为指纹规则收集当前页面、现有规则与获授权网络搜索的证据。',
  includes: ['gopainter-word-matcher', 'gopainter-regex-matcher', 'gopainter-runtime-matcher'],
  tools: ['inspect_page', 'search_rules', 'search_page_body', 'search_page_js', 'test_word_matcher', 'test_regex', 'evaluate_dsl', 'validate_rule', 'web_search', 'fetch_url'],
  maxTurns: 8,
});
