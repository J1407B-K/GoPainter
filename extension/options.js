// options：规则导入和 AI 配置。YAML 解析用 js-yaml，规范化在 wasm 里（走 background）。

const msgEl = document.getElementById('msg');

function showMsg(text, isError = false) {
  msgEl.textContent = text;
  msgEl.className = isError ? 'error' : '';
}

// --- 规则存取 ---

let ruleSetState = null;
const RULE_RENDER_LIMIT = 300;
const LIST_RENDER_LIMIT = 300;

function scheduleIdle(task) {
  const run = () => Promise.resolve(task()).catch((error) => console.warn('延迟加载失败:', error));
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1200 });
  else setTimeout(run, 0);
}

async function loadRuleSetState(force = false) {
  if (!force && ruleSetState) return ruleSetState;
  const raw = await chrome.storage.local.get(['rules', 'ruleSets', 'activeRuleSetId', 'enabledRuleSetIds']);
  const state = GoPainterUtils.normalizeRuleSets(raw.ruleSets, raw.activeRuleSetId, raw.rules, raw.enabledRuleSetIds);
  // 只在结构缺失/激活集失效时修复，避免每次操作 stringify 整个大型规则库。
  if (!Array.isArray(raw.ruleSets) || raw.activeRuleSetId !== state.activeRuleSetId || !Array.isArray(raw.enabledRuleSetIds) || !Array.isArray(raw.rules)) {
    await chrome.storage.local.set(state);
  }
  ruleSetState = state;
  return state;
}

async function loadRules() {
  const state = await loadRuleSetState();
  return state.ruleSets.find((set) => set.id === state.activeRuleSetId)?.rules || [];
}

async function saveActiveRules(rules) {
  const state = await loadRuleSetState();
  ruleSetState = GoPainterUtils.replaceActiveRuleSetRules(state, rules);
  await chrome.storage.local.set(ruleSetState);
}

function renderRuleSetControls(state) {
  const select = document.getElementById('ruleset-select');
  select.innerHTML = state.ruleSets.map((set) =>
    `<option value="${escapeHtml(set.id)}">${escapeHtml(set.name)}（${set.rules.length} 条）</option>`
  ).join('');
  select.value = state.activeRuleSetId;
  document.getElementById('ruleset-delete').disabled = state.ruleSets.length <= 1;
  const enabled = new Set(state.enabledRuleSetIds);
  document.getElementById('ruleset-enabled-list').innerHTML = state.ruleSets.map((set) => `
    <label class="ruleset-enabled-item">
      <input type="checkbox" data-ruleset-id="${escapeHtml(set.id)}" ${enabled.has(set.id) ? 'checked' : ''}>
      <span>${escapeHtml(set.name)}</span><small>${set.rules.length} 条</small>
    </label>`).join('');
}

async function refreshRuleList() {
  const state = await loadRuleSetState();
  const active = state.ruleSets.find((set) => set.id === state.activeRuleSetId);
  const rules = active?.rules || [];
  renderRuleSetControls(state);
  const filtered = GoPainterUtils.filterRules(rules, document.getElementById('rule-filter').value, RULE_RENDER_LIMIT);
  const suffix = filtered.total > filtered.items.length ? `，显示前 ${filtered.items.length} 条` : '';
  document.getElementById('rule-stats').textContent = `「${active.name}」共 ${rules.length} 条规则，匹配 ${filtered.total} 条${suffix}`;
  const list = document.getElementById('rule-list');
  list.innerHTML = filtered.items.length
    ? filtered.items.map((r) => `<div class="rule-item" data-id="${escapeHtml(r.id)}" title="点击查看该规则"><span class="name">${escapeHtml(r.name)}</span><span class="id">${escapeHtml(r.id)}</span></div>`).join('')
    : '<div class="muted">（空）</div>';
}

let ruleFilterFrame = 0;
document.getElementById('rule-filter').addEventListener('input', () => {
  cancelAnimationFrame(ruleFilterFrame);
  ruleFilterFrame = requestAnimationFrame(refreshRuleList);
});

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

