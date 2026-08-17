// Rule-set storage and import/export messages. Deterministic validation and conversion stay in Go Core.
(() => {
  const RULE_STATE_KEYS = [
    'rules',
    'ruleSets',
    'activeRuleSetId',
    'enabledRuleSetIds',
    'ruleSetOverrides',
  ];

  async function loadRuleState() {
    const stored = await chrome.storage.local.get(RULE_STATE_KEYS);
    return GoPainterUtils.normalizeRuleSets(
      stored.ruleSets,
      stored.activeRuleSetId,
      stored.rules,
      stored.enabledRuleSetIds,
      stored.ruleSetOverrides
    );
  }

  async function normalizeRuleYaml(yaml) {
    const docs = [];
    jsyaml.loadAll(yaml, (doc) => docs.push(doc));
    const clean = GoPainterUtils.sanitizeRuleDocs(docs);
    if (!clean.length) throw new Error('YAML 里没有有效规则');
    await ensureWasm();
    const output = JSON.parse(globalThis.goNormalizeRules(JSON.stringify(clean)));
    if (output.error) throw new Error(output.error);
    if (!output.rules?.length) throw new Error('YAML 里没有有效规则');
    return output.rules;
  }

  async function overview() {
    const state = await loadRuleState();
    return {
      activeRuleSetId: state.activeRuleSetId,
      enabledRuleSetIds: state.enabledRuleSetIds,
      ruleSets: state.ruleSets.map((set) => ({
        id: set.id,
        name: set.name,
        count: set.rules.length,
        enabled: state.enabledRuleSetIds.includes(set.id),
      })),
    };
  }

  async function activeSummaries() {
    const state = await loadRuleState();
    const active = state.ruleSets.find((set) => set.id === state.activeRuleSetId);
    return { rules: (active?.rules || []).map(({ id, name }) => ({ id, name })) };
  }

  async function setActive({ ruleSetId }) {
    const state = await loadRuleState();
    const selected = state.ruleSets.find((set) => set.id === ruleSetId);
    if (!selected) throw new Error('规则集不存在');
    await chrome.storage.local.set({ activeRuleSetId: selected.id });
    return { ok: true };
  }

  async function setEnabled({ enabledRuleSetIds }) {
    const current = await loadRuleState();
    const state = GoPainterUtils.normalizeRuleSets(
      current.ruleSets,
      current.activeRuleSetId,
      current.rules,
      enabledRuleSetIds,
      current.ruleSetOverrides
    );
    await chrome.storage.local.set({
      enabledRuleSetIds: state.enabledRuleSetIds,
      ruleSetOverrides: state.ruleSetOverrides,
      rules: state.rules,
    });
    return { ok: true, enabledRuleSetIds: state.enabledRuleSetIds, ruleCount: state.rules.length };
  }

  async function setOverride({ ruleId: rawRuleId, ruleSetId: rawRuleSetId }) {
    const ruleId = String(rawRuleId || '');
    const ruleSetId = String(rawRuleSetId || '');
    const current = await loadRuleState();
    const info = GoPainterUtils.ruleSetOverrideInfo(
      current.ruleSets,
      current.enabledRuleSetIds,
      current.ruleSetOverrides
    );
    const conflict = info.conflicts.find((item) => item.id === ruleId);
    const source = conflict?.sources.find((item) => item.id === ruleSetId);
    if (!source) throw new Error('该规则版本不存在或对应规则集未启用');

    const overrides = { ...current.ruleSetOverrides, [ruleId]: ruleSetId };
    const state = GoPainterUtils.normalizeRuleSets(
      current.ruleSets,
      current.activeRuleSetId,
      [],
      current.enabledRuleSetIds,
      overrides
    );
    await chrome.storage.local.set({ ruleSetOverrides: state.ruleSetOverrides, rules: state.rules });
    return { ok: true, ruleSetOverrides: state.ruleSetOverrides, ruleSetName: source.name };
  }

  function conflictResponse(conflicts) {
    return {
      ok: true,
      needsResolution: true,
      conflicts: conflicts.map((conflict) => ({
        id: conflict.id,
        name: conflict.name,
        existingYaml: jsyaml.dump(conflict.existing, { noRefs: true, lineWidth: -1 }),
        incomingYaml: jsyaml.dump(conflict.incoming, { noRefs: true, lineWidth: -1 }),
      })),
    };
  }

  async function addRule(msg) {
    const incoming = await normalizeRuleYaml(msg.yaml);
    if (msg.requireSingle && incoming.length !== 1) {
      throw new Error('Agent 必须交付且只能交付一条完整规则');
    }
    const expectedId = String(msg.expectedId || '').trim();
    if (expectedId && incoming.some((rule) => rule.id !== expectedId)) {
      throw new Error(`优化规则必须保留原 id：${expectedId}`);
    }

    const state = await loadRuleState();
    const existing = state.ruleSets.find((set) => set.id === state.activeRuleSetId)?.rules || [];
    const merge = GoPainterUtils.planRuleMerge(existing, incoming, msg.resolutions || {});
    if (merge.unresolved.length) return conflictResponse(merge.unresolved);
    if (merge.added || merge.replaced) {
      await chrome.storage.local.set(GoPainterUtils.replaceActiveRuleSetRules(state, merge.rules));
    }
    return {
      ok: true,
      added: merge.added,
      replaced: merge.replaced,
      kept: merge.kept,
      unchanged: merge.unchanged,
    };
  }

  async function normalizeRules({ docsJSON }) {
    let rawDocs = docsJSON;
    try {
      const parsed = JSON.parse(rawDocs);
      if (Array.isArray(parsed)) {
        rawDocs = JSON.stringify(GoPainterUtils.sanitizeImportedRuleDocs(parsed));
      }
    } catch { /* Let Go Core return the authoritative JSON/schema error. */ }
    await ensureWasm();
    const output = JSON.parse(globalThis.goNormalizeRules(rawDocs));
    if (output.error) throw new Error(output.error);
    return { ok: true, rules: output.rules };
  }

  async function callCoreConverter(name, input) {
    await ensureWasm();
    const output = JSON.parse(globalThis[name](input));
    if (output.error) throw new Error(output.error);
    return { ok: true, rules: output.rules };
  }

  async function classifyRuleSets() {
    const state = await loadRuleState();
    await ensureWasm();
    const results = {};
    for (const set of state.ruleSets) {
      const output = JSON.parse(globalThis.goClassifyRules(JSON.stringify(set.rules || [])));
      results[set.id] = output.error ? { error: output.error } : output;
    }
    return {
      ok: true,
      results,
      ruleSets: state.ruleSets.map((set) => ({
        id: set.id,
        name: set.name,
        count: set.rules.length,
        enabled: state.enabledRuleSetIds.includes(set.id),
      })),
    };
  }

  async function probes() {
    const { paths, probes: planned } = await getProbeList();
    return { ok: true, paths, probes: planned };
  }

  globalThis.GoPainterRulesHost = Object.freeze({
    handlers: Object.freeze({
      getRuleSetOverview: overview,
      getActiveRuleSummaries: activeSummaries,
      setActiveRuleSet: setActive,
      setEnabledRuleSets: setEnabled,
      setRuleSetOverride: setOverride,
      addRule,
      normalizeRules,
      convertWappalyzer: ({ techJSON }) => callCoreConverter('goConvertWappalyzer', techJSON),
      convertEHole: ({ fingerJSON }) => callCoreConverter('goConvertEHole', fingerJSON),
      classifyRuleSets,
      getProbes: probes,
    }),
  });
})();
