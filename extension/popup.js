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
const ruleValidation = document.getElementById('rule-validation');
const ruleGenerate = document.getElementById('rule-generate');
const ruleSave = document.getElementById('rule-save');
const ruleDiscard = document.getElementById('rule-discard');
const pageInfo = document.getElementById('page-info');
const ruleSetQuick = document.getElementById('ruleset-quick');
const agentGoal = document.getElementById('agent-goal');
const agentRun = document.getElementById('agent-run');
const agentInput = document.getElementById('agent-input');
const agentRuleField = document.getElementById('agent-rule-field');
const agentRuleFilter = document.getElementById('agent-rule-filter');
const agentRuleCount = document.getElementById('agent-rule-count');
const agentRuleSelect = document.getElementById('agent-rule-select');
const agentBtn = document.getElementById('agent-btn');
const agentTrace = document.getElementById('agent-trace');
const agentModal = document.getElementById('agent-modal');
const agentCancel = document.getElementById('agent-cancel');
const agentInputField = document.getElementById('agent-input-field');
const agentResult = document.getElementById('agent-result');
const agentOutcome = document.getElementById('agent-outcome');
const agentApplyRule = document.getElementById('agent-apply-rule');
const agentPermissionModal = document.getElementById('agent-permission-modal');
const agentPermissionDescription = document.getElementById('agent-permission-description');
const agentPermissionAllow = document.getElementById('agent-permission-allow');
const agentPermissionSession = document.getElementById('agent-permission-session');
const agentPermissionDeny = document.getElementById('agent-permission-deny');
const ruleConflictModal = document.getElementById('rule-conflict-modal');
const ruleConflictTitle = document.getElementById('rule-conflict-title');
const ruleConflictProgress = document.getElementById('rule-conflict-progress');
const ruleConflictDiff = document.getElementById('rule-conflict-diff');
const t = (zh, english) => GoPainterI18n?.locale === 'en' ? english : zh;

let currentTabId = null;
let currentTabUrl = '';
let currentData = null;
// 置信度开关：设置页开的，开了才显示数值/排序/过滤
let confCfg = { showConfidence: false, confThreshold: 0 };
// 规则库快照：判断「已有规则」用；AI 合并的命中（source:'ai'）仅本次 popup 会话有效
let rulesCache = [];
let rulesLookup = new Map();
let ruleSetStateCache = null;
let aiTechs = [];
let aiMergedHits = [];
let ruleMode = null;
let optimizeRuleId = null;
let editRuleRevision = null;
let ruleValidationTimer = null;
let ruleValidationSerial = 0;
let editRuleContext = null;
let pendingAgentRuleYaml = '';
let pendingAgentRuleId = '';
let ruleSummariesPromise = null;
let activeAgentPort = null;
let agentRunSerial = 0;

async function loadRuleSetState() {
  const state = await chrome.runtime.sendMessage({ type: 'getRuleSetOverview' });
  ruleSetStateCache = state;
  ruleSetQuick.innerHTML = state.ruleSets.map((set) => {
    const option = document.createElement('option');
    option.value = set.id;
    option.textContent = `${set.enabled ? '✓ ' : ''}${set.name}（${set.count}）`;
    return option.outerHTML;
  }).join('');
  ruleSetQuick.value = state.activeRuleSetId;
  return state;
}

async function loadActiveRuleSummaries(force = false) {
  if (!force && rulesCache.length) return rulesCache;
  if (ruleSummariesPromise) return ruleSummariesPromise;
  agentRuleSelect.disabled = true;
  agentRuleSelect.replaceChildren(new Option('正在加载规则…', ''));
  ruleSummariesPromise = chrome.runtime.sendMessage({ type: 'getActiveRuleSummaries' })
    .then((response) => {
      rulesCache = response?.rules || [];
      rulesLookup = new Map();
      for (const rule of rulesCache) {
        for (const key of [rule.id, rule.name]) {
          const normalized = String(key || '').trim().toLowerCase();
          if (normalized && !rulesLookup.has(normalized)) rulesLookup.set(normalized, rule);
        }
      }
      populateAgentRuleSelect();
      return rulesCache;
    })
    .finally(() => {
      ruleSummariesPromise = null;
      agentRuleSelect.disabled = false;
    });
  return ruleSummariesPromise;
}

ruleSetQuick.addEventListener('change', async () => {
  const state = ruleSetStateCache || await loadRuleSetState();
  if (!state.ruleSets.some((set) => set.id === ruleSetQuick.value) || ruleSetQuick.value === state.activeRuleSetId) return;
  await chrome.runtime.sendMessage({ type: 'setActiveRuleSet', ruleSetId: ruleSetQuick.value });
  rulesCache = [];
  rulesLookup.clear();
  await loadRuleSetState();
  if (currentData) render(currentData);
});

