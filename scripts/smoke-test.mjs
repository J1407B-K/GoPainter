// 冒烟测试：在 Node 里加载 matcher.wasm 调 goMatch，验证引擎行为。
// 跑之前先 make build。
// 用法: node scripts/smoke-test.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

await import(join(ROOT, 'extension/wasm/wasm_exec.js')); // 挂全局 Go

const go = new globalThis.Go();
const bytes = readFileSync(join(ROOT, 'extension/wasm/matcher.wasm'));
const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
go.run(instance);

const rules = [
  {
    id: 'wordpress',
    name: 'WordPress',
    'matchers-condition': 'or',
    matchers: [{ type: 'word', part: 'body', words: ['/wp-content/', '/wp-includes/'] }],
  },
  {
    id: 'nginx-server',
    name: 'Nginx',
    matchers: [{ type: 'word', part: 'header', words: ['server: nginx'] }],
  },
  {
    id: 'jenkins',
    name: 'Jenkins',
    matchers: [
      { type: 'word', part: 'header', words: ['x-jenkins:'] },
      { type: 'regex', part: 'title', regex: ['Jenkins'] },
    ],
  },
  {
    id: 'gitea',
    name: 'Gitea',
    matchers: [{ type: 'icon_hash', hash: [-1234567890] }],
  },
];

const features = {
  url: 'https://blog.example.com/',
  title: 'My Blog',
  body: '<html><script src="/wp-content/themes/x.js"></script></html>',
  headers: { server: 'nginx', 'content-type': 'text/html' },
  status: 200,
  faviconHash: 42,
};

const out = JSON.parse(globalThis.goMatch(JSON.stringify(rules), JSON.stringify(features)));
console.log(JSON.stringify(out, null, 2));

const names = (out.hits || []).map((h) => h.name);
const wp = (out.hits || []).find((h) => h.id === 'wordpress');
const evidenceOk = wp?.evidence?.some((e) => e.type === 'word' && e.detail === '/wp-content/');

let pass =
  names.includes('WordPress') &&
  names.includes('Nginx') &&
  !names.includes('Jenkins') &&
  !names.includes('Gitea') &&
  evidenceOk;

// goMmh3：python mmh3.hash("foo") == -156908512
const hash = globalThis.goMmh3('foo');
console.log('goMmh3("foo") =', hash);
pass &&= hash === -156908512;

// goExtractFeatures：从 HTML 里提 title/meta/scripts
const html = `<html><head>
<title>  Test   Page </title>
<meta name="generator" content="WordPress 6.5">
<meta property="og:site_name" content="Example">
<link rel="shortcut icon" href="/static/favicon.ico">
<a href="/about">关于</a>
<script src="/wp-content/themes/x.js"></script>
<script async src='https://cdn.example.com/a.js'></script>
</head><body></body></html>`;
const ex = JSON.parse(globalThis.goExtractFeatures(html));
console.log('extract =', JSON.stringify(ex));
pass &&= ex.title === 'Test Page'
  && ex.meta?.generator === 'WordPress 6.5'
  && ex.meta?.['og:site_name'] === 'Example'
  && ex.scripts?.length === 2
  && ex.favicons?.length === 1 && ex.favicons[0] === '/static/favicon.ico'
  && ex.links?.length === 1 && ex.links[0] === '/about';

// 多 icon 哈希：faviconHashes 里任意一个命中规则的 icon_hash 都算
const multiIcon = JSON.parse(globalThis.goMatch(JSON.stringify(rules), JSON.stringify({
  ...features, faviconHash: 0, faviconHashes: [111, -1234567890],
})));
console.log('multiIcon hits =', multiIcon.hits.map((h) => h.id).join(','));
pass &&= multiIcon.hits.some((h) => h.id === 'gitea');

// goNormalizeRules：nuclei 模板 + 原生规则数组都要转对
const docs = [
  {
    id: 'nuclei-jenkins',
    info: { name: 'Jenkins Detect' },
    http: [{
      matchers: [
        { type: 'word', part: 'header', words: ['x-jenkins'] },
        { type: 'dsl', dsl: ['true'] }, // dsl 现在支持了，会转成 dsl matcher
      ],
    }],
  },
  [{ id: 'native-nginx', name: 'Nginx', matchers: [{ type: 'word', part: 'header', words: ['nginx'] }] }],
  { id: 'bad-no-matchers' }, // 无效的要被过滤
];
const norm = JSON.parse(globalThis.goNormalizeRules(JSON.stringify(docs)));
console.log('normalize =', JSON.stringify(norm));
pass &&= norm.rules?.length === 2
  && norm.rules[0].id === 'nuclei-jenkins'
  && norm.rules[0].matchers.length === 2
  && norm.rules[0].matchers[1].type === 'dsl'
  && norm.rules[1].id === 'native-nginx';

