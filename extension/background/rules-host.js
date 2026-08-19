// Rule-set storage and import/export messages. Deterministic validation and conversion stay in Go Core.
(() => {
  const RULE_STATE_KEYS = [
    'rules',
    'ruleSets',
    'activeRuleSetId',
    'enabledRuleSetIds',
    'ruleSetOverrides',
  ];
  const RULE_STATE_REVISION_KEY = 'ruleStateRevision';
  // chrome.storage has no compare-and-swap. Keep every GoPainter rule mutation in
  // this one service-worker queue so two async handlers cannot lose each other's write.
  let mutationQueue = Promise.resolve();
  function serializeMutation(fn) {
    const task = mutationQueue.then(fn, fn);
    mutationQueue = task.catch(() => {});
    return task;
  }

  function normalizeStoredRuleState(stored) {
    return GoPainterUtils.normalizeRuleSets(
      stored.ruleSets,
      stored.activeRuleSetId,
      stored.rules,
      stored.enabledRuleSetIds,
      stored.ruleSetOverrides
    );
  }

  async function loadRuleState() {
    return normalizeStoredRuleState(await chrome.storage.local.get(RULE_STATE_KEYS));
  }

  async function loadVersionedRuleState() {
    const stored = await chrome.storage.local.get([...RULE_STATE_KEYS, RULE_STATE_REVISION_KEY]);
    return {
      state: normalizeStoredRuleState(stored),
      revision: Number.isSafeInteger(stored[RULE_STATE_REVISION_KEY]) ? stored[RULE_STATE_REVISION_KEY] : 0,
    };
  }

  async function writeRuleState(values, revision) {
    const nextRevision = revision + 1;
    await chrome.storage.local.set({ ...values, [RULE_STATE_REVISION_KEY]: nextRevision });
    return nextRevision;
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

  function singleRuleDocument(yaml) {
    const docs = [];
    jsyaml.loadAll(String(yaml || ''), (doc) => {
      if (doc !== undefined && doc !== null) docs.push(doc);
    });
    if (docs.length !== 1 || Array.isArray(docs[0]) || typeof docs[0] !== 'object') {
      throw new Error('编辑器必须包含且只能包含一条规则');
    }
    return docs[0];
  }

  async function pageFeatures(tabId) {
    if (!Number.isInteger(tabId)) return {};
    const key = `result:${tabId}`;
    const stored = await chrome.storage.session.get(key);
    return stored[key]?.features || {};
  }

  async function validateDraft(yaml, tabId) {
    const document = singleRuleDocument(yaml);
    await ensureWasm();
    const validation = JSON.parse(globalThis.goValidateCandidate(
      JSON.stringify(document), JSON.stringify(await pageFeatures(tabId))
    ));
    if (validation.error) throw new Error(validation.error);
    return validation;
  }

  function effectiveRuleSource(state, ruleId) {
    const enabled = new Set(state.enabledRuleSetIds);
    const explicit = state.ruleSetOverrides[ruleId];
    if (explicit && enabled.has(explicit)) return state.ruleSets.find((set) => set.id === explicit) || null;
    let owner = null;
    for (const set of state.ruleSets) {
      if (enabled.has(set.id) && set.rules.some((rule) => rule?.id === ruleId)) owner = set;
    }
    return owner;
  }

  async function ruleForEditing({ ruleId: rawRuleId }) {
    const ruleId = String(rawRuleId || '').trim();
    const { state, revision } = await loadVersionedRuleState();
    const rule = state.rules.find((item) => item?.id === ruleId);
    if (!rule) throw new Error(`规则 ${ruleId} 不存在`);
    // Converted Go rules include explicit zero-value fields for matcher defaults.
    // The strict editor intentionally rejects those ambiguous empty scalars, so
    // present the equivalent canonical rule shape to every editing surface.
    const editableRule = GoPainterUtils.sanitizeRule(rule);
    if (!editableRule) throw new Error(`规则 ${ruleId} 无法编辑`);
    const active = state.ruleSets.find((set) => set.id === state.activeRuleSetId);
    const source = effectiveRuleSource(state, ruleId);
    return {
      ok: true,
      ruleId,
      yaml: jsyaml.dump(editableRule, { noRefs: true, lineWidth: -1 }),
      revision,
      sourceRuleSetId: source?.id || '',
      sourceRuleSetName: source?.name || '',
      editRuleSetId: active?.id || '',
      editRuleSetName: active?.name || '',
      copiesToEditSet: source?.id !== active?.id,
    };
  }

  async function validateRuleDraft({ yaml, tabId, expectedId }) {
    const validation = await validateDraft(yaml, tabId);
    if (validation.valid && expectedId && validation.rule?.id !== expectedId) {
      return {
        ok: true,
        valid: false,
        errors: [{ path: 'id', code: 'id_changed', message: `编辑规则必须保留原 id：${expectedId}` }],
      };
    }
    return { ok: true, ...validation };
  }

  async function saveRuleDraft({ yaml, tabId, expectedId, expectedRevision }) {
    const validation = await validateDraft(yaml, tabId);
    if (!validation.valid) return { ok: true, ...validation };
    const rule = GoPainterUtils.sanitizeRule(validation.rule);
    if (!rule) throw new Error('规则规范化失败');
    if (expectedId && rule.id !== expectedId) throw new Error(`编辑规则必须保留原 id：${expectedId}`);

    const { state, revision } = await loadVersionedRuleState();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== revision) {
      throw new Error('规则状态已更新，请重新打开编辑器后重试');
    }
    const active = state.ruleSets.find((set) => set.id === state.activeRuleSetId);
    if (!active) throw new Error('当前编辑集不存在');
    const rules = active.rules.slice();
    const index = rules.findIndex((item) => item?.id === rule.id);
    if (index >= 0) rules[index] = rule;
    else rules.push(rule);
    const enabledRuleSetIds = state.enabledRuleSetIds.includes(active.id)
      ? state.enabledRuleSetIds : [...state.enabledRuleSetIds, active.id];
    const ruleSetOverrides = { ...state.ruleSetOverrides, [rule.id]: active.id };
    const next = GoPainterUtils.normalizeRuleSets(
      state.ruleSets.map((set) => set.id === active.id ? { ...set, rules } : set),
      active.id,
      [],
      enabledRuleSetIds,
      ruleSetOverrides
    );
    const nextRevision = await writeRuleState(next, revision);
    globalThis.invalidateRuleMatchingCaches?.();
    if (Number.isInteger(tabId)) {
      chrome.tabs?.sendMessage(tabId, { type: 'gopainter:recollect' }).catch(() => {});
    }
    return {
      ok: true,
      valid: true,
      rule,
      currentPageHits: validation.currentPageHits || [],
      runtimeCoverage: validation.runtimeCoverage,
      revision: nextRevision,
      ruleSetName: active.name,
      copied: index < 0,
    };
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
    const { state, revision } = await loadVersionedRuleState();
    const selected = state.ruleSets.find((set) => set.id === ruleSetId);
    if (!selected) throw new Error('规则集不存在');
    const next = { ...state, activeRuleSetId: selected.id };
    const nextRevision = await writeRuleState({ activeRuleSetId: selected.id }, revision);
    return { ok: true, state: next, revision: nextRevision };
  }

  async function setEnabled({ enabledRuleSetIds }) {
    const { state: current, revision } = await loadVersionedRuleState();
    const state = GoPainterUtils.normalizeRuleSets(
      current.ruleSets,
      current.activeRuleSetId,
      current.rules,
      enabledRuleSetIds,
      current.ruleSetOverrides
    );
    const nextRevision = await writeRuleState({
      enabledRuleSetIds: state.enabledRuleSetIds,
      ruleSetOverrides: state.ruleSetOverrides,
      rules: state.rules,
    }, revision);
    return { ok: true, enabledRuleSetIds: state.enabledRuleSetIds, ruleCount: state.rules.length, state, revision: nextRevision };
  }

  async function setOverride({ ruleId: rawRuleId, ruleSetId: rawRuleSetId }) {
    const ruleId = String(rawRuleId || '');
    const ruleSetId = String(rawRuleSetId || '');
    const { state: current, revision } = await loadVersionedRuleState();
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
    const nextRevision = await writeRuleState({ ruleSetOverrides: state.ruleSetOverrides, rules: state.rules }, revision);
    return { ok: true, ruleSetOverrides: state.ruleSetOverrides, ruleSetName: source.name, state, revision: nextRevision };
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

    const { state, revision } = await loadVersionedRuleState();
    const existing = state.ruleSets.find((set) => set.id === state.activeRuleSetId)?.rules || [];
    const merge = GoPainterUtils.planRuleMerge(existing, incoming, msg.resolutions || {});
    if (merge.unresolved.length) return conflictResponse(merge.unresolved);
    if (merge.added || merge.replaced) {
      await writeRuleState(GoPainterUtils.replaceActiveRuleSetRules(state, merge.rules), revision);
    }
    return {
      ok: true,
      added: merge.added,
      replaced: merge.replaced,
      kept: merge.kept,
      unchanged: merge.unchanged,
    };
  }

  async function replaceActiveRuleSetRules({ rules, expectedRevision }) {
    if (!Array.isArray(rules)) throw new Error('规则必须是数组');
    const { state, revision } = await loadVersionedRuleState();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== revision) {
      throw new Error('规则状态已更新，请刷新后重试');
    }
    const next = GoPainterUtils.replaceActiveRuleSetRules(state, rules);
    const nextRevision = await writeRuleState(next, revision);
    return { ok: true, state: next, revision: nextRevision };
  }

  async function createRuleSet({ name: rawName }) {
    const name = String(rawName || '').trim();
    if (!name) throw new Error('请填写规则集名称');
    const { state, revision } = await loadVersionedRuleState();
    if (state.ruleSets.some((set) => set.name === name)) throw new Error('已有同名规则集');
    const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'ruleset';
    let id = base;
    let suffix = 2;
    while (state.ruleSets.some((set) => set.id === id)) id = `${base}-${suffix++}`;
    const next = GoPainterUtils.normalizeRuleSets(
      [...state.ruleSets, { id, name, rules: [] }], id, [], state.enabledRuleSetIds, state.ruleSetOverrides
    );
    const nextRevision = await writeRuleState(next, revision);
    return { ok: true, state: next, name, revision: nextRevision };
  }

  async function deleteRuleSet({ ruleSetId }) {
    const { state, revision } = await loadVersionedRuleState();
    const target = state.ruleSets.find((set) => set.id === ruleSetId);
    if (!target) throw new Error('规则集不存在');
    if (state.ruleSets.length <= 1) throw new Error('至少保留一个规则集');
    const ruleSets = state.ruleSets.filter((set) => set.id !== target.id);
    const next = GoPainterUtils.normalizeRuleSets(
      ruleSets, ruleSets[0].id, [], state.enabledRuleSetIds.filter((id) => id !== target.id), state.ruleSetOverrides
    );
    const nextRevision = await writeRuleState(next, revision);
    return { ok: true, state: next, name: target.name, revision: nextRevision };
  }

  async function replaceSourceRuleSet({ id, name, rules }, beforeReplace) {
    if (!id || !name || !Array.isArray(rules) || !rules.length) throw new Error('远程规则集无效');
    const { state, revision } = await loadVersionedRuleState();
    const previous = state.ruleSets.find((set) => set.id === id);
    if (beforeReplace && previous?.rules?.length) await beforeReplace(previous.rules);
    const replacement = { id, name, rules };
    const ruleSets = previous
      ? state.ruleSets.map((set) => set.id === id ? replacement : set)
      : [...state.ruleSets, replacement];
    const enabledRuleSetIds = state.enabledRuleSetIds.includes(id)
      ? state.enabledRuleSetIds : [...state.enabledRuleSetIds, id];
    const next = GoPainterUtils.normalizeRuleSets(
      ruleSets, state.activeRuleSetId, [], enabledRuleSetIds, state.ruleSetOverrides
    );
    const nextRevision = await writeRuleState(next, revision);
    return {
      summary: GoPainterUtils.ruleSetUpdateSummary(previous?.rules || [], rules),
      previousCount: previous?.rules?.length || 0,
      ruleCount: rules.length,
      revision: nextRevision,
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
      getRuleForEditing: ruleForEditing,
      validateRuleDraft,
      saveRuleDraft: (msg) => serializeMutation(() => saveRuleDraft(msg)),
      setActiveRuleSet: (msg) => serializeMutation(() => setActive(msg)),
      setEnabledRuleSets: (msg) => serializeMutation(() => setEnabled(msg)),
      setRuleSetOverride: (msg) => serializeMutation(() => setOverride(msg)),
      addRule: (msg) => serializeMutation(() => addRule(msg)),
      replaceActiveRuleSetRules: (msg) => serializeMutation(() => replaceActiveRuleSetRules(msg)),
      createRuleSet: (msg) => serializeMutation(() => createRuleSet(msg)),
      deleteRuleSet: (msg) => serializeMutation(() => deleteRuleSet(msg)),
      normalizeRules,
      convertWappalyzer: ({ techJSON }) => callCoreConverter('goConvertWappalyzer', techJSON),
      convertEHole: ({ fingerJSON }) => callCoreConverter('goConvertEHole', fingerJSON),
      classifyRuleSets,
      getProbes: probes,
    }),
    replaceSourceRuleSet: (input, beforeReplace) => serializeMutation(() => replaceSourceRuleSet(input, beforeReplace)),
  });
})();
