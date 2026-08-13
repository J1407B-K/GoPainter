// popup：展示当前 tab 的命中结果和证据，附 AI 识别按钮。

const statusEl = document.getElementById('status');
const hitsEl = document.getElementById('hits');
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
const agentGoal = document.getElementById('agent-goal');
const agentRun = document.getElementById('agent-run');
const agentInput = document.getElementById('agent-input');
const agentBtn = document.getElementById('agent-btn');
const agentTrace = document.getElementById('agent-trace');
const agentModal = document.getElementById('agent-modal');
const agentCancel = document.getElementById('agent-cancel');
const agentInputField = document.getElementById('agent-input-field');
const agentResult = document.getElementById('agent-result');
const agentOutcome = document.getElementById('agent-outcome');
const agentPermissionModal = document.getElementById('agent-permission-modal');
const agentPermissionDescription = document.getElementById('agent-permission-description');
const agentPermissionAllow = document.getElementById('agent-permission-allow');
const agentPermissionDeny = document.getElementById('agent-permission-deny');

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
    for (const id of ['crawl-btn', 'agent-btn']) {
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

function syncAgentInput() {
  const needsInput = agentGoal.value !== 'identify-site';
  agentInputField.style.display = needsInput ? '' : 'none';
  agentInput.required = needsInput;
}

function closeAgentModal() {
  agentModal.style.display = 'none';
}

function showAgentMessage(text) {
  agentResult.style.display = 'block';
  renderMarkdown(agentResult, text);
}

function showAgentOutcome(status, steps = null) {
  const complete = status === 'complete';
  agentOutcome.className = complete ? 'success' : 'warning';
  agentOutcome.style.display = 'flex';
  agentOutcome.replaceChildren();
  const icon = document.createElement('span');
  icon.className = 'outcome-icon';
  icon.textContent = complete ? '✓' : '!';
  const text = document.createElement('span');
  text.textContent = complete
    ? `Agent 已完成${steps ? ` · ${steps} 步` : ''}`
    : `Agent 未完成${steps ? ` · ${steps} 步` : ''}`;
  agentOutcome.append(icon, text);
}

agentBtn.addEventListener('click', () => {
  syncAgentInput();
  agentTrace.replaceChildren();
  agentOutcome.style.display = 'none';
  agentResult.style.display = 'none';
  agentResult.replaceChildren();
  agentModal.style.display = 'flex';
  (agentGoal.value === 'identify-site' ? agentGoal : agentInput).focus();
});

agentGoal.addEventListener('change', syncAgentInput);
agentCancel.addEventListener('click', closeAgentModal);
agentModal.addEventListener('click', (event) => {
  if (event.target === agentModal) closeAgentModal();
});

function permissionDescription(request) {
  if (request.name === 'web_search') {
    const query = request.input?.query ? `\n搜索词：${request.input.query}` : '';
    return `Agent 请求联网搜索公开网页（DuckDuckGo）。搜索结果属于外部不可信内容，并会产生一次网络请求。${query}`;
  }
  return `Agent 请求调用工具「${request.name}」。该调用需要你的明确授权。`;
}

function renderAgentTrace(trace = []) {
  if (!trace.length) { agentTrace.innerHTML = ''; return; }
  const details = document.createElement('details');
  details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = `执行记录（${trace.length} 项，不含模型私有推理）`;
  details.appendChild(summary);
  for (const item of trace) {
    const row = document.createElement('div');
    row.className = 'agent-trace-row';
    row.textContent = `第 ${item.step} 步 · ${item.message}`;
    details.appendChild(row);
  }
  agentTrace.replaceChildren(details);
}

agentRun.addEventListener('click', async () => {
  const goalId = agentGoal.value;
  const input = agentInput.value.trim();
  if (goalId !== 'identify-site' && !input) {
    showAgentMessage('研究或优化规则时，请填写技术名或规则 ID。');
    return;
  }
  setBusy(agentRun, true, '执行中…');
  const liveTrace = [];
  renderAgentTrace(liveTrace);
  agentResult.style.display = 'none';
  agentResult.replaceChildren();
  agentOutcome.style.display = 'none';
  try {
    const result = await new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'gopainter-agent' });
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      port.onMessage.addListener((message) => {
        if (message.type === 'trace') {
          liveTrace.push(message.item);
          renderAgentTrace(liveTrace);
        } else if (message.type === 'permission') {
          agentPermissionDescription.textContent = permissionDescription(message.request);
          agentPermissionModal.style.display = 'flex';
          const respond = (granted) => {
            agentPermissionModal.style.display = 'none';
            port.postMessage({ type: 'permissionResponse', granted });
          };
          agentPermissionAllow.onclick = () => respond(true);
          agentPermissionDeny.onclick = () => respond(false);
        } else if (message.type === 'complete') {
          port.disconnect();
          finish(resolve, message.result);
        } else if (message.type === 'error') {
          port.disconnect();
          finish(reject, new Error(message.error));
        }
      });
      port.onDisconnect.addListener(() => {
        const lastError = chrome.runtime.lastError;
        if (lastError) finish(reject, new Error(lastError.message));
      });
      port.postMessage({
        type: 'runAgent', goalId, tabId: currentTabId, input,
      });
    });
    renderAgentTrace(result.trace);
    showAgentOutcome(result.status, result.steps);
    const citations = result.citations?.length ? `\n来源：${result.citations.join('、')}` : '';
    showAgentMessage(`${result.summary || result.text || ''}${citations}`);
  } catch (error) {
    showAgentOutcome('incomplete');
    showAgentMessage(`Agent 出错：${error.message}`);
  } finally {
    setBusy(agentRun, false);
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

function appendMarkdownInline(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let cursor = 0;
  for (const match of String(text).matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else {
      const [, label, href] = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/) || [];
      const link = document.createElement('a');
      link.textContent = label || token;
      link.href = href || '#';
      link.target = '_blank';
      link.rel = 'noreferrer';
      parent.append(link);
    }
    cursor = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(cursor)));
}

