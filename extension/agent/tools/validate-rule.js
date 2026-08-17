(() => {
  const matcherTypes = new Set(['word', 'regex', 'status', 'icon_hash', 'dsl', 'js', 'dom']);
  const parts = new Set(['body', 'title', 'url', 'header', 'raw', 'meta', 'script']);
  const commonMatcherFields = new Set(['type', 'part', 'condition', 'negative', 'confidence']);
  const payloadField = Object.freeze({
    word: 'words', regex: 'regex', status: 'status', icon_hash: 'hash', dsl: 'dsl', js: 'js', dom: 'dom',
  });
  const nonEmptyString = (value, maxLength = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
  const stringList = (value, maxItems = 50, maxLength = 4000) => Array.isArray(value) && value.length > 0
    && value.length <= maxItems && value.every((item) => nonEmptyString(item, maxLength));
  const integerList = (value) => Array.isArray(value) && value.length > 0 && value.length <= 50 && value.every(Number.isInteger);
  const confidence = (value) => value === undefined || (Number.isInteger(value) && value >= 0 && value <= 100);
  const noExtraFields = (value, allowed, label) => {
    const extra = Object.keys(value).filter((key) => !allowed.has(key));
    if (extra.length) throw new Error(`${label} 包含不支持的字段：${extra.join('、')}`);
  };

  function validateProbeList(type, value, index) {
    if (!Array.isArray(value) || !value.length || value.length > 50
      || value.some((probe) => !probe || typeof probe !== 'object' || Array.isArray(probe))) {
      throw new Error(`第 ${index + 1} 个 ${type} matcher 的探针列表无效`);
    }
    for (const [probeIndex, probe] of value.entries()) {
      const allowed = type === 'js' ? new Set(['path', 'pattern']) : new Set(['sel', 'text', 'attrs']);
      noExtraFields(probe, allowed, `第 ${index + 1} 个 matcher 的第 ${probeIndex + 1} 个探针`);
      const identity = type === 'js' ? probe.path : probe.sel;
      if (!nonEmptyString(identity, type === 'js' ? 500 : 1000)) throw new Error(`第 ${index + 1} 个 ${type} matcher 缺少或超长${type === 'js' ? ' path' : ' sel'}`);
      if (probe.pattern !== undefined && !nonEmptyString(probe.pattern, 1000)) throw new Error('js pattern 必须是有界非空字符串');
      if (probe.text !== undefined && !nonEmptyString(probe.text, 1000)) throw new Error('dom text 必须是有界非空字符串');
      if (probe.attrs !== undefined && (!probe.attrs || typeof probe.attrs !== 'object' || Array.isArray(probe.attrs)
        || !Object.keys(probe.attrs).length || Object.keys(probe.attrs).length > 30
        || Object.entries(probe.attrs).some(([key, val]) => !nonEmptyString(key, 200) || !nonEmptyString(val, 1000)))) {
        throw new Error('dom attrs 必须是非空字符串映射');
      }
    }
  }

  function validateMatcher(matcher, index) {
    if (!matcher || typeof matcher !== 'object' || Array.isArray(matcher) || !matcherTypes.has(matcher.type)) {
      throw new Error(`第 ${index + 1} 个 matcher 类型无效`);
    }
    const payload = payloadField[matcher.type];
    noExtraFields(matcher, new Set([...commonMatcherFields, payload]), `第 ${index + 1} 个 matcher`);
    if (matcher.part !== undefined && !parts.has(matcher.part)) throw new Error(`第 ${index + 1} 个 matcher 的 part 无效`);
    if (matcher.condition !== undefined && !['and', 'or'].includes(matcher.condition)) throw new Error(`第 ${index + 1} 个 matcher 的 condition 无效`);
    if (matcher.negative !== undefined && typeof matcher.negative !== 'boolean') throw new Error(`第 ${index + 1} 个 matcher 的 negative 无效`);
    if (!confidence(matcher.confidence)) throw new Error(`第 ${index + 1} 个 matcher 的 confidence 无效`);
    if (['word', 'regex', 'dsl'].includes(matcher.type) && !stringList(matcher[payload])) throw new Error(`第 ${index + 1} 个 matcher 的 ${payload} 无效`);
    if (['status', 'icon_hash'].includes(matcher.type) && !integerList(matcher[payload])) throw new Error(`第 ${index + 1} 个 matcher 的 ${payload} 无效`);
    if (matcher.type === 'status' && matcher.status.some((value) => value < 100 || value > 599)) throw new Error(`第 ${index + 1} 个 status 超出 HTTP 状态码范围`);
    if (matcher.type === 'icon_hash' && matcher.hash.some((value) => value < -2147483648 || value > 2147483647)) throw new Error(`第 ${index + 1} 个 icon_hash 超出 int32 范围`);
    if (matcher.type === 'js' || matcher.type === 'dom') validateProbeList(matcher.type, matcher[payload], index);
  }

  function validateRule(rule) {
    noExtraFields(rule, new Set(['id', 'name', 'matchers-condition', 'matchers', 'confidence', 'implies', 'excludes']), '候选规则');
    if (!nonEmptyString(rule.id) || !nonEmptyString(rule.name)) throw new Error('候选规则必须包含非空 id 和 name');
    if (!['and', 'or'].includes(rule['matchers-condition'])) throw new Error('matchers-condition 必须是 and 或 or');
    if (!Array.isArray(rule.matchers) || !rule.matchers.length || rule.matchers.length > 50) throw new Error('候选规则必须包含 1-50 个 matchers');
    if (!confidence(rule.confidence)) throw new Error('候选规则的 confidence 无效');
    for (const field of ['implies', 'excludes']) {
      if (rule[field] !== undefined && !stringList(rule[field], 50, 500)) throw new Error(`${field} 必须是有界非空字符串数组`);
    }
    rule.matchers.forEach(validateMatcher);
    return rule;
  }

  function regexPatterns(rule) {
    const patterns = [];
    for (const matcher of rule.matchers) {
      if (matcher.type === 'regex') patterns.push(...matcher.regex);
      if (matcher.type === 'js') patterns.push(...matcher.js.map((probe) => probe.pattern).filter(Boolean));
      if (matcher.type === 'dom') {
        for (const probe of matcher.dom) {
          if (probe.text) patterns.push(probe.text);
          if (probe.attrs) patterns.push(...Object.values(probe.attrs));
        }
      }
    }
    return patterns;
  }

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
      return { rule: validateRule(input.rule) };
    },
    async execute({ rule }, context) {
      const features = await GoPainterAgentPage.getFeatures({}, context);
      await ensureWasm();
      const patterns = regexPatterns(rule);
      if (patterns.length) {
        const checked = JSON.parse(globalThis.goAgentRegexTest(JSON.stringify(patterns), '[]'));
        if (checked.error) throw new Error(checked.error);
        const invalid = checked.results?.find((result) => !result.valid);
        if (invalid) throw new Error(`正则无法由 Go RE2 编译：${invalid.pattern}（${invalid.error || '未知错误'}）`);
      }
      const expressions = rule.matchers.filter((matcher) => matcher.type === 'dsl').flatMap((matcher) => matcher.dsl);
      if (expressions.length) {
        const checked = JSON.parse(globalThis.goDslEval(JSON.stringify(expressions), JSON.stringify(features)));
        if (checked.error) throw new Error(checked.error);
        const error = checked.errors?.find(Boolean);
        if (error) throw new Error(`DSL 无法执行：${error}`);
      }
      const normalized = JSON.parse(globalThis.goNormalizeRules(JSON.stringify([rule])));
      if (normalized.error) throw new Error(normalized.error);
      if (!Array.isArray(normalized.rules) || normalized.rules.length !== 1
        || normalized.rules[0].matchers?.length !== rule.matchers.length) throw new Error('候选规则未通过 Go 原生结构校验');
      const matched = JSON.parse(globalThis.goMatch(JSON.stringify(normalized.rules), JSON.stringify(features)));
      if (matched.error) throw new Error(matched.error);
      const jsPaths = rule.matchers.filter((matcher) => matcher.type === 'js').flatMap((matcher) => matcher.js.map((probe) => probe.path));
      const missingJsPaths = jsPaths.filter((path) => !Object.prototype.hasOwnProperty.call(features.js || {}, path));
      const hasDomMatcher = rule.matchers.some((matcher) => matcher.type === 'dom');
      const runtimeCoverageComplete = !missingJsPaths.length && !hasDomMatcher;
      return {
        valid: true,
        rule: normalized.rules[0],
        currentPageHits: matched.hits || [],
        runtimeCoverage: {
          complete: runtimeCoverageComplete,
          missingJsPaths,
          hasUnverifiedDomSelectors: hasDomMatcher,
          note: runtimeCoverageComplete
            ? '当前页面特征覆盖了候选规则的运行时输入。'
            : 'js/dom 候选可能尚未被当前页面采集器探测；无命中不能单独证明规则不匹配。',
        },
      };
    },
  });
})();
