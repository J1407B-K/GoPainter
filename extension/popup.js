// popup：展示当前 tab 的命中结果和证据，附 AI 识别按钮。

const statusEl = document.getElementById('status');
const hitsEl = document.getElementById('hits');
const aiBtn = document.getElementById('ai-btn');
const aiResult = document.getElementById('ai-result');
const aiCandidates = document.getElementById('ai-candidates');
const aiRaw = document.getElementById('ai-raw');
const aiMerge = document.getElementById('ai-merge');
const ruleArea = document.getElementById('rule-area');
const ruleModeLabel = document.getElementById('rule-mode-label');
const ruleNameInput = document.getElementById('rule-name-input');
const ruleYaml = document.getElementById('rule-yaml');
const ruleGenerate = document.getElementById('rule-generate');
const ruleSave = document.getElementById('rule-save');
const ruleDiscard = document.getElementById('rule-discard');
const pageInfo = document.getElementById('page-info');
const ruleSetQuick = document.getElementById('ruleset-quick');

let currentTabId = null;
let currentTabUrl = '';
let currentData = null;
// 置信度开关：设置页开的，开了才显示数值/排序/过滤
let confCfg = { showConfidence: false, confThreshold: 0 };
// 规则库快照：判断「已有规则」用；AI 合并的命中（source:'ai'）仅本次 popup 会话有效
let rulesCache = [];
let aiTechs = [];
let aiMergedHits = [];
let ruleMode = null;
let optimizeRuleId = null;

async function loadRuleSetState() {
  const raw = await chrome.storage.local.get(['rules', 'ruleSets', 'activeRuleSetId']);
  const state = GoPainterUtils.normalizeRuleSets(raw.ruleSets, raw.activeRuleSetId, raw.rules);
  if (!Array.isArray(raw.ruleSets) || raw.activeRuleSetId !== state.activeRuleSetId
      || JSON.stringify(raw.rules || []) !== JSON.stringify(state.rules)) {
    await chrome.storage.local.set(state);
  }
  ruleSetQuick.innerHTML = state.ruleSets.map((set) => {
    const option = document.createElement('option');
    option.value = set.id;
    option.textContent = `${set.name}（${set.rules.length}）`;
    return option.outerHTML;
  }).join('');
  ruleSetQuick.value = state.activeRuleSetId;
  return state;
}

ruleSetQuick.addEventListener('change', async () => {
  const state = await loadRuleSetState();
  const next = state.ruleSets.find((set) => set.id === ruleSetQuick.value);
  if (!next || next.id === state.activeRuleSetId) return;
  await chrome.storage.local.set({ ...state, activeRuleSetId: next.id, rules: next.rules });
  rulesCache = next.rules;
});

function confidenceValue(hit) {
  return GoPainterUtils.confidenceValue(hit);
}

function setBusy(el, busy, busyLabel) {
  el.classList.toggle('busy', busy);
  const label = el.querySelector('.ac-label');
  if (!label) {
    if (busy) {
      el.dataset.orig = el.textContent;
      el.textContent = busyLabel;
      el.disabled = true;
    } else {
      if (el.dataset.orig) el.textContent = el.dataset.orig;
      el.disabled = false;
    }
    return;
  }
  if (busy) {
    label.dataset.orig = label.textContent;
    label.textContent = busyLabel;
  } else if (label.dataset.orig) {
    label.textContent = label.dataset.orig;
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) {
    statusEl.innerHTML = '<span class="icon">🚫</span>当前页面不支持分析（仅 http/https）';
    for (const id of ['ai-btn', 'rule-btn', 'crawl-btn']) {
      document.getElementById(id).classList.add('disabled');
    }
    return;
  }
  currentTabId = tab.id;
  currentTabUrl = tab.url;

  confCfg = await chrome.storage.local.get({ showConfidence: false, confThreshold: 0 });
  rulesCache = (await loadRuleSetState()).rules;

  // 有爬虫在跑就把「爬取本站」置灰，点了变成打开侧栏看进度
  const st = await chrome.runtime.sendMessage({ type: 'crawlStatus' });
  if (st?.ok && st.running) {
    document.getElementById('crawl-btn').classList.add('running');
  }

  const data = await chrome.runtime.sendMessage({ type: 'getResult', tabId: currentTabId });
  if (!data) {
    statusEl.innerHTML = '<span class="icon">🔄</span>尚未采集到页面特征<br>请刷新页面后重试';
    return;
  }
  currentData = data;
  render(data);
}