// goHashLookup：内置库命中 + 自定义覆盖
const builtin = JSON.parse(globalThis.goHashLookup(-1010568750, '{}'));
const custom = JSON.parse(globalThis.goHashLookup(-1010568750, JSON.stringify({ '-1010568750': '公司内部 PMA' })));
const miss = JSON.parse(globalThis.goHashLookup(42, '{}'));
console.log('hashLookup =', JSON.stringify({ builtin, custom, miss }));
pass &&= builtin.name === 'Phpmyadmin'
  && custom.name === '公司内部 PMA'
  && !miss.name;

// 爬虫调度：同站过滤 + 去重 + 页数上限
globalThis.goCrawlStart('https://www.example.com/', 3);
let b1 = JSON.parse(globalThis.goCrawlBatch(5));
// 注意 done 是"取完这批后队列空了"，不代表该停——urls 为空才是停
pass &&= b1.urls?.length === 1;

// 喂链接：相对/绝对/子域名该收，外站/静态资源/重复（含 # 和尾 / 变体）该丢
const feed = JSON.parse(globalThis.goCrawlFeed('https://www.example.com/', JSON.stringify([
  '/about',                                    // 相对 → 收
  'https://docs.example.com/api',              // 子域名 → 收
  'https://other.com/x',                       // 外站 → 丢
  '/about#section',                            // 和 /about 重复（去 fragment）→ 丢
  '/about/',                                   // 尾斜杠变体 → 丢
  'https://www.example.com/static/app.js',     // 静态资源 → 丢
  'mailto:a@example.com',                      // 非 http → 丢
])));
console.log('crawlFeed =', JSON.stringify(feed));
pass &&= feed.added === 2;

// maxPages=3：seed 已占 1，这批只能再取 2；再取就该空了
let b2 = JSON.parse(globalThis.goCrawlBatch(5));
console.log('crawlBatch =', JSON.stringify(b2));
pass &&= b2.urls?.length === 2;
let b3 = JSON.parse(globalThis.goCrawlBatch(5));
pass &&= (b3.urls?.length || 0) === 0 && b3.done === true;
const st = JSON.parse(globalThis.goCrawlStatus());
pass &&= st.visited === 3;

// dsl 表达式：函数/逻辑/比较/取反/括号/错误处理
const dslOut = JSON.parse(globalThis.goDslEval(JSON.stringify([
  'contains(body, "wp-content")',
  'status == 200 && contains(title, "Blog")',
  'contains(header, "nginx") || status == 404',
  '!contains(body, "Jenkins")',
  '(status == 200 || status == 301) && matches(body, "wp-content/themes/\\w+")',
  'contains(body, "wp-content"',          // 语法错：不闭合
  'contains(body)',                       // 参数不够
  'favicon_hash == 42 && status != 404',
]), JSON.stringify(features)));
console.log('dsl =', JSON.stringify(dslOut));
pass &&= JSON.stringify(dslOut.results) === JSON.stringify([true, true, true, true, true, false, false, true])
  && dslOut.errors[5] !== '' && dslOut.errors[6] !== '';

// dsl 也走 matcher 通道（nuclei 模板里的 dsl 会被转换过来）
const dslRules = [{
  id: 'dsl-test', name: 'DSL Test',
  matchers: [{ type: 'dsl', dsl: ['contains(body, "wp-content") && status == 200'] }],
}];
const dslMatch = JSON.parse(globalThis.goMatch(JSON.stringify(dslRules), JSON.stringify(features)));
pass &&= dslMatch.hits?.length === 1 && dslMatch.hits[0].evidence[0].type === 'dsl';

// goConvertWappalyzer：headers/meta/html/cookies 转换 + \; 后缀清理 + RE2 不兼容的丢弃
const wapp = JSON.parse(globalThis.goConvertWappalyzer(JSON.stringify({
  'WordPress': {
    headers: { 'X-Pingback': '' },
    meta: { generator: ['WordPress(?: ([\\d.]+))?\\;version:\\1'] },
    html: ['/wp-content/'],
    cookies: { 'wp-settings-1': '' },
  },
  'Bad Tech': { html: ['(unclosed\\1'] }, // RE2 编译不了，整个丢掉
  'Empty': {},
})));
console.log('wappalyzer =', JSON.stringify(wapp.rules.map((r) => r.id)));
const wpRule = wapp.rules.find((r) => r.id === 'wordpress');
pass &&= !!wpRule
  && wpRule.matchers.some((m) => m.part === 'header')
  && wpRule.matchers.some((m) => m.part === 'meta' && !m.regex[0].includes('\\;version'))
  && wpRule.matchers.some((m) => m.part === 'body')
  && !wapp.rules.some((r) => r.id === 'bad-tech' || r.id === 'empty');
