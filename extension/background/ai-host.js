// Legacy direct-AI messages kept separate from the native Agent loop.
(() => {
  async function pageFeatures(tabId, fallback) {
    const data = await chrome.storage.session.get(`result:${tabId}`);
    return data[`result:${tabId}`]?.features || fallback;
  }

  async function requirePageFeatures(tabId) {
    const features = await pageFeatures(tabId);
    if (!features) throw new Error('没有当前页面的特征，请先刷新页面');
    return features;
  }

  async function identify(msg) {
    const features = await pageFeatures(msg.tabId, msg.features);
    const prompt = await GoPainterLegacyAI.prompt('identify');
    const answer = await GoPainterLegacyAI.call(prompt, features);
    return { ok: true, ...GoPainterUtils.techsFromAiReply(answer) };
  }

  async function generateRule({ tabId }) {
    const features = await requirePageFeatures(tabId);
    const prompt = await GoPainterLegacyAI.prompt('rule');
    const answer = await GoPainterLegacyAI.call(prompt, features);
    return { ok: true, yaml: GoPainterLegacyAI.extractYaml(answer) };
  }

  async function createRule({ tabId, name: rawName }) {
    const features = await requirePageFeatures(tabId);
    const name = String(rawName || '').trim();
    const extra = name
      ? `目标技术名：${name}。请为这个技术生成一条规则，id 用 kebab-case（如 ${name} 的小写短横线形式），只输出 YAML。`
      : '请为站点上检测到的新技术生成一条规则，只输出 YAML。';
    const prompt = await GoPainterLegacyAI.prompt('rule');
    const answer = await GoPainterLegacyAI.call(prompt, features, extra);
    return { ok: true, yaml: GoPainterLegacyAI.extractYaml(answer) };
  }

  async function activeRule(ruleId) {
    const stored = await chrome.storage.local.get([
      'rules',
      'ruleSets',
      'activeRuleSetId',
      'enabledRuleSetIds',
      'ruleSetOverrides',
    ]);
    const state = GoPainterUtils.normalizeRuleSets(
      stored.ruleSets,
      stored.activeRuleSetId,
      stored.rules,
      stored.enabledRuleSetIds,
      stored.ruleSetOverrides
    );
    const rules = state.ruleSets.find((set) => set.id === state.activeRuleSetId)?.rules || [];
    const rule = rules.find((item) => item.id === ruleId);
    if (!rule) throw new Error(`规则 ${ruleId} 不存在`);
    return rule;
  }

  async function normalizeOptimizedYaml(yaml, ruleId) {
    const docs = [];
    jsyaml.loadAll(yaml, (doc) => docs.push(doc));
    const clean = GoPainterUtils.sanitizeRuleDocs(docs);
    if (!clean.length) throw new Error('优化结果里没有有效规则');
    await ensureWasm();
    const output = JSON.parse(globalThis.goNormalizeRules(JSON.stringify(clean)));
    if (output.error) throw new Error(output.error);
    const rules = (output.rules || []).map((rule) => ({ ...rule, id: ruleId }));
    if (!rules.length) throw new Error('优化结果里没有有效规则');
    return jsyaml.dump(rules);
  }

  async function optimizeRule({ tabId, ruleId }) {
    const [features, rule] = await Promise.all([
      requirePageFeatures(tabId),
      activeRule(ruleId),
    ]);
    const extra = [
      '页面特征已给出。',
      '当前规则(YAML)：',
      jsyaml.dump(rule),
      '请基于该页面特征优化此规则，保持 id 不变，只输出优化后的 YAML。',
    ].join('\n');
    const prompt = await GoPainterLegacyAI.prompt('optimize');
    const answer = await GoPainterLegacyAI.call(prompt, features, extra);
    const yaml = await normalizeOptimizedYaml(GoPainterLegacyAI.extractYaml(answer), rule.id);
    return { ok: true, yaml, ruleName: rule.name };
  }

  async function testAgentTools({ config }) {
    return { ok: true, result: await GoPainterAgentProviders.testToolCalling(config) };
  }

  globalThis.GoPainterAIHost = Object.freeze({
    handlers: Object.freeze({
      aiIdentify: identify,
      aiGenerateRule: generateRule,
      aiCreateRule: createRule,
      aiOptimizeRule: optimizeRule,
      testAgentTools,
      getDefaultPrompts: () => ({ ok: true, prompts: GoPainterLegacyAI.DEFAULT_PROMPTS }),
    }),
  });
})();