// 展示列表 = 规则命中 + 已合并的 AI 命中（按 name 小写去重，避免同技术重复展示）
function displayHits() {
  const base = currentData?.result?.hits || [];
  const seen = new Set(base.map((h) => (h.name || '').toLowerCase()).filter(Boolean));
  const merged = aiMergedHits.filter((h) => !seen.has((h.name || '').toLowerCase()));
  return [...base, ...merged];
}

function render({ features, result }) {
  // 页面信息卡
  pageInfo.style.display = 'block';
  document.getElementById('page-title').textContent = features.title || '（无标题）';
  document.getElementById('page-url').textContent = features.url;

  // favicon：命中时加绿圈
  const faviconEl = document.getElementById('page-favicon');
  if (features.favicon) {
    faviconEl.src = features.favicon;
    faviconEl.style.display = 'block';
    faviconEl.onerror = () => { faviconEl.style.display = 'none'; };
    faviconEl.classList.toggle('matched', !!result.hits?.length);
  }

  const metaRow = document.getElementById('meta-row');
  metaRow.innerHTML = '';
  if (features.status) {
    const ok = features.status >= 200 && features.status < 400;
    metaRow.appendChild(makeChip(`HTTP ${features.status}`, ok));
  }
  const server = features.headers?.['server'];
  if (server) metaRow.appendChild(makeChip(`server: ${server}`));
  const iconHashes = (features.faviconHashes || []).filter((h) => Number.isFinite(h));
  if (iconHashes.length) {
    const extra = iconHashes.length - 1;
    metaRow.appendChild(makeChip(`icon_hash: ${iconHashes[0]}` + (extra > 0 ? ` +${extra}` : '')));
  }

  // 命中结果
  statusEl.style.display = 'none';
  hitsEl.innerHTML = '';

  if (result.note === 'no_rules') {
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<span class="icon">📭</span>尚未导入任何规则<br>点击右下角「⚙️ 规则」导入 YAML';
    return;
  }
  if (!displayHits().length) {
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<span class="icon">🔍</span>未命中任何规则<br>可点击下方 AI 辅助识别';
    return;
  }

  // 置信度启用时：低置信度的隐藏，剩下的按置信度从高到低排
  // displayHits() = 规则命中 + 用户勾选合并的 AI 命中（去重）
  const filtered = GoPainterUtils.filterAndSortHits(displayHits(), confCfg);
  const { hits, hidden, annotated } = filtered;

  if (!hits.length) {
    statusEl.style.display = 'block';
    statusEl.innerHTML = hidden > 0
      ? `<span class="icon">🔍</span>${hidden} 个命中都低于置信度阈值<br>可在设置里调低阈值`
      : '<span class="icon">🔍</span>未命中任何规则<br>可点击下方 AI 辅助识别';
    return;
  }

  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = `命中 ${hits.length} 个指纹` + (hidden > 0 ? `（隐藏 ${hidden} 个低置信度）` : '');
  hitsEl.appendChild(label);
  for (const h of hits) {
    hitsEl.appendChild(renderHit(h));
  }
}

