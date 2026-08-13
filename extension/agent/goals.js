// 目标定义与完成条件。目标只描述工作，不授予工具或权限。
(() => {
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
      isComplete: (state) => state.evidenceCalls > 0,
    }),
    'research-rule': Object.freeze({
      id: 'research-rule', skillId: 'fingerprint-research', maxSteps: 8,
      prompt: '为用户指定的技术研究可验证的指纹证据。先搜索现有规则，避免重复；不要写入规则。最终以 Markdown 任务报告输出，固定使用“## 结论”“## 可用证据”“## 规则建议”“## 未确认项”四个标题；不要聊天式闲谈。',
      isComplete: (state) => state.evidenceCalls > 0,
    }),
    'optimize-rule': Object.freeze({
      id: 'optimize-rule', skillId: 'fingerprint-research', maxSteps: 8,
      prompt: '研究如何优化用户指定的现有规则。收集页面和现有规则证据，只提出预览建议，不写入规则。最终以 Markdown 任务报告输出，固定使用“## 结论”“## 当前证据”“## 建议变更”“## 风险与未确认项”四个标题；不要聊天式闲谈。',
      isComplete: (state) => state.evidenceCalls > 0,
    }),
  });
  globalThis.GoPainterAgentGoals = Object.freeze({ get: (id) => goals[id] || null });
})();
