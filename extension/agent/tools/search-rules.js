GoPainterAgentTools.register({
  name: 'search_rules',
  description: '搜索当前激活规则集或全部命名规则集中的规则 ID、名称和 matcher 内容，避免生成重复规则。',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, scope: { type: 'string', enum: ['active', 'all'] }, limit: { type: 'integer', minimum: 1, maximum: 30 } }, required: ['query'], additionalProperties: false },
  effect: 'read', permission: 'auto', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, skillIds: ['fingerprint-research'],
  validate(input) {
    const query = GoPainterAgentPage.string(input?.query).trim().toLowerCase();
    if (!query) throw new Error('query 不能为空');
    const scope = input?.scope || 'active';
    if (!['active', 'all'].includes(scope)) throw new Error('scope 只能是 active 或 all');
    return { query, scope, limit: GoPainterAgentPage.limit(input?.limit, 10, 30) };
  },
  async execute({ query, scope, limit }) {
    const stored = await chrome.storage.local.get(['rules', 'ruleSets', 'activeRuleSetId']);
    const state = GoPainterUtils.normalizeRuleSets(stored.ruleSets, stored.activeRuleSetId, stored.rules);
    const sets = scope === 'all' ? state.ruleSets : state.ruleSets.filter((set) => set.id === state.activeRuleSetId);
    const matches = [];
    for (const set of sets) for (const rule of set.rules) {
      if (!JSON.stringify(rule).toLowerCase().includes(query)) continue;
      matches.push({ ruleSetId: set.id, ruleSetName: set.name, id: rule.id, name: rule.name, matcherCount: (rule.matchers || []).length });
      if (matches.length >= limit) return { query, scope, matches };
    }
    return { query, scope, matches };
  },
});
