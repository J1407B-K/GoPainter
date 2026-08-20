// options：规则导入和 AI 配置。YAML 解析用 js-yaml，规范化在 wasm 里（走 background）。

const msgEl = document.getElementById('msg');

function showMsg(text, isError = false) {
  msgEl.textContent = text;
  msgEl.className = isError ? 'error' : '';
}

// --- 规则存取 ---

let ruleSetState = null;
let ruleSetRevision = 0;
const RULE_RENDER_LIMIT = 300;
const LIST_RENDER_LIMIT = 300;

function scheduleIdle(task) {
  const run = () => Promise.resolve(task()).catch((error) => console.warn('延迟加载失败:', error));
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1200 });
  else setTimeout(run, 0);
}

async function loadRuleSetState(force = false) {
  if (!force && ruleSetState) return ruleSetState;
  const raw = await chrome.storage.local.get(['rules', 'ruleSets', 'activeRuleSetId', 'enabledRuleSetIds', 'ruleSetOverrides', 'ruleStateRevision']);
  const state = GoPainterUtils.normalizeRuleSets(raw.ruleSets, raw.activeRuleSetId, raw.rules, raw.enabledRuleSetIds, raw.ruleSetOverrides);
  ruleSetState = state;
  ruleSetRevision = Number.isSafeInteger(raw.ruleStateRevision) ? raw.ruleStateRevision : 0;
  return state;
}

async function loadRules() {
  const state = await loadRuleSetState();
  return state.ruleSets.find((set) => set.id === state.activeRuleSetId)?.rules || [];
}

async function saveActiveRules(rules) {
  const response = await chrome.runtime.sendMessage({ type: 'replaceActiveRuleSetRules', rules, expectedRevision: ruleSetRevision });
  if (!response?.ok) throw new Error(response?.error || '保存规则失败');
  ruleSetState = response.state;
  ruleSetRevision = response.revision;
}

let visibleRuleSetConflicts = [];

function renderRuleSetOverrideList(query = '') {
  const needle = String(query).trim().toLowerCase();
  const filtered = needle
    ? visibleRuleSetConflicts.filter((conflict) => conflict.id.toLowerCase().includes(needle))
    : visibleRuleSetConflicts;
  const visible = filtered.slice(0, 200);
  document.getElementById('ruleset-overrides-list').innerHTML = visible.map((conflict) => `
    <div class="ruleset-override-item">
      <code title="${escapeHtml(conflict.id)}">${escapeHtml(conflict.id)}</code>
      <select data-rule-override-id="${escapeHtml(conflict.id)}" aria-label="选择 ${escapeHtml(conflict.id)} 的生效版本">
        ${conflict.sources.map((source) => `<option value="${escapeHtml(source.id)}" ${source.id === conflict.winnerId ? 'selected' : ''}>${escapeHtml(source.name)}${source.id === conflict.winnerId ? '（当前生效）' : ''}</option>`).join('')}
      </select>
    </div>`).join('') + (filtered.length > visible.length
      ? `<div class="muted">还有 ${filtered.length - visible.length} 项，请输入规则 ID 继续筛选</div>`
      : '');
}

function renderRuleSetControls(state) {
  const select = document.getElementById('ruleset-select');
  select.innerHTML = state.ruleSets.map((set) =>
    `<option value="${escapeHtml(set.id)}">${escapeHtml(set.name)}（${set.rules.length} 条）</option>`
  ).join('');
  select.value = state.activeRuleSetId;
  document.getElementById('ruleset-delete').disabled = state.ruleSets.length <= 1;
  const active = state.ruleSets.find((set) => set.id === state.activeRuleSetId);
  document.getElementById('ruleset-export').disabled = !active?.rules.length;
  const enabled = new Set(state.enabledRuleSetIds);
  const overrideInfo = GoPainterUtils.ruleSetOverrideInfo(state.ruleSets, state.enabledRuleSetIds, state.ruleSetOverrides);
  document.getElementById('ruleset-enabled-list').innerHTML = state.ruleSets.map((set) => `
    <label class="ruleset-enabled-item">
      <input type="checkbox" data-ruleset-id="${escapeHtml(set.id)}" ${enabled.has(set.id) ? 'checked' : ''}>
      <span class="ruleset-enabled-name">
        <span>${escapeHtml(set.name)}</span>
        ${overrideInfo.perSet[set.id]?.wins ? `<em class="ruleset-override-win">最终生效 ${overrideInfo.perSet[set.id].wins}</em>` : ''}
        ${overrideInfo.perSet[set.id]?.overridden ? `<em class="ruleset-override-loss">被覆盖 ${overrideInfo.perSet[set.id].overridden}</em>` : ''}
      </span>
      <small>${set.rules.length} 条</small>
    </label>`).join('');
  const overrides = document.getElementById('ruleset-overrides');
  const conflicts = overrideInfo.conflicts;
  visibleRuleSetConflicts = conflicts;
  overrides.hidden = !conflicts.length;
  document.getElementById('ruleset-overrides-summary').textContent = conflicts.length
    ? `${conflicts.length} 个重复规则 ID · 请选择生效版本（默认靠后优先）`
    : '';
  renderRuleSetOverrideList(document.getElementById('ruleset-overrides-filter').value);
}

