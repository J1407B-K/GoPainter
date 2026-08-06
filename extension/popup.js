// popup：展示当前 tab 的命中结果和证据，附 AI 识别按钮。

const statusEl = document.getElementById('status');
const hitsEl = document.getElementById('hits');
const aiBtn = document.getElementById('ai-btn');
const aiResult = document.getElementById('ai-result');
const pageInfo = document.getElementById('page-info');

let currentTabId = null;
let currentTabUrl = '';
let currentData = null;
// 置信度开关：设置页开的，开了才显示数值/排序/过滤
let confCfg = { showConfidence: false, confThreshold: 0 };

function confidenceValue(hit) {
  if (hit?.confidence === null || hit?.confidence === undefined || hit?.confidence === '') {
    return null;
  }
  const n = Number(hit.confidence);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
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
  if (features.faviconHash) {
    const extra = (features.faviconHashes?.length || 1) - 1;
    metaRow.appendChild(makeChip(`icon_hash: ${features.faviconHash}` + (extra > 0 ? ` +${extra}` : '')));
  }

  // 命中结果
  statusEl.style.display = 'none';
  hitsEl.innerHTML = '';

  if (result.note === 'no_rules') {
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<span class="icon">📭</span>尚未导入任何规则<br>点击右下角「⚙️ 规则」导入 YAML';
    return;
  }
  if (!result.hits?.length) {
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<span class="icon">🔍</span>未命中任何规则<br>可点击下方 AI 辅助识别';
    return;
  }

  // 置信度启用时：低置信度的隐藏，剩下的按置信度从高到低排
  let hits = result.hits;
  let hidden = 0;
  const annotated = hits.filter((h) => confidenceValue(h) != null).length;
  if (confCfg.showConfidence) {
    if (confCfg.confThreshold > 0) {
      hidden = hits.filter((h) => {
        const conf = confidenceValue(h);
        return conf != null && conf < confCfg.confThreshold;
      }).length;
      hits = hits.filter((h) => {
        const conf = confidenceValue(h);
        return conf == null || conf >= confCfg.confThreshold;
      });
    }
    hits = hits.map((h, i) => ({ h, i })).sort((a, b) => {
      const av = confidenceValue(a.h);
      const bv = confidenceValue(b.h);
      const ac = av != null;
      const bc = bv != null;
      if (ac && bc) return bv - av || a.i - b.i;
      if (ac !== bc) return ac ? -1 : 1;
      return a.i - b.i;
    }).map((x) => x.h);
  }

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
  head.querySelector('.id').textContent = hit.id;
  const conf = confidenceValue(hit);
  if (confCfg.showConfidence) {
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
  return card;
}

function makeChip(text, ok = false) {
  const span = document.createElement('span');
  span.className = 'chip' + (ok ? ' ok' : '');
  span.textContent = text;
  return span;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.showConfidence && !changes.confThreshold)) return;
  confCfg = {
    showConfidence: changes.showConfidence ? !!changes.showConfidence.newValue : confCfg.showConfidence,
    confThreshold: changes.confThreshold ? (changes.confThreshold.newValue || 0) : confCfg.confThreshold,
  };
  if (currentData) render(currentData);
});

aiBtn.addEventListener('click', async () => {
  setBusy(aiBtn, true, '分析中…');
  aiResult.style.display = 'block';
  aiResult.textContent = '';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'aiIdentify', tabId: currentTabId });
    aiResult.textContent = resp.ok ? resp.answer : `出错：${resp.error}`;
  } catch (e) {
    aiResult.textContent = `出错：${e.message}`;
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
    aiResult.style.display = 'block';
    aiResult.textContent = '起始 URL 得是 http/https';
    return;
  }
  if (raw !== '' && (!Number.isInteger(maxPages) || maxPages <= 0)) {
    aiResult.style.display = 'block';
    aiResult.textContent = '最大页数要么留空，要么填正整数';
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
    aiResult.style.display = 'block';
    aiResult.textContent = `启动爬取失败：${e.message}`;
  } finally {
    setBusy(crawlStartPopup, false);
  }
});

document.getElementById('settings-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// --- AI 生成规则：生成 -> 预览 -> 确认入库 ---

const ruleBtn = document.getElementById('rule-btn');
const ruleArea = document.getElementById('rule-area');
const ruleYaml = document.getElementById('rule-yaml');
const ruleSave = document.getElementById('rule-save');
const ruleDiscard = document.getElementById('rule-discard');

ruleBtn.addEventListener('click', async () => {
  setBusy(ruleBtn, true, '生成中…');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'aiGenerateRule', tabId: currentTabId });
    if (!resp.ok) throw new Error(resp.error);
    ruleYaml.textContent = resp.yaml;
    ruleArea.style.display = 'block';
  } catch (e) {
    aiResult.style.display = 'block';
    aiResult.textContent = `出错：${e.message}`;
  } finally {
    setBusy(ruleBtn, false);
  }
});

ruleSave.addEventListener('click', async () => {
  ruleSave.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'addRule', yaml: ruleYaml.textContent });
    if (!resp.ok) throw new Error(resp.error);
    ruleArea.style.display = 'none';
    aiResult.style.display = 'block';
    aiResult.textContent = `已加入 ${resp.added} 条规则，刷新页面即可生效`;
  } catch (e) {
    aiResult.style.display = 'block';
    aiResult.textContent = `入库失败：${e.message}`;
  } finally {
    ruleSave.disabled = false;
  }
});

ruleDiscard.addEventListener('click', () => {
  ruleArea.style.display = 'none';
});

init();
