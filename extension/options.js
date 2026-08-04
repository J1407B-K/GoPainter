// options：规则导入和 AI 配置。YAML 解析用 js-yaml，规范化在 wasm 里（走 background）。

const msgEl = document.getElementById('msg');

function showMsg(text, isError = false) {
  msgEl.textContent = text;
  msgEl.className = isError ? 'error' : '';
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
      // js-yaml 支持多文档（--- 分隔），逐份解析，规范化交给 wasm
      const docs = [];
      jsyaml.loadAll(text, (d) => docs.push(d));
      const resp = await chrome.runtime.sendMessage({ type: 'normalizeRules', docsJSON: JSON.stringify(docs) });
      if (!resp.ok) throw new Error(resp.error);
      for (const rule of resp.rules) {
        byId.set(rule.id, rule); // 同 id 覆盖，便于更新规则
        added++;
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

// --- favicon 哈希库：自定义条目存 storage，查库时传给 wasm，覆盖内置 ---

async function loadCustomHashes() {
  const { customHashes = {} } = await chrome.storage.local.get('customHashes');
  return customHashes;
}

async function refreshHashList() {
  const hashes = await loadCustomHashes();
  const entries = Object.entries(hashes);
  document.getElementById('hash-stats').textContent = `自定义 ${entries.length} 条（内置 956 条）`;
  const list = document.getElementById('hash-list');
  list.innerHTML = '';
  for (const [h, name] of entries) {
    const row = document.createElement('div');
    row.className = 'hash-item';
    row.innerHTML = `<span class="h"></span><span class="n"></span><button class="del" title="删除">✕</button>`;
    row.querySelector('.h').textContent = h;
    row.querySelector('.n').textContent = name;
    row.querySelector('.del').addEventListener('click', async () => {
      const cur = await loadCustomHashes();
      delete cur[h];
      await chrome.storage.local.set({ customHashes: cur });
      refreshHashList();
    });
    list.appendChild(row);
  }
}

document.getElementById('hash-import').addEventListener('click', async () => {
  const text = document.getElementById('hash-input').value.trim();
  if (!text) return;
  const parsed = {};

  // 先试 JSON，不行再按行解析（哈希 名称）
  try {
    const obj = JSON.parse(text);
    for (const [h, name] of Object.entries(obj)) {
      if (/^-?\d+$/.test(h) && name) parsed[h] = String(name);
    }
  } catch {
    for (const line of text.split('\n')) {
      const m = line.trim().match(/^(-?\d+)\s+(.+)$/);
      if (m) parsed[m[1]] = m[2].trim();
    }
  }

  const n = Object.keys(parsed).length;
  if (!n) {
    showMsg('没解析出有效条目，格式：哈希 名称（每行一条）或 JSON', true);
    return;
  }
  const cur = await loadCustomHashes();
  Object.assign(cur, parsed);
  await chrome.storage.local.set({ customHashes: cur });
  document.getElementById('hash-input').value = '';
  await refreshHashList();
  showMsg(`导入 ${n} 条自定义哈希`);
});

document.getElementById('hash-clear').addEventListener('click', async () => {
  if (!confirm('确定清空自定义哈希？内置库不受影响。')) return;
  await chrome.storage.local.set({ customHashes: {} });
  refreshHashList();
  showMsg('自定义哈希已清空');
});

refreshHashList();

// --- 书签整理：勾选哪些就处理哪些，没勾的一律不动 ---

const bmPanel = document.getElementById('bm-panel');
const bmList = document.getElementById('bm-list');
const bmAll = document.getElementById('bm-all');
const bmCount = document.getElementById('bm-count');
const organizeBtn = document.getElementById('organize-btn');

document.getElementById('load-bm-btn').addEventListener('click', async () => {
  const tree = await chrome.bookmarks.getTree();
  // 按所在文件夹分组，路径拼成 "书签栏 / 开发 / 前端" 这种
  const groups = new Map();
  const walk = (nodes, path) => {
    for (const n of nodes) {
      if (n.url) {
        if (!/^https?:/.test(n.url)) continue;
        if (!groups.has(path)) groups.set(path, []);
        groups.get(path).push(n);
      } else if (n.children) {
        const name = n.title || (n.id === '1' ? '书签栏' : n.id === '2' ? '其他书签' : '');
        walk(n.children, path && name ? `${path} / ${name}` : name || path);
      }
    }
  };
  walk(tree[0].children, '');

  bmList.innerHTML = '';
  for (const [path, items] of groups) {
    const head = document.createElement('div');
    head.className = 'bm-group';
    head.textContent = path || '（根目录）';
    bmList.appendChild(head);
    for (const bm of items) {
      const row = document.createElement('label');
      row.className = 'bm-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = bm.id;
      const text = document.createElement('span');
      text.className = 'bm-text';
      text.textContent = bm.title || bm.url;
      text.title = bm.url;
      row.append(cb, text);
      bmList.appendChild(row);
    }
  }
  bmPanel.style.display = 'block';
  bmAll.checked = false;
  updateBmCount();
});

function checkedIds() {
  return [...bmList.querySelectorAll('input:checked')].map((c) => c.value);
}

function updateBmCount() {
  const n = checkedIds().length;
  bmCount.textContent = `已选 ${n} 个`;
  organizeBtn.disabled = n === 0;
}

bmList.addEventListener('change', updateBmCount);
bmAll.addEventListener('change', () => {
  bmList.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = bmAll.checked; });
  updateBmCount();
});

