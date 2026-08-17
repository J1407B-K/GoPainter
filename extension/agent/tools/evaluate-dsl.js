GoPainterAgentTools.register({
  name: 'evaluate_dsl',
  description: '用 GoPainter 的 Go DSL evaluator 在当前页面特征上执行表达式，返回逐条结果和语法错误。',
  inputSchema: {
    type: 'object', properties: {
      expressions: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 1000 } },
    }, required: ['expressions'], additionalProperties: false,
  },
  effect: 'read', permission: 'auto',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  skillIds: ['fingerprint-research', 'gopainter-runtime-matcher'],
  validate(input) {
    if (!Array.isArray(input?.expressions) || !input.expressions.length || input.expressions.length > 12) throw new Error('expressions 数量无效');
    const expressions = input.expressions.map((item) => String(item));
    if (expressions.some((item) => !item || item.length > 1000)) throw new Error('expressions 内容无效');
    return { expressions };
  },
  async execute({ expressions }, context) {
    const features = await GoPainterAgentPage.getFeatures({}, context);
    await ensureWasm();
    const result = JSON.parse(globalThis.goDslEval(JSON.stringify(expressions), JSON.stringify(features)));
    if (result.error) throw new Error(result.error);
    return result;
  },
});
