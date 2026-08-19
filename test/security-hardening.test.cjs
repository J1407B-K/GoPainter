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
  assert.match(browserState, /faviconHashes: compactInt32List\(features\.faviconHashes, 64\)/);
  assert.match(browserState, /domHits: compactBooleanObject\(features\.domHits, 200, 300\)/);
  assert.match(browserState, /\^\(\?:result\|popup\|agent\):/);
  assert.match(browserState, /evict\.push\(\.\.\.keys\)/);
  assert.match(browserState, /function currentTabPageFeatureVersion/);
  assert.match(browserState, /currentTabPageFeatureVersion\(tabId\) !== pageFeatureVersion/);
  assert.match(browserState, /function storePageSession/);
});

test('main-frame response state records both early and completed webRequest events', () => {
  const browserState = read('background', 'browser-state.js');
  assert.match(browserState, /chrome\.webRequest\.onBeforeRequest\.addListener\(\s*beginMainFrameNavigation/s);
  assert.match(browserState, /function recordMainFrameResponse\(details\)/);
  assert.match(browserState, /chrome\.webRequest\.onHeadersReceived\.addListener\(\s*recordMainFrameResponse/s);
  assert.match(browserState, /chrome\.webRequest\.onCompleted\.addListener\(\s*recordMainFrameResponse/s);
  assert.equal((browserState.match(/\['responseHeaders', 'extraHeaders'\]/g) || []).length, 2);
  assert.match(browserState, /Object\.prototype\.hasOwnProperty\.call\(headers, name\)/);
  assert.match(browserState, /`\$\{headers\[name\]\}\\n\$\{name\}: \$\{value\}`/);
  assert.match(browserState, /currentRequestId !== details\.requestId/);
  assert.doesNotMatch(browserState, /chrome\.tabs\.onUpdated\.addListener/);
});

test('matching bridge rejects malformed Go output before caching it', () => {
  const matching = read('background', 'matching.js');
  assert.match(matching, /if \(!Array\.isArray\(out\?\.hits\)\)/);
  assert.match(matching, /typeof out\?\.error === 'string'/);
  assert.match(matching, /matchCache\.set\(featuresJSON, \{ hits: out\.hits\.slice\(\) \}\)/);
});

test('persistent storage and packaged WASM are not exposed to content scripts or web pages', () => {
  const background = read('background.js');
  const storageAccess = read('background', 'storage-access.js');
  const manifest = JSON.parse(read('manifest.json'));
  assert.match(background, /background\/storage-access\.js/);
  assert.match(storageAccess, /chrome\.storage\.local\.setAccessLevel/);
  assert.match(storageAccess, /accessLevel: 'TRUSTED_CONTEXTS'/);
  assert.equal(manifest.web_accessible_resources, undefined);
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

test('third-party rule sources are bounded, scheduled, and rollback without duplicating rules in local storage', () => {
  const sourceHost = read('background', 'source-host.js');
  const rulesHost = read('background', 'rules-host.js');
  const options = read('options.js');
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(manifest.permissions.includes('alarms'));
  assert.match(sourceHost, /MAX_FILE_BYTES = 3 \* 1024 \* 1024/);
  assert.match(sourceHost, /MAX_TOTAL_BYTES = 30 \* 1024 \* 1024/);
  assert.match(sourceHost, /MAX_FILES = 2_000/);
  assert.match(sourceHost, /MAX_RULES = 25_000/);
  assert.match(sourceHost, /FETCH_CONCURRENCY = 4/);
  assert.match(sourceHost, /FETCH_TIMEOUT_MS = 15_000/);
  assert.match(sourceHost, /function serializeSourceOperation\(operation\)/);
  assert.match(sourceHost, /const controller = new AbortController\(\)/);
  assert.match(sourceHost, /controller\.abort\(\);\s+await patchMeta/s);
  assert.match(sourceHost, /return serializeSourceOperation\(\(\) => performRollback\(sourceId\)\)/);
  assert.match(sourceHost, /redirect: 'manual'/);
  assert.match(sourceHost, /credentials: 'omit'/);
  assert.match(sourceHost, /response\.body\.getReader\(\)/);
  assert.match(sourceHost, /await reader\.cancel\(\)/);
  assert.doesNotMatch(sourceHost, /arrayBuffer\(\)/);
  assert.match(sourceHost, /indexedDB\.open\('gopainter-rule-source-backups'/);
  assert.match(sourceHost, /chrome\.alarms\.onAlarm\.addListener/);
  assert.match(sourceHost, /replaceSourceRuleSet/);
  assert.match(rulesHost, /replaceSourceRuleSet: \(input, beforeReplace\) =>\s*serializeMutation/s);
  assert.match(sourceHost, /autoUpdate: false/);
  assert.match(sourceHost, /ALLOWED_HOSTS = new Set/);
  assert.doesNotMatch(sourceHost, /rawURL:\s*msg|msg\.url|sourceURL/);
  assert.doesNotMatch(options, /raw\.githubusercontent\.com|api\.github\.com/);
});