// 转换出来的规则得能直接用
const wappMatch = JSON.parse(globalThis.goMatch(JSON.stringify(wapp.rules), JSON.stringify(features)));
pass &&= wappMatch.hits.some((h) => h.id === 'wordpress');

// goConvertEHole：keyword/faviconhash 分组转换
const ehole = JSON.parse(globalThis.goConvertEHole(JSON.stringify({
  fingerprint: [
    { cms: '致远OA', method: 'keyword', location: 'body', keyword: ['/seeyon/'] },
    { cms: '致远OA', method: 'faviconhash', location: 'body', keyword: '-123456' },
    { cms: '致远OA', method: 'keyword', location: 'icon', keyword: ['x'] }, // location 不支持，丢
    { cms: '', method: 'keyword', location: 'body', keyword: ['y'] },        // 没名字，丢
  ],
})));
console.log('ehole =', JSON.stringify(ehole.rules));
pass &&= ehole.rules?.length === 1
  && ehole.rules[0].id === '致远oa'
  && ehole.rules[0].name === '致远OA'
  && ehole.rules[0].matchers.length === 2
  && ehole.rules[0].matchers.some((m) => m.type === 'icon_hash' && m.hash[0] === -123456);

// js / dom / implies 三件套
const probeRules = [
  {
    id: 'react', name: 'React', implies: ['React DOM', 'JSX'],
    matchers: [{ type: 'js', js: [{ path: 'React.version', pattern: '^\\d+\\.' }, { path: 'Vue' }] }],
  },
  {
    id: 'shopify', name: 'Shopify',
    matchers: [{ type: 'dom', words: ['div.shopify-section', 'html'] }],
  },
  { id: 'react-dom', name: 'React DOM', implies: ['Scheduler'], matchers: [{ type: 'status', status: [999] }] }, // 规则存在但自身不命中
];
const probeFeatures = {
  ...features,
  js: { 'React.version': '18.2.0' },       // React.version 在，Vue 不在
  dom: ['html', 'div.shopify-section'],     // 两个选择器都中
};
const probeOut = JSON.parse(globalThis.goMatch(JSON.stringify(probeRules), JSON.stringify(probeFeatures)));
const probeNames = probeOut.hits.map((h) => h.name);
console.log('probe hits =', probeNames.join(', '));
const reactHit = probeOut.hits.find((h) => h.name === 'React');
pass &&= !!reactHit
  && reactHit.evidence.some((e) => e.type === 'js' && e.detail.includes('React.version'))
  && probeNames.includes('Shopify')                       // dom 命中
  && probeNames.includes('React DOM')                     // implies 一级
  && probeNames.includes('Scheduler')                     // implies 二级（级联）
  && probeNames.includes('JSX')                           // implies 裸命中（没有对应规则）
  && probeOut.hits.find((h) => h.name === 'Scheduler').evidence[0].type === 'implies';

// js 不在时不该命中
const noJs = JSON.parse(globalThis.goMatch(JSON.stringify(probeRules.slice(0, 1)), JSON.stringify(features)));
pass &&= noJs.hits.length === 0;

// wappalyzer 转换保留 js/dom/implies
const wapp2 = JSON.parse(globalThis.goConvertWappalyzer(JSON.stringify({
  'Next.js': {
    html: ['__NEXT_DATA__'],
    js: { 'next.version': '' },
    dom: { '#__next': { exists: '' } },
    implies: 'React\\;confidence:50',
  },
})));
const nextRule = wapp2.rules[0];
console.log('nextjs rule =', JSON.stringify(nextRule.matchers.map((m) => m.type)), 'implies =', nextRule.implies);
pass &&= nextRule.matchers.some((m) => m.type === 'js')
  && nextRule.matchers.some((m) => m.type === 'dom' && m.dom.some((p) => p.sel === '#__next'))
  && nextRule.implies?.[0] === 'React';

