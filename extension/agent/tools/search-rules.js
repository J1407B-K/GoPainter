(() => {
let activeCache = null;
let activeLoadPromise = null;
let allCache = null;
let allLoadPromise = null;
let cacheVersion = 0;

const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

async function buildEntries(sets) {
  const entries = [];
  const byKey = new Map();
  let processed = 0;
  for (const set of sets) {
    for (const rule of set.rules || []) {
      const entry = {
        ruleSetId: set.id, ruleSetName: set.name, rule,
        searchText: `${rule.id || ''}\n${rule.name || ''}\n${JSON.stringify(rule.matchers || [])}`.toLowerCase(),
      };
      entries.push(entry);
      for (const key of [rule.id, rule.name]) {
        const normalized = String(key || '').toLowerCase();
        if (normalized && !byKey.has(normalized)) byKey.set(normalized, entry);
      }
      if (++processed % 250 === 0) await yieldToEventLoop();
    }
  }
  return { entries, byKey };
}

async function loadActiveIndex() {
  if (activeCache) return activeCache;
  if (activeLoadPromise) return activeLoadPromise;
  const version = cacheVersion;
  activeLoadPromise = (async () => {
    const stored = await chrome.storage.local.get(['rules', 'ruleSets', 'activeRuleSetId', 'enabledRuleSetIds', 'ruleSetOverrides']);
    const state = GoPainterUtils.normalizeRuleSets(stored.ruleSets, stored.activeRuleSetId, stored.rules, stored.enabledRuleSetIds, stored.ruleSetOverrides);
    const set = state.ruleSets.find((item) => item.id === state.activeRuleSetId) || state.ruleSets[0];
    const built = await buildEntries([set]);
    if (version === cacheVersion) activeCache = built;
    return version === cacheVersion ? built : loadActiveIndex();
  })().finally(() => { activeLoadPromise = null; });
  return activeLoadPromise;
}

async function loadAllIndex() {
  if (allCache) return allCache;
  if (allLoadPromise) return allLoadPromise;
  const version = cacheVersion;
  allLoadPromise = (async () => {
    const stored = await chrome.storage.local.get(['rules', 'ruleSets', 'activeRuleSetId', 'enabledRuleSetIds', 'ruleSetOverrides']);
    const state = GoPainterUtils.normalizeRuleSets(stored.ruleSets, stored.activeRuleSetId, stored.rules, stored.enabledRuleSetIds, stored.ruleSetOverrides);
    const built = await buildEntries(state.ruleSets);
    if (version === cacheVersion) allCache = built;
    return version === cacheVersion ? built : loadAllIndex();
  })().finally(() => { allLoadPromise = null; });
  return allLoadPromise;
}

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || (!changes.rules && !changes.ruleSets && !changes.activeRuleSetId && !changes.enabledRuleSetIds && !changes.ruleSetOverrides)) return;
  cacheVersion++;
  activeCache = null;
  activeLoadPromise = null;
  allCache = null;
  allLoadPromise = null;
});

GoPainterAgentTools.register({
  name: 'search_rules',
  description: '搜索当前编辑规则集或全部命名规则集中的规则 ID、名称和 matcher 内容，避免生成重复规则。',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 }, scope: { type: 'string', enum: ['active', 'all'] }, limit: { type: 'integer', minimum: 1, maximum: 30 } }, required: ['query'], additionalProperties: false },
  effect: 'read', permission: 'auto', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, skillIds: ['fingerprint-research'],
  validate(input) {
    const query = GoPainterAgentPage.string(input?.query).trim().toLowerCase();
    if (!query) throw new Error('query 不能为空');
    const scope = input?.scope || 'active';
    if (!['active', 'all'].includes(scope)) throw new Error('scope 只能是 active 或 all');
    return { query, scope, limit: GoPainterAgentPage.limit(input?.limit, 10, 30) };
  },
  async execute({ query, scope, limit }, context) {
    const index = await (scope === 'all' ? loadAllIndex() : loadActiveIndex());
    const matches = [];
    const exact = index.byKey.get(query);
    const candidates = exact ? [exact, ...index.entries] : index.entries;
    for (const entry of candidates) {
      if (entry !== exact && !entry.searchText.includes(query)) continue;
      if (matches.some((match) => match.id === entry.rule.id && match.ruleSetId === entry.ruleSetId)) continue;
      const { rule } = entry;
      const match = { ruleSetId: entry.ruleSetId, ruleSetName: entry.ruleSetName, id: rule.id, name: rule.name, matcherCount: (rule.matchers || []).length };
      if (entry === exact) match.rule = rule;
      matches.push(match);
      if (matches.length >= limit) return { query, scope, matches };
    }
    return { query, scope, matches };
  },
});
})();
