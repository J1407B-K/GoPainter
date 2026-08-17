GoPainterAgentTools.register({
  name: 'test_regex',
  description: '用生产 Go RE2 后端编译正则并在给定样本上执行，返回每条模式的编译错误、命中状态和命中文本。',
  inputSchema: {
    type: 'object',
    properties: {
      patterns: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 500 } },
      samples: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 4000 } },
    },
    required: ['patterns'], additionalProperties: false,
  },
  effect: 'read', permission: 'auto',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  skillIds: ['fingerprint-research', 'gopainter-regex-matcher'],
  validate(input) {
    const strings = (value, name, maxItems, maxLength, required = false) => {
      if (!Array.isArray(value) || (required && !value.length) || value.length > maxItems) throw new Error(`${name} 数量无效`);
      const out = value.map((item) => String(item));
      if (out.some((item) => (required && !item) || item.length > maxLength)) throw new Error(`${name} 内容无效`);
      return out;
    };
    return {
      patterns: strings(input?.patterns, 'patterns', 12, 500, true),
      samples: strings(input?.samples || [], 'samples', 12, 4000),
    };
  },
  async execute({ patterns, samples }) {
    await ensureWasm();
    const result = JSON.parse(globalThis.goAgentRegexTest(JSON.stringify(patterns), JSON.stringify(samples)));
    if (result.error) throw new Error(result.error);
    return result;
  },
});
