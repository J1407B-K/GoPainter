GoPainterAgentSkills.register({
  id: 'fingerprint-research',
  description: '为指纹规则收集当前页面、现有规则与获授权网络搜索的证据。',
  tools: ['inspect_page', 'search_rules', 'search_page_body', 'search_page_js', 'web_search'],
  maxSteps: 8,
});
