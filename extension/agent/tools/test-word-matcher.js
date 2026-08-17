GoPainterAgentTools.register({
  name: 'test_word_matcher',
  description: '用生产 Go word matcher 语义在给定样本上测试 words、and/or 与 negative 组合。',
  inputSchema: {
    type: 'object',
    properties: {
      words: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 500 } },
      samples: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', maxLength: 4000 } },
      condition: { type: 'string', enum: ['and', 'or'] },
      negative: { type: 'boolean' },
    },
    required: ['words', 'samples'], additionalProperties: false,
  },
  effect: 'read', permission: 'auto',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  skillIds: ['fingerprint-research', 'gopainter-word-matcher'],
  validate(input) {
    const list = (value, name, maxItems, maxLength) => {
      if (!Array.isArray(value) || !value.length || value.length > maxItems) throw new Error(`${name} 数量无效`);
      const out = value.map((item) => String(item));
      if (out.some((item) => !item || item.length > maxLength)) throw new Error(`${name} 内容无效`);
      return out;
    };
    const condition = input?.condition || 'or';
    if (!['and', 'or'].includes(condition)) throw new Error('condition 只能是 and 或 or');
    return {
      words: list(input?.words, 'words', 20, 500),
      samples: list(input?.samples, 'samples', 12, 4000),
      condition, negative: input?.negative === true,
    };
  },
  async execute({ words, samples, condition, negative }) {
    await ensureWasm();
    const result = JSON.parse(globalThis.goAgentWordTest(JSON.stringify(words), JSON.stringify(samples), condition, negative));
    if (result.error) throw new Error(result.error);
    return result;
  },
});