// 正则防御：大重复驯化 + 深层嵌套拦截
const defense = JSON.parse(globalThis.goConvertWappalyzer(JSON.stringify({
  'Livewire': { html: ['<[^>]{1,512}\\bwire:'] },            // {1,512} → {1,}
  'Deep Nest': { html: ['(' + 'a('.repeat(60) + 'x' + ')'.repeat(61)] }, // 61 层嵌套 → 丢弃
})));
const lw = defense.rules.find((r) => r.id === 'livewire');
const dn = defense.rules.find((r) => r.id === 'deep-nest');
console.log('defense: livewire =', lw?.matchers?.[0]?.regex?.[0] ?? lw?.matchers?.[0]?.type, '| deep-nest =', dn ? JSON.stringify(dn.matchers) : '规则被丢弃');
pass &&= lw && lw.matchers.some((m) => m.regex?.[0]?.includes('{1,}'));
// 深嵌套的 body matcher 被丢，但如果整个规则没有其他 matcher 就没有这条规则
pass &&= !dn || dn.matchers.every((m) => !m.regex?.some((r) => r.includes('a(a(a(a(a(')));

// 选择器信息量过滤 + dom 条件保留 + excludes
const noise = JSON.parse(globalThis.goConvertWappalyzer(JSON.stringify({
  'Qwik': { dom: '*' },                                    // 通配 → 整条规则丢弃
  'Preact': { dom: { '#app, body > *': { properties: { '__k': '' } } } }, // properties 没法探 → 丢弃
  'Open Graph': { dom: "meta[property*='og:']" },          // 有属性 → 保留
  'Wagtail': { dom: { '[data-block-key]': { attributes: { 'data-block-key': '^[a-z0-9]{5}$' } } }, implies: ['Django'] },
  'Apple Sign-in': { dom: { 'button': { text: 'Sign in with Apple' } } }, // 裸标签但有文本条件 → 保留
  'Multi': { dom: { 'div, span': { exists: '' }, '.real-class': { exists: '' } } }, // 部分保留
})));
const noiseIds = noise.rules.map((r) => r.id);
console.log('noise filter =', noiseIds.join(','));
pass &&= !noiseIds.includes('qwik') && !noiseIds.includes('preact')
  && noiseIds.includes('open-graph') && noiseIds.includes('wagtail') && noiseIds.includes('apple-sign-in');
const multi = noise.rules.find((r) => r.id === 'multi');
pass &&= multi && multi.matchers[0].dom.length === 1 && multi.matchers[0].dom[0].sel === '.real-class';
const wagtail = noise.rules.find((r) => r.id === 'wagtail');
pass &&= wagtail.matchers[0].dom[0].attrs?.['data-block-key'] === '^[a-z0-9]{5}$'
  && wagtail.implies?.[0] === 'Django';
const apple = noise.rules.find((r) => r.id === 'apple-sign-in');
pass &&= apple.matchers[0].dom[0].sel === 'button' && apple.matchers[0].dom[0].text === 'Sign in with Apple';

// 带条件的 dom 探测匹配（条件评估在 content.js，wasm 只看选择器在不在命中列表里）
const domRules = [{
  id: 'wagtail', name: 'Wagtail',
  matchers: [{ type: 'dom', dom: [{ sel: '[data-block-key]', attrs: { 'data-block-key': '^[a-z0-9]{5}$' } }] }],
}];
const domHit = JSON.parse(globalThis.goMatch(JSON.stringify(domRules), JSON.stringify({ ...features, dom: ['[data-block-key]'] })));
const domMiss = JSON.parse(globalThis.goMatch(JSON.stringify(domRules), JSON.stringify({ ...features, dom: ['other'] })));
pass &&= domHit.hits.length === 1 && domMiss.hits.length === 0;

// excludes：A 命中后 B 被压制
const exRules = [
  { id: 'a', name: 'TechA', excludes: ['TechB'], matchers: [{ type: 'status', status: [200] }] },
  { id: 'b', name: 'TechB', matchers: [{ type: 'status', status: [200] }] },
];
const exOut = JSON.parse(globalThis.goMatch(JSON.stringify(exRules), JSON.stringify(features)));
const exNames = exOut.hits.map((h) => h.name);
console.log('excludes =', exNames.join(','));
pass &&= exNames.includes('TechA') && !exNames.includes('TechB');

// header 值模式的 ^ 锚点剥除（GitHub Pages 规则就是这么死的）
const anchor = JSON.parse(globalThis.goConvertWappalyzer(JSON.stringify({
  'GitHub Pages': { headers: { 'Server': '^GitHub\\.com$' } },
})));
const ghRule = anchor.rules[0];
const ghPattern = ghRule.matchers[0].regex[0];
console.log('anchor pattern =', ghPattern);
pass &&= !ghPattern.includes('\\s*^'); // 中间不能有第二个 ^
// 转换出来的规则得能匹配 "server: GitHub.com\n" 这种行
const ghHit = JSON.parse(globalThis.goMatch(JSON.stringify(anchor.rules), JSON.stringify({
  ...features, headers: { server: 'GitHub.com', 'x-github-request-id': 'abc' },
})));
pass &&= ghHit.hits.some((h) => h.name === 'GitHub Pages');
const ghMiss = JSON.parse(globalThis.goMatch(JSON.stringify(anchor.rules), JSON.stringify({
  ...features, headers: { server: 'GitHub.com.evil.com' },
})));
pass &&= ghMiss.hits.length === 0; // $ 锚点还在，前缀相同不算中