document.getElementById('ruleset-overrides-filter').addEventListener('input', (event) => {
  renderRuleSetOverrideList(event.target.value);
});

document.getElementById('ruleset-overrides-list').addEventListener('change', async (event) => {
  const select = event.target.closest('select[data-rule-override-id]');
  if (!select) return;
  select.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'setRuleSetOverride', ruleId: select.dataset.ruleOverrideId, ruleSetId: select.value,
    });
    if (!response?.ok) throw new Error(response?.error || '更新规则版本失败');
    ruleSetState = response.state;
    ruleSetRevision = response.revision;
    renderRuleSetControls(ruleSetState);
    showMsg(`规则 ${select.dataset.ruleOverrideId} 已改用「${response.ruleSetName}」版本`);
  } catch (error) {
    showMsg(error.message, true);
    await refreshRuleList();
  } finally {
    select.disabled = false;
  }
});

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
let currentRuleId = '';
let currentRuleName = '';
let ruleModalValidationTimer = null;
let ruleModalValidationSerial = 0;
const ruleModalValidation = document.getElementById('rule-modal-validation');
const ruleModalSave = document.getElementById('rule-modal-save');

function optionValidationText(response) {
  if (response?.valid) return GoPainterI18n?.locale === 'en' ? '✓ Valid YAML and rule' : '✓ YAML 与规则有效';
  const issue = response?.errors?.[0];
  if (!issue) return GoPainterI18n?.locale === 'en' ? 'Invalid YAML / rule' : 'YAML / 规则无效';
  return GoPainterI18n?.locale === 'en'
    ? `Invalid YAML / rule: ${issue.path || '$'}: ${issue.code || 'invalid rule'}`
    : `YAML / 规则无效：${issue.path || '$'}：${issue.message || issue.code}`;
}

async function validateOptionRule() {
  const serial = ++ruleModalValidationSerial;
  ruleModalValidation.className = 'pending';
  ruleModalValidation.textContent = GoPainterI18n?.locale === 'en' ? 'Validating YAML…' : '正在校验 YAML…';
  ruleModalSave.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'validateRuleDraft', yaml: ruleModalBody.value, expectedId: currentRuleId,
    });
    if (serial !== ruleModalValidationSerial) return null;
    ruleModalValidation.className = response?.valid ? 'valid' : 'invalid';
    ruleModalValidation.textContent = response?.ok ? optionValidationText(response) : (response?.error || optionValidationText());
    ruleModalSave.disabled = !response?.valid;
    return response;
  } catch (error) {
    if (serial !== ruleModalValidationSerial) return null;
    ruleModalValidation.className = 'invalid';
    ruleModalValidation.textContent = error.message;
    ruleModalSave.disabled = true;
    return null;
  }
}

function openRuleDetail(rule) {
  currentRuleName = rule.name;
  currentRuleId = rule.id;
  ruleModalTitle.textContent = GoPainterI18n?.locale === 'en'
    ? `${currentRuleName} (${currentRuleId})` : `${currentRuleName}（${currentRuleId}）`;
  ruleModalValidationSerial++;
  ruleModalBody.value = jsyaml.dump(GoPainterUtils.sanitizeRule(rule) || rule, { noRefs: true, lineWidth: -1 });
  ruleModalValidation.className = 'pending';
  ruleModalValidation.textContent = '正在校验 YAML…';
  ruleModalSave.disabled = true;
  ruleModal.classList.add('open');
  clearTimeout(ruleModalValidationTimer);
  ruleModalValidationTimer = setTimeout(validateOptionRule, 0);
}

ruleModalBody.addEventListener('input', () => {
  clearTimeout(ruleModalValidationTimer);
  ruleModalValidationTimer = setTimeout(validateOptionRule, 220);
});