function renderHit(hit) {
  const card = document.createElement('div');
  card.className = 'hit';

  const head = document.createElement('div');
  head.className = 'head';
  head.innerHTML = `<span class="name"></span><span class="tail"><span class="id"></span></span>`;
  head.querySelector('.name').textContent = hit.name || hit.id;
  const idEl = head.querySelector('.id');
  if (hit.source === 'ai') {
    // AI 合并命中：紫色左边框 + AI 徽章，不显示伪 id
    card.classList.add('hit-ai');
    const badge = document.createElement('span');
    badge.className = 'ai-badge';
    badge.textContent = 'AI';
    head.querySelector('.tail').insertBefore(badge, idEl);
    idEl.style.display = 'none';
  } else {
    idEl.textContent = hit.id;
  }
  const conf = confidenceValue(hit);
  if (confCfg.showConfidence || hit.source === 'ai') {
    const badge = document.createElement('span');
    badge.className = 'conf ' + (conf == null ? 'none' : conf >= 80 ? 'high' : conf >= 50 ? 'mid' : 'low');
    badge.textContent = conf == null ? 'null' : conf + '%';
    badge.title = '置信度';
    head.querySelector('.tail').appendChild(badge);
  }
  card.appendChild(head);

  if (hit.evidence?.length) {
    const box = document.createElement('div');
    box.className = 'evidence';
    for (const ev of hit.evidence) {
      const row = document.createElement('div');
      row.className = 'ev';
      const tagText = ev.part && ev.part !== 'body' ? `${ev.type}:${ev.part}` : ev.type;
      row.innerHTML = `<span class="tag"></span><span class="detail"></span>`;
      row.querySelector('.tag').textContent = tagText;
      row.querySelector('.detail').textContent = ev.detail;
      box.appendChild(row);
    }
    card.appendChild(box);
  }

  // 仅对当前页实际命中的已有规则开放优化：让 AI 用本页的额外特征补强 matcher。
  const rule = GoPainterUtils.ruleByTechName(rulesCache, hit.name) || GoPainterUtils.ruleByTechName(rulesCache, hit.id);
  if (rule) {
    const btn = document.createElement('button');
    btn.className = 'opt-btn';
    btn.textContent = '优化此规则';
    btn.addEventListener('click', () => optimizeRule(rule));
    card.appendChild(btn);
  }
  return card;
}

function makeChip(text, ok = false) {
  const span = document.createElement('span');
  span.className = 'chip' + (ok ? ' ok' : '');
  span.textContent = text;
  return span;
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.rules) {
    ({ rules: rulesCache = [] } = await chrome.storage.local.get('rules'));
    await loadRuleSetState();
    if (currentData) render(currentData);
    return;
  }
  if (!changes.showConfidence && !changes.confThreshold) return;
  confCfg = {
    showConfidence: changes.showConfidence ? !!changes.showConfidence.newValue : confCfg.showConfidence,
    confThreshold: changes.confThreshold ? (changes.confThreshold.newValue || 0) : confCfg.confThreshold,
  };
  if (currentData) render(currentData);
});

aiBtn.addEventListener('click', async () => {
  setBusy(aiBtn, true, '分析中…');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'aiIdentify', tabId: currentTabId });
    if (!resp.ok) throw new Error(resp.error);
    if (resp.techs?.length) {
      renderAiCandidates(resp.techs);
    } else {
      // AI 没给出结构化候选，原文兜底展示
      showAiMessage(resp.raw || 'AI 未识别出技术栈');
    }
  } catch (e) {
    showAiMessage(`出错：${e.message}`);
  } finally {
    setBusy(aiBtn, false);
  }
});

// --- 爬取本站：在 popup 内确认页数后启动 ---

const crawlModal = document.getElementById('crawl-modal');
const crawlUrlInput = document.getElementById('crawl-url-popup');
const crawlMaxInput = document.getElementById('crawl-max-popup');
const crawlStartPopup = document.getElementById('crawl-start-popup');

function closeCrawlModal() {
  crawlModal.style.display = 'none';
}

document.getElementById('crawl-btn').addEventListener('click', async () => {
  const crawlBtn = document.getElementById('crawl-btn');
  // 正在爬取：点了直接打开侧栏看进度，不再弹配置框
  if (crawlBtn.classList.contains('running')) {
    await chrome.sidePanel?.open({ tabId: currentTabId }).catch(() => {});
    return;
  }
  if (!currentTabUrl) return;
  const { crawlMaxPages = '50' } = await chrome.storage.local.get('crawlMaxPages');
  crawlUrlInput.value = currentTabUrl;
  crawlMaxInput.value = crawlMaxPages;
  crawlModal.style.display = 'flex';
  crawlMaxInput.focus();
  crawlMaxInput.select();
});

document.getElementById('crawl-cancel-popup').addEventListener('click', closeCrawlModal);
crawlModal.addEventListener('click', (e) => {
  if (e.target === crawlModal) closeCrawlModal();
});