function confidenceValue(hit) {
  return GoPainterUtils.confidenceValue(hit);
}

function cachedRule(name) {
  return rulesLookup.get(String(name || '').trim().toLowerCase()) || null;
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

let cancelRuleConflictDialog = null;

function renderPopupRuleDiff(existingYaml, incomingYaml) {
  const diff = GoPainterUtils.diffTextLines(existingYaml, incomingYaml);
  ruleConflictDiff.replaceChildren(...diff.map((item) => {
    const line = document.createElement('span');
    line.className = `rule-diff-line ${item.type}`;
    line.textContent = `${item.type === 'remove' ? '-' : item.type === 'add' ? '+' : ' '} ${item.line}`;
    return line;
  }));
  ruleConflictDiff.scrollTop = 0;
}

function resolvePopupRuleConflicts(conflicts) {
  if (!conflicts.length) return Promise.resolve({});
  return new Promise((resolve) => {
    const resolutions = {};
    let index = 0;
    const finish = (result) => {
      ruleConflictModal.style.display = 'none';
      cancelRuleConflictDialog = null;
      resolve(result);
    };
    const render = () => {
      const conflict = conflicts[index];
      ruleConflictTitle.textContent = `规则冲突：${conflict.name}（${conflict.id}）`;
      ruleConflictProgress.textContent = `${index + 1} / ${conflicts.length}`;
      renderPopupRuleDiff(conflict.existingYaml, conflict.incomingYaml);
      const hasRemaining = index < conflicts.length - 1;
      document.getElementById('rule-conflict-keep-all').style.display = hasRemaining ? '' : 'none';
      document.getElementById('rule-conflict-use-all').style.display = hasRemaining ? '' : 'none';
    };
    const choose = (choice, all) => {
      if (all) {
        for (; index < conflicts.length; index++) resolutions[conflicts[index].id] = choice;
        finish(resolutions);
        return;
      }
      resolutions[conflicts[index].id] = choice;
      if (++index >= conflicts.length) finish(resolutions);
      else render();
    };
    document.getElementById('rule-conflict-keep').onclick = () => choose('existing', false);
    document.getElementById('rule-conflict-use').onclick = () => choose('incoming', false);
    document.getElementById('rule-conflict-keep-all').onclick = () => choose('existing', true);
    document.getElementById('rule-conflict-use-all').onclick = () => choose('incoming', true);
    document.getElementById('rule-conflict-cancel').onclick = () => finish(null);
    cancelRuleConflictDialog = () => finish(null);
    ruleConflictModal.style.display = 'flex';
    render();
  });
}

ruleConflictModal.addEventListener('click', (event) => {
  if (event.target === ruleConflictModal && cancelRuleConflictDialog) cancelRuleConflictDialog();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && cancelRuleConflictDialog) cancelRuleConflictDialog();
});

async function addRuleWithResolution(payload) {
  const resolutions = {};
  while (true) {
    const response = await chrome.runtime.sendMessage({ ...payload, resolutions });
    if (!response?.ok) throw new Error(response?.error || '规则入库失败');
    if (!response.needsResolution) return response;
    const choices = await resolvePopupRuleConflicts(response.conflicts || []);
    if (!choices) return { ok: true, cancelled: true };
    Object.assign(resolutions, choices);
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) {
    statusEl.innerHTML = `<span class="icon">🚫</span>${t('当前页面不支持分析（仅 http/https）', 'This page cannot be analyzed (http/https only)')}`;
    for (const id of ['crawl-btn', 'agent-btn']) {
      document.getElementById(id).classList.add('disabled');
    }
    return;
  }
  currentTabId = tab.id;
  currentTabUrl = tab.url;

  // 首屏只等待页面结果和轻量配置；大规则集读取延后，避免 popup 打开时白屏。
  const popupKey = `popup:${currentTabId}`;
  const [config, compactStored] = await Promise.all([
    chrome.storage.local.get({ showConfidence: false, confThreshold: 0 }),
    chrome.storage.session.get(popupKey),
  ]);
  confCfg = config;
  setTimeout(loadDeferredPopupState, 0);
  const data = compactStored[popupKey]
    || await chrome.runtime.sendMessage({ type: 'getPopupResult', tabId: currentTabId }).catch(() => null);
  if (!data) {
    statusEl.innerHTML = `<span class="icon">🔄</span>${t('尚未采集到页面特征', 'Page features are not available yet')}<br>${t('请刷新页面后重试', 'Refresh the page and try again')}`;
    return;
  }
  currentData = data;
  render(data);
}

async function loadDeferredPopupState() {
  try {
    const [state, crawlState] = await Promise.all([
      loadRuleSetState(),
      chrome.runtime.sendMessage({ type: 'crawlStatus' }),
    ]);
    document.getElementById('crawl-btn').classList.toggle('running', !!(crawlState?.ok && crawlState.running));
  } catch {
    // 次要状态加载失败不影响当前页面命中结果。
  }
}

