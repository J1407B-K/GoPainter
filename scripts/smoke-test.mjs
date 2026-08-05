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

console.log(pass ? '✅ 冒烟测试通过' : '❌ 结果不符合预期');
process.exit(pass ? 0 : 1);
