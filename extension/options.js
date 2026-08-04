// options：规则导入（原生格式 / nuclei 模板）和 AI 配置。

const msgEl = document.getElementById('msg');

function showMsg(text, isError = false) {
  msgEl.textContent = text;
  msgEl.className = isError ? 'error' : '';
}

// 把一份 YAML 文档转成规则数组。
// 支持原生格式（单条或数组）和 nuclei 模板（抽 http matchers 里能用的部分）。
function normalizeRules(doc, sourceName) {
  if (!doc || typeof doc !== 'object') return [];

  // nuclei 模板：有 id + info + http/requests 字段
  if (doc.id && doc.info && (doc.http || doc.requests)) {
    const blocks = doc.http || doc.requests || [];
    const matchers = [];
    let condition = 'or';
    for (const b of blocks) {
      for (const m of b.matchers || []) {
        const converted = convertNucleiMatcher(m);
        if (converted) matchers.push(converted);
      }
      if (b['matchers-condition']) condition = b['matchers-condition'];
    }
    if (matchers.length === 0) return [];
    return [{
      id: String(doc.id),
      name: doc.info.name || String(doc.id),
      'matchers-condition': condition,
      matchers,
    }];
  }

  // 原生格式：数组或单条
  const list = Array.isArray(doc) ? doc : [doc];
  return list
    .filter((r) => r && r.id && Array.isArray(r.matchers) && r.matchers.length > 0)
    .map((r) => ({
      id: String(r.id),
      name: r.name || String(r.id),
      'matchers-condition': r['matchers-condition'] === 'and' ? 'and' : 'or',
      matchers: r.matchers,
    }));
}

// nuclei matcher -> 原生 matcher；dsl 这类不支持的返回 null 跳过
function convertNucleiMatcher(m) {
  const part = ['body', 'title', 'url', 'header', 'raw'].includes(m.part) ? m.part : 'body';
  switch (m.type) {
    case 'word':
      return { type: 'word', part, words: m.words || [], condition: m.condition || 'or', negative: !!m.negative };
    case 'regex':
      return { type: 'regex', part, regex: m.regex || [], condition: m.condition || 'or', negative: !!m.negative };
    case 'status':
      return { type: 'status', status: m.status || [], negative: !!m.negative };
    default:
      return null; // dsl / binary / xpath 等暂不支持
  }
}

// --- 规则存取 ---

async function loadRules() {
  const { rules = [] } = await chrome.storage.local.get('rules');
  return rules;
}

async function refreshRuleList() {
  const rules = await loadRules();
  document.getElementById('rule-stats').textContent = `当前共 ${rules.length} 条规则`;
  const list = document.getElementById('rule-list');
  list.innerHTML = rules.length
    ? rules.map((r) => `<div class="rule-item"><span class="name">${escapeHtml(r.name)}</span><span class="id">${escapeHtml(r.id)}</span></div>`).join('')
    : '<div class="muted">（空）</div>';
}

document.getElementById('file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const rules = await loadRules();
  const byId = new Map(rules.map((r) => [r.id, r]));
  let added = 0, failed = [];

  for (const f of files) {
    try {
      const text = await f.text();
      // js-yaml 支持多文档（--- 分隔），逐份解析
      const docs = [];
      jsyaml.loadAll(text, (d) => docs.push(d));
      for (const doc of docs) {
        for (const rule of normalizeRules(doc, f.name)) {
          byId.set(rule.id, rule); // 同 id 覆盖，便于更新规则
          added++;
        }
      }
    } catch (err) {
      failed.push(`${f.name}: ${err.message}`);
    }
  }

  await chrome.storage.local.set({ rules: [...byId.values()] });
  await refreshRuleList();
  showMsg(
    `导入完成：新增/更新 ${added} 条规则` + (failed.length ? `；失败 ${failed.length} 个文件` : ''),
    failed.length > 0
  );
  if (failed.length) console.warn('导入失败:', failed);
  e.target.value = '';
});

document.getElementById('clear-rules').addEventListener('click', async () => {
  if (!confirm('确定清空所有规则？')) return;
  await chrome.storage.local.set({ rules: [] });
  await refreshRuleList();
  showMsg('规则已清空');
});

// --- AI 配置 ---

async function loadAiConfig() {
  const cfg = await chrome.storage.local.get(['aiBaseURL', 'aiApiKey', 'aiModel']);
  document.getElementById('ai-base-url').value = cfg.aiBaseURL || '';
  document.getElementById('ai-api-key').value = cfg.aiApiKey || '';
  document.getElementById('ai-model').value = cfg.aiModel || '';
}

document.getElementById('save-ai').addEventListener('click', async () => {
  await chrome.storage.local.set({
    aiBaseURL: document.getElementById('ai-base-url').value.trim(),
    aiApiKey: document.getElementById('ai-api-key').value.trim(),
    aiModel: document.getElementById('ai-model').value.trim(),
  });
  showMsg('AI 配置已保存');
});

// --- 工具 ---

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

refreshRuleList();
loadAiConfig();