// 展示列表 = 规则命中 + 已合并的 AI 命中（按 name 小写去重，避免同技术重复展示）
function displayHits() {
  const base = currentData?.result?.hits || [];
  const seen = new Set(base.map((h) => (h.name || '').toLowerCase()).filter(Boolean));
  const merged = aiMergedHits.filter((h) => !seen.has((h.name || '').toLowerCase()));
  return [...base, ...merged];
}

function renderPageSummary(features, result) {
  pageInfo.style.display = 'block';
  document.getElementById('page-title').textContent = features.title || t('（无标题）', '(Untitled)');
  document.getElementById('page-url').textContent = features.url;
  const faviconEl = document.getElementById('page-favicon');
  faviconEl.style.display = features.favicon ? 'block' : 'none';
  if (features.favicon) {
    faviconEl.src = features.favicon;
    faviconEl.onerror = () => { faviconEl.style.display = 'none'; };
    faviconEl.classList.toggle('matched', !!result.hits?.length);
  }
  const metaRow = document.getElementById('meta-row');
  metaRow.replaceChildren();
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
}

function showHitStatus(html) {
  statusEl.style.display = 'block';
  statusEl.innerHTML = html;
}

function renderHitList(result) {
  const allHits = displayHits();
  if (result.note === 'no_rules') {
    showHitStatus(`<span class="icon">📭</span>${t('尚未导入任何规则', 'No rules have been imported')}<br>${t('点击右下角「⚙️ 规则」导入 YAML', 'Open Settings to import YAML')}`);
    return;
  }
  if (!allHits.length) {
    showHitStatus(`<span class="icon">🔍</span>${t('未命中任何规则', 'No rules matched')}<br>${t('可点击下方 AI 辅助识别', 'Use AI-assisted identification below')}`);
    return;
  }

  const { hits, hidden } = GoPainterUtils.filterAndSortHits(allHits, confCfg);
  if (!hits.length) {
    showHitStatus(hidden > 0
      ? `<span class="icon">🔍</span>${t(`${hidden} 个命中都低于置信度阈值`, `${hidden} matches are below the confidence threshold`)}<br>${t('可在设置里调低阈值', 'Lower the threshold in Settings')}`
      : `<span class="icon">🔍</span>${t('未命中任何规则', 'No rules matched')}<br>${t('可点击下方 AI 辅助识别', 'Use AI-assisted identification below')}`);
    return;
  }

  const label = document.createElement('div');
  label.className = 'section-label';
  const totalHits = Math.max(hits.length, Number(result.totalHits) || 0);
  const limited = totalHits > hits.length ? t(`，展示前 ${hits.length} 个`, `, showing first ${hits.length}`) : '';
  label.textContent = t(`命中 ${totalHits} 个指纹${limited}`, `${totalHits} fingerprints detected${limited}`)
    + (hidden > 0 ? t(`（隐藏 ${hidden} 个低置信度）`, ` (${hidden} low-confidence hidden)`) : '');
  hitsEl.append(label, ...hits.map(renderHit));
}

function render({ features, result }) {
  renderPageSummary(features, result);

  statusEl.style.display = 'none';
  hitsEl.replaceChildren();
  renderHitList(result);
}

function renderHit(hit) {
  const card = document.createElement('div');
  card.className = 'hit';
  card.dataset.ruleId = hit.id || '';

  const head = document.createElement('div');
  head.className = 'head';
  head.innerHTML = `<span class="name"></span><span class="tail"><span class="id"></span></span>`;
  const nameEl = head.querySelector('.name');
  nameEl.textContent = hit.name || hit.id;
  if (hit.version) {
    const version = document.createElement('span');
    version.className = 'version';
    version.textContent = ` ${hit.version}`;
    nameEl.appendChild(version);
  }
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
    badge.title = t('置信度', 'Confidence');
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

  const actions = document.createElement('div');
  actions.className = 'hit-actions';
  const derivedOnly = hit.evidence?.length > 0
    && hit.evidence.every((item) => item.type === 'implies');
  // Hash-database and implied detections are results, not editable rule objects.
  if (hit.source !== 'ai' && hit.source !== 'hash' && !derivedOnly) {
    const edit = document.createElement('button');
    edit.className = 'opt-btn edit-rule-btn';
    edit.textContent = t('编辑规则', 'Edit rule');
    edit.addEventListener('click', (event) => {
      event.stopPropagation();
      openRuleEditor(hit);
    });
    actions.appendChild(edit);
    head.classList.add('editable');
    head.title = t('点击编辑此规则', 'Click to edit this rule');
    head.addEventListener('click', () => openRuleEditor(hit));
  }

  // 仅对当前编辑集里的已有规则开放 AI 优化。
  const rule = cachedRule(hit.name) || cachedRule(hit.id);
  if (rule) {
    const btn = document.createElement('button');
    btn.className = 'opt-btn';
    btn.textContent = t('优化此规则', 'Optimize this rule');
    btn.addEventListener('click', () => optimizeRule(rule));
    actions.appendChild(btn);
  }
  if (actions.childElementCount) card.appendChild(actions);
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
    rulesCache = [];
    rulesLookup.clear();
    await loadRuleSetState();
    if (agentGoal.value === 'optimize-rule' && agentModal.style.display === 'flex') {
      await loadActiveRuleSummaries(true);
    }
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
  const research = agentGoal.value === 'research-rule';
  const optimize = agentGoal.value === 'optimize-rule';
  agentInputField.style.display = research ? '' : 'none';
  agentRuleField.style.display = optimize ? '' : 'none';
  agentInput.required = research;
  agentRuleSelect.required = optimize;
  if (optimize) loadActiveRuleSummaries().catch((error) => showAgentMessage(`规则列表加载失败：${error.message}`));
}

