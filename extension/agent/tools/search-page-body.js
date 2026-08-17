GoPainterAgentTools.register({
  name: 'search_page_body',
  description: '在当前页面已采集的 HTML body 中查找文本，返回有限数量的上下文片段。用于核验候选指纹证据。',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'], additionalProperties: false },
  effect: 'read', permission: 'auto', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, skillIds: ['fingerprint-research', 'gopainter-word-matcher', 'gopainter-regex-matcher'],
  validate(input) {
    const query = GoPainterAgentPage.string(input?.query).trim();
    if (!query) throw new Error('query 不能为空');
    return { query, limit: GoPainterAgentPage.limit(input?.limit, 5, 10) };
  },
  async execute({ query, limit }, context) {
    const body = (await GoPainterAgentPage.getFeatures({}, context)).body || '';
    const needle = query.toLowerCase(), lower = body.toLowerCase(), matches = [];
    for (let at = lower.indexOf(needle); at !== -1 && matches.length < limit; at = lower.indexOf(needle, at + needle.length)) {
      matches.push(body.slice(Math.max(0, at - 120), Math.min(body.length, at + query.length + 120)));
    }
    return { query, count: matches.length, matches };
  },
});
