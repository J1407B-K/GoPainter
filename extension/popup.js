// popup：展示当前 tab 的命中结果和证据，附 AI 识别按钮。

const statusEl = document.getElementById('status');
const hitsEl = document.getElementById('hits');
const aiBtn = document.getElementById('ai-btn');
const aiResult = document.getElementById('ai-result');
const pageInfo = document.getElementById('page-info');

let currentTabId = null;
let currentTabUrl = '';

function setBusy(el, busy, busyLabel) {
  el.classList.toggle('busy', busy);
  const label = el.querySelector('.ac-label');
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

  const data = await chrome.runtime.sendMessage({ type: 'getResult', tabId: currentTabId });
  if (!data) {
    statusEl.innerHTML = '<span class="icon">🔄</span>尚未采集到页面特征<br>请刷新页面后重试';
    return;
  }
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

  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = `命中 ${result.hits.length} 个指纹`;
  hitsEl.appendChild(label);

  for (const h of result.hits) {
    hitsEl.appendChild(renderHit(h));
  }
}

function renderHit(hit) {
  const card = document.createElement('div');
  card.className = 'hit';

  const head = document.createElement('div');
  head.className = 'head';
  head.innerHTML = `<span class="name"></span><span class="id"></span>`;
  head.querySelector('.name').textContent = hit.name || hit.id;
  head.querySelector('.id').textContent = hit.id;
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

// --- 爬取本站：用当前标签页 URL 启动，跳设置页看进度 ---

document.getElementById('crawl-btn').addEventListener('click', async () => {
  if (!currentTabUrl) return;
  const btn = document.getElementById('crawl-btn');
  setBusy(btn, true, '启动中…');
  try {
    // 最大页数沿用设置页上次填的，没填过默认 50
    const { crawlMaxPages = '50' } = await chrome.storage.local.get('crawlMaxPages');
    const maxPages = crawlMaxPages === '' ? null : parseInt(crawlMaxPages, 10);
    const resp = await chrome.runtime.sendMessage({ type: 'crawlStart', url: currentTabUrl, maxPages });
    if (!resp.ok) throw new Error(resp.error);
    chrome.runtime.openOptionsPage(); // 进度和结果在设置页看
  } catch (e) {
    aiResult.style.display = 'block';
    aiResult.textContent = `启动爬取失败：${e.message}`;
  } finally {
    setBusy(btn, false);
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
