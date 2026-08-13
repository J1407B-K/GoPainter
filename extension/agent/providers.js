// 供应商适配：内部 ToolSpec 转成 API 方言，再把 tool call 归一化回统一对象。
(() => {
  const PROTOCOLS = Object.freeze({
    OPENAI_CHAT: 'openai-chat',
    ANTHROPIC_MESSAGES: 'anthropic-messages',
    TEXT_ONLY: 'text-only',
  });

  function apiURL(baseURL, suffix) {
    return `${String(baseURL || '').replace(/\/$/, '')}${suffix}`;
  }

  async function request(url, headers, body) {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      let detail = raw;
      try {
        const parsed = JSON.parse(raw);
        detail = parsed.error?.message || parsed.error?.type || parsed.message || raw;
      } catch { /* 非 JSON 错误体直接显示 */ }
      detail = String(detail || '').replace(/\s+/g, ' ').slice(0, 500);
      throw new Error(`AI 请求失败: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    }
    return response.json();
  }

  function parseOpenAICall(data) {
    const message = data.choices?.[0]?.message;
    const call = message?.tool_calls?.[0];
    if (call?.type !== 'function' || call.function?.name !== 'ping') throw new Error('模型未按要求调用 ping 工具');
    let input;
    try { input = JSON.parse(call.function.arguments || '{}'); } catch { throw new Error('模型返回的 ping 参数不是 JSON'); }
    return { id: call.id, name: call.function.name, input, assistantMessage: message };
  }

  async function testOpenAI(cfg, tool) {
    const url = apiURL(cfg.baseURL, '/chat/completions');
    const headers = { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' };
    const tools = [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }];
    const firstBody = {
      model: cfg.model,
      messages: [{ role: 'system', content: 'Call the required ping tool now.' }, { role: 'user', content: 'Run the connection test.' }],
      tools,
    };
    const first = await request(url, headers, firstBody);
    const call = parseOpenAICall(first);
    const result = await GoPainterAgentTools.executeTool(call.name, call.input);
    const second = await request(url, headers, {
      model: cfg.model,
      messages: [...firstBody.messages, call.assistantMessage, {
        role: 'tool', tool_call_id: call.id, content: JSON.stringify(result),
      }],
      tools,
    });
    return { protocol: PROTOCOLS.OPENAI_CHAT, tool: call.name, result, reply: second.choices?.[0]?.message?.content || '' };
  }

  async function testAnthropic(cfg, tool) {
    const url = apiURL(cfg.baseURL, '/messages');
    const headers = { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    const tools = [{ name: tool.name, description: tool.description, input_schema: tool.inputSchema }];
    const firstBody = {
      model: cfg.model, max_tokens: 64, system: 'Call the required ping tool now.',
      messages: [{ role: 'user', content: 'Run the connection test.' }], tools,
      tool_choice: { type: 'tool', name: tool.name },
    };
    const first = await request(url, headers, firstBody);
    const use = first.content?.find((part) => part.type === 'tool_use' && part.name === tool.name);
    if (!use) throw new Error('模型未按要求调用 ping 工具');
    const result = await GoPainterAgentTools.executeTool(use.name, use.input || {});
    const second = await request(url, headers, {
      ...firstBody,
      messages: [...firstBody.messages, { role: 'assistant', content: first.content }, {
        role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) }],
      }],
      tool_choice: { type: 'auto' },
    });
    return { protocol: PROTOCOLS.ANTHROPIC_MESSAGES, tool: use.name, result, reply: second.content?.filter((part) => part.type === 'text').map((part) => part.text).join('') || '' };
  }

  async function testToolCalling(cfg) {
    if (!cfg?.baseURL || !cfg?.apiKey || !cfg?.model) throw new Error('请填写 Base URL、API Key 和模型');
    const tool = GoPainterAgentTools.getTool('ping');
    try {
      if (cfg.protocol === PROTOCOLS.OPENAI_CHAT) return testOpenAI(cfg, tool);
      if (cfg.protocol === PROTOCOLS.ANTHROPIC_MESSAGES) return testAnthropic(cfg, tool);
    } catch (error) {
      if (/HTTP 404/.test(error.message)) {
        const expected = cfg.protocol === PROTOCOLS.ANTHROPIC_MESSAGES
          ? 'Anthropic Messages 的 Base URL 通常应为 https://api.anthropic.com/v1；若使用 OpenAI 兼容地址，请选择 OpenAI-compatible Chat Completions。'
          : 'OpenAI-compatible Chat Completions 的 Base URL 通常以 /v1 结尾；请检查服务商的 chat/completions 路径。';
        throw new Error(`${error.message}。${expected}`);
      }
      throw error;
    }
    throw new Error('纯文本协议不支持工具调用测试');
  }

  function parseArguments(value) {
    try { return JSON.parse(value || '{}'); } catch { throw new Error('模型返回的工具参数不是 JSON'); }
  }

  function openAITools(tools) {
    return tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
  }

  function createOpenAISession(cfg) {
    const url = apiURL(cfg.baseURL, '/chat/completions');
    const headers = { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' };
    const tools = openAITools(cfg.tools);
    const messages = [{ role: 'system', content: cfg.system }, { role: 'user', content: cfg.user }];
    return {
      async next(options = {}) {
        const body = { model: cfg.model, messages };
        if (!options.noTools) body.tools = tools;
        if (!options.noTools) body.parallel_tool_calls = false;
        const data = await request(url, headers, body);
        const assistantMessage = data.choices?.[0]?.message || {};
        const calls = (assistantMessage.tool_calls || []).filter((call) => call.type === 'function').map((call) => ({
          id: call.id, name: call.function.name, input: parseArguments(call.function.arguments),
        }));
        return { assistantMessage, calls, text: assistantMessage.content || '' };
      },
      addToolResults(reply, results) {
        messages.push(reply.assistantMessage, ...results.map((result) => ({ role: 'tool', tool_call_id: result.id, content: JSON.stringify(result.output) })));
      },
      addUserText(text) { messages.push({ role: 'user', content: text }); },
    };
  }

  function createAnthropicSession(cfg) {
    const url = apiURL(cfg.baseURL, '/messages');
    const headers = { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    const tools = cfg.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
    const messages = [{ role: 'user', content: cfg.user }];
    return {
      async next(options = {}) {
        const body = { model: cfg.model, max_tokens: 1200, system: cfg.system, messages };
        if (!options.noTools) {
          body.tools = tools;
          body.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
        }
        const data = await request(url, headers, body);
        const assistantMessage = { role: 'assistant', content: data.content || [] };
        const calls = assistantMessage.content.filter((part) => part.type === 'tool_use').map((part) => ({ id: part.id, name: part.name, input: part.input || {} }));
        return { assistantMessage, calls, text: assistantMessage.content.filter((part) => part.type === 'text').map((part) => part.text).join('') };
      },
      addToolResults(reply, results) {
        messages.push(reply.assistantMessage, { role: 'user', content: results.map((result) => ({ type: 'tool_result', tool_use_id: result.id, content: JSON.stringify(result.output) })) });
      },
      addUserText(text) { messages.push({ role: 'user', content: text }); },
    };
  }

  function createSession(cfg) {
    if (!cfg?.baseURL || !cfg?.apiKey || !cfg?.model) throw new Error('请先在设置页配置 AI（baseURL / API Key / 模型）');
    if (cfg.protocol === PROTOCOLS.OPENAI_CHAT) return createOpenAISession(cfg);
    if (cfg.protocol === PROTOCOLS.ANTHROPIC_MESSAGES) return createAnthropicSession(cfg);
    throw new Error('当前 Agent 协议不支持工具调用');
  }

  globalThis.GoPainterAgentProviders = Object.freeze({ PROTOCOLS, testToolCalling, createSession });
})();