document.getElementById('rule-modal-check').addEventListener('click', () => {
  clearTimeout(ruleModalValidationTimer);
  validateOptionRule();
});

document.getElementById('rule-list').addEventListener('click', (e) => {
  const el = e.target.closest('.rule-item');
  if (!el) return;
  loadRuleSetState().then((state) => {
    const activeRules = state.ruleSets.find((set) => set.id === state.activeRuleSetId)?.rules || [];
    const rule = activeRules.find((r) => r.id === el.dataset.id);
    if (rule) openRuleDetail(rule);
  });
});

function closeRuleDetail() {
  clearTimeout(ruleModalValidationTimer);
  ruleModalValidationSerial++;
  ruleModal.classList.remove('open');
}

document.getElementById('rule-modal-close').addEventListener('click', closeRuleDetail);
ruleModal.addEventListener('click', (e) => {
  if (e.target === ruleModal) closeRuleDetail(); // 点遮罩关闭
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeRuleDetail();
});

const conflictModal = document.getElementById('rule-conflict-modal');
const conflictTitle = document.getElementById('rule-conflict-title');
const conflictProgress = document.getElementById('rule-conflict-progress');
const conflictDiff = document.getElementById('rule-conflict-diff');
let cancelConflictDialog = null;

function renderRuleDiff(existing, incoming) {
  const options = { noRefs: true, lineWidth: -1 };
  const diff = GoPainterUtils.diffTextLines(jsyaml.dump(existing, options), jsyaml.dump(incoming, options));
  conflictDiff.replaceChildren(...diff.map((item) => {
    const line = document.createElement('span');
    line.className = `rule-diff-line ${item.type}`;
    line.textContent = `${item.type === 'remove' ? '-' : item.type === 'add' ? '+' : ' '} ${item.line}`;
    return line;
  }));
  conflictDiff.scrollTop = 0;
}

function resolveRuleConflicts(conflicts) {
  if (!conflicts.length) return Promise.resolve({});
  return new Promise((resolve) => {
    const resolutions = {};
    let index = 0;
    const finish = (result) => {
      conflictModal.classList.remove('open');
      cancelConflictDialog = null;
      resolve(result);
    };
    const render = () => {
      const conflict = conflicts[index];
      conflictTitle.textContent = `规则冲突：${conflict.name}（${conflict.id}）`;
      conflictProgress.textContent = `${index + 1} / ${conflicts.length}`;
      renderRuleDiff(conflict.existing, conflict.incoming);
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
    cancelConflictDialog = () => finish(null);
    conflictModal.classList.add('open');
    render();
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && cancelConflictDialog) cancelConflictDialog();
});

async function resolveIncomingRules(existingRules, incomingRules) {
  const pending = GoPainterUtils.planRuleMerge(existingRules, incomingRules);
  if (!pending.unresolved.length) return pending;
  const resolutions = await resolveRuleConflicts(pending.unresolved);
  return resolutions ? GoPainterUtils.planRuleMerge(existingRules, incomingRules, resolutions) : null;
}

document.getElementById('rule-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(ruleModalBody.value);
    showMsg('规则 YAML 已复制');
  } catch {
    showMsg('复制失败，请手动选择复制', true);
  }
});

document.getElementById('rule-modal-save').addEventListener('click', async () => {
  const button = document.getElementById('rule-modal-save');
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'saveRuleDraft', yaml: ruleModalBody.value, expectedId: currentRuleId, expectedRevision: ruleSetRevision,
    });
    if (!response?.ok) throw new Error(response?.error || '保存规则失败');
    if (!response.valid) {
      document.getElementById('rule-modal-validation').className = 'invalid';
      document.getElementById('rule-modal-validation').textContent = optionValidationText(response);
      return;
    }
    ruleSetRevision = response.revision;
    ruleSetState = null;
    closeRuleDetail();
    await refreshRuleList();
    showMsg(`规则 ${currentRuleId} 已保存并生效`);
  } catch (error) {
    showMsg(error.message, true);
  } finally {
    if (ruleModal.classList.contains('open')) {
      button.disabled = !document.getElementById('rule-modal-validation').classList.contains('valid');
    }
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
  const incomingRules = [];
  const failed = [];

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
      incomingRules.push(...normalized);
    } catch (err) {
      failed.push(`${f.name}: ${err.message}`);
    }
  }

  const result = await resolveIncomingRules(rules, incomingRules);
  if (!result) {
    showMsg('已取消导入，没有修改当前编辑集');
    e.target.value = '';
    return;
  }
  if (result.added || result.replaced) await saveActiveRules(result.rules);
  await refreshRuleList();
  showMsg(
    `导入完成：新增 ${result.added}，替换 ${result.replaced}，保留旧版 ${result.kept}，未变化 ${result.unchanged}`
      + (failed.length ? `；失败：${failed.slice(0, 3).join('；')}${failed.length > 3 ? `；另有 ${failed.length - 3} 个` : ''}` : ''),
    failed.length > 0
  );
  if (failed.length) console.warn('导入失败:', failed);
  e.target.value = '';
});

