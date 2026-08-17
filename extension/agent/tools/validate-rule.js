(() => {
  function stableJSON(value) {
    if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function canonicalize(rule) {
    if (typeof globalThis.goValidateCandidate !== 'function') return '';
    const checked = JSON.parse(globalThis.goValidateCandidate(JSON.stringify(rule), '{}'));
    if (!checked.valid || !checked.rule) return '';
    return stableJSON(checked.rule);
  }

  globalThis.GoPainterAgentRuleArtifacts = Object.freeze({ canonicalize, stableJSON });

  GoPainterAgentTools.register({
    name: 'validate_rule',
    description: '严格校验完整 GoPainter 原生规则，用 Go RE2/DSL 检查表达式，再用生产 matcher 在当前页面执行。提交规则型最终答案前使用。',
    inputSchema: {
      type: 'object', properties: {
        rule: { type: 'object', description: '包含 id、name、matchers-condition 和非空 matchers 的完整 GoPainter 原生规则' },
      }, required: ['rule'], additionalProperties: false,
    },
    effect: 'read', permission: 'auto',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    skillIds: ['fingerprint-research'],
    validate(input) {
      if (!input?.rule || typeof input.rule !== 'object' || Array.isArray(input.rule)) throw new Error('rule 必须是完整规则对象');
      if (JSON.stringify(input.rule).length > 30_000) throw new Error('rule 过大');
      return { rule: input.rule };
    },
    async execute({ rule }, context) {
      const features = await GoPainterAgentPage.getFeatures({}, context);
      await ensureWasm();
      const result = JSON.parse(globalThis.goValidateCandidate(JSON.stringify(rule), JSON.stringify(features)));
      if (result.error) throw new Error(result.error);
      if (!result.valid) {
        const errors = Array.isArray(result.errors) ? result.errors : [];
        throw new Error(errors.map((item) => `${item.path}: ${item.message}`).join('；') || '候选规则未通过 Go Core 严格校验');
      }
      // 仅供 host 绑定最终产物；不枚举，避免把整条规则重复回填给模型。
      Object.defineProperty(result, 'artifact', { value: stableJSON(result.rule), enumerable: false });
      return result;
    },
  });
})();
