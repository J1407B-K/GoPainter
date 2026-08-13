// 当前页面的结构化概览。它刻意不返回 body，避免把页面正文中提到的第三方技术误当作本站技术。
GoPainterAgentTools.register({
  name: 'inspect_page',
  description: '读取当前标签页的 URL、标题、状态码、响应头、meta、脚本路径、favicon 哈希与已探测 JS 信号。用于先确认识别对象和可靠指纹；不返回页面正文。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  effect: 'read', permission: 'auto', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, skillIds: ['fingerprint-research'],
  validate(input) {
    if (input != null && (typeof input !== 'object' || Array.isArray(input))) throw new Error('input 必须是对象');
    return {};
  },
  async execute(_input, context) {
    const features = await GoPainterAgentPage.getFeatures({}, context);
    return {
      url: features.url || '', title: features.title || '', status: features.status ?? null,
      headers: features.headers || {}, meta: features.meta || {}, scripts: (features.scripts || []).slice(0, 100),
      faviconHashes: features.faviconHashes || [], js: features.js || {},
      note: '这是唯一的识别目标页面。页面正文中出现的项目、依赖或第三方名称不能单独作为本站技术栈证据。',
    };
  },
});