// 规则导入（文件或内置库）共用的合并逻辑
async function importRules(rulesToAdd) {
  const rules = await loadRules();
  const result = await resolveIncomingRules(rules, rulesToAdd);
  if (!result) return null;
  if (result.added || result.replaced) await saveActiveRules(result.rules);
  await refreshRuleList();
  return result;
}

document.getElementById('import-builtin').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  try {
    const text = await (await fetch(chrome.runtime.getURL('rules/builtin.yaml'))).text();
    const docs = [];
    jsyaml.loadAll(text, (d) => docs.push(d));
    const rules = await normalizeImportedDocs(docs);
    const result = await importRules(rules);
    if (!result) return showMsg('已取消导入内置规则库');
    showMsg(`内置规则库导入完成：新增 ${result.added}，替换 ${result.replaced}，保留旧版 ${result.kept}`);
  } catch (err) {
    showMsg(`内置规则导入失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('ruleset-export').addEventListener('click', async () => {
  const state = await loadRuleSetState();
  const active = state.ruleSets.find((set) => set.id === state.activeRuleSetId);
  if (!active?.rules.length) return showMsg('当前编辑集没有可导出的规则', true);
  const filename = String(active.name || active.id || 'rules')
    .trim().replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '-').replace(/^-+|-+$/g, '') || 'rules';
  downloadReport(`${filename}.yaml`, jsyaml.dump(active.rules, { noRefs: true, lineWidth: -1 }), 'application/yaml;charset=utf-8');
  showMsg(`已导出「${active.name}」的 ${active.rules.length} 条规则`);
});

// --- 第三方规则源：用户主动拉取，后台有界下载、独立规则集、定时更新与单版本回滚 ---

const sourceStatus = (text, isError = false) => {
  const el = document.getElementById('source-status');
  el.textContent = text;
  el.className = isError ? 'error' : 'muted';
};

function sourceTime(timestamp) {
  if (!timestamp) return '从未';
  return new Date(timestamp).toLocaleString(GoPainterI18n.locale === 'en' ? 'en' : 'zh-CN');
}

function sourceSummary(source) {
  if (source.running) return '正在检查并转换…';
  if (source.lastError) return `上次检查失败：${GoPainterI18n.translate(source.lastError)}`;
  if (!source.lastCheckedAt) return '尚未同步';
  const summary = source.lastSummary;
  const changes = summary
    ? `；上次变化：新增 ${summary.added}，删除 ${summary.removed}，修改 ${summary.changed}`
    : '';
  return `${source.ruleCount} 条规则；上次检查：${sourceTime(source.lastCheckedAt)}${changes}`;
}

function renderRuleSources(sources) {
  for (const source of sources) {
    const status = document.querySelector(`[data-source-status="${source.id}"]`);
    const refresh = document.querySelector(`[data-source-refresh="${source.id}"]`);
    const rollback = document.querySelector(`[data-source-rollback="${source.id}"]`);
    const auto = document.querySelector(`[data-source-auto="${source.id}"]`);
    const interval = document.querySelector(`[data-source-interval="${source.id}"]`);
    const ruleSet = document.querySelector(`[data-source-ruleset="${source.id}"]`);
    if (!status || !refresh || !rollback || !auto || !interval) continue;
    status.textContent = sourceSummary(source);
    status.className = `source-meta ${source.lastError ? 'error' : 'muted'}`;
    refresh.disabled = source.running;
    refresh.textContent = source.running ? '更新中…' : '立即刷新';
    rollback.disabled = source.running || !source.canRollback;
    auto.checked = source.autoUpdate;
    interval.value = String(source.intervalHours === 168 ? 168 : 24);
    interval.disabled = !source.autoUpdate;
    if (ruleSet) ruleSet.textContent = `规则集：${source.name}`;
  }
}

async function loadRuleSources() {
  const response = await chrome.runtime.sendMessage({ type: 'getRuleSources' });
  if (!response?.ok) throw new Error(response?.error || '加载规则源失败');
  renderRuleSources(response.sources || []);
}

async function reloadSourcesAndRules() {
  ruleSetState = null;
  ruleSetRevision = 0;
  await Promise.all([loadRuleSources(), refreshRuleList()]);
}

document.querySelectorAll('[data-source-refresh]').forEach((button) => {
  button.addEventListener('click', async () => {
    const sourceId = button.dataset.sourceRefresh;
    button.disabled = true;
    sourceStatus('正在下载、转换并验证规则…');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'refreshRuleSource', sourceId });
      if (!response?.ok) throw new Error(response?.error || '规则源更新失败');
      await reloadSourcesAndRules();
      sourceStatus(response.unchanged ? '远程规则没有变化' : '规则源更新完成');
    } catch (error) {
      await loadRuleSources().catch(() => {});
      sourceStatus(`规则源更新失败：${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  });
});