organizeBtn.addEventListener('click', async () => {
  const ids = checkedIds();
  if (!ids.length) return;
  const useAI = document.getElementById('bm-use-ai').checked;
  const out = document.getElementById('organize-result');
  organizeBtn.disabled = true;
  organizeBtn.textContent = '整理中…（选得多的话要等一会）';
  out.textContent = '';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'organizeBookmarks', ids, useAI });
    if (!resp.ok) throw new Error(resp.error);
    const r = resp.summary;
    const groups = Object.entries(r.groups)
      .map(([name, n]) => `${name}（${n}）`).join('、') || '无';
    const aiPart = r.aiMatched ? `，其中 AI 判断 ${r.aiMatched}` : '';
    out.textContent = `共扫描 ${r.total} 个书签：命中 ${r.matched}${aiPart}，已挪入分类文件夹 ${r.moved}，抓取失败 ${r.failed}，未识别跳过 ${r.total - r.matched - r.aiMatched - r.failed}。\n分类：${groups}`;
  } catch (err) {
    out.textContent = `出错：${err.message}`;
  } finally {
    organizeBtn.disabled = false;
    organizeBtn.textContent = '🗂 整理选中';
    updateBmCount();
  }
});

// --- AI 配置 ---

// 三个场景的提示词分开存，空着就用默认（默认从 background 拿，不在前端抄一份）
const PROMPT_KEYS = ['identify', 'rule', 'bookmark'];
let defaultPrompts = {};

async function loadAiConfig() {
  const keys = ['aiBaseURL', 'aiApiKey', 'aiModel', 'aiPromptIdentify', 'aiPromptRule', 'aiPromptBookmark'];
  const cfg = await chrome.storage.local.get(keys);
  document.getElementById('ai-base-url').value = cfg.aiBaseURL || '';
  document.getElementById('ai-api-key').value = cfg.aiApiKey || '';
  document.getElementById('ai-model').value = cfg.aiModel || '';
  document.getElementById('prompt-identify').value = cfg.aiPromptIdentify || '';
  document.getElementById('prompt-rule').value = cfg.aiPromptRule || '';
  document.getElementById('prompt-bookmark').value = cfg.aiPromptBookmark || '';

  const resp = await chrome.runtime.sendMessage({ type: 'getDefaultPrompts' });
  if (resp?.ok) {
    defaultPrompts = resp.prompts;
    for (const k of PROMPT_KEYS) {
      document.getElementById(`prompt-${k}`).placeholder = `默认提示词：\n${defaultPrompts[k]}`;
    }
  }
}

document.getElementById('save-ai').addEventListener('click', async () => {
  await chrome.storage.local.set({
    aiBaseURL: document.getElementById('ai-base-url').value.trim(),
    aiApiKey: document.getElementById('ai-api-key').value.trim(),
    aiModel: document.getElementById('ai-model').value.trim(),
    aiPromptIdentify: document.getElementById('prompt-identify').value.trim(),
    aiPromptRule: document.getElementById('prompt-rule').value.trim(),
    aiPromptBookmark: document.getElementById('prompt-bookmark').value.trim(),
  });
  showMsg('AI 配置已保存');
});

// 「恢复默认」就是清空自定义，运行时自动回退到默认提示词
document.querySelectorAll('[data-prompt-reset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById(`prompt-${btn.dataset.promptReset}`).value = '';
  });
});

// --- 工具 ---

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

refreshRuleList();
loadAiConfig();
