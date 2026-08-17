// 目标只描述工作和最终产物校验，不决定 Agent 何时停止调用工具。
(() => {
  const noOptimization = (text) => /^## 结论\s*\n当前 AI 无合理优化建议[。]?\s*$/.test(String(text || '').trim());
  const insufficientResearch = (text) => /^## 结论\s*\n现有证据不足，无法生成可靠规则[。]?\s*$/.test(String(text || '').trim());
  const fencedYaml = (text) => {
    const blocks = [...String(text || '').matchAll(/```(?:yaml|yml)[^\S\r\n]*\r?\n([\s\S]*?)```/gi)];
    return blocks.length === 1 ? blocks[0][1].trim() : '';
  };
  const ruleOutput = (text, expectedId = '') => {
    const yaml = fencedYaml(text);
    if (!yaml || !globalThis.jsyaml) return null;
    try {
      const docs = [];
      globalThis.jsyaml.loadAll(yaml, (doc) => docs.push(doc));
      const rawRules = docs.flatMap((doc) => Array.isArray(doc) ? doc : [doc]).filter((rule) => rule && typeof rule === 'object');
      // Agent final artifacts deliberately bypass sanitizeRuleDocs. That helper is for
      // third-party imports and compatibility; silently dropping fields here would make
      // the displayed YAML differ from the rule that was actually validated.
      if (rawRules.length !== 1) return null;
      const rawRule = rawRules[0];
      if (!String(rawRule.id || '').trim() || !String(rawRule.name || '').trim()
        || !['and', 'or'].includes(rawRule['matchers-condition'])) return null;
      const rawMatchers = Array.isArray(rawRules[0].matchers) ? rawRules[0].matchers : [];
      // Agent 产物不允许依靠导入清洗静默丢 matcher；否则预览和实际入库规则会不一致。
      if (!rawMatchers.length) return null;
      if (expectedId && rawRule.id !== expectedId) return null;
      return rawRule;
    } catch { return null; }
  };
  const goals = Object.freeze({
    'identify-site': Object.freeze({
      id: 'identify-site', skillId: 'fingerprint-research', maxTurns: 8,
      prompt: [
        '识别当前标签页 URL 所属网站的技术栈，不是识别 GoPainter 本身、当前仓库或页面文本中提到的项目。必须先调用 inspect_page 确认目标 URL；先检索现有规则和页面证据；只报告有证据支持的结论，并标明不确定性。',
        '最终输出必须是以下 Markdown 任务报告，严格使用这些标题，不要聊天式前言或结尾：',
        '## 识别结论\n一句话说明站点主要技术栈与整体把握。',
        '## 已确认技术栈\n逐项使用紧凑卡片式列表：`**技术名** · 类别 · 置信度（高/中/低）`，下一行用“证据：”说明。不要使用 Markdown 表格；没有证据时直接写“无已确认技术”。',
        '## 证据\n首行写“目标页面：<inspect_page 返回的 URL>”。随后逐条列出 JS probe、响应头、meta、脚本路径、favicon 或现有规则的具体命中。正文仅出现技术名称不是证据。',
        '## 未确认项\n明确说明尚不能判断的框架、CMS、后端或构建工具；不要猜测。',
        '## 建议下一步\n只给 0–3 条针对该 URL 的可执行验证建议；若页面特征已成功读取但无正向证据，写“当前页面未发现可靠技术指纹”，不要要求用户提供当前 URL。',
      ].join('\n\n'),
    }),
    'research-rule': Object.freeze({
      id: 'research-rule', skillId: 'fingerprint-research', maxTurns: 8,
      prompt: [
        '为用户指定的技术制作一条可以立即导入 GoPainter 的指纹规则。先调用 search_rules 避免重复，再调用 web_search 查找公开、稳定且可核验的技术特征；联网搜索需要宿主授权。当前标签页只有在确实属于目标技术时才可作为证据。',
        '当你认为证据足以支持可靠规则时自行结束；若继续检索也无法可靠推断，正常结束并只输出“## 结论\n现有证据不足，无法生成可靠规则”，不要编造 matcher。',
        '最终输出固定使用“## 结论”“## 证据依据”“## 可导入规则”“## 风险与限制”四个 Markdown 标题。',
        '除 YAML 外保持精简：结论只写一句，证据依据与风险各不超过 3 条，总说明文字不超过 250 个汉字。',
        '严格使用原生 matcher 结构：word={type,part?,words:[字符串]}；regex={type,part?,regex:[字符串]}；status={type,status:[整数]}；icon_hash={type,hash:[整数]}；dsl={type,dsl:[表达式]}；js={type,js:[{path,pattern?}]}；dom={type,dom:[{sel,text?,attrs?}]}。condition 只允许 and/or，绝不能放 JavaScript 表达式。无法用这些结构表达的特征不要写入规则。',
        '结论只能声称 YAML 中实际 matcher 能检测到的能力；不要把仅存在于证据说明、但无法被原生 matcher 表达的特征描述成规则已覆盖。',
        '“## 可导入规则”下必须且只能包含一个 ```yaml 代码块，内容必须是一条完整 GoPainter 原生规则，至少包含 id、name、matchers-condition 和非空 matchers；matcher 必须使用 GoPainter 支持的 word/regex/status/icon_hash/dsl/js/dom 类型。不要只给 matcher 片段，不要省略 id/name，不要声称自动写入。',
      ].join('\n\n'),
      acceptsWithoutValidatedRule: insufficientResearch,
      extractRule: (text) => ruleOutput(text),
      isOutputComplete: (text) => insufficientResearch(text) || Boolean(ruleOutput(text)),
    }),
    'optimize-rule': Object.freeze({
      id: 'optimize-rule', skillId: 'fingerprint-research', maxTurns: 8,
      prompt: [
        '优化用户从当前规则库明确选择的现有规则。必须用 search_rules 按规则 ID 读取完整规则，再调用 web_search 联网核验稳定特征；不要改规则 ID。',
        '最终输出固定使用“## 结论”“## 修改依据”“## 优化后规则”“## 风险与限制”四个 Markdown 标题。',
        '除 YAML 外保持精简：结论只写一句，修改依据与风险各不超过 3 条，总说明文字不超过 250 个汉字。',
        '严格使用原生 matcher 结构：word={type,part?,words:[字符串]}；regex={type,part?,regex:[字符串]}；status={type,status:[整数]}；icon_hash={type,hash:[整数]}；dsl={type,dsl:[表达式]}；js={type,js:[{path,pattern?}]}；dom={type,dom:[{sel,text?,attrs?}]}。condition 只允许 and/or，绝不能放 JavaScript 表达式。优化后每个 matcher 都必须能被原生解析，不能依赖导入清洗丢弃无效项。',
        '候选规则必须产生至少一项有公开证据支持的实质增删改，不得原样返回或只调整 YAML 排版。“修改依据”必须明确写出新增、删除或替换了哪个 matcher，不能只写“保留”“补强”之类笼统结论。',
        '如果研究后没有可靠的实质改进，正常结束并只输出“## 结论\n当前 AI 无合理优化建议”，不要编造修改，也不要输出原规则 YAML。',
        '结论只能声称优化后 YAML 中实际 matcher 能检测到的能力；不要把未落入规则的研究证据描述成已覆盖能力。',
        '“## 优化后规则”下必须且只能包含一个 ```yaml 代码块，内容必须是可直接覆盖入库的完整 GoPainter 原生规则，保留原 id，并至少包含 id、name、matchers-condition 和非空 matchers。不要只输出 diff 或 matcher 片段，不要声称自动写入。',
      ].join('\n\n'),
      isNoChange: (text) => noOptimization(text),
      acceptsWithoutValidatedRule: noOptimization,
      extractRule: (text, input) => ruleOutput(text, String(input || '').trim()),
      isOutputComplete: (text, input) => noOptimization(text) || Boolean(ruleOutput(text, String(input || '').trim())),
    }),
  });
  globalThis.GoPainterAgentGoals = Object.freeze({ get: (id) => goals[id] || null });
})();
