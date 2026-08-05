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
  document.getElementById('rule-stats').textContent = `当前共 ${rules.length} 条规则（点击查看详情）`;
  const list = document.getElementById('rule-list');
  list.innerHTML = rules.length
    ? rules.map((r) => `<div class="rule-item" data-id="${escapeHtml(r.id)}" title="点击查看该规则"><span class="name">${escapeHtml(r.name)}</span><span class="id">${escapeHtml(r.id)}</span></div>`).join('')
    : '<div class="muted">（空）</div>';
}

// --- 规则详情：点击列表项实时查看单条规则的完整 YAML ---

const ruleModal = document.getElementById('rule-modal');
const ruleModalTitle = document.getElementById('rule-modal-title');
const ruleModalBody = document.getElementById('rule-modal-body');
let currentRuleYaml = '';

function openRuleDetail(rule) {
  ruleModalTitle.textContent = `${rule.name}（${rule.id}）`;
  currentRuleYaml = jsyaml.dump(rule);
  ruleModalBody.textContent = currentRuleYaml;
  ruleModal.classList.add('open');
}

// 点击列表项时从 storage 重新读一次，保证看到的是最新规则
document.getElementById('rule-list').addEventListener('click', (e) => {
  const el = e.target.closest('.rule-item');
  if (!el) return;
  loadRules().then((rules) => {
    const rule = rules.find((r) => r.id === el.dataset.id);
    if (rule) openRuleDetail(rule);
  });
});

document.getElementById('rule-modal-close').addEventListener('click', () => ruleModal.classList.remove('open'));
ruleModal.addEventListener('click', (e) => {
  if (e.target === ruleModal) ruleModal.classList.remove('open'); // 点遮罩关闭
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ruleModal.classList.remove('open');
});

document.getElementById('rule-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(currentRuleYaml);
    showMsg('规则 YAML 已复制');
  } catch {
    showMsg('复制失败，请手动选择复制', true);
  }
});