document.getElementById('rule-list').addEventListener('click', (e) => {
  const el = e.target.closest('.rule-item');
  if (!el) return;
  loadRuleSetState().then((state) => {
    const activeRules = state.ruleSets.find((set) => set.id === state.activeRuleSetId)?.rules || [];
    const rule = activeRules.find((r) => r.id === el.dataset.id);
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

async function normalizeImportedDocs(docs, onProgress) {
  const rules = [];
  const chunkSize = 100;
  for (let offset = 0; offset < docs.length; offset += chunkSize) {
    const chunk = docs.slice(offset, offset + chunkSize);
    const resp = await chrome.runtime.sendMessage({ type: 'normalizeRules', docsJSON: JSON.stringify(chunk) });
    if (!resp?.ok) throw new Error(resp?.error || '规则转换失败');
    rules.push(...(resp.rules || []));
    onProgress?.(Math.min(offset + chunkSize, docs.length), docs.length);
  }
  return rules;
}

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
      const normalized = await normalizeImportedDocs(docs);
      for (const rule of normalized) {
        byId.set(rule.id, rule); // 同 id 覆盖，便于更新规则
        added++;
      }
    } catch (err) {
      failed.push(`${f.name}: ${err.message}`);
    }
  }

  await saveActiveRules([...byId.values()]);
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
  await saveActiveRules(GoPainterUtils.mergeRules(rules, rulesToAdd));
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
    const rules = await normalizeImportedDocs(docs);
    const n = await importRules(rules);
    showMsg(`内置规则库导入完成：${n} 条`);
  } catch (err) {
    showMsg(`内置规则导入失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
});

// --- 第三方规则源：用户浏览器实时拉取 + wasm 转换，数据不随扩展分发 ---
// 每个源的仓库链接在页面上标出，致敬社区作者

const sourceStatus = (text, isError = false) => {
  const el = document.getElementById('source-status');
  el.textContent = text;
  el.className = isError ? 'error' : 'muted';
};
const SOURCE_LABELS = {
  wappalyzer: 'Wappalyzer',
  ehole: 'EHole',
  nuclei: 'nuclei-templates',
};

function mergeConvertedRules(rules) {
  return GoPainterUtils.mergeConvertedRules(rules);
}

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
    sourceStatus('EHole：拉取 finger.json…');
    const urls = [
      'https://raw.githubusercontent.com/EdgeSecurityTeam/EHole/main/finger.json',
      'https://github.com/EdgeSecurityTeam/EHole/raw/main/finger.json',
    ];
    let text = '';
    let lastErr = '';
    for (const url of urls) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        text = await resp.text();
        break;
      } catch (err) {
        lastErr = err.message || String(err);
      }
    }
    if (!text) throw new Error(`拉取 finger.json 失败：${lastErr}`);
    sourceStatus('EHole：转换中…');
    let fingers;
    try {
      fingers = JSON.parse(text);
      if (!Array.isArray(fingers)) fingers = fingers?.fingerprint;
      if (!Array.isArray(fingers)) throw new Error('finger.json 不是数组格式');
    } catch (err) {
      throw new Error(`finger.json 解析失败：${err.message}`);
    }

    // 跟 Wappalyzer 一样分批转，避免一次性大 JSON 触发 TinyGo wasm 栈/堆问题。
    const CHUNK = 100;
    const rules = [];
    for (let i = 0; i < fingers.length; i += CHUNK) {
      const chunk = fingers.slice(i, i + CHUNK);
      const r = await chrome.runtime.sendMessage({ type: 'convertEHole', fingerJSON: JSON.stringify(chunk) });
      if (!r?.ok) throw new Error(r?.error || '后台转换无响应');
      rules.push(...(r.rules || []));
      sourceStatus(`EHole：转换中… ${Math.min(i + CHUNK, fingers.length)}/${fingers.length}`);
    }
    const merged = mergeConvertedRules(rules);
    if (!merged.length) throw new Error('finger.json 已拉取，但没有转换出有效规则');
    return merged;
  },

  async nuclei() {
    // GitHub API 列目录（未登录限 60 次/小时，只占 1 次），文件走 raw 不限
    const listResp = await fetch('https://api.github.com/repos/projectdiscovery/nuclei-templates/contents/http/technologies');
    if (!listResp.ok) throw new Error(`列目录失败: HTTP ${listResp.status}（可能触发了 GitHub 限流，过会儿再试）`);
    const entries = await listResp.json();
    const files = entries.filter((e) => e.type === 'file' && /\.ya?ml$/i.test(e.name));
    if (!files.length) throw new Error('目录中没有找到可导入的 YAML 模板');
    const docs = [];
    let done = 0;
    // 8 路并发拉 yaml，解析成文档
    const queue = [...files];
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (queue.length) {
        const f = queue.shift();
        try {
          const response = await fetch(f.download_url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = await response.text();
          jsyaml.loadAll(text, (d) => docs.push(d));
        } catch { /* 单个文件坏了就跳过 */ }
        sourceStatus(`nuclei-templates：拉取中… ${++done}/${files.length}`);
      }
    }));
    if (!docs.length) throw new Error('模板文件下载完成，但没有解析出 YAML 文档');
    sourceStatus('nuclei-templates：转换中…');
    return normalizeImportedDocs(docs, (converted, total) => {
      sourceStatus(`nuclei-templates：转换中… ${converted}/${total}`);
    });
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
      sourceStatus(`${SOURCE_LABELS[source] || source}：导入完成，${n} 条规则（同 id 已覆盖）`);
      showMsg(`导入完成：${n} 条规则（同 id 已覆盖）`);
    } catch (err) {
      sourceStatus(`${SOURCE_LABELS[source] || source}：失败：${err.message}`, true);
      showMsg(`拉取失败：${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
});

document.getElementById('clear-rules').addEventListener('click', async () => {
  if (!confirm('确定清空当前编辑集中的所有规则？')) return;
  await saveActiveRules([]);
  await refreshRuleList();
  showMsg('当前编辑集已清空');
});

document.getElementById('ruleset-select').addEventListener('change', async (e) => {
  const state = await loadRuleSetState();
  const next = state.ruleSets.find((set) => set.id === e.target.value);
  if (!next || next.id === state.activeRuleSetId) return;
  const response = await chrome.runtime.sendMessage({ type: 'setActiveRuleSet', ruleSetId: next.id });
  if (!response?.ok) return showMsg(response?.error || '切换编辑集失败', true);
  ruleSetState = { ...state, activeRuleSetId: next.id };
  await refreshRuleList();
  showMsg(`当前编辑集已切换到「${next.name}」`);
});

async function saveEnabledRuleSets(enabledRuleSetIds, message) {
  const state = await loadRuleSetState();
  const response = await chrome.runtime.sendMessage({ type: 'setEnabledRuleSets', enabledRuleSetIds });
  if (!response?.ok) throw new Error(response?.error || '更新启用规则集失败');
  ruleSetState = { ...state, enabledRuleSetIds: response.enabledRuleSetIds };
  renderRuleSetControls(ruleSetState);
  showMsg(message || `已启用 ${response.enabledRuleSetIds.length} 个规则集，共 ${response.ruleCount} 条匹配规则`);
}

document.getElementById('ruleset-enabled-list').addEventListener('change', async (e) => {
  const checkbox = e.target.closest('input[data-ruleset-id]');
  if (!checkbox) return;
  const state = await loadRuleSetState();
  const enabled = new Set(state.enabledRuleSetIds);
  if (checkbox.checked) enabled.add(checkbox.dataset.rulesetId);
  else enabled.delete(checkbox.dataset.rulesetId);
  checkbox.disabled = true;
  try {
    await saveEnabledRuleSets([...enabled]);
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    showMsg(error.message, true);
  } finally {
    checkbox.disabled = false;
  }
});

document.getElementById('ruleset-enable-all').addEventListener('click', async () => {
  const state = await loadRuleSetState();
  const button = document.getElementById('ruleset-enable-all');
  button.disabled = true;
  const label = button.textContent;
  button.textContent = '启用中…';
  try {
    await saveEnabledRuleSets(state.ruleSets.map((set) => set.id), '已启用全部规则集');
  } catch (error) {
    showMsg(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

document.getElementById('ruleset-enable-current').addEventListener('click', async () => {
  const state = await loadRuleSetState();
  const button = document.getElementById('ruleset-enable-current');
  button.disabled = true;
  const label = button.textContent;
  button.textContent = '切换中…';
  try {
    await saveEnabledRuleSets([state.activeRuleSetId], '已仅启用当前编辑集');
  } catch (error) {
    showMsg(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

document.getElementById('ruleset-create').addEventListener('click', async () => {
  const input = document.getElementById('ruleset-name');
  const name = input.value.trim();
  if (!name) return showMsg('请填写规则集名称', true);
  const state = await loadRuleSetState();
  if (state.ruleSets.some((set) => set.name === name)) return showMsg('已有同名规则集', true);
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'ruleset';
  let id = base, suffix = 2;
  while (state.ruleSets.some((set) => set.id === id)) id = `${base}-${suffix++}`;
  const ruleSets = [...state.ruleSets, { id, name, rules: [] }];
  ruleSetState = { ...state, ruleSets, activeRuleSetId: id };
  await chrome.storage.local.set({ ruleSets, activeRuleSetId: id });
  input.value = '';
  await refreshRuleList();
  showMsg(`已新建并切换到「${name}」`);
});

document.getElementById('ruleset-delete').addEventListener('click', async () => {
  const state = await loadRuleSetState();
  const active = state.ruleSets.find((set) => set.id === state.activeRuleSetId);
  if (state.ruleSets.length <= 1) return showMsg('至少保留一个规则集', true);
  if (!confirm(`删除规则集「${active.name}」及其中 ${active.rules.length} 条规则？`)) return;
  const ruleSets = state.ruleSets.filter((set) => set.id !== active.id);
  const next = ruleSets[0];
  const enabledRuleSetIds = state.enabledRuleSetIds.filter((id) => id !== active.id);
  ruleSetState = GoPainterUtils.normalizeRuleSets(ruleSets, next.id, [], enabledRuleSetIds);
  await chrome.storage.local.set(ruleSetState);
  await refreshRuleList();
  showMsg(`已删除「${active.name}」，切换到「${next.name}」`);
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
  for (const [h, name] of entries.slice(0, LIST_RENDER_LIMIT)) {
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
  if (entries.length > LIST_RENDER_LIMIT) list.insertAdjacentHTML('beforeend', `<div class="muted">仅显示前 ${LIST_RENDER_LIMIT} 条</div>`);
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

scheduleIdle(refreshHashList);

// --- 扫描历史与报告 ---

const SCAN_HISTORY_KEY = 'scanHistory';
const DEFAULT_SCAN_HISTORY_LIMIT = 300;

async function loadScanHistory() {
  const { [SCAN_HISTORY_KEY]: history = [] } = await chrome.storage.local.get(SCAN_HISTORY_KEY);
  return Array.isArray(history) ? history : [];
}

function downloadReport(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatHistoryTime(at) {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '未知时间' : date.toLocaleString();
}

async function refreshScanHistory() {
  const history = await loadScanHistory();
  const { scanHistoryLimit = DEFAULT_SCAN_HISTORY_LIMIT } = await chrome.storage.local.get({ scanHistoryLimit: DEFAULT_SCAN_HISTORY_LIMIT });
  const limit = GoPainterUtils.normalizeHistoryLimit(scanHistoryLimit, DEFAULT_SCAN_HISTORY_LIMIT);
  document.getElementById('history-limit').value = limit;
  document.getElementById('history-limit-value').textContent = `${limit} 条`;
  document.getElementById('history-stats').textContent = `已保存 ${history.length} / ${limit} 条，最新记录在前`;
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  if (!history.length) {
    list.innerHTML = '<div class="muted" style="padding: 10px;">尚无扫描记录</div>';
    return;
  }
  for (const item of history.slice(0, LIST_RENDER_LIMIT)) {
    const row = document.createElement('div');
    row.className = 'history-item';
    const top = document.createElement('div');
    top.className = 'top';
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatHistoryTime(item.at);
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.title || item.url;
    top.append(time, title);
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = `${item.source === 'crawl' ? '爬取' : '页面'} · ${item.url}（HTTP ${item.status || '—'}）`;
    const hits = document.createElement('div');
    hits.className = 'hits';
    const names = (item.hits || []).map((hit) => hit.name || hit.id).filter(Boolean);
    hits.textContent = names.length ? `🎯 ${names.join('、')}` : '— 未识别';
    row.append(top, url, hits);
    list.appendChild(row);
  }
  if (history.length > LIST_RENDER_LIMIT) list.insertAdjacentHTML('beforeend', `<div class="muted" style="padding: 10px;">仅显示最新 ${LIST_RENDER_LIMIT} 条；导出仍包含全部记录</div>`);
}

document.getElementById('history-limit').addEventListener('input', (event) => {
  document.getElementById('history-limit-value').textContent = `${event.target.value} 条`;
});

document.getElementById('history-limit-save').addEventListener('click', async () => {
  const limit = Number(document.getElementById('history-limit').value);
  const resp = await chrome.runtime.sendMessage({ type: 'setScanHistoryLimit', limit });
  if (!resp?.ok) {
    showMsg(resp?.error || '保存扫描历史上限失败', true);
    return;
  }
  await refreshScanHistory();
  showMsg(`扫描历史上限已设为 ${resp.limit} 条`);
});

document.getElementById('history-export-json').addEventListener('click', async () => {
  const history = await loadScanHistory();
  downloadReport('gopainter-scan-report.json', JSON.stringify(GoPainterUtils.scanHistoryReport(history), null, 2), 'application/json');
  showMsg(`已导出 ${history.length} 条扫描记录（JSON）`);
});

document.getElementById('history-export-csv').addEventListener('click', async () => {
  const history = await loadScanHistory();
  // UTF-8 BOM 让 Excel 直接正确识别中文。
  downloadReport('gopainter-scan-history.csv', `\uFEFF${GoPainterUtils.scanHistoryCsv(history)}`, 'text/csv;charset=utf-8');
  showMsg(`已导出 ${history.length} 条扫描记录（CSV）`);
});

document.getElementById('history-clear').addEventListener('click', async () => {
  if (!confirm('确定清空全部扫描历史？此操作无法撤销。')) return;
  const resp = await chrome.runtime.sendMessage({ type: 'clearScanHistory' });
  if (!resp?.ok) {
    showMsg(resp?.error || '清空扫描历史失败', true);
    return;
  }
  await refreshScanHistory();
  showMsg('扫描历史已清空');
});

scheduleIdle(refreshScanHistory);

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

scheduleIdle(refreshScriptList);

// --- 站点爬取 ---

let crawlTimer = null;
let crawlRenderSignature = '';

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
  const signature = GoPainterUtils.crawlRenderSignature(resp);
  if (signature !== crawlRenderSignature) {
    crawlRenderSignature = signature;
    const list = document.getElementById('crawl-results');
    list.innerHTML = '';
    for (const r of resp.results.slice(-LIST_RENDER_LIMIT)) {
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
  }
  if (!resp.running && crawlTimer) {
    clearInterval(crawlTimer);
    crawlTimer = null;
  }
}

// 打开设置页时拉一次，把上次爬的结果（或进行中的进度）恢复出来
scheduleIdle(pollCrawl);

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

// 几个场景的提示词分开存，空着就用默认（默认从 background 拿，不在前端抄一份）
const PROMPT_KEYS = ['identify', 'rule', 'optimize', 'bookmark'];
let defaultPrompts = {};

async function loadAiConfig() {
  const keys = ['aiBaseURL', 'aiApiKey', 'aiModel', 'agentProtocol', 'agentToolVerifiedAt', 'aiPromptIdentify', 'aiPromptRule', 'aiPromptOptimize', 'aiPromptBookmark'];
  const cfg = await chrome.storage.local.get(keys);
  document.getElementById('ai-base-url').value = cfg.aiBaseURL || '';
  document.getElementById('ai-api-key').value = cfg.aiApiKey || '';
  document.getElementById('ai-model').value = cfg.aiModel || '';
  document.getElementById('agent-protocol').value = cfg.agentProtocol || 'openai-chat';
  if (cfg.agentToolVerifiedAt) document.getElementById('agent-test-status').textContent = `上次验证成功：${new Date(cfg.agentToolVerifiedAt).toLocaleString()}`;
  document.getElementById('prompt-identify').value = cfg.aiPromptIdentify || '';
  document.getElementById('prompt-rule').value = cfg.aiPromptRule || '';
  document.getElementById('prompt-optimize').value = cfg.aiPromptOptimize || '';
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
    agentProtocol: document.getElementById('agent-protocol').value,
    aiPromptIdentify: document.getElementById('prompt-identify').value.trim(),
    aiPromptRule: document.getElementById('prompt-rule').value.trim(),
    aiPromptOptimize: document.getElementById('prompt-optimize').value.trim(),
    aiPromptBookmark: document.getElementById('prompt-bookmark').value.trim(),
  });
  showMsg('AI 配置已保存');
});

document.getElementById('test-agent-tools').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  const status = document.getElementById('agent-test-status');
  button.disabled = true;
  status.className = 'muted';
  status.textContent = '测试中：将执行 ping 工具调用并回填结果…';
  try {
    const config = {
      baseURL: document.getElementById('ai-base-url').value.trim(),
      apiKey: document.getElementById('ai-api-key').value.trim(),
      model: document.getElementById('ai-model').value.trim(),
      protocol: document.getElementById('agent-protocol').value,
    };
    const response = await chrome.runtime.sendMessage({ type: 'testAgentTools', config });
    if (!response?.ok) throw new Error(response?.error || '测试未完成');
    const verifiedAt = new Date().toISOString();
    await chrome.storage.local.set({ agentToolVerifiedAt: verifiedAt, agentProtocol: config.protocol });
    status.className = 'muted';
    status.textContent = `验证成功：${response.result.protocol} → ${response.result.tool} → ${response.result.result.value}`;
  } catch (error) {
    status.textContent = `验证失败：${error.message}`;
    status.className = 'error';
  } finally {
    button.disabled = false;
  }
});

// 「恢复默认」就是清空自定义，运行时自动回退到默认提示词
document.querySelectorAll('[data-prompt-reset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById(`prompt-${btn.dataset.promptReset}`).value = '';
  });
});

// --- 置信度 ---

async function loadConfConfig() {
  const cfg = await chrome.storage.local.get(['showConfidence', 'confThreshold']);
  document.getElementById('conf-enabled').checked = !!cfg.showConfidence;
  document.getElementById('conf-threshold').value = cfg.confThreshold || '';
}

document.getElementById('conf-save').addEventListener('click', async () => {
  const raw = document.getElementById('conf-threshold').value.trim();
  const threshold = raw === '' ? 0 : parseInt(raw, 10);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
    showMsg('置信度阈值得是 0-100 的整数', true);
    return;
  }
  await chrome.storage.local.set({
    showConfidence: document.getElementById('conf-enabled').checked,
    confThreshold: threshold,
  });
  showMsg('置信度设置已保存');
});

// --- 工具 ---

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Keep the compact settings navigation anchored to the section in view.
function initSettingsNav() {
  const links = [...document.querySelectorAll('.settings-nav a[href^="#"]')];
  const sections = links.map((link) => document.querySelector(link.hash)).filter(Boolean);
  if (!sections.length) return;
  let scheduled = false;
  const update = () => {
    scheduled = false;
    let current = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= 130) current = section;
    }
    for (const link of links) link.classList.toggle('active', link.hash === `#${current.id}`);
  };
  document.addEventListener('scroll', () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(update);
  }, { passive: true });
  update();
}

initSettingsNav();
refreshRuleList();
scheduleIdle(loadAiConfig);
scheduleIdle(loadConfConfig);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.rules || changes.ruleSets || changes.activeRuleSetId || changes.enabledRuleSetIds) ruleSetState = null;
});