crawlStartPopup.addEventListener('click', async () => {
  const url = crawlUrlInput.value.trim();
  const raw = crawlMaxInput.value.trim();
  const maxPages = raw === '' ? null : parseInt(raw, 10);
  if (!/^https?:/.test(url)) {
    showAiMessage('起始 URL 得是 http/https');
    return;
  }
  if (raw !== '' && (!Number.isInteger(maxPages) || maxPages <= 0)) {
    showAiMessage('最大页数要么留空，要么填正整数');
    return;
  }

  setBusy(crawlStartPopup, true, '启动中…');
  try {
    await chrome.storage.local.set({ crawlMaxPages: raw });
    const resp = await chrome.runtime.sendMessage({ type: 'crawlStart', url, maxPages });
    if (!resp.ok) throw new Error(resp.error);
    closeCrawlModal();
    // 按钮置灰 + 打开侧栏看实时进度
    document.getElementById('crawl-btn').classList.add('running');
    await chrome.sidePanel?.open({ tabId: currentTabId }).catch(() => {});
  } catch (e) {
    showAiMessage(`启动爬取失败：${e.message}`);
  } finally {
    setBusy(crawlStartPopup, false);
  }
});

document.getElementById('settings-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// --- AI 规则：新建 / 基于当前命中页面优化已有规则 ---

const ruleBtn = document.getElementById('rule-btn');

// footer「新建规则」：打开新建模式，技术名可手动填
ruleBtn.addEventListener('click', () => {
  openRuleCreate('');
});

// 新建模式：填技术名后点「生成」，或从 AI 候选一键触发
ruleGenerate.addEventListener('click', async () => {
  const name = ruleNameInput.value.trim();
  await generateRule(name);
});

// 保存：两条流都走 addRule（同 id 覆盖），成功后刷新规则库并重扫当前页
ruleSave.addEventListener('click', async () => {
  ruleSave.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'addRule', yaml: ruleYaml.textContent });
    if (!resp.ok) throw new Error(resp.error);
    ruleArea.style.display = 'none';
    const msg = ruleMode === 'optimize' && optimizeRuleId
      ? `已覆盖规则 ${optimizeRuleId}，刷新页面即可生效`
      : `已加入 ${resp.added} 条规则，刷新页面即可生效`;
    showAiMessage(msg);
    // 规则变了：刷新快照，并重取当前结果让新规则即时反映
    ({ rules: rulesCache = [] } = await chrome.storage.local.get('rules'));
    const data = await chrome.runtime.sendMessage({ type: 'getResult', tabId: currentTabId });
    if (data) {
      currentData = data;
      render(data);
    }
  } catch (e) {
    showAiMessage(`入库失败：${e.message}`);
  } finally {
    ruleSave.disabled = false;
  }
});

ruleDiscard.addEventListener('click', () => {
  ruleArea.style.display = 'none';
  ruleNameInput.style.display = 'none';
  ruleGenerate.style.display = 'none';
});

function openRuleCreate(prefill) {
  ruleMode = 'create';
  optimizeRuleId = null;
  ruleModeLabel.textContent = '新建规则';
  ruleNameInput.value = prefill || '';
  ruleNameInput.style.display = 'block';
  ruleGenerate.style.display = 'block';
  ruleYaml.textContent = '';
  ruleSave.textContent = '✅ 保存规则';
  ruleArea.style.display = 'block';
}

async function generateRule(name) {
  ruleSave.disabled = true;
  ruleGenerate.disabled = true;
  ruleYaml.textContent = '生成中…';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'aiCreateRule', tabId: currentTabId, name });
    if (!resp.ok) throw new Error(resp.error);
    ruleYaml.textContent = resp.yaml;
  } catch (e) {
    ruleYaml.textContent = '';
    showAiMessage(`生成失败：${e.message}`);
  } finally {
    ruleSave.disabled = false;
    ruleGenerate.disabled = false;
  }
}

async function optimizeRule(rule) {
  ruleMode = 'optimize';
  optimizeRuleId = rule.id;
  ruleModeLabel.textContent = `优化规则：${rule.name}`;
  ruleNameInput.style.display = 'none';
  ruleGenerate.style.display = 'none';
  ruleYaml.textContent = '优化中…';
  ruleSave.textContent = '✅ 覆盖入库';
  ruleArea.style.display = 'block';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'aiOptimizeRule', tabId: currentTabId, ruleId: rule.id });
    if (!resp.ok) throw new Error(resp.error);
    ruleYaml.textContent = resp.yaml;
  } catch (e) {
    ruleYaml.textContent = '';
    showAiMessage(`优化失败：${e.message}`);
  }
}

