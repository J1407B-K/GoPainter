// GoPainter 爬取侧边栏：实时轮询 crawlStatus，展示进度和结果，可启停。
// 状态在 background（storage.session + wasm 内存），这里只做展示和下发命令。

let pollTimer = null;
let resultsSignature = '';
const RESULT_RENDER_LIMIT = 300;

const badge = document.getElementById('crawl-badge');
const statusEl = document.getElementById('crawl-status');
const listEl = document.getElementById('crawl-results');
const startBtn = document.getElementById('crawl-start');
const stopBtn = document.getElementById('crawl-stop');
const t = (zh, english) => GoPainterI18n?.locale === 'en' ? english : zh;

function setBadge(running, interrupted) {
  badge.className = 'badge' + (running ? ' running' : '');
  if (running) badge.textContent = t('爬取中', 'Crawling');
  else if (interrupted) badge.textContent = t('已中断', 'Interrupted');
  else badge.textContent = t('未运行', 'Not running');
}

function renderResults(resp) {
  const signature = GoPainterUtils.crawlRenderSignature(resp);
  if (signature === resultsSignature) return;
  resultsSignature = signature;
  const rows = [];
  for (const r of resp.results.slice(-RESULT_RENDER_LIMIT)) {
    const names = (r.hits || []).map((h) => h.name).join('、');
    rows.push(
      `<div class="crawl-item"><div class="t">${escapeHtml(r.title)}</div>` +
      `<div class="u">${escapeHtml(r.url)}（HTTP ${r.status}）</div>` +
      `<div class="hits">${names ? '🎯 ' + escapeHtml(names) : t('— 未识别', '— No match')}</div></div>`
    );
  }
  for (const r of (resp.failed || []).slice(-20)) {
    rows.push(
      `<div class="crawl-item failed"><div class="t">${t('抓取失败', 'Fetch failed')}</div>` +
      `<div class="u">${escapeHtml(r.url)}</div>` +
      `<div class="hits">${escapeHtml(r.error || t('未知错误', 'Unknown error'))}</div></div>`
    );
  }
  listEl.innerHTML = rows.length
    ? rows.join('')
    : `<div class="empty">${t('尚未爬取', 'No crawl yet')}</div>`;
}

async function pollCrawl() {
  const resp = await chrome.runtime.sendMessage({ type: 'crawlStatus' });
  if (!resp?.ok) return;

  startBtn.disabled = !!resp.running;
  setBadge(resp.running, resp.interrupted);

  if (resp.running) {
    statusEl.innerHTML =
      t(`已扫 <span class="highlight">${resp.visited}</span> 页，` +
        `队列 <span class="highlight">${resp.queued}</span>，` +
        `失败 <span class="highlight">${resp.failed?.length || 0}</span>…`,
        `Scanned <span class="highlight">${resp.visited}</span> pages, queued <span class="highlight">${resp.queued}</span>, failed <span class="highlight">${resp.failed?.length || 0}</span>…`);
  } else if (resp.interrupted) {
    statusEl.textContent = t(`任务被系统中断（service worker 被回收），已保留 ${resp.results.length} 页结果`, `Interrupted by service-worker shutdown; retained ${resp.results.length} page results`);
  } else if (resp.results.length) {
    statusEl.textContent = t(`结束：成功 ${resp.results.length} 页，失败 ${resp.failed?.length || 0} 页`, `Finished: ${resp.results.length} succeeded, ${resp.failed?.length || 0} failed`);
  } else if (resp.failed?.length) {
    statusEl.textContent = t(`结束：没有成功页面，失败 ${resp.failed.length} 页`, `Finished: no successful pages; ${resp.failed.length} failed`);
  } else {
    statusEl.textContent = '';
  }

  renderResults(resp);

  // 跑着就每 1s 刷一次，停了就停轮询（省得面板挂着空转）
  if (resp.running && !pollTimer) {
    pollTimer = setInterval(pollCrawl, 1000);
  } else if (!resp.running && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

startBtn.addEventListener('click', async () => {
  const url = document.getElementById('crawl-url').value.trim();
  if (!/^https?:/.test(url)) {
    statusEl.textContent = t('起始 URL 得是 http/https', 'Start URL must use http or https');
    return;
  }
  const raw = document.getElementById('crawl-max').value.trim();
  const maxPages = raw === '' ? null : parseInt(raw, 10);
  if (raw !== '' && (!Number.isInteger(maxPages) || maxPages <= 0)) {
    statusEl.textContent = t('最大页数要么留空，要么填正整数', 'Maximum pages must be blank or a positive integer');
    return;
  }
  await chrome.storage.local.set({ crawlMaxPages: raw });
  const resp = await chrome.runtime.sendMessage({ type: 'crawlStart', url, maxPages });
  if (!resp.ok) {
    statusEl.textContent = resp.error;
    return;
  }
  startBtn.disabled = true;
  await pollCrawl();
});

stopBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'crawlStop' });
  await pollCrawl();
});

// 打开面板时恢复上次填的页数和当前进度
(async () => {
  const { crawlMaxPages } = await chrome.storage.local.get('crawlMaxPages');
  if (crawlMaxPages != null) document.getElementById('crawl-max').value = crawlMaxPages;
  await pollCrawl();
})();

window.addEventListener('gopainter:localechange', () => {
  resultsSignature = '';
  pollCrawl();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
