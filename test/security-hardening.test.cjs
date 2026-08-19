const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extension = path.join(__dirname, '..', 'extension');
const read = (...parts) => fs.readFileSync(path.join(extension, ...parts), 'utf8');

test('runtime probes use the extension bridge and DOM probes do not truncate candidates', () => {
  const content = read('content.js');
  const pageHost = read('background', 'page-host.js');
  const routeHook = read('route-hook.js');
  assert.match(content, /type: 'probeJs'/);
  assert.match(pageHost, /chrome\.scripting\.executeScript/);
  assert.match(pageHost, /world: 'MAIN'/);
  assert.doesNotMatch(pageHost, /JSON\.stringify\(value\)/);
  assert.match(pageHost, /MAX_PAGE_SCAN_CONCURRENCY = 3/);
  assert.match(pageHost, /MAX_PAGE_SCAN_QUEUE = 32/);
  assert.match(pageHost, /latestPageScan/);
  assert.match(pageHost, /const sameTab = pageScanQueue\.findIndex/);
  assert.match(pageHost, /retryAfter: 250/);
  assert.doesNotMatch(pageHost, /staleScan\(pageScanQueue\.shift\(\)\)/);
  assert.match(pageHost, /markTabPageFeatureVersion\(sender\.tab\?\.id\)/);
  assert.match(content, /function sendFeatures\(features\)/);
  assert.match(content, /if \(location\.href === features\.url\) sendFeatures\(features\)/);
  assert.doesNotMatch(content, /gopainter:probe|gopainter:jsResult/);
  assert.doesNotMatch(routeHook, /gopainter:probe|gopainter:jsResult/);
  assert.doesNotMatch(content, /Math\.min\(elements\.length, 50\)/);
  assert.match(content, /DOM_YIELD_EVERY/);
});

test('favicon hashing has byte, URL, and stream-read bounds', () => {
  const matching = read('background', 'matching.js');
  const browserState = read('background', 'browser-state.js');
  assert.match(matching, /MAX_ICON_BYTES = 200_000/);
  assert.match(matching, /MAX_ICON_URLS = 64/);
  assert.match(matching, /MAX_ICON_FETCH_CONCURRENCY = 6/);
  assert.match(matching, /MAX_ICON_FETCH_QUEUE = 256/);
  assert.match(matching, /MAX_ICON_REDIRECTS = 3/);
  assert.match(matching, /redirect: 'manual'/);
  assert.match(matching, /credentials: 'omit'/);
  assert.match(matching, /function discardStaleIconJobs/);
  assert.match(matching, /const staleTimer = isStale && setInterval/);
  assert.match(matching, /await reader\.cancel\(\)/);
  assert.match(matching, /function publicIconURL/);
  assert.match(matching, /response\.body\.getReader\(\)/);
  assert.doesNotMatch(matching, /resp\.arrayBuffer\(\)/);
  assert.doesNotMatch(matching, /\[\.\.\.new Set\(urls\)\]/);
  assert.match(browserState, /if \(!publicIconURL\(url\)\) return;/);
  assert.match(browserState, /SESSION_PAGE_ENTRY_LIMIT = 64/);
  assert.match(browserState, /SESSION_PAGE_STORAGE_BUDGET_BYTES = 6_500_000/);
  assert.match(browserState, /SESSION_PAGE_BODY_CHARS = 80_000/);
  assert.match(browserState, /scripts: compactStringList\(features\.scripts, 100, 2_000\)/);
  assert.match(browserState, /\^\(\?:result\|popup\|agent\):/);
  assert.match(browserState, /evict\.push\(\.\.\.keys\)/);
  assert.match(browserState, /function currentTabPageFeatureVersion/);
  assert.match(browserState, /currentTabPageFeatureVersion\(tabId\) !== pageFeatureVersion/);
  assert.match(browserState, /function storePageSession/);
});

test('main-frame response state records both early and completed webRequest events', () => {
  const browserState = read('background', 'browser-state.js');
  assert.match(browserState, /function recordMainFrameResponse\(details\)/);
  assert.match(browserState, /chrome\.webRequest\.onHeadersReceived\.addListener\(\s*recordMainFrameResponse/s);
  assert.match(browserState, /chrome\.webRequest\.onCompleted\.addListener\(\s*recordMainFrameResponse/s);
  assert.match(browserState, /\['responseHeaders'\]/);
});

test('rule writes are serialized and extension-privileged string execution is absent', () => {
  const rulesHost = read('background', 'rules-host.js');
  const options = read('options.js');
  const matching = read('background', 'matching.js');
  const optionsHtml = read('options.html');
  assert.match(rulesHost, /function serializeMutation\(fn\)/);
  assert.match(rulesHost, /replaceActiveRuleSetRules: \(msg\) => serializeMutation/);
  assert.match(rulesHost, /RULE_STATE_REVISION_KEY/);
  assert.match(rulesHost, /expectedRevision !== revision/);
  assert.doesNotMatch(options, /chrome\.storage\.local\.set\(ruleSetState\)/);
  assert.match(matching, /let rulesGeneration = 0/);
  assert.match(matching, /if \(generation !== rulesGeneration\) continue/);
  assert.match(matching, /rulesGeneration\+\+/);
  assert.doesNotMatch(matching, /new Function|runUserScripts/);
  assert.doesNotMatch(options, /new Function|userScripts/);
  assert.doesNotMatch(optionsHtml, /scripts-section|script-code/);
});

test('the retired external-script storage is removed once during startup', () => {
  const background = read('background.js');
  const migration = read('background', 'migrations.js');
  assert.match(background, /background\/migrations\.js/);
  assert.match(migration, /chrome\.storage\.local\.remove\('userScripts'\)/);
  assert.match(migration, /storageCleanup:v0\.6\.5/);
});
