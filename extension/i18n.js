// Lightweight extension UI localization. Technical fingerprints and user-provided
// names remain untouched; only bundled interface copy is translated.
(() => {
  const LOCALE_KEY = 'uiLocale';
  const DEFAULT_LOCALE = 'zh-CN';
  let locale = DEFAULT_LOCALE;
  const originals = new WeakMap();
  const attributeOriginals = new WeakMap();
  const originalTitle = document.title;

  const en = {
    '设置与数据管理': 'Settings & data management', '设置': 'Settings',
    '指纹规则': 'Fingerprint rules', '规则体检': 'Rule health', '置信度': 'Confidence',
    '第三方规则源': 'Third-party rule sources', 'favicon 哈希库': 'Favicon hash database',
    '书签分类': 'Bookmark organization', '扫描历史与报告': 'Scan history & reports',
    '站点爬取': 'Site crawl', 'AI 与 Agent': 'AI & Agent',
    '当前编辑集': 'Active rule set', '参与匹配的规则集': 'Rule sets used for matching',
    '全部启用': 'Enable all', '仅当前': 'Current only', '新建并切换': 'Create & switch',
    '删除当前集': 'Delete current set', '导入内置规则库': 'Import built-in rules',
    '导出当前集': 'Export current set', '清空规则': 'Clear rules',
    '开始体检全部规则集': 'Check all rule sets', '规则详情': 'Rule details', '关闭': 'Close',
    '复制 YAML': 'Copy YAML', '规则冲突': 'Rule conflict', '旧规则': 'Existing rule',
    '新规则': 'Incoming rule', '保留旧规则': 'Keep existing', '覆盖规则': 'Replace rule',
    '剩余全部保留': 'Keep all remaining', '剩余全部覆盖': 'Replace all remaining', '取消导入': 'Cancel import',
    '按置信度排序': 'Sort by confidence', '保存': 'Save', '导入': 'Import',
    '清空自定义': 'Clear custom entries', '加载书签列表': 'Load bookmarks', '全选': 'Select all',
    '整理选中': 'Organize selected', '历史保留上限（滚动窗口）': 'History limit (rolling window)',
    '保存上限': 'Save limit', '导出 JSON': 'Export JSON', '导出 CSV': 'Export CSV',
    '清空历史': 'Clear history', '起始 URL': 'Start URL', '最大页数': 'Maximum pages',
    '开始爬取': 'Start crawl', '停止': 'Stop', '模型': 'Model',
    'Agent 工具调用协议': 'Agent tool-call protocol', '测试工具调用（可能产生 API 消耗）': 'Test tool calls (may use API credits)',
    '提示词': 'Prompts', '恢复默认': 'Restore default', '保存 AI 配置': 'Save AI settings',
    '编辑集': 'Rule set', '加载中…': 'Loading…', '爬取本站': 'Crawl site',
    '设置': 'Settings', '技术名，如 WordPress': 'Technology name, e.g. WordPress',
    '✨ 生成': '✨ Generate', '✅ 保存规则': '✅ Save rule', '丢弃': 'Discard',
    '留空 = 不限': 'Leave blank = unlimited', '取消': 'Cancel',
    '目标': 'Goal', '识别当前网站': 'Identify current site', '研究指纹规则': 'Research fingerprint rule',
    '优化规则建议': 'Optimize rule suggestion', '技术名': 'Technology name',
    '选择当前编辑集中的规则': 'Choose a rule in the active set', '执行': 'Run',
    '导入规则': 'Import rule', '需要授权': 'Permission required', '允许本次调用': 'Allow once',
    '本次会话始终允许': 'Always allow this session', '拒绝': 'Deny',
    '未运行': 'Not running', '爬取中': 'Crawling', '已中断': 'Interrupted',
    '爬取结果': 'Crawl results', '尚未爬取': 'No crawl yet',
    'GoPainter 爬取': 'GoPainter Crawl',
    '选择 YAML 文件导入（支持多选）': 'Choose YAML files to import (multiple supported)',
    '规则（或单条 matcher）可以标': 'Rules (or individual matchers) can specify',
    '规则未命中时用 AI 判断（慢，每个书签一次 AI 调用）': 'Use AI when rules do not match (slow; one call per bookmark)',
    '普通 AI 功能继续使用 OpenAI 兼容接口。Agent 工具调用可额外选择 OpenAI 兼容或 Anthropic Messages 协议。': 'Standard AI uses an OpenAI-compatible API. Agent tool calls can additionally use OpenAI-compatible or Anthropic Messages protocols.',
  };

  const attrs = {
    '筛选重复规则 ID': 'Filter duplicate rule IDs', '新规则集名称': 'New rule set name',
    '筛选规则 ID 或名称': 'Filter rule ID or name', '0': '0',
    '每行一条：哈希 名称（如 -1010568750 Phpmyadmin）\n或者直接贴 JSON：{"-1010568750": "Phpmyadmin"}': 'One per line: hash name (e.g. -1010568750 Phpmyadmin)\nOr paste JSON: {"-1010568750": "Phpmyadmin"}',
    'https://api.openai.com/v1 或 http://localhost:11434/v1': 'https://api.openai.com/v1 or http://localhost:11434/v1',
    '筛选技术名或规则 ID': 'Filter technology name or rule ID', '例如 React、WordPress': 'e.g. React, WordPress',
  };

  function normalized(value) { return String(value).trim().replace(/\s+/g, ' '); }
  function translate(value, table = en) {
    if (locale !== 'en') return value;
    const key = normalized(value);
    return table[key] || value;
  }

  function translateText(root = document) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || ['SCRIPT', 'STYLE', 'CODE', 'PRE'].includes(parent.tagName) || !node.data.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (!originals.has(node)) originals.set(node, node.data);
      node.data = locale === 'en' ? translate(originals.get(node)) : originals.get(node);
    }
  }

  function translateAttributes(root = document) {
    for (const el of root.querySelectorAll('[placeholder], [title], [aria-label]')) {
      let originalAttrs = attributeOriginals.get(el);
      if (!originalAttrs) {
        originalAttrs = new Map();
        attributeOriginals.set(el, originalAttrs);
      }
      for (const attr of ['placeholder', 'title', 'aria-label']) {
        if (!el.hasAttribute(attr)) continue;
        if (!originalAttrs.has(attr)) originalAttrs.set(attr, el.getAttribute(attr));
        const original = originalAttrs.get(attr);
        el.setAttribute(attr, locale === 'en' ? (attrs[original] || en[original] || original) : original);
      }
    }
  }

  function updateToggle(root = document) {
    for (const toggle of root.querySelectorAll('[data-locale-toggle]')) {
      toggle.textContent = locale === 'en' ? '中文' : 'EN';
      toggle.title = locale === 'en' ? '切换到中文' : 'Switch to English';
      toggle.setAttribute('aria-label', toggle.title);
    }
  }

  function apply(root = document) {
    document.documentElement.lang = locale;
    document.title = locale === 'en' ? translate(originalTitle) : originalTitle;
    translateText(root);
    translateAttributes(root);
    updateToggle(root);
  }

  async function setLocale(next) {
    locale = next === 'en' ? 'en' : DEFAULT_LOCALE;
    apply();
    window.dispatchEvent(new CustomEvent('gopainter:localechange'));
    await chrome.storage.local.set({ [LOCALE_KEY]: locale });
  }

  function t(zh, fallback = zh) { return locale === 'en' ? (en[zh] || fallback) : zh; }

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-locale-toggle]')) setLocale(locale === 'en' ? DEFAULT_LOCALE : 'en');
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LOCALE_KEY]) {
      locale = changes[LOCALE_KEY].newValue === 'en' ? 'en' : DEFAULT_LOCALE;
      apply();
      window.dispatchEvent(new CustomEvent('gopainter:localechange'));
    }
  });
  chrome.storage.local.get(LOCALE_KEY).then((stored) => {
    locale = stored[LOCALE_KEY] === 'en' ? 'en' : DEFAULT_LOCALE;
    apply();
  });

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) apply(node);
        else if (node.nodeType === Node.TEXT_NODE && node.parentElement) apply(node.parentElement);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  globalThis.GoPainterI18n = Object.freeze({ apply, setLocale, t, get locale() { return locale; } });
})();