function populateAgentRuleSelect() {
  const selected = agentRuleSelect.value;
  const query = agentRuleFilter.value.trim().toLowerCase();
  const matches = query
    ? rulesCache.filter((rule) => `${rule.id}\n${rule.name || ''}`.toLowerCase().includes(query))
    : rulesCache;
  const visible = matches.slice(0, 200);
  agentRuleSelect.replaceChildren();
  agentRuleCount.textContent = matches.length > visible.length
    ? `匹配 ${matches.length} 条，显示前 ${visible.length} 条`
    : `${matches.length} 条规则`;
  if (!visible.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = rulesCache.length ? '没有匹配规则' : '当前编辑集为空';
    agentRuleSelect.appendChild(option);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const rule of visible) {
    const option = document.createElement('option');
    option.value = rule.id;
    option.textContent = `${rule.name || rule.id}（${rule.id}）`;
    fragment.appendChild(option);
  }
  agentRuleSelect.appendChild(fragment);
  if ([...agentRuleSelect.options].some((option) => option.value === selected)) agentRuleSelect.value = selected;
}

let agentRuleFilterTimer = null;
agentRuleFilter.addEventListener('input', () => {
  clearTimeout(agentRuleFilterTimer);
  agentRuleFilterTimer = setTimeout(populateAgentRuleSelect, 80);
});

function closeAgentModal() {
  agentRunSerial++;
  if (activeAgentPort) {
    try { activeAgentPort.disconnect(); } catch { /* 已断开 */ }
    activeAgentPort = null;
  }
  agentPermissionModal.style.display = 'none';
  setBusy(agentRun, false);
  agentModal.style.display = 'none';
}

function showAgentMessage(text) {
  agentResult.style.display = 'block';
  renderMarkdown(agentResult, text);
}

function showAgentOutcome(status, steps = null) {
  const noChange = status === 'nochange';
  const complete = status === 'complete';
  agentOutcome.className = complete ? 'success' : noChange ? 'neutral' : 'warning';
  agentOutcome.style.display = 'flex';
  agentOutcome.replaceChildren();
  const icon = document.createElement('span');
  icon.className = 'outcome-icon';
  icon.textContent = complete ? '✓' : noChange ? '·' : '!';
  const text = document.createElement('span');
  text.textContent = noChange
    ? '当前 AI 无合理优化建议'
    : complete
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
  pendingAgentRuleYaml = '';
  pendingAgentRuleId = '';
  agentApplyRule.style.display = 'none';
  agentApplyRule.disabled = false;
  agentModal.style.display = 'flex';
  (agentGoal.value === 'identify-site' ? agentGoal : agentGoal.value === 'optimize-rule' ? agentRuleSelect : agentInput).focus();
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
  if (request.name === 'fetch_url') {
    const url = request.input?.url || request.scope || '';
    return `Agent 请求读取 HTTPS 页面：\n${url}\n\n只执行有界 GET；外部内容不可信。拒绝显式本地/私有地址，并尽力降低 SSRF 风险，但浏览器 fetch 无法提供 DNS pinning。会话记忆仅适用于 ${request.scope || '这个来源'}。`;
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

function appendAgentTrace(item, count) {
  let details = agentTrace.querySelector('details');
  if (!details) {
    details = document.createElement('details');
    details.open = true;
    details.appendChild(document.createElement('summary'));
    agentTrace.replaceChildren(details);
  }
  details.querySelector('summary').textContent = `执行记录（${count} 项，不含模型私有推理）`;
  const row = document.createElement('div');
  row.className = 'agent-trace-row';
  row.textContent = `第 ${item.step} 步 · ${item.message}`;
  details.appendChild(row);
}

function resetAgentRunUI() {
  const liveTrace = [];
  renderAgentTrace(liveTrace);
  agentResult.style.display = 'none';
  agentResult.replaceChildren();
  agentOutcome.style.display = 'none';
  agentApplyRule.style.display = 'none';
  pendingAgentRuleYaml = '';
  pendingAgentRuleId = '';
  return liveTrace;
}

function showAgentPermission(port, request) {
  agentPermissionDescription.textContent = permissionDescription(request);
  agentPermissionSession.textContent = request.scope ? '本次会话允许此来源' : '本次会话始终允许';
  agentPermissionModal.style.display = 'flex';
  const respond = (granted, remember = false) => {
    agentPermissionModal.style.display = 'none';
    port.postMessage({ type: 'permissionResponse', granted, remember });
  };
  agentPermissionAllow.onclick = () => respond(true);
  agentPermissionSession.onclick = () => respond(true, true);
  agentPermissionDeny.onclick = () => respond(false);
}

function runAgentRequest(goalId, input, liveTrace) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'gopainter-agent' });
    activeAgentPort = port;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearInterval(keepalive);
      if (activeAgentPort === port) activeAgentPort = null;
      callback(value);
    };
    const keepalive = setInterval(() => {
      if (settled) return;
      try { port.postMessage({ type: 'keepalive' }); }
      catch (error) { finish(reject, new Error(`Agent 后台连接中断：${error.message}`)); }
    }, 15_000);
    port.onMessage.addListener((message) => {
      if (message.type === 'trace') {
        liveTrace.push(message.item);
        appendAgentTrace(message.item, liveTrace.length);
      } else if (message.type === 'permission') {
        showAgentPermission(port, message.request);
      } else if (message.type === 'complete') {
        finish(resolve, message.result);
        port.disconnect();
      } else if (message.type === 'error') {
        finish(reject, new Error(message.error));
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      const lastError = chrome.runtime.lastError;
      finish(reject, new Error(lastError?.message || 'Agent 后台连接意外中断，请重试'));
    });
    port.postMessage({ type: 'runAgent', goalId, tabId: currentTabId, input });
  });
}