// 轻量、安全的 Markdown：所有模型文本均以 DOM 节点写入，绝不使用 innerHTML。
function renderMarkdown(target, markdown) {
  target.replaceChildren();
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  let list = null, listType = '', codeLines = null;
  const closeList = () => { list = null; listType = ''; };
  const paragraph = (text) => { const el = document.createElement('p'); appendMarkdownInline(el, text); target.append(el); };
  const tableCells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  const tableSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('```')) {
      if (codeLines === null) { closeList(); codeLines = []; } else { const pre = document.createElement('pre'); pre.textContent = codeLines.join('\n'); target.append(pre); codeLines = null; }
      continue;
    }
    if (codeLines !== null) { codeLines.push(line); continue; }
    if (line.includes('|') && tableSeparator(lines[index + 1] || '')) {
      closeList();
      const headers = tableCells(line);
      const wrap = document.createElement('div');
      wrap.className = 'md-table-wrap';
      const table = document.createElement('table');
      table.className = 'md-table';
      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      for (const header of headers) { const th = document.createElement('th'); appendMarkdownInline(th, header); headerRow.append(th); }
      thead.append(headerRow); table.append(thead);
      const tbody = document.createElement('tbody');
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const cells = tableCells(lines[index]);
        if (cells.length !== headers.length) break;
        const row = document.createElement('tr');
        for (const cell of cells) { const td = document.createElement('td'); appendMarkdownInline(td, cell); row.append(td); }
        tbody.append(row);
        index++;
      }
      index--;
      table.append(tbody); wrap.append(table); target.append(wrap);
      continue;
    }
    const heading = line.match(/^#{1,3}\s+(.+)/);
    const bullet = line.match(/^[-*]\s+(.+)/);
    const ordered = line.match(/^\d+\.\s+(.+)/);
    if (heading) { closeList(); const el = document.createElement('h3'); appendMarkdownInline(el, heading[1]); target.append(el); continue; }
    if (bullet || ordered) {
      const type = ordered ? 'ol' : 'ul';
      if (!list || listType !== type) { closeList(); list = document.createElement(type); listType = type; target.append(list); }
      const item = document.createElement('li'); appendMarkdownInline(item, (bullet || ordered)[1]); list.append(item); continue;
    }
    closeList();
    if (line.trim()) paragraph(line);
  }
  if (codeLines !== null) { const pre = document.createElement('pre'); pre.textContent = codeLines.join('\n'); target.append(pre); }
}

// 把 AI 相关/错误/成功消息统一显示在 #ai-raw（避免覆盖候选列表）
function showAiMessage(text) {
  aiCandidates.style.display = 'none';
  aiMerge.style.display = 'none';
  renderMarkdown(aiRaw, text);
  aiRaw.style.display = 'block';
  aiResult.style.display = 'block';
}

init();