// --- AI 识别候选列表：勾选 + 合并 + 一键转规则 ---

function slugAiId(name) {
  return 'ai-' + String(name).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '').replace(/-+/g, '-');
}

function renderAiCandidates(techs) {
  aiTechs = techs;
  aiCandidates.innerHTML = '';
  const currentNames = new Set(displayHits().map((h) => (h.name || '').toLowerCase()));
  for (const tech of techs) {
    const card = document.createElement('div');
    card.className = 'candidate';

    const head = document.createElement('div');
    head.className = 'head';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.name = tech.name;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = tech.name;
    const conf = document.createElement('span');
    conf.className = 'conf ' + (tech.confidence == null ? 'none' : tech.confidence >= 80 ? 'high' : tech.confidence >= 50 ? 'mid' : 'low');
    conf.textContent = tech.confidence == null ? 'null' : tech.confidence + '%';
    head.appendChild(cb);
    head.appendChild(name);
    head.appendChild(conf);
    card.appendChild(head);

    if (tech.evidence?.length) {
      const box = document.createElement('div');
      box.className = 'evidence';
      for (const ev of tech.evidence) {
        const row = document.createElement('div');
        row.className = 'ev';
        const tagText = ev.part && ev.part !== 'body' ? `${ev.type}:${ev.part}` : ev.type;
        row.innerHTML = `<span class="tag"></span><span class="detail"></span>`;
        row.querySelector('.tag').textContent = tagText;
        row.querySelector('.detail').textContent = ev.detail;
        box.appendChild(row);
      }
      card.appendChild(box);
    }

    // 状态标记 + 动作：已有命中→禁勾选；尚无规则的候选可新建规则。
    const actions = document.createElement('div');
    actions.className = 'actions';
    const alreadyHit = currentNames.has(tech.name.toLowerCase());
    const rule = GoPainterUtils.ruleByTechName(rulesCache, tech.name);
    if (alreadyHit) {
      cb.disabled = true;
      const tag = document.createElement('span');
      tag.className = 'tag-st has-hit';
      tag.textContent = '已有命中';
      actions.appendChild(tag);
    } else if (rule) {
      const tag = document.createElement('span');
      tag.className = 'tag-st has-rule';
      tag.textContent = '已有规则';
      actions.appendChild(tag);
    } else {
      const tag = document.createElement('span');
      tag.className = 'tag-st new';
      tag.textContent = '新';
      actions.appendChild(tag);
      const create = document.createElement('button');
      create.className = 'opt-btn';
      create.textContent = '新建规则';
      create.addEventListener('click', async () => {
        openRuleCreate(tech.name);
        await generateRule(tech.name);
      });
      actions.appendChild(create);
    }
    card.appendChild(actions);
    aiCandidates.appendChild(card);
  }

  aiRaw.style.display = 'none';
  aiMerge.style.display = 'block';
  aiMerge.disabled = false;
  aiResult.style.display = 'block';
}

// 合并选中：勾选的技术转成 AI 命中，并入当前展示列表（仅本次 popup 会话）
aiMerge.addEventListener('click', () => {
  const selected = [...aiCandidates.querySelectorAll('input[type=checkbox]:checked')]
    .map((cb) => cb.dataset.name);
  if (!selected.length) return;
  const byName = new Map();
  for (const tech of aiTechs) byName.set(String(tech.name).toLowerCase(), tech);
  for (const name of selected) {
    const tech = byName.get(name.toLowerCase());
    if (!tech) continue;
    aiMergedHits.push({
      id: slugAiId(name),
      name: tech.name,
      confidence: tech.confidence,
      evidence: tech.evidence || [],
      source: 'ai',
    });
  }
  aiCandidates.innerHTML = '';
  aiMerge.style.display = 'none';
  aiResult.style.display = 'none';
  if (currentData) render(currentData);
});

// 把 AI 相关/错误/成功消息统一显示在 #ai-raw（避免覆盖候选列表）
function showAiMessage(text) {
  aiCandidates.style.display = 'none';
  aiMerge.style.display = 'none';
  aiRaw.textContent = text;
  aiRaw.style.display = 'block';
  aiResult.style.display = 'block';
}

init();