function presentAgentResult(result, goalId, input) {
  showAgentOutcome(result.status, result.steps);
  const citations = result.citations?.length ? `\n来源：${result.citations.join('、')}` : '';
  const summary = `${result.summary || result.text || ''}${citations}`;
  showAgentMessage(summary);
  if (result.status !== 'complete' || goalId === 'identify-site') return;
  const yaml = extractAgentRuleYaml(summary);
  if (!yaml) {
    showAgentOutcome('incomplete', result.steps);
    return;
  }
  pendingAgentRuleYaml = yaml;
  pendingAgentRuleId = goalId === 'optimize-rule' ? input : '';
  agentApplyRule.textContent = goalId === 'optimize-rule' ? '覆盖当前规则' : '导入规则';
  agentApplyRule.style.display = 'block';
}

agentRun.addEventListener('click', async () => {
  const runSerial = ++agentRunSerial;
  const goalId = agentGoal.value;
  const input = goalId === 'optimize-rule' ? agentRuleSelect.value : agentInput.value.trim();
  if (goalId !== 'identify-site' && !input) {
    showAgentMessage(goalId === 'optimize-rule' ? '当前编辑集中没有可优化的规则。' : '研究规则时，请填写技术名。');
    return;
  }
  setBusy(agentRun, true, '执行中…');
  const liveTrace = resetAgentRunUI();
  try {
    const result = await runAgentRequest(goalId, input, liveTrace);
    if (runSerial !== agentRunSerial) return;
    // trace 已通过 port 按序增量渲染；完成时不再销毁重建，避免最后一帧卡顿。
    presentAgentResult(result, goalId, input);
  } catch (error) {
    if (runSerial !== agentRunSerial) return;
    showAgentOutcome('incomplete');
    showAgentMessage(`Agent 出错：${error.message}`);
  } finally {
    if (runSerial === agentRunSerial) setBusy(agentRun, false);
  }
});

function extractAgentRuleYaml(text) {
  const match = String(text || '').match(/```(?:yaml|yml)[^\S\r\n]*\r?\n([\s\S]*?)```/i);
  return match ? match[1].trim() : '';
}