document.getElementById('file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const rules = await loadRules();
  const byId = new Map(rules.map((r) => [r.id, r]));
  let added = 0, failed = [];

  for (const f of files) {
    try {
      // 防巨型文件把 wasm 堆干爆，5MB 对指纹规则来说已经很夸张了
      if (f.size > 5 * 1024 * 1024) {
        failed.push(`${f.name}: 文件超过 5MB，跳过了`);
        continue;
      }
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

// 规则导入（文件或内置库）共用的合并逻辑
async function importRules(rulesToAdd) {
  const rules = await loadRules();
  const byId = new Map(rules.map((r) => [r.id, r]));
  for (const rule of rulesToAdd) {
    byId.set(rule.id, rule); // 同 id 覆盖，便于更新规则
  }
  await chrome.storage.local.set({ rules: [...byId.values()] });
  await refreshRuleList();
  return rulesToAdd.length;
}

document.getElementById('import-builtin').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  try {
    const text = await (await fetch(chrome.runtime.getURL('rules/builtin.yaml'))).text();
    const docs = [];
    jsyaml.loadAll(text, (d) => docs.push(d));
    const resp = await chrome.runtime.sendMessage({ type: 'normalizeRules', docsJSON: JSON.stringify(docs) });
    if (!resp.ok) throw new Error(resp.error);
    const n = await importRules(resp.rules);
    showMsg(`内置规则库导入完成：${n} 条`);
  } catch (err) {
    showMsg(`内置规则导入失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
});

// --- 第三方规则源：用户浏览器实时拉取 + wasm 转换，数据不随扩展分发 ---
// 每个源的仓库链接在页面上标出，致敬社区作者

const sourceStatus = (text) => { document.getElementById('source-status').textContent = text; };

const RULE_SOURCES = {
  async wappalyzer() {
    // 指纹按字母拆成 27 个文件
    const base = 'https://raw.githubusercontent.com/enthec/webappanalyzer/main/src/technologies';
    const files = ['_', ...'abcdefghijklmnopqrstuvwxyz'];
    const techs = {};
    let done = 0;
    await Promise.all(files.map(async (f) => {
      const resp = await fetch(`${base}/${f}.json`);
      if (!resp.ok) throw new Error(`拉取 ${f}.json 失败: HTTP ${resp.status}`);
      Object.assign(techs, await resp.json());
      sourceStatus(`Wappalyzer：拉取中… ${++done}/${files.length}`);
    }));
    sourceStatus('Wappalyzer：转换中…');
    // 一次性塞 7500+ 条进 wasm 会把 TinyGo 的堆搞崩，分批转
    const entries = Object.entries(techs);
    const CHUNK = 500;
    const rules = [];
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = Object.fromEntries(entries.slice(i, i + CHUNK));
      const resp = await chrome.runtime.sendMessage({ type: 'convertWappalyzer', techJSON: JSON.stringify(chunk) });
      if (!resp.ok) throw new Error(resp.error);
      rules.push(...resp.rules);
      sourceStatus(`Wappalyzer：转换中… ${Math.min(i + CHUNK, entries.length)}/${entries.length}`);
    }
    return rules;
  },

  async ehole() {
    const resp = await fetch('https://raw.githubusercontent.com/EdgeSecurityTeam/EHole/main/finger.json');
    if (!resp.ok) throw new Error(`拉取 finger.json 失败: HTTP ${resp.status}`);
    sourceStatus('EHole：转换中…');
    const r = await chrome.runtime.sendMessage({ type: 'convertEHole', fingerJSON: await resp.text() });
    if (!r.ok) throw new Error(r.error);
    return r.rules;
  },

  async nuclei() {
    // GitHub API 列目录（未登录限 60 次/小时，只占 1 次），文件走 raw 不限
    const listResp = await fetch('https://api.github.com/repos/projectdiscovery/nuclei-templates/contents/http/technologies');
    if (!listResp.ok) throw new Error(`列目录失败: HTTP ${listResp.status}（可能触发了 GitHub 限流，过会儿再试）`);
    const entries = await listResp.json();
    const files = entries.filter((e) => e.type === 'file' && e.name.endsWith('.yaml'));
    const docs = [];
    let done = 0;
    // 8 路并发拉 yaml，解析成文档
    const queue = [...files];
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (queue.length) {
        const f = queue.shift();
        try {
          const text = await (await fetch(f.download_url)).text();
          jsyaml.loadAll(text, (d) => docs.push(d));
        } catch { /* 单个文件坏了就跳过 */ }
        sourceStatus(`nuclei-templates：拉取中… ${++done}/${files.length}`);
      }
    }));
    sourceStatus('nuclei-templates：转换中…');
    const resp = await chrome.runtime.sendMessage({ type: 'normalizeRules', docsJSON: JSON.stringify(docs) });
    if (!resp.ok) throw new Error(resp.error);
    return resp.rules;
  },
};

document.querySelectorAll('[data-source]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const source = btn.dataset.source;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '拉取中…';
    try {
      const rules = await RULE_SOURCES[source]();
      const n = await importRules(rules);
      sourceStatus('');
      showMsg(`导入完成：${n} 条规则（同 id 已覆盖）`);
    } catch (err) {
      sourceStatus('');
      showMsg(`拉取失败：${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
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

// --- 外接脚本 ---

async function loadScripts() {
  const { userScripts = [] } = await chrome.storage.local.get('userScripts');
  return userScripts;
}

async function refreshScriptList() {
  const scripts = await loadScripts();
  const list = document.getElementById('script-list');
  list.innerHTML = scripts.length ? '' : '<div class="muted">（空）</div>';
  for (const s of scripts) {
    const row = document.createElement('div');
    row.className = 'script-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s.enabled;
    cb.title = '启用/停用';
    cb.addEventListener('change', async () => {
      const cur = await loadScripts();
      const target = cur.find((x) => x.id === s.id);
      if (target) target.enabled = cb.checked;
      await chrome.storage.local.set({ userScripts: cur });
    });
    const name = document.createElement('span');
    name.textContent = s.name;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      const cur = (await loadScripts()).filter((x) => x.id !== s.id);
      await chrome.storage.local.set({ userScripts: cur });
      refreshScriptList();
    });
    row.append(cb, name, del);
    list.appendChild(row);
  }
}

document.getElementById('script-add').addEventListener('click', async () => {
  const name = document.getElementById('script-name').value.trim();
  const code = document.getElementById('script-code').value.trim();
  if (!name || !code) {
    showMsg('脚本名和代码都要填', true);
    return;
  }
  // 先语法检查一下，别存个跑不起来的
  try {
    new Function('features', 'hits', code);
  } catch (e) {
    showMsg(`脚本语法错误：${e.message}`, true);
    return;
  }
  const scripts = await loadScripts();
  scripts.push({ id: `s-${Date.now()}`, name, code, enabled: true });
  await chrome.storage.local.set({ userScripts: scripts });
  document.getElementById('script-name').value = '';
  document.getElementById('script-code').value = '';
  await refreshScriptList();
  showMsg(`脚本「${name}」已添加并启用`);
});

refreshScriptList();

// --- 站点爬取 ---

let crawlTimer = null;

async function pollCrawl() {
  const resp = await chrome.runtime.sendMessage({ type: 'crawlStatus' });
  if (!resp?.ok) return;
  // 爬取中禁用「开始爬取」，防止开第二个任务（后台也只会报错）
  document.getElementById('crawl-start').disabled = !!resp.running;
  const statusEl = document.getElementById('crawl-status');
  if (resp.running) {
    statusEl.textContent = `爬取中：已扫 ${resp.visited} 页，队列 ${resp.queued}，失败 ${resp.failed?.length || 0}，发现链接去重中…`;
  } else if (resp.interrupted) {
    statusEl.textContent = `任务被系统中断（service worker 被回收）：已保留 ${resp.results.length} 页结果，失败 ${resp.failed?.length || 0} 页`;
  } else if (resp.results.length) {
    statusEl.textContent = `结束：成功 ${resp.results.length} 页，失败 ${resp.failed?.length || 0} 页`;
  } else if (resp.failed?.length) {
    statusEl.textContent = `结束：没有成功页面，失败 ${resp.failed.length} 页`;
  } else {
    statusEl.textContent = '';
  }
  const list = document.getElementById('crawl-results');
  list.innerHTML = '';
  for (const r of resp.results) {
    const row = document.createElement('div');
    row.className = 'crawl-item';
    const names = (r.hits || []).map((h) => h.name).join('、');
    row.innerHTML = `<div class="t"></div><div class="u"></div><div class="hits"></div>`;
    row.querySelector('.t').textContent = r.title;
    row.querySelector('.u').textContent = `${r.url}（HTTP ${r.status}）`;
    row.querySelector('.hits').textContent = names ? `🎯 ${names}` : '— 未识别';
    list.appendChild(row);
  }
  for (const r of (resp.failed || []).slice(-20)) {
    const row = document.createElement('div');
    row.className = 'crawl-item failed';
    row.innerHTML = `<div class="t">抓取失败</div><div class="u"></div><div class="hits"></div>`;
    row.querySelector('.u').textContent = r.url;
    row.querySelector('.hits').textContent = r.error || '未知错误';
    list.appendChild(row);
  }
  if (!resp.running && crawlTimer) {
    clearInterval(crawlTimer);
    crawlTimer = null;
  }
}

// 打开设置页时拉一次，把上次爬的结果（或进行中的进度）恢复出来
pollCrawl();

// 页数上限记住上次填的
chrome.storage.local.get('crawlMaxPages').then((d) => {
  if (d.crawlMaxPages != null) document.getElementById('crawl-max').value = d.crawlMaxPages;
});

document.getElementById('crawl-start').addEventListener('click', async () => {
  const url = document.getElementById('crawl-url').value.trim();
  if (!/^https?:/.test(url)) {
    showMsg('起始 URL 得是 http/https', true);
    return;
  }
  const raw = document.getElementById('crawl-max').value.trim();
  const maxPages = raw === '' ? null : parseInt(raw, 10);
  if (raw !== '' && (!Number.isInteger(maxPages) || maxPages <= 0)) {
    showMsg('最大页数要么是空，要么是正整数', true);
    return;
  }
  await chrome.storage.local.set({ crawlMaxPages: raw }); // popup「爬取本站」也用这个值
  const resp = await chrome.runtime.sendMessage({ type: 'crawlStart', url, maxPages });
  if (!resp.ok) {
    showMsg(resp.error, true);
    return;
  }
  if (!crawlTimer) crawlTimer = setInterval(pollCrawl, 1000);
  pollCrawl();
});

document.getElementById('crawl-stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'crawlStop' });
  pollCrawl();
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
