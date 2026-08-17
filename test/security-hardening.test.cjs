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
  assert.match(matching, /response\.body\.getReader\(\)/);
  assert.doesNotMatch(matching, /resp\.arrayBuffer\(\)/);
  assert.doesNotMatch(matching, /\[\.\.\.new Set\(urls\)\]/);
  assert.match(browserState, /st\.seen\.size >= MAX_ICON_URLS/);
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
