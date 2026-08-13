GoPainterAgentTools.register({
  name: 'search_page_js',
  description: '搜索当前页面已探测的 JavaScript 全局变量和值。用于核验运行时指纹证据。',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 30 } }, required: ['query'], additionalProperties: false },
  effect: 'read', permission: 'auto', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, skillIds: ['fingerprint-research'],
  validate(input) {
    const query = GoPainterAgentPage.string(input?.query).trim();
    if (!query) throw new Error('query 不能为空');
    return { query: query.toLowerCase(), limit: GoPainterAgentPage.limit(input?.limit, 10, 30) };
  },
  async execute({ query, limit }, context) {
    const js = (await GoPainterAgentPage.getFeatures({}, context)).js || {};
    const matches = Object.entries(js).filter(([path, value]) => `${path} ${GoPainterAgentPage.string(value)}`.toLowerCase().includes(query)).slice(0, limit)
      .map(([path, value]) => ({ path, value: GoPainterAgentPage.string(value).slice(0, 500) }));
    return { query, count: matches.length, matches };
  },
});
