// 目标定义与完成条件。目标只描述工作，不授予工具或权限。
(() => {
  const used = (state, name) => state.successfulTools?.has(name) || false;
  const calls = (state, name) => (state.successfulCalls || []).filter((call) => call.name === name);
  const hasWebEvidence = (state) => calls(state, 'web_search').some((call) => call.output?.results?.length);
  const loadedRule = (state, id) => calls(state, 'search_rules').some((call) =>
    String(call.input?.query || '').trim().toLowerCase() === String(id || '').trim().toLowerCase()
    && call.output?.matches?.some((match) => match.rule?.id === id));
  const fencedYaml = (text) => {
    const blocks = [...String(text || '').matchAll(/```(?:yaml|yml)[^\S\r\n]*\r?\n([\s\S]*?)```/gi)];
    return blocks.length === 1 ? blocks[0][1].trim() : '';
  };
  const completeRuleOutput = (text, expectedId = '') => {
    const yaml = fencedYaml(text);
    if (!yaml) return false;
    try {
      if (globalThis.jsyaml && globalThis.GoPainterUtils) {
        const docs = [];
        globalThis.jsyaml.loadAll(yaml, (doc) => docs.push(doc));
        const rawRules = docs.flatMap((doc) => Array.isArray(doc) ? doc : [doc]).filter((rule) => rule && typeof rule === 'object');
        const rules = globalThis.GoPainterUtils.sanitizeRuleDocs(docs);
        if (rawRules.length !== 1 || rules.length !== 1 || !rules[0]['matchers-condition']) return false;
        const rawMatchers = Array.isArray(rawRules[0].matchers) ? rawRules[0].matchers : [];
        // Agent 产物不允许依靠导入清洗静默丢 matcher；否则预览和实际入库规则会不一致。
        if (!rawMatchers.length || rawMatchers.length !== rules[0].matchers.length) return false;
        return !expectedId || rules[0].id === expectedId;
      }
    } catch { return false; }
    const has = (key) => new RegExp(`(^|\\n)\\s*(?:-\\s*)?${key}\\s*:`, 'i').test(yaml);
    if (!has('id') || !has('name') || !has('matchers-condition') || !has('matchers')) return false;
    if (!expectedId) return true;
    const id = yaml.match(/(?:^|\n)\s*(?:-\s*)?id\s*:\s*["']?([^\s"'#]+)["']?/i)?.[1] || '';
    return id === expectedId;
  };
  const goals = Object.freeze({
    'identify-site': Object.freeze({
      id: 'identify-site', skillId: 'fingerprint-research', maxSteps: 8,
      prompt: [
        '识别当前标签页 URL 所属网站的技术栈，不是识别 GoPainter 本身、当前仓库或页面文本中提到的项目。必须先调用 inspect_page 确认目标 URL；先检索现有规则和页面证据；只报告有证据支持的结论，并标明不确定性。',
        '最终输出必须是以下 Markdown 任务报告，严格使用这些标题，不要聊天式前言或结尾：',
        '## 识别结论\n一句话说明站点主要技术栈与整体把握。',
        '## 已确认技术栈\n逐项使用紧凑卡片式列表：`**技术名** · 类别 · 置信度（高/中/低）`，下一行用“证据：”说明。不要使用 Markdown 表格；没有证据时直接写“无已确认技术”。',
        '## 证据\n首行写“目标页面：<inspect_page 返回的 URL>”。随后逐条列出 JS probe、响应头、meta、脚本路径、favicon 或现有规则的具体命中。正文仅出现技术名称不是证据。',
        '## 未确认项\n明确说明尚不能判断的框架、CMS、后端或构建工具；不要猜测。',
        '## 建议下一步\n只给 0–3 条针对该 URL 的可执行验证建议；若页面特征已成功读取但无正向证据，写“当前页面未发现可靠技术指纹”，不要要求用户提供当前 URL。',
      ].join('\n\n'),
      // Bind the target page, then check the active rule library before synthesizing.
      isComplete: (state) => used(state, 'inspect_page') && used(state, 'search_rules'),
    }),
    'research-rule': Object.freeze({
      id: 'research-rule', skillId: 'fingerprint-research', maxSteps: 8,
      prompt: [
        '为用户指定的技术制作一条可以立即导入 GoPainter 的指纹规则。先调用 search_rules 避免重复，再调用 web_search 查找公开、稳定且可核验的技术特征；联网搜索需要宿主授权。当前标签页只有在确实属于目标技术时才可作为证据。',
        '最终输出固定使用“## 结论”“## 证据依据”“## 可导入规则”“## 风险与限制”四个 Markdown 标题。',
        '除 YAML 外保持精简：结论只写一句，证据依据与风险各不超过 3 条，总说明文字不超过 250 个汉字。',
        '严格使用原生 matcher 结构：word={type,part?,words:[字符串]}；regex={type,part?,regex:[字符串]}；status={type,status:[整数]}；icon_hash={type,hash:[整数]}；dsl={type,dsl:[表达式]}；js={type,js:[{path,pattern?}]}；dom={type,dom:[{sel,text?,attrs?}]}。condition 只允许 and/or，绝不能放 JavaScript 表达式。无法用这些结构表达的特征不要写入规则。',
        '结论只能声称 YAML 中实际 matcher 能检测到的能力；不要把仅存在于证据说明、但无法被原生 matcher 表达的特征描述成规则已覆盖。',
        '“## 可导入规则”下必须且只能包含一个 ```yaml 代码块，内容必须是一条完整 GoPainter 原生规则，至少包含 id、name、matchers-condition 和非空 matchers；matcher 必须使用 GoPainter 支持的 word/regex/status/icon_hash/dsl/js/dom 类型。不要只给 matcher 片段，不要省略 id/name，不要声称自动写入。',
      ].join('\n\n'),
      isComplete: (state) => used(state, 'search_rules') && hasWebEvidence(state),
      isOutputComplete: (text) => completeRuleOutput(text),
    }),
    'optimize-rule': Object.freeze({
      id: 'optimize-rule', skillId: 'fingerprint-research', maxSteps: 8,
      prompt: [
        '优化用户从当前规则库明确选择的现有规则。必须用 search_rules 按规则 ID 读取完整规则，再调用 web_search 联网核验稳定特征；不要改规则 ID。',
        '最终输出固定使用“## 结论”“## 修改依据”“## 优化后规则”“## 风险与限制”四个 Markdown 标题。',
        '除 YAML 外保持精简：结论只写一句，修改依据与风险各不超过 3 条，总说明文字不超过 250 个汉字。',
        '严格使用原生 matcher 结构：word={type,part?,words:[字符串]}；regex={type,part?,regex:[字符串]}；status={type,status:[整数]}；icon_hash={type,hash:[整数]}；dsl={type,dsl:[表达式]}；js={type,js:[{path,pattern?}]}；dom={type,dom:[{sel,text?,attrs?}]}。condition 只允许 and/or，绝不能放 JavaScript 表达式。优化后每个 matcher 都必须能被原生解析，不能依赖导入清洗丢弃无效项。',
        '结论只能声称优化后 YAML 中实际 matcher 能检测到的能力；不要把未落入规则的研究证据描述成已覆盖能力。',
        '“## 优化后规则”下必须且只能包含一个 ```yaml 代码块，内容必须是可直接覆盖入库的完整 GoPainter 原生规则，保留原 id，并至少包含 id、name、matchers-condition 和非空 matchers。不要只输出 diff 或 matcher 片段，不要声称自动写入。',
      ].join('\n\n'),
      isComplete: (state, input) => loadedRule(state, input) && hasWebEvidence(state),
      isOutputComplete: (text, input) => completeRuleOutput(text, String(input || '').trim()),
    }),
  });
  globalThis.GoPainterAgentGoals = Object.freeze({ get: (id) => goals[id] || null });
})();
