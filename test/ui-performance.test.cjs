const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extension = path.join(__dirname, '..', 'extension');

test('shared UI CSS uses static page scopes instead of dynamic :has selectors', () => {
  const css = fs.readFileSync(path.join(extension, 'ui-rework.css'), 'utf8');
  assert.doesNotMatch(css, /:has\(/);
  assert.match(css, /html\.gp-popup/);
  assert.match(css, /html\.gp-options/);
  assert.match(css, /html\.gp-sidepanel/);
  const popupModal = css.match(/html\.gp-popup \.modal-backdrop \{([\s\S]*?)\}/)?.[1] || '';
  assert.doesNotMatch(popupModal, /backdrop-filter/);

  const pages = [
    ['popup.html', 'gp-popup'],
    ['options.html', 'gp-options'],
    ['sidepanel.html', 'gp-sidepanel'],
  ];
  for (const [file, className] of pages) {
    const html = fs.readFileSync(path.join(extension, file), 'utf8');
    assert.match(html, new RegExp(`<html[^>]*class="[^"]*${className}`));
  }
  const optionsHtml = fs.readFileSync(path.join(extension, 'options.html'), 'utf8');
  const optionsJs = fs.readFileSync(path.join(extension, 'options.js'), 'utf8');
  const popupHtml = fs.readFileSync(path.join(extension, 'popup.html'), 'utf8');
  assert.match(optionsHtml, /id="rule-conflict-modal"/);
  assert.match(optionsHtml, /id="ruleset-overrides-list"/);
  assert.match(optionsJs, /setRuleSetOverride/);
  assert.match(popupHtml, /id="rule-conflict-modal"/);
  assert.doesNotMatch(popupHtml, /rule-conflict-debug/);
});

test('page collection and large lists keep bounded performance paths', () => {
  const content = fs.readFileSync(path.join(extension, 'content.js'), 'utf8');
  const options = fs.readFileSync(path.join(extension, 'options.js'), 'utf8');
  const matching = fs.readFileSync(path.join(extension, 'background', 'matching.js'), 'utf8');
  const css = fs.readFileSync(path.join(extension, 'ui-rework.css'), 'utf8');
  const searchRules = fs.readFileSync(path.join(extension, 'agent', 'tools', 'search-rules.js'), 'utf8');
  assert.doesNotMatch(content, /document\.documentElement\.outerHTML/);
  assert.match(content, /serializeDocumentPrefix\(\)/);
  assert.doesNotMatch(content, /\[\.\.\.els\]/);
  assert.match(options, /RULE_RENDER_LIMIT = 300/);
  assert.match(options, /crawlRenderSignature/);
  const popup = fs.readFileSync(path.join(extension, 'popup.js'), 'utf8');
  assert.match(popup, /activeAgentPort\.disconnect\(\)/);
  assert.match(popup, /addRuleWithResolution/);
  assert.doesNotMatch(popup, /previewRuleChange/);
  assert.doesNotMatch(popup, /appendAgentRuleDiff/);
  assert.doesNotMatch(popup, /renderPopupRuleComparison/);
  assert.match(options, /planRuleMerge/);
  assert.match(matching, /Math\.min\(6, unique\.length\)/);
  assert.match(matching, /chrome\.tabs\.query\(\{\}\)/);
  assert.match(matching, /chrome\.storage\.session\.get\(keys\)/);
  assert.match(searchRules, /activeCache/);
  assert.match(searchRules, /processed % 250/);
});

test('rule health explains its scope and exposes actionable invalid regex details', () => {
  const html = fs.readFileSync(path.join(extension, 'options.html'), 'utf8');
  const js = fs.readFileSync(path.join(extension, 'options.js'), 'utf8');
  assert.match(html, /不把性能指标冒充识别准确率/);
  assert.match(html, /技术指纹是否真实、稳定仍需结合命中证据判断/);
  assert.match(js, /invalidPatterns/);
  assert.match(js, /无效正则明细/);
  assert.match(js, /具备潜在跳过条件/);
  assert.match(js, /短锚点榜/);
  assert.match(js, /长锚点榜/);
  assert.match(html, /不代表实测热度/);
  assert.doesNotMatch(js, /每页预计真跑/);
});
