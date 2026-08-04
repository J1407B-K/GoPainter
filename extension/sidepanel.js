// GoPainter 爬取侧边栏：实时轮询 crawlStatus，展示进度和结果，可启停。
// 状态在 background（storage.session + wasm 内存），这里只做展示和下发命令。

let pollTimer = null;

const badge = document.getElementById('crawl-badge');
const statusEl = document.getElementById('crawl-status');
const listEl = document.getElementById('crawl-results');
const startBtn = document.getElementById('crawl-start');
const stopBtn = document.getElementById('crawl-stop');

function setBadge(running, interrupted) {
  badge.className = 'badge' + (running ? ' running' : '');
  if (running) badge.textContent = '爬取中';
  else if (interrupted) badge.textContent = '已中断';
  else badge.textContent = '未运行';
}

function renderResults(resp) {
  const rows = [];
  for (const r of resp.results) {
    const names = (r.hits || []).map((h) => h.name).join('、');
    rows.push(
      `<div class="crawl-item"><div class="t">${escapeHtml(r.title)}</div>` +
      `<div class="u">${escapeHtml(r.url)}（HTTP ${r.status}）</div>` +
      `<div class="hits">${names ? '🎯 ' + escapeHtml(names) : '— 未识别'}</div></div>`
    );
  }
  for (const r of (resp.failed || []).slice(-20)) {
    rows.push(
      `<div class="crawl-item failed"><div class="t">抓取失败</div>` +
      `<div class="u">${escapeHtml(r.url)}</div>` +
      `<div class="hits">${escapeHtml(r.error || '未知错误')}</div></div>`
    );
  }
  listEl.innerHTML = rows.length
    ? rows.join('')
    : '<div class="empty">尚未爬取</div>';
}

async function pollCrawl() {
  const resp = await chrome.runtime.sendMessage({ type: 'crawlStatus' });
  if (!resp?.ok) return;

  startBtn.disabled = !!resp.running;
  setBadge(resp.running, resp.interrupted);

  if (resp.running) {
    statusEl.innerHTML =
      `已扫 <span class="highlight">${resp.visited}</span> 页，` +
      `队列 <span class="highlight">${resp.queued}</span>，` +
      `失败 <span class="highlight">${resp.failed?.length || 0}</span>…`;
  } else if (resp.interrupted) {
    statusEl.textContent = `任务被系统中断（service worker 被回收），已保留 ${resp.results.length} 页结果`;
  } else if (resp.results.length) {
    statusEl.textContent = `结束：成功 ${resp.results.length} 页，失败 ${resp.failed?.length || 0} 页`;
  } else if (resp.failed?.length) {
    statusEl.textContent = `结束：没有成功页面，失败 ${resp.failed.length} 页`;
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
    statusEl.textContent = '起始 URL 得是 http/https';
    return;
  }
  const raw = document.getElementById('crawl-max').value.trim();
  const maxPages = raw === '' ? null : parseInt(raw, 10);
  if (raw !== '' && (!Number.isInteger(maxPages) || maxPages <= 0)) {
    statusEl.textContent = '最大页数要么留空，要么填正整数';
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