// "值里包含"语义：CSP 中间的 s3 引用要能中（之前的 \s* 强制从头匹配把这批规则杀了）
const csp = JSON.parse(globalThis.goConvertWappalyzer(JSON.stringify({
  'Amazon S3': { headers: { 'Content-Security-Policy': 's3[^ ]*amazonaws\\.com' } },
})));
const cspHit = JSON.parse(globalThis.goMatch(JSON.stringify(csp.rules), JSON.stringify({
  ...features, headers: { 'content-security-policy': "default-src 'self'; connect-src s3.amazonaws.com" },
})));
pass &&= cspHit.hits.some((h) => h.name === 'Amazon S3');

// 置信度：matcher 级 or 取 max、and 取 min、规则级缩放、implies 继承、没标就是 null
const confRules = [
  { id: 'or-rule', name: 'OrRule', matchers: [
    { type: 'status', status: [200], confidence: 40 },
    { type: 'word', words: ['wp-content'], confidence: 90 },
  ] },
  { id: 'and-rule', name: 'AndRule', 'matchers-condition': 'and', matchers: [
    { type: 'status', status: [200], confidence: 40 },
    { type: 'word', words: ['wp-content'] }, // 没标 = 100
  ] },
  { id: 'scaled', name: 'Scaled', confidence: 50, implies: ['ScaledChild'], matchers: [
    { type: 'status', status: [200], confidence: 80 },
  ] },
  { id: 'plain', name: 'Plain', matchers: [{ type: 'status', status: [200] }] },
];
const confOut = JSON.parse(globalThis.goMatch(JSON.stringify(confRules), JSON.stringify(features)));
const confOf = (id) => confOut.hits.find((h) => h.id === id)?.confidence;
console.log('confidence =', confOut.hits.map((h) => `${h.id}:${h.confidence}`).join(', '));
pass &&= confOf('or-rule') === 90        // or → 最强信号
  && confOf('and-rule') === 40           // and → 最短板
  && confOf('scaled') === 40             // 80 × 规则级 50%
  && confOf('scaledchild') === 40        // implies 继承来源
  && confOf('plain') === null;           // 啥都没标 → 不编分

// wappalyzer 的 \;confidence:N 后缀要转进 matcher；同字段不同置信度要拆开，
// 避免只命中高分模式时被未命中的低分模式拖低
const wappConf = JSON.parse(globalThis.goConvertWappalyzer(JSON.stringify({
  'WeakTech': { html: ['<div id="app"\\;confidence:30', 'webpack\\;confidence:60'] },
  'StrongTech': { meta: { generator: 'StrongTech\\;confidence:95\\;version:\\1' } },
})));
const weak = wappConf.rules.find((r) => r.id === 'weaktech');
const strong = wappConf.rules.find((r) => r.id === 'strongtech');
console.log('wapp confidence =', JSON.stringify(wappConf.rules.map((r) => [r.id, r.matchers.map((m) => m.confidence ?? null)])));
const weakWebpackOnly = JSON.parse(globalThis.goMatch(JSON.stringify([weak]), JSON.stringify({
  ...features, body: '<html><script>webpack</script></html>',
})));
const noWappConf = JSON.parse(globalThis.goConvertWappalyzer(JSON.stringify({
  'NoConfTech': { html: ['no-conf-marker'] },
})));
const noWappConfHit = JSON.parse(globalThis.goMatch(JSON.stringify(noWappConf.rules), JSON.stringify({
  ...features, body: 'no-conf-marker',
})));
pass &&= weak && weak.matchers.some((m) => m.confidence === 30)
  && weak.matchers.some((m) => m.confidence === 60)
  && weakWebpackOnly.hits[0]?.confidence === 60
  && strong && strong.matchers[0].confidence === 95
  && !strong.matchers[0].regex[0].includes('\\;')     // 后缀还是切干净的
  && noWappConf.rules[0].matchers.every((m) => !('confidence' in m))
  && noWappConfHit.hits[0]?.confidence === null;

console.log(pass ? '✅ 冒烟测试通过' : '❌ 结果不符合预期');
process.exit(pass ? 0 : 1);