agentApplyRule.addEventListener('click', async () => {
  if (!pendingAgentRuleYaml) return;
  agentApplyRule.disabled = true;
  try {
    const response = await addRuleWithResolution({
      type: 'addRule', yaml: pendingAgentRuleYaml, requireSingle: true,
      expectedId: pendingAgentRuleId || undefined,
    });
    if (response.cancelled) {
      agentApplyRule.disabled = false;
      showAgentMessage('已取消规则入库。');
      return;
    }
    agentApplyRule.textContent = response.replaced
      ? '已覆盖入库'
      : response.kept
        ? '已保留旧规则'
        : response.unchanged ? '规则无变化' : '已导入';
    pendingAgentRuleYaml = '';
    await loadActiveRuleSummaries(true);
  } catch (error) {
    agentApplyRule.disabled = false;
    showAgentMessage(`规则入库失败：${error.message}`);
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

function validationIssueText(issue) {
  if (GoPainterI18n?.locale !== 'en') return `${issue.path || '$'}：${issue.message || issue.code || '规则无效'}`;
  if (issue.code === 'runtime_error') return `${issue.path || '$'}: ${issue.message || 'Validation failed'}`;
  const labels = {
    invalid_json: 'Invalid YAML or rule structure', invalid_null: 'Null is not allowed', unsupported_field: 'Unsupported field',
    invalid_string: 'Invalid or oversized string', invalid_enum: 'Unsupported value', invalid_list: 'Invalid list',
    invalid_payload: 'Matcher payload does not match its type', invalid_regex: 'Invalid RE2 expression',
    invalid_dsl: 'Invalid DSL expression', out_of_range: 'Value is out of range', too_many_items: 'Too many items',
    invalid_map: 'Invalid map', id_changed: 'Rule ID cannot be changed while editing',
  };
  return `${issue.path || '$'}: ${labels[issue.code] || 'Invalid rule'}`;
}

function showRuleValidation(response, pending = false) {
  if (pending) {
    ruleValidation.className = 'pending';
    ruleValidation.textContent = t('正在校验…', 'Validating…');
    ruleSave.disabled = true;
    return;
  }
  if (!response?.valid) {
    ruleValidation.className = 'invalid';
    const issues = response?.errors || [];
    ruleValidation.textContent = issues.length ? issues.slice(0, 3).map(validationIssueText).join(' · ') : t('规则无效', 'Invalid rule');
    ruleSave.disabled = true;
    return;
  }
  ruleValidation.className = 'valid';
  const matched = response.currentPageHits?.length > 0;
  ruleValidation.textContent = matched
    ? t('规则有效 · 当前页面命中', 'Valid rule · matches the current page')
    : response.runtimeCoverage?.complete
      ? t('规则有效 · 当前页面未命中', 'Valid rule · does not match the current page')
      : t('规则有效 · JS/DOM 探针将在保存后重新采集', 'Valid rule · JS/DOM probes will be recollected after saving');
  ruleSave.disabled = false;
}

async function validateRuleEditor() {
  const serial = ++ruleValidationSerial;
  const yaml = ruleYaml.value.trim();
  if (!yaml) {
    showRuleValidation({ valid: false, errors: [{ path: '$', code: 'invalid_json', message: 'YAML 不能为空' }] });
    return null;
  }
  showRuleValidation(null, true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'validateRuleDraft', yaml, tabId: currentTabId,
      expectedId: ruleMode === 'edit' || ruleMode === 'optimize' ? optimizeRuleId : undefined,
    });
    if (serial !== ruleValidationSerial) return null;
    if (!response?.ok) throw new Error(response?.error || '规则校验失败');
    showRuleValidation(response);
    return response;
  } catch (error) {
    if (serial !== ruleValidationSerial) return null;
    const message = GoPainterI18n?.locale === 'en'
      ? GoPainterI18n.translate(error.message) : error.message;
    showRuleValidation({ valid: false, errors: [{ path: '$', code: 'runtime_error', message }] });
    return null;
  }
}

function scheduleRuleValidation(delay = 220) {
  clearTimeout(ruleValidationTimer);
  ruleValidationTimer = setTimeout(validateRuleEditor, delay);
}

ruleYaml.addEventListener('input', () => {
  showRuleValidation(null, true);
  scheduleRuleValidation();
});

function updateEditRuleCopy() {
  const hit = editRuleContext?.hit;
  if (!hit) return;
  const response = editRuleContext.response;
  if (!response) {
    ruleModeLabel.textContent = t(`编辑规则：${hit.name || hit.id}`, `Edit rule: ${hit.name || hit.id}`);
  } else {
    ruleModeLabel.textContent = response.copiesToEditSet
      ? t(`编辑规则：${hit.name || hit.id} · 保存到「${response.editRuleSetName}」`, `Edit rule: ${hit.name || hit.id} · save to “${response.editRuleSetName}”`)
      : t(`编辑规则：${hit.name || hit.id} · 「${response.editRuleSetName}」`, `Edit rule: ${hit.name || hit.id} · “${response.editRuleSetName}”`);
  }
  ruleSave.textContent = t('✅ 保存并生效', '✅ Save and apply');
}

async function openRuleEditor(hit) {
  ruleMode = 'edit';
  optimizeRuleId = hit.id;
  editRuleRevision = null;
  editRuleContext = { hit, response: null };
  updateEditRuleCopy();
  ruleNameInput.style.display = 'none';
  ruleGenerate.style.display = 'none';
  ruleYaml.value = '';
  ruleSave.disabled = true;
  ruleArea.style.display = 'block';
  showRuleValidation(null, true);
  ruleArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getRuleForEditing', ruleId: hit.id });
    if (!response?.ok) throw new Error(response?.error || '读取规则失败');
    if (ruleMode !== 'edit' || optimizeRuleId !== hit.id || editRuleContext?.hit?.id !== hit.id) return;
    editRuleRevision = response.revision;
    editRuleContext.response = response;
    ruleYaml.value = response.yaml;
    updateEditRuleCopy();
    scheduleRuleValidation(0);
    ruleYaml.focus();
  } catch (error) {
    const message = GoPainterI18n?.locale === 'en'
      ? GoPainterI18n.translate(error.message) : error.message;
    showRuleValidation({ valid: false, errors: [{ path: '$', code: 'runtime_error', message }] });
  }
}