document.querySelectorAll('[data-source-rollback]').forEach((button) => {
  button.addEventListener('click', async () => {
    const sourceId = button.dataset.sourceRollback;
    if (!confirm('确定将此规则源回滚到上一个版本？当前版本会成为新的回滚版本。')) return;
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'rollbackRuleSource', sourceId });
      if (!response?.ok) throw new Error(response?.error || '规则源回滚失败');
      await reloadSourcesAndRules();
      sourceStatus('规则源已回滚');
    } catch (error) {
      sourceStatus(`规则源回滚失败：${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  });
});

async function saveSourceSchedule(sourceId) {
  const auto = document.querySelector(`[data-source-auto="${sourceId}"]`);
  const interval = document.querySelector(`[data-source-interval="${sourceId}"]`);
  const response = await chrome.runtime.sendMessage({
    type: 'setRuleSourceAutoUpdate', sourceId, enabled: auto.checked, intervalHours: Number(interval.value),
  });
  if (!response?.ok) throw new Error(response?.error || '保存自动更新设置失败');
  interval.disabled = !auto.checked;
  sourceStatus(auto.checked ? '已开启自动更新' : '已关闭自动更新');
}

document.querySelectorAll('[data-source-auto], [data-source-interval]').forEach((control) => {
  control.addEventListener('change', () => saveSourceSchedule(control.dataset.sourceAuto || control.dataset.sourceInterval)
    .catch((error) => sourceStatus(`保存自动更新设置失败：${error.message}`, true)));
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
  ruleSetState = response.state;
  ruleSetRevision = response.revision;
  await refreshRuleList();
  showMsg(`当前编辑集已切换到「${next.name}」`);
});

async function saveEnabledRuleSets(enabledRuleSetIds, message) {
  const response = await chrome.runtime.sendMessage({ type: 'setEnabledRuleSets', enabledRuleSetIds });
  if (!response?.ok) throw new Error(response?.error || '更新启用规则集失败');
  ruleSetState = response.state;
  ruleSetRevision = response.revision;
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
  const response = await chrome.runtime.sendMessage({ type: 'createRuleSet', name });
  if (!response?.ok) return showMsg(response?.error || '新建规则集失败', true);
  ruleSetState = response.state;
  ruleSetRevision = response.revision;
  input.value = '';
  await refreshRuleList();
  showMsg(`已新建并切换到「${name}」`);
});

document.getElementById('ruleset-delete').addEventListener('click', async () => {
  const state = await loadRuleSetState();
  const active = state.ruleSets.find((set) => set.id === state.activeRuleSetId);
  if (state.ruleSets.length <= 1) return showMsg('至少保留一个规则集', true);
  if (!confirm(`删除规则集「${active.name}」及其中 ${active.rules.length} 条规则？`)) return;
  const response = await chrome.runtime.sendMessage({ type: 'deleteRuleSet', ruleSetId: active.id });
  if (!response?.ok) return showMsg(response?.error || '删除规则集失败', true);
  ruleSetState = response.state;
  ruleSetRevision = response.revision;
  await refreshRuleList();
  showMsg(`已删除「${response.name}」，已切换到「${ruleSetState.ruleSets[0].name}」`);
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
    const sourceName = item.source === 'crawl' ? '爬取' : item.source === 'batch' ? '批量' : '页面';
    url.textContent = `${sourceName} · ${item.url}（HTTP ${item.status || '—'}）`;
    const hits = document.createElement('div');
    hits.className = 'hits';
    const names = (item.hits || []).map(GoPainterUtils.hitLabel).filter(Boolean);
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

// --- 批量 URL 扫描 ---

let batchTimer = null;
let batchSignature = '';
let batchState = null;

function batchStatusText(state) {
  if (state.running) return `批量扫描中：${state.completed || 0} / ${state.total || 0}，等待 ${state.pending || 0}，失败 ${state.failed?.length || 0}`;
  if (state.interrupted) return `批量扫描被系统中断：已完成 ${state.completed || 0} / ${state.total || 0}`;
  if (state.error) return `批量扫描异常：${state.error}`;
  if (!state.total) return '尚未扫描';
  const stopped = state.stopped ? '（已停止）' : '';
  return `批量扫描完成${stopped}：成功 ${state.results?.length || 0}，失败 ${state.failed?.length || 0}，无效 ${state.invalid || 0}，重复 ${state.duplicate || 0}`;
}

function batchResultRow(result, failed = false) {
  const row = document.createElement('div');
  row.className = `crawl-item${failed ? ' failed' : ''}`;
  const title = document.createElement('div');
  title.className = 't';
  title.textContent = failed ? result.error : (result.title || result.finalUrl || result.url);
  const url = document.createElement('div');
  url.className = 'u';
  url.textContent = result.url;
  const hits = document.createElement('div');
  hits.className = 'hits';
  hits.textContent = failed ? '抓取失败' : ((result.hits || []).map(GoPainterUtils.hitLabel).join('、') || '— 未识别');
  row.append(title, url, hits);
  return row;
}

function renderBatch(state) {
  batchState = state;
  document.getElementById('batch-start').disabled = !!state.running;
  document.getElementById('batch-stop').disabled = !state.running;
  document.getElementById('batch-status').textContent = batchStatusText(state);
  const signature = GoPainterUtils.batchRenderSignature(state);
  if (signature === batchSignature) return;
  batchSignature = signature;
  const list = document.getElementById('batch-results');
  list.replaceChildren(
    ...(state.results || []).slice(-LIST_RENDER_LIMIT).map((item) => batchResultRow(item)),
    ...(state.failed || []).slice(-50).map((item) => batchResultRow(item, true)),
  );
}

async function pollBatch() {
  const state = await chrome.runtime.sendMessage({ type: 'batchStatus' });
  if (!state?.ok) return;
  renderBatch(state);
  if (state.running && !batchTimer) {
    batchTimer = setInterval(pollBatch, 500);
  } else if (!state.running && batchTimer) {
    clearInterval(batchTimer);
    batchTimer = null;
  }
}

document.getElementById('batch-start').addEventListener('click', async () => {
  const urls = document.getElementById('batch-urls').value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  const response = await chrome.runtime.sendMessage({ type: 'batchStart', urls });
  if (!response?.ok) {
    showMsg(response?.error || '启动批量扫描失败', true);
    return;
  }
  batchSignature = '';
  await pollBatch();
  showMsg(`已开始扫描 ${response.total} 个 URL`);
});

document.getElementById('batch-stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'batchStop' });
  await pollBatch();
});

document.getElementById('batch-clear').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'batchClear' });
  if (!response?.ok) {
    showMsg(response?.error || '清空批量扫描结果失败', true);
    return;
  }
  batchSignature = '';
  await pollBatch();
});

document.getElementById('batch-export-json').addEventListener('click', async () => {
  await pollBatch();
  downloadReport('gopainter-batch-report.json', JSON.stringify(GoPainterUtils.batchScanReport(batchState), null, 2), 'application/json');
});

document.getElementById('batch-export-csv').addEventListener('click', async () => {
  await pollBatch();
  downloadReport('gopainter-batch-report.csv', `\uFEFF${GoPainterUtils.batchScanCsv(batchState)}`, 'text/csv;charset=utf-8');
});

scheduleIdle(pollBatch);

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

// --- 站点爬取 ---

let crawlTimer = null;
let crawlRenderSignature = '';

function crawlStatusText(resp) {
  const failed = resp.failed?.length || 0;
  if (resp.running) return `爬取中：已扫 ${resp.visited} 页，队列 ${resp.queued}，失败 ${failed}，发现链接去重中…`;
  if (resp.interrupted) return `任务被系统中断（service worker 被回收）：已保留 ${resp.results.length} 页结果，失败 ${failed} 页`;
  if (resp.results.length) return `结束：成功 ${resp.results.length} 页，失败 ${failed} 页`;
  if (failed) return `结束：没有成功页面，失败 ${failed} 页`;
  return '';
}

function crawlResultRow(result) {
  const row = document.createElement('div');
  row.className = 'crawl-item';
  row.innerHTML = `<div class="t"></div><div class="u"></div><div class="hits"></div>`;
  row.querySelector('.t').textContent = result.title;
  row.querySelector('.u').textContent = `${result.url}（HTTP ${result.status}）`;
  const names = (result.hits || []).map(GoPainterUtils.hitLabel).join('、');
  row.querySelector('.hits').textContent = names ? `🎯 ${names}` : '— 未识别';
  return row;
}

function crawlFailureRow(result) {
  const row = document.createElement('div');
  row.className = 'crawl-item failed';
  row.innerHTML = `<div class="t">抓取失败</div><div class="u"></div><div class="hits"></div>`;
  row.querySelector('.u').textContent = result.url;
  row.querySelector('.hits').textContent = result.error || '未知错误';
  return row;
}

function renderCrawlResults(resp) {
  const signature = GoPainterUtils.crawlRenderSignature(resp);
  if (signature === crawlRenderSignature) return;
  crawlRenderSignature = signature;
  const list = document.getElementById('crawl-results');
  list.replaceChildren(
    ...resp.results.slice(-LIST_RENDER_LIMIT).map(crawlResultRow),
    ...(resp.failed || []).slice(-20).map(crawlFailureRow),
  );
}

async function pollCrawl() {
  const resp = await chrome.runtime.sendMessage({ type: 'crawlStatus' });
  if (!resp?.ok) return;
  // 爬取中禁用「开始爬取」，防止开第二个任务（后台也只会报错）
  document.getElementById('crawl-start').disabled = !!resp.running;
  document.getElementById('crawl-status').textContent = crawlStatusText(resp);
  renderCrawlResults(resp);
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

async function loadDefaultPrompts() {
  const resp = await chrome.runtime.sendMessage({ type: 'getDefaultPrompts' });
  if (!resp?.ok) return;
  defaultPrompts = resp.prompts;
  const prefix = GoPainterI18n.t('默认提示词：', 'Default prompt:');
  for (const k of PROMPT_KEYS) {
    document.getElementById(`prompt-${k}`).placeholder = `${prefix}\n${defaultPrompts[k]}`;
  }
}

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

  await loadDefaultPrompts();
}

window.addEventListener('gopainter:localechange', () => { loadDefaultPrompts().catch(() => {}); });

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

// --- 规则体检 ---

const healthRun = document.getElementById('health-run');
const healthStatus = document.getElementById('health-status');
const healthList = document.getElementById('health-list');

function healthPct(part, total) {
  return total ? ((part / total) * 100).toFixed(1) : '0';
}

function healthAssessment(health) {
  const total = health.totalPatterns || 0;
  if (!total) return { label: '无 regex', className: 'neutral' };
  if (health.invalid) return { label: `${health.invalid} 条无效`, className: 'bad' };
  if (health.broad) return { label: `${health.broad} 条无锚点待复核`, className: 'warn' };
  return { label: '结构正常', className: 'good' };
}

function healthPatternDetails(title, entries, total, itemExtra = () => '') {
  if (!entries.length) return '';
  const count = entries.length < total ? `显示前 ${entries.length} 条 / 共 ${total} 条` : `共 ${total} 条`;
  return `
    <details>
      <summary>${title}（${count}）</summary>
      <div class="hc-broad-list">
        ${entries.map((entry) => `
          <div class="hc-broad-item" title="${escapeHtml(entry.pattern)}">
            <span class="r">${escapeHtml(entry.ruleName || entry.ruleId)}</span>
            <span class="p">${escapeHtml(entry.pattern)}${itemExtra(entry)}</span>
          </div>`).join('')}
      </div>
    </details>`;
}

function renderHealthCard(set, health) {
  const total = health.totalPatterns || 0;
  const noLiteralPrefilter = (health.nonAscii || 0) + (health.broad || 0);
  const seg = (v) => (total ? ((v || 0) / total) * 100 : 0);
  const broad = health.broadPatterns || [];
  const invalid = health.invalidPatterns || [];
  const shortAnchors = health.shortAnchors || [];
  const longAnchors = health.longAnchors || [];
  const assessment = healthAssessment(health);
  const anchorExtra = (entry) => `<br><small>最弱分支代表锚点：<span class="hc-anchor">${escapeHtml(entry.anchor)}</span> · ${entry.length} 个字母/数字</small>`;
  const card = document.createElement('div');
  card.className = 'health-card';
  card.innerHTML = `
    <div class="hc-head">
      <span class="hc-name">${escapeHtml(set.name)}</span>
      ${set.enabled ? '<span class="hc-enabled">参与匹配</span>' : ''}
      <span class="hc-meta">${set.count} 条规则</span>
      <span class="hc-grade ${assessment.className}">${assessment.label}</span>
    </div>
    ${total ? `
      <div class="hc-bar" aria-hidden="true">
        <i class="seg-skip" style="width:${seg(health.skippable)}%"></i>
        <i class="seg-nascii" style="width:${seg(health.nonAscii)}%"></i>
        <i class="seg-broad" style="width:${seg(health.broad)}%"></i>
        <i class="seg-invalid" style="width:${seg(health.invalid)}%"></i>
      </div>
      <div class="hc-stats">
        <span class="hc-stat"><span class="v skip">${health.skippable} <small>(${healthPct(health.skippable, total)}%)</small></span>具备 ASCII 预筛条件</span>
        <span class="hc-stat"><span class="v nascii">${health.nonAscii} <small>(${healthPct(health.nonAscii, total)}%)</small></span>非 ASCII 护栏</span>
        <span class="hc-stat"><span class="v broad">${health.broad} <small>(${healthPct(health.broad, total)}%)</small></span>无预筛锚点</span>
        <span class="hc-stat"><span class="v invalid">${health.invalid} <small>(${healthPct(health.invalid, total)}%)</small></span>生产引擎无法解析</span>
      </div>
      <div class="hc-sum">共 ${total} 条 regex pattern；有效率 <b>${healthPct(total - health.invalid, total)}%</b>。其中 <b>${healthPct(health.skippable, total)}%</b> 具备潜在跳过条件，<b>${noLiteralPrefilter}</b> 条无法由字面量预筛跳过；实际跳过数取决于页面内容。</div>
    ` : '<div class="hc-empty">该规则集没有 regex 匹配器。</div>'}
    ${healthPatternDetails('短锚点榜（更可能高频，仅结构启发）', shortAnchors, health.skippable || 0, anchorExtra)}
    ${healthPatternDetails('长锚点榜（更具区分度，仅结构启发）', longAnchors, health.skippable || 0, anchorExtra)}
    ${healthPatternDetails('无效正则明细', invalid, health.invalid || 0, (entry) => `<br><small>${escapeHtml(entry.reason || '无法解析')}</small>`)}
    ${healthPatternDetails('无预筛锚点明细', broad, health.broad || 0)}
  `;
  return card;
}

healthRun.addEventListener('click', async () => {
  healthRun.disabled = true;
  healthStatus.textContent = '正在体检全部规则集…';
  healthList.innerHTML = '';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'classifyRuleSets' });
    if (!resp?.ok) throw new Error(resp?.error || '体检失败');
    healthList.replaceChildren(...(resp.ruleSets || []).map((set) => {
      const health = resp.results?.[set.id];
      if (!health || health.error) {
        const el = document.createElement('div');
        el.className = 'health-card';
        el.innerHTML = `<div class="hc-head"><span class="hc-name">${escapeHtml(set.name)}</span></div><div class="hc-empty">${escapeHtml(health?.error || '无数据')}</div>`;
        return el;
      }
      return renderHealthCard(set, health);
    }));
    healthStatus.textContent = resp.ruleSets?.length ? '' : '当前没有规则集';
  } catch (error) {
    healthStatus.textContent = `体检失败：${error.message}`;
  } finally {
    healthRun.disabled = false;
  }
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
scheduleIdle(loadRuleSources);
window.addEventListener('gopainter:localechange', () => {
  loadRuleSources().catch(() => {});
  refreshScanHistory().catch(() => {});
  if (batchState) {
    batchSignature = '';
    renderBatch(batchState);
  }
  if (ruleModal.classList.contains('open')) {
    ruleModalTitle.textContent = GoPainterI18n?.locale === 'en'
      ? `${currentRuleName} (${currentRuleId})` : `${currentRuleName}（${currentRuleId}）`;
    validateOptionRule().catch(() => {});
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.rules || changes.ruleSets || changes.activeRuleSetId || changes.enabledRuleSetIds || changes.ruleSetOverrides || changes.ruleStateRevision) {
    ruleSetState = null;
    ruleSetRevision = 0;
  }
  if (changes.ruleSources) loadRuleSources().catch(() => {});
});
