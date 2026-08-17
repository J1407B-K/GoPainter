// Agent 之前的直接 AI 入口。暂供 popup 视别/生成/优化和书签整理使用，不参与 Agent loop。
(() => {
  const DEFAULT_PROMPTS = Object.freeze({
    identify: [
      '你是 Web 技术栈指纹分析专家。根据页面特征（URL/标题/状态码/响应头/meta/script/favicon哈希/body/js全局变量/dom选择器）识别站点使用的技术栈（框架、CMS、中间件、Web服务器、语言、前端库、统计工具等）。',
      '只输出一个 JSON 数组，不要任何解释、不要 markdown 代码块。',
      '数组每项结构：{"name":"技术名","confidence":0到100整数,"evidence":[{"type":"...","detail":"..."}]}',
      'evidence.type 只允许：word / regex / header / meta / script / js / dom / status / icon_hash',
      '  - header/meta/script 表示命中位置，detail 写具体内容，如 "server: nginx"、"generator: ZenTao"、"/media/system/js/core.js"',
      '  - js 写 "window.React.version"；dom 写选择器；status 写 "状态码 200"；icon_hash 写 "mmh3 <数字>"',
      'confidence 越高越确定；没有把握的技术不要列。',
      '',
      '【示范】用户特征 {"url":"https://demo.example.com","title":"登录 - 禅道","meta":{"generator":"ZenTao"}}',
      '应返回：[{"name":"ZenTao","confidence":92,"evidence":[{"type":"meta","detail":"generator: ZenTao"}]}]',
    ].join('\n'),
    rule: [
      '你是 Web 指纹规则编写专家。根据用户给的页面特征，为一个 Web 技术编写一条 GoPainter 指纹规则，只输出 YAML，不要任何解释。',
      '',
      '支持的 schema（严格照抄字段名，别自创）：',
      '- id: kebab-case 英文标识（必填）',
      '- name: 产品/系统名（必填）',
      '- matchers-condition: and 或 or（多个 matcher 之间的组合，默认 or）',
      '- matchers: 一个或多个 matcher',
      '    - type: word | regex | status | icon_hash',
      '      part: body | title | url | header | raw | meta | script（默认 body）',
      '      words: [字符串]        # type=word 用',
      '      regex: [字符串]        # type=regex 用',
      '      status: [整数]         # type=status 用',
      '      hash: [整数]           # type=icon_hash 用，直接用用户给的 faviconHashes 数字，别自己编',
      '      condition: and 或 or   # matcher 内部多条件组合，默认 or',
      '      negative: true         # 可选，取反',
      '      confidence: 0-100      # 可选，这条 matcher 的信号强度；没把握就别写，弱信号给低点',
      '',
      '【示范】用户给的页面特征 → 应输出的完整规则：',
      '用户特征：',
      '  url: https://demo.example.com',
      '  title: Demo - Joomla!',
      '  faviconHashes: [-452104223]',
      '  meta: {"generator": "Joomla! - Open Source Content Management"}',
      '  scripts: ["/media/system/js/core.js", "/media/vendor/jquery/js/jquery.min.js"]',
      '应输出：',
      '- id: joomla',
      '  name: Joomla',
      '  matchers-condition: or',
      '  matchers:',
      '    - type: word',
      '      part: meta',
      '      words:',
      '        - "generator: Joomla"',
      '    - type: word',
      '      part: script',
      '      words:',
      '        - "/media/system/js/core.js"',
      '    - type: icon_hash',
      '      hash:',
      '        - -452104223',
      '',
      '要求：',
      '- 挑稳定特征：generator meta、框架特有路径/script、响应头、favicon 哈希，别选随时会变的文案',
      '- faviconHashes 非空时可以作为一条 icon_hash matcher，hash 直接用里面的数字',
      '- 一个 YAML 文档只写一条规则（以 "- id:" 开头）',
      '- 只输出 YAML，不要 ```yaml 代码块，不要解释文字',
      '- 别写 JS 表达式/DSL，只用上面列出的字段',
    ].join('\n'),
    optimize: [
      '你是 Web 指纹规则优化专家。下面「用户消息」里会给出：页面特征 + 当前规则的 YAML。',
      '请基于该页面特征优化这条规则：',
      '- 保持 id 不变（同 id 覆盖入库），可微调 name；保留当前已有 matcher，不要删除或替换它们',
      '- 从当前页面尚未使用的稳定特征中补充 1-2 条 matcher：优先 generator meta、框架特有 script 路径、响应头、favicon 哈希（hash 直接用页面 faviconHashes 数字）、js 全局变量（window.x）、dom 选择器；没有可靠的新特征时保持原规则不变',
      '- 只输出一个 YAML 文档（以 "- id:" 开头），不要 ```yaml 代码块，不要解释文字',
      '- 严格照抄 schema 字段：type(word|regex|status|icon_hash|js|dom) / part(body|title|url|header|raw|meta|script) / words / regex / status / hash / js(数组,{path,pattern}) / dom(数组,{sel,text,attrs}) / condition / negative / confidence(0-100)',
      '- 别写 JS 表达式/DSL',
    ].join('\n'),
    bookmark: '根据用户给出的页面特征判断该站点使用的系统/框架/中间件，只回复一个名称（如 Nginx、WordPress、Vue），拿不准就回复「未知」，不要任何其他内容。',
  });

  async function call(systemPrompt, features, extraUserText = '') {
    const cfg = await chrome.storage.local.get(['aiBaseURL', 'aiApiKey', 'aiModel']);
    if (!cfg.aiBaseURL || !cfg.aiApiKey || !cfg.aiModel) throw new Error('请先在设置页配置 AI（baseURL / API Key / 模型）');
    const jsEntries = Object.entries(features.js || {}).slice(0, 40);
    const domSelectors = (await matchedDomSelectors(features)).slice(0, 40);
    const slim = {
      url: features.url, title: features.title, status: features.status, headers: features.headers,
      faviconHashes: features.faviconHashes || [], meta: features.meta,
      scripts: (features.scripts || []).slice(0, 30), js: Object.fromEntries(jsEntries), dom: domSelectors,
      body: (features.body || '').slice(0, 8000),
    };
    const userContent = [JSON.stringify(slim), extraUserText && `\n\n${extraUserText}`].filter(Boolean).join('');
    const response = await fetch(`${cfg.aiBaseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.aiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.aiModel,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
      }),
    });
    if (!response.ok) throw new Error(`AI 请求失败: HTTP ${response.status}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async function prompt(key) {
    const storageKey = {
      identify: 'aiPromptIdentify', rule: 'aiPromptRule', optimize: 'aiPromptOptimize', bookmark: 'aiPromptBookmark',
    }[key];
    if (!storageKey || !DEFAULT_PROMPTS[key]) throw new Error(`未知 AI prompt：${key}`);
    const cfg = await chrome.storage.local.get(storageKey);
    return cfg[storageKey] || DEFAULT_PROMPTS[key];
  }

  globalThis.GoPainterLegacyAI = Object.freeze({
    DEFAULT_PROMPTS,
    call,
    prompt,
    extractYaml: (text) => GoPainterUtils.extractYaml(text),
  });
})();