async function refreshPopupAfterRuleSave(previousAt, previousName, savedRule) {
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const data = await chrome.runtime.sendMessage({ type: 'getPopupResult', tabId: currentTabId }).catch(() => null);
    if (!data) continue;
    const savedHit = data.result?.hits?.find((hit) => hit.id === savedRule?.id);
    const renamed = previousName !== savedRule?.name && savedHit?.name === savedRule?.name;
    if (data.at === previousAt && !renamed) continue;
    currentData = data;
    render(data);
    return;
  }
}

// 新建模式：填技术名后点「生成」，或从 AI 候选一键触发
ruleGenerate.addEventListener('click', async () => {
  const name = ruleNameInput.value.trim();
  await generateRule(name);
});

// 编辑命中规则走严格校验 + revision 保存；AI 新建/优化仍走带冲突确认的导入流。
ruleSave.addEventListener('click', async () => {
  ruleSave.disabled = true;
  try {
    if (ruleMode === 'edit') {
      const previousAt = currentData?.at;
      const previousName = currentData?.result?.hits?.find((hit) => hit.id === optimizeRuleId)?.name;
      const resp = await chrome.runtime.sendMessage({
        type: 'saveRuleDraft', yaml: ruleYaml.value, tabId: currentTabId,
        expectedId: optimizeRuleId, expectedRevision: editRuleRevision,
      });
      if (!resp?.ok) throw new Error(resp?.error || '保存规则失败');
      if (!resp.valid) {
        showRuleValidation(resp);
        return;
      }
      editRuleRevision = resp.revision;
      editRuleContext = null;
      ruleArea.style.display = 'none';
      rulesCache = [];
      rulesLookup.clear();
      showAiMessage(t(`规则已保存到「${resp.ruleSetName}」并重新匹配当前页面`, `Rule saved to “${resp.ruleSetName}”; the current page is being rematched`));
      refreshPopupAfterRuleSave(previousAt, previousName, resp.rule).catch(() => {});
      return;
    }
    const resp = await addRuleWithResolution({ type: 'addRule', yaml: ruleYaml.value });
    if (resp.cancelled) {
      showAiMessage('已取消规则入库');
      return;
    }
    ruleArea.style.display = 'none';
    const msg = resp.replaced
      ? `已覆盖 ${resp.replaced} 条规则，刷新页面即可生效`
      : resp.kept
        ? '已保留旧规则，没有写入新版本'
        : resp.unchanged
          ? '规则内容没有变化'
          : `已加入 ${resp.added} 条规则，刷新页面即可生效`;
    showAiMessage(msg);
    if (resp.added || resp.replaced) {
      rulesCache = [];
      rulesLookup.clear();
      const data = await chrome.runtime.sendMessage({ type: 'getPopupResult', tabId: currentTabId });
      if (data) {
        currentData = data;
        render(data);
      }
    }
  } catch (e) {
    showAiMessage(t(`入库失败：${e.message}`, `Save failed: ${GoPainterI18n.translate(e.message)}`));
  } finally {
    ruleSave.disabled = !ruleValidation.classList.contains('valid');
  }
});

ruleDiscard.addEventListener('click', () => {
  clearTimeout(ruleValidationTimer);
  ruleValidationSerial++;
  ruleArea.style.display = 'none';
  ruleNameInput.style.display = 'none';
  ruleGenerate.style.display = 'none';
  editRuleContext = null;
});

function openRuleCreate(prefill) {
  ruleMode = 'create';
  editRuleContext = null;
  optimizeRuleId = null;
  ruleModeLabel.textContent = '新建规则';
  ruleNameInput.value = prefill || '';
  ruleNameInput.style.display = 'block';
  ruleGenerate.style.display = 'block';
  ruleYaml.value = '';
  ruleValidation.className = 'pending';
  ruleValidation.textContent = '';
  ruleSave.textContent = '✅ 保存规则';
  ruleSave.disabled = true;
  ruleArea.style.display = 'block';
}

