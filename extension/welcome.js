const sampleYamlURL = chrome.runtime.getURL('rules/onboarding.yaml');
const sampleFeatures = {
  url: 'https://demo.gopainter.local/',
  title: 'Example WordPress site',
  status: 200,
  headers: { server: 'nginx/1.26.1' },
  meta: { generator: 'WordPress 6.6.2' },
  scripts: ['https://analytics.example.test/tracker.js'],
  body: '<!doctype html>\n<html>\n  <head>\n    <meta name="generator" content="WordPress 6.6.2">\n    <script src="https://analytics.example.test/tracker.js"></script>\n  </head>\n  <body>\n    <link rel="stylesheet" href="/wp-content/themes/demo/style.css">\n    <main>Hello, GoPainter.</main>\n  </body>\n</html>',
};

const bodyEl = document.getElementById('sample-body');
const intro = document.getElementById('intro');
const demo = document.getElementById('demo');
const importButton = document.getElementById('import-sample');
const introStatus = document.getElementById('intro-status');
const scanStatus = document.getElementById('scan-status');
const hitsEl = document.getElementById('demo-hits');
let wasmReady = null;

function ensureWasm() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const go = new Go();
      const response = await fetch(chrome.runtime.getURL('wasm/matcher.wasm'));
      const { instance } = await WebAssembly.instantiateStreaming(response, go.importObject);
      go.run(instance);
      if (typeof globalThis.goMatch !== 'function') throw new Error('匹配引擎没有准备完成');
    })();
    wasmReady.catch(() => { wasmReady = null; });
  }
  return wasmReady;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

function renderSampleBody() {
  let html = escapeHtml(sampleFeatures.body);
  for (const token of ['WordPress 6.6.2', '/wp-content/', 'analytics.example.test/tracker.js']) {
    html = html.replace(token, `<mark class="token-hit">${token}</mark>`);
  }
  bodyEl.innerHTML = html.replace('nginx/1.26.1', '<span class="token-head">nginx/1.26.1</span>');
}

function renderHit(hit, index) {
  const evidence = hit.evidence?.[0] || {};
  const card = document.createElement('article');
  card.className = 'demo-hit';
  card.innerHTML = `<span class="hit-check">✓</span><div><strong>${escapeHtml(hit.name || hit.id)}</strong><small>${escapeHtml(evidence.type || 'match')} · ${escapeHtml(evidence.part || 'body')} · ${escapeHtml(evidence.detail || '')}</small></div>${hit.version ? `<span class="hit-version">${escapeHtml(hit.version)}</span>` : ''}`;
  hitsEl.appendChild(card);
  setTimeout(() => card.classList.add('show'), 280 + index * 220);
}

async function showDemo(rules) {
  intro.hidden = true;
  demo.hidden = false;
  renderSampleBody();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const line = document.querySelector('.scan-line');
  line.classList.add('scanning');
  scanStatus.textContent = '正在匹配…';
  await new Promise((resolve) => setTimeout(resolve, 650));
  const output = JSON.parse(globalThis.goMatch(JSON.stringify(rules), JSON.stringify(sampleFeatures)));
  if (!Array.isArray(output.hits)) throw new Error(output.error || '样例匹配失败');
  line.classList.remove('scanning');
  line.classList.add('done');
  scanStatus.textContent = `命中 ${output.hits.length} 条规则`;
  output.hits.forEach(renderHit);
}

async function importSample() {
  importButton.disabled = true;
  introStatus.className = 'status';
  introStatus.textContent = '正在加载本地匹配引擎并导入样例…';
  try {
    const yaml = await (await fetch(sampleYamlURL)).text();
    const [response] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'installOnboardingRules', yaml }),
      ensureWasm(),
    ]);
    if (!response?.ok) throw new Error(response?.error || '样例规则导入失败');
    await showDemo(response.rules);
  } catch (error) {
    introStatus.className = 'status error';
    introStatus.textContent = `无法完成样例导入：${error.message || error}`;
    importButton.disabled = false;
  }
}

async function finish() {
  await chrome.storage.local.set({ onboardingCompletedAt: Date.now() });
  window.close();
}

document.getElementById('import-sample').addEventListener('click', importSample);
document.getElementById('finish').addEventListener('click', finish);
document.getElementById('skip').addEventListener('click', finish);
renderSampleBody();