async function generateRule(name) {
  ruleSave.disabled = true;
  ruleGenerate.disabled = true;
  ruleYaml.value = '生成中…';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'aiCreateRule', tabId: currentTabId, name });
    if (!resp.ok) throw new Error(resp.error);
    ruleYaml.value = resp.yaml;
    scheduleRuleValidation(0);
  } catch (e) {
    ruleYaml.value = '';
    showAiMessage(`生成失败：${e.message}`);
  } finally {
    ruleGenerate.disabled = false;
  }
}

async function optimizeRule(rule) {
  ruleMode = 'optimize';
  editRuleContext = null;
  optimizeRuleId = rule.id;
  ruleModeLabel.textContent = `优化规则：${rule.name}`;
  ruleNameInput.style.display = 'none';
  ruleGenerate.style.display = 'none';
  ruleYaml.value = '优化中…';
  ruleValidation.className = 'pending';
  ruleValidation.textContent = '';
  ruleSave.textContent = '✅ 覆盖入库';
  ruleSave.disabled = true;
  ruleArea.style.display = 'block';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'aiOptimizeRule', tabId: currentTabId, ruleId: rule.id });
    if (!resp.ok) throw new Error(resp.error);
    ruleYaml.value = resp.yaml;
    scheduleRuleValidation(0);
  } catch (e) {
    ruleYaml.value = '';
    ruleSave.disabled = true;
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
    const rule = cachedRule(tech.name);
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

function markdownTableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function appendMarkdownRow(section, tag, cells) {
  const row = document.createElement('tr');
  for (const cell of cells) {
    const element = document.createElement(tag);
    appendMarkdownInline(element, cell);
    row.append(element);
  }
  section.append(row);
}

function appendMarkdownTable(target, lines, headerIndex) {
  const headers = markdownTableCells(lines[headerIndex]);
  const wrap = document.createElement('div');
  wrap.className = 'md-table-wrap';
  const table = document.createElement('table');
  table.className = 'md-table';
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  appendMarkdownRow(thead, 'th', headers);
  let index = headerIndex + 2;
  while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
    const cells = markdownTableCells(lines[index]);
    if (cells.length !== headers.length) break;
    appendMarkdownRow(tbody, 'td', cells);
    index++;
  }
  table.append(thead, tbody);
  wrap.append(table);
  target.append(wrap);
  return index - 1;
}

function appendMarkdownTextElement(target, tag, text) {
  const element = document.createElement(tag);
  appendMarkdownInline(element, text);
  target.append(element);
}

function appendMarkdownCode(target, lines) {
  const pre = document.createElement('pre');
  pre.textContent = lines.join('\n');
  target.append(pre);
}

// 轻量、安全的 Markdown：所有模型文本均以 DOM 节点写入，绝不使用 innerHTML。
function renderMarkdown(target, markdown) {
  target.replaceChildren();
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const state = { list: null, listType: '', codeLines: null };
  const closeList = () => { state.list = null; state.listType = ''; };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('```')) {
      if (state.codeLines === null) { closeList(); state.codeLines = []; }
      else { appendMarkdownCode(target, state.codeLines); state.codeLines = null; }
      continue;
    }
    if (state.codeLines !== null) { state.codeLines.push(line); continue; }
    if (line.includes('|') && isMarkdownTableSeparator(lines[index + 1] || '')) {
      closeList();
      index = appendMarkdownTable(target, lines, index);
      continue;
    }
    const heading = line.match(/^#{1,3}\s+(.+)/);
    const bullet = line.match(/^[-*]\s+(.+)/);
    const ordered = line.match(/^\d+\.\s+(.+)/);
    if (heading) { closeList(); appendMarkdownTextElement(target, 'h3', heading[1]); continue; }
    if (bullet || ordered) {
      const type = ordered ? 'ol' : 'ul';
      if (!state.list || state.listType !== type) {
        closeList();
        state.list = document.createElement(type);
        state.listType = type;
        target.append(state.list);
      }
      appendMarkdownTextElement(state.list, 'li', (bullet || ordered)[1]);
      continue;
    }
    closeList();
    if (line.trim()) appendMarkdownTextElement(target, 'p', line);
  }
  if (state.codeLines !== null) appendMarkdownCode(target, state.codeLines);
}

// 把 AI 相关/错误/成功消息统一显示在 #ai-raw（避免覆盖候选列表）
function showAiMessage(text) {
  aiCandidates.style.display = 'none';
  aiMerge.style.display = 'none';
  renderMarkdown(aiRaw, text);
  aiRaw.style.display = 'block';
  aiResult.style.display = 'block';
}

window.addEventListener('gopainter:localechange', () => {
  if (currentData) render(currentData);
  if (ruleMode === 'edit' && editRuleContext && ruleArea.style.display !== 'none') {
    updateEditRuleCopy();
    scheduleRuleValidation(0);
  }
});

init();
