// Lightweight extension UI localization. Technical fingerprints and user-provided
// names remain untouched; only bundled interface copy is translated.
(() => {
  const LOCALE_KEY = 'uiLocale';
  const DEFAULT_LOCALE = 'zh-CN';
  let locale = DEFAULT_LOCALE;
  const originals = new WeakMap();
  const attributeOriginals = new WeakMap();
  const translatedNodes = new WeakMap();
  const originalTitle = document.title;

  const en = {
    '设置与数据管理': 'Settings & data management', '设置': 'Settings',
    '指纹规则': 'Fingerprint rules', '规则体检': 'Rule health', '置信度': 'Confidence',
    '第三方规则源': 'Third-party rule sources', 'favicon 哈希库': 'Favicon hash database',
    '书签分类': 'Bookmark organization', '扫描历史与报告': 'Scan history & reports',
    '站点爬取': 'Site crawl', 'AI 与 Agent': 'AI & Agent',
    '当前编辑集': 'Active rule set', '参与匹配的规则集': 'Rule sets used for matching',
    '全部启用': 'Enable all', '仅当前': 'Current only', '新建并切换': 'Create & switch',
    '删除当前集': 'Delete current set', '导入内置规则库': 'Import built-in rules',
    '导出当前集': 'Export current set', '清空规则': 'Clear rules',
    '开始体检全部规则集': 'Check all rule sets', '规则详情': 'Rule details', '关闭': 'Close',
    '复制 YAML': 'Copy YAML', '规则冲突': 'Rule conflict', '旧规则': 'Existing rule',
    '新规则': 'Incoming rule', '保留旧规则': 'Keep existing', '覆盖规则': 'Replace rule',
    '剩余全部保留': 'Keep all remaining', '剩余全部覆盖': 'Replace all remaining', '取消导入': 'Cancel import',
    '按置信度排序': 'Sort by confidence', '保存': 'Save', '导入': 'Import',
    '清空自定义': 'Clear custom entries', '加载书签列表': 'Load bookmarks', '全选': 'Select all',
    '整理选中': 'Organize selected', '历史保留上限（滚动窗口）': 'History limit (rolling window)',
    '保存上限': 'Save limit', '导出 JSON': 'Export JSON', '导出 CSV': 'Export CSV',
    '清空历史': 'Clear history', '起始 URL': 'Start URL', '最大页数': 'Maximum pages',
    '开始爬取': 'Start crawl', '停止': 'Stop', '模型': 'Model',
    'Agent 工具调用协议': 'Agent tool-call protocol', '测试工具调用（可能产生 API 消耗）': 'Test tool calls (may use API credits)',
    '提示词': 'Prompts', '恢复默认': 'Restore default', '保存 AI 配置': 'Save AI settings',
    '编辑集': 'Rule set', '加载中…': 'Loading…', '爬取本站': 'Crawl site',
    '技术名，如 WordPress': 'Technology name, e.g. WordPress',
    '✨ 生成': '✨ Generate', '✅ 保存规则': '✅ Save rule', '丢弃': 'Discard',
    '留空 = 不限': 'Leave blank = unlimited', '取消': 'Cancel',
    '目标': 'Goal', '识别当前网站': 'Identify current site', '研究指纹规则': 'Research fingerprint rule',
    '优化规则建议': 'Optimize rule suggestion', '技术名': 'Technology name',
    '选择当前编辑集中的规则': 'Choose a rule in the active set', '执行': 'Run',
    '导入规则': 'Import rule', '需要授权': 'Permission required', '允许本次调用': 'Allow once',
    '本次会话始终允许': 'Always allow this session', '拒绝': 'Deny',
    '未运行': 'Not running', '爬取中': 'Crawling', '已中断': 'Interrupted',
    '爬取结果': 'Crawl results', '尚未爬取': 'No crawl yet',
    'GoPainter 爬取': 'GoPainter Crawl',
    '选择 YAML 文件导入（支持多选）': 'Choose YAML files to import (multiple supported)',
    '规则（或单条 matcher）可以标': 'Rules (or individual matchers) can specify',
    '规则未命中时用 AI 判断（慢，每个书签一次 AI 调用）': 'Use AI when rules do not match (slow; one call per bookmark)',
    '普通 AI 功能继续使用 OpenAI 兼容接口。Agent 工具调用可额外选择 OpenAI 兼容或 Anthropic Messages 协议。': 'Standard AI uses an OpenAI-compatible API. Agent tool calls can additionally use OpenAI-compatible or Anthropic Messages protocols.',
    '支持 GoPainter 原生格式（见 rules/examples.yaml）和 nuclei 模板（自动提取 http matchers 子集）。 可多选文件，同 id 规则会在当前编辑集覆盖更新；可同时启用多个规则集参与匹配。': 'Supports GoPainter-native rules (see rules/examples.yaml) and nuclei templates (the HTTP matcher subset is extracted automatically). Import multiple files; matching can use any combination of rule sets.',
    '支持 GoPainter 原生格式（见 rules/examples.yaml）和 nuclei 模板（自动提取 http matchers 子集）。': 'Supports GoPainter-native rules (see rules/examples.yaml) and nuclei templates (the HTTP matcher subset is extracted automatically).',
    '可多选文件，同 id 规则会在当前编辑集覆盖更新；可同时启用多个规则集参与匹配。': 'Import multiple files; rules with the same ID are updated in the active rule set, and matching can use any combination of rule sets.',
    '不改动任何规则，只评估 regex 的': 'Does not change any rules; evaluates only regex ',
    '有效性与扫描成本': 'validity and scan cost',
    '，不把性能指标冒充识别准确率。 每个规则集的 regex pattern 会按 AST 结构分类：': ', without presenting performance metrics as detection accuracy. Each rule set’s regex patterns are classified by AST structure:',
    '具备 ASCII 预筛条件': 'ASCII prefilter available',
    '（含必需 ASCII 字面量；仅表示页面缺少该字面量时可以安全跳过）、': ' (contains a required ASCII literal; the rule can safely be skipped only when that literal is absent),',
    '非 ASCII 护栏': 'Non-ASCII guardrail',
    '（必需字面量含非 ASCII，SimpleFold 护栏下字面量预筛不参与）、': ' (a required literal contains non-ASCII characters, so literal prefiltering is disabled by the SimpleFold guardrail),',
    '无预筛锚点': 'No prefilter anchor',
    '（无必需字面量，如纯字符类、锚点或全可选结构，字面量预筛无法证明不匹配）。 无预筛锚点的正则需要人工复核：它可能是有意设计，也可能过宽。 这些是结构能力，不是某个页面的实际跳过率；实际执行情况取决于页面内容。 长/短锚点榜按“最弱分支代表锚点的字母/数字有效字符数”粗排，只用于发现可能高频的短锚点，不代表实测热度。 “无效”表示生产引擎无法解析，应优先修复；技术指纹是否真实、稳定仍需结合命中证据判断。': ' (there is no required literal—for example a character class, anchor, or fully optional structure—so a literal prefilter cannot prove a miss). Rules without a prefilter anchor need manual review: this may be intentional, or may be too broad. These are structural properties, not actual per-page skip rates; runtime behavior depends on page content. Short and long anchor lists are ranked by the representative anchor’s effective alphanumeric length in the weakest branch; they are only heuristics and not measured popularity. “Invalid” means the production engine cannot parse the expression and should be fixed first; confirm fingerprint reliability from the evidence.',
    '（无必需字面量，如纯字符类、锚点或全可选结构，字面量预筛无法证明不匹配）。': ' (there is no required literal—for example a character class, anchor, or fully optional structure—so a literal prefilter cannot prove a miss).',
    '无预筛锚点的正则需要人工复核：它可能是有意设计，也可能过宽。': 'Regexes without a prefilter anchor need manual review: this may be intentional, or may be too broad.',
    '这些是结构能力，不是某个页面的实际跳过率；实际执行情况取决于页面内容。': 'These are structural properties, not actual per-page skip rates; runtime behavior depends on page content.',
    '长/短锚点榜按“最弱分支代表锚点的字母/数字有效字符数”粗排，只用于发现可能高频的短锚点，不代表实测热度。': 'Short and long anchor lists are ranked by the representative anchor’s effective alphanumeric length in the weakest branch; they are only heuristics and not measured popularity.',
    '“无效”表示生产引擎无法解析，应优先修复；技术指纹是否真实、稳定仍需结合命中证据判断。': '“Invalid” means the production engine cannot parse the expression and should be fixed first; confirm fingerprint reliability from the evidence.',
    '，数值越低表示信号越弱 （比如「页面声明了 manifest」只是 PWA 候选，标 30；meta generator 这种强信号标 90）。 Wappalyzer 源自带的置信度拉取时会自动转进来。 开启排序后，弹窗每条都会显示置信度：已标注显示百分比，未标注显示': '; lower values indicate weaker evidence (for example, a declared manifest is only a PWA candidate and might use 30, while a generator meta tag is strong evidence and might use 90). Wappalyzer confidence values are imported automatically. When sorting is enabled, the popup shows a percentage for annotated hits and ',
    '，数值越低表示信号越弱': '; lower values indicate weaker evidence',
    '（比如「页面声明了 manifest」只是 PWA 候选，标 30；meta generator 这种强信号标 90）。': ' (for example, a declared manifest is only a PWA candidate and might use 30, while a generator meta tag is strong evidence and might use 90).',
    'Wappalyzer 源自带的置信度拉取时会自动转进来。': 'Wappalyzer confidence values are imported automatically.',
    '开启排序后，弹窗每条都会显示置信度：已标注显示百分比，未标注显示': 'When sorting is enabled, the popup shows a percentage for annotated hits and ',
    '；排序和阈值只作用于数字置信度。': ' for unannotated hits; sorting and thresholds apply only to numeric confidence.',
    '隐藏低于此置信度的命中（0 = 不隐藏）': 'Hide hits below this confidence (0 = do not hide)',
    '以下规则源由各自社区维护。点击后由你的浏览器实时拉取并转换入库（同 id 覆盖），': 'These sources are maintained by their communities. Clicking fetches and converts them in your browser (same IDs are replaced).',
    '规则数据不随本扩展分发': 'Rule data is not distributed with this extension',
    '。第三方源的内容、版权与合规性由其维护者和使用者自行负责，': '. Their content, licensing, and compliance are the responsibility of their maintainers and users.',
    '你的拉取与使用行为与本项目无关。': 'Your fetching and use are independent of this project.',
    '。第三方源的内容、版权与合规性由其维护者和使用者自行负责， 你的拉取与使用行为与本项目无关。': '. Their content, licensing, and compliance are the responsibility of their maintainers and users.',
    'Wappalyzer 社区版': 'Wappalyzer Community Edition', '几千条 Web 技术指纹（headers/meta/html/script/cookie/url）': 'Thousands of web technology fingerprints (headers/meta/html/script/cookie/url)',
    '拉取入库': 'Fetch & import', '958 条指纹，国产系统覆盖好（关键词 + faviconhash）': '958 fingerprints, with strong coverage of Chinese products (keywords + favicon hashes)',
    'http/technologies 目录的技术识别模板（文件多，拉取较慢）': 'Technology-detection templates from http/technologies (many files; slower to fetch)',
    '内置 956 条（': 'Includes 956 entries (', 'BishopFox 数据集': 'BishopFox dataset',
    '）。 自定义条目优先于内置同名哈希，适合补充公司内部系统。': '). Custom entries override built-in hashes with the same name, which is useful for internal systems.',
    '加载书签列表后勾选想整理的，抓页面跑指纹匹配，命中的挪进书签栏「🎨 指纹分类」下以系统命名的子文件夹（比如命中 nginx 的挪到「Nginx」）。 没勾选的一律不动；需要登录或已失效的书签会抓取失败，跳过不影响。': 'Select bookmarks to organize, fetch their pages, and match fingerprints. Matches are moved into system-named folders under “🎨 Fingerprints” in the bookmarks bar (for example, an nginx hit goes to “Nginx”). Unselected bookmarks are never changed; inaccessible or expired bookmarks are skipped.',
    '保留页面/爬取扫描的摘要：URL、标题、状态码、favicon 哈希和命中证据。不保存页面 HTML、响应头或 API Key。': 'Stores page/crawl summaries: URL, title, status, favicon hashes, and match evidence. It does not store page HTML, response headers, or API keys.',
    '从起始 URL 递归抓取同站点页面并逐一做指纹识别（含哈希库），自动去重。 最大页数留空 = 一直爬到没有新链接；填 100 = 最多扫 100 个页面。': 'Recursively crawls same-site pages from the start URL and fingerprints each one (including the hash database), with automatic deduplication. Leave maximum pages blank to continue until no new links remain; enter 100 to scan at most 100 pages.',
    '仅文本（不支持工具）': 'Text only (tools unavailable)',
    '工具调用测试会发送两次极短 API 请求，可能产生 token/API 费用；仅调用本地无副作用的': 'Tool-call testing sends two very small API requests and may incur token/API costs; it calls only the local, side-effect-free ',
    '工具。': ' tool.', '（留空则用默认，四个场景互不影响）': '(leave blank to use defaults; the four scenarios are independent)',
    'AI 技术栈识别': 'AI technology identification', 'AI 新建规则': 'AI new rule', 'AI 优化规则': 'AI rule optimization', '书签 AI 兜底分类': 'AI bookmark fallback classification',
    '合并选中': 'Merge selected', '切换当前编辑规则集': 'Switch active rule set',
    '正在加载规则…': 'Loading rules…', '当前编辑集为空': 'The active rule set is empty', '没有匹配规则': 'No matching rules',
    '（空）': '(empty)', '（无标题）': '(Untitled)', '无 regex': 'No regex', '结构正常': 'Structure looks good',
    '该规则集没有 regex 匹配器。': 'This rule set has no regex matchers.', '无数据': 'No data', '无法解析': 'Cannot parse',
    '短锚点榜（更可能高频，仅结构启发）': 'Short anchor list (possibly high-frequency; structural heuristic only)',
    '长锚点榜（更具区分度，仅结构启发）': 'Long anchor list (more distinctive; structural heuristic only)',
    '无效正则明细': 'Invalid regex details', '无预筛锚点明细': 'No-prefilter-anchor details',
    '生产引擎无法解析': 'Not parseable by the production engine', '参与匹配': 'Used for matching',
    '最终生效': 'Effective', '被覆盖': 'Overridden', '当前生效': 'Currently effective',
    '尚无扫描记录': 'No scan history yet', '未知时间': 'Unknown time', '页面': 'Page', '爬取': 'Crawl',
    '— 未识别': '— No match', '抓取失败': 'Fetch failed', '未知错误': 'Unknown error',
    '正在体检全部规则集…': 'Checking all rule sets…', '当前没有规则集': 'There are no rule sets',
    '体检失败': 'Health check failed', '测试中：将执行 ping 工具调用并回填结果…': 'Testing: running the ping tool call and returning its result…',
    '测试未完成': 'Test did not complete', 'AI 配置已保存': 'AI settings saved', '置信度设置已保存': 'Confidence settings saved',
    '保存规则失败': 'Failed to save rules', '规则入库失败': 'Failed to add rule', '规则转换失败': 'Rule conversion failed',
    '更新规则版本失败': 'Failed to update rule version', '切换编辑集失败': 'Failed to switch rule set',
    '更新启用规则集失败': 'Failed to update enabled rule sets', '新建规则集失败': 'Failed to create rule set',
    '删除规则集失败': 'Failed to delete rule set', '至少保留一个规则集': 'At least one rule set must remain',
    '请填写规则集名称': 'Enter a rule set name', '规则 YAML 已复制': 'Rule YAML copied', '复制失败，请手动选择复制': 'Copy failed; select and copy manually',
    '已取消导入，没有修改当前编辑集': 'Import cancelled; the active rule set was not changed', '已取消导入内置规则库': 'Built-in rule import cancelled',
    '当前编辑集没有可导出的规则': 'The active rule set has no rules to export', '当前编辑集已清空': 'Active rule set cleared',
    '没解析出有效条目，格式：哈希 名称（每行一条）或 JSON': 'No valid entries found. Use “hash name” per line or JSON.',
    '确定清空自定义哈希？内置库不受影响。': 'Clear all custom hashes? The built-in database is unaffected.',
    '自定义哈希已清空': 'Custom hashes cleared', '保存扫描历史上限失败': 'Failed to save scan history limit',
    '确定清空全部扫描历史？此操作无法撤销。': 'Clear all scan history? This cannot be undone.',
    '清空扫描历史失败': 'Failed to clear scan history', '扫描历史已清空': 'Scan history cleared',
    '起始 URL 得是 http/https': 'Start URL must use http or https', '最大页数要么是空，要么是正整数': 'Maximum pages must be blank or a positive integer',
    '置信度阈值得是 0-100 的整数': 'Confidence threshold must be an integer from 0 to 100',
    '生成中…': 'Generating…', '优化中…': 'Optimizing…', '新建规则': 'New rule', '优化此规则': 'Optimize this rule',
    '覆盖当前规则': 'Replace current rule', '已有命中': 'Already matched', '已有规则': 'Existing rule', '新': 'New',
    '当前 AI 无合理优化建议': 'The AI has no reasonable optimization suggestion',
    '本次会话允许此来源': 'Allow this origin for this session',
    'GoPainter 设置': 'GoPainter Settings', '加载中': 'Loading', '扫描历史': 'Scan history',
    'EHole 棱洞': 'EHole', '自定义条目优先于内置同名哈希，适合补充公司内部系统。': 'Custom entries override built-in hashes with the same name, which is useful for internal systems.',
    '没勾选的一律不动；需要登录或已失效的书签会抓取失败，跳过不影响。': 'Unselected bookmarks are never changed; inaccessible or expired bookmarks are skipped.',
    '最大页数留空 = 一直爬到没有新链接；填 100 = 最多扫 100 个页面。': 'Leave maximum pages blank to continue until no new links remain; enter 100 to scan at most 100 pages.',
    '规则无变化': 'Rule unchanged', '已导入': 'Imported', '已覆盖入库': 'Replaced in rule set',
    '已保留旧规则': 'Kept existing rule', '已取消规则入库。': 'Rule import cancelled.',
    '当前编辑集中没有可优化的规则。': 'There are no optimizable rules in the active rule set.',
    '研究规则时，请填写技术名。': 'Enter a technology name to research a rule.',
    '执行中…': 'Running…', '整理中…（选得多的话要等一会）': 'Organizing… (this can take a while for many bookmarks)',
    '🗂 整理选中': '🗂 Organize selected', '默认提示词：': 'Default prompt:',
    '拉取中…': 'Fetching…', '转换中…': 'Converting…',
    '已启用全部规则集': 'All rule sets enabled', '已仅启用当前编辑集': 'Only the active rule set is enabled',
    '切换到中文': 'Switch to Chinese',
    '默认规则集': 'Default rule set', '由 cdnjs 推导': 'Derived from cdnjs',
    'YAML 里没有有效规则': 'No valid rules in the YAML', '规则集不存在': 'Rule set does not exist',
    '该规则版本不存在或对应规则集未启用': 'This rule version does not exist or its rule set is disabled',
    'Agent 必须交付且只能交付一条完整规则': 'The Agent must deliver exactly one complete rule',
    '规则必须是数组': 'Rules must be an array', '规则状态已更新，请刷新后重试': 'Rule state changed; refresh and try again',
    '已有同名规则集': 'A rule set with this name already exists', '已有爬取任务在跑': 'A crawl is already running',
    '没有当前页面的特征，请先刷新页面': 'Current page features are unavailable; refresh the page first',
    '优化结果里没有有效规则': 'No valid rule in the optimization result',
    '请先在设置页配置 AI（baseURL / API Key / 模型）': 'Configure AI first in Settings (base URL / API key / model)',
    '当前 Agent 协议不支持工具调用': 'The selected Agent protocol does not support tool calling',
    '纯文本协议不支持工具调用测试': 'The text-only protocol does not support tool-call testing',
    '请填写 Base URL、API Key 和模型': 'Enter a Base URL, API key, and model',
    'Agent 已在执行中': 'Agent is already running', 'Agent 已取消': 'Agent cancelled',
    '超过单轮 6 个工具调用上限': 'Exceeded the limit of six tool calls in one round',
    '重复的工具调用': 'Duplicate tool call',
    '模型最终产物已通过结构与原生验证绑定，目标完成': 'The final model artifact passed structural and native validation; goal complete',
    '模型返回了空交付，已回填状态并继续同一会话': 'The model returned an empty deliverable; status was fed back and the same session continues',
    '最终规则未与本会话成功验证的候选匹配，已回填并继续同一会话': 'The final rule did not match a candidate validated in this session; status was fed back and the same session continues',
    '模型产物未通过宿主结构校验，已回填错误并继续同一会话': 'The model artifact did not pass host structural validation; the error was fed back and the same session continues',
    '模型返回最终结论': 'Model returned a final conclusion', 'Agent 步数预算已用尽，未取得有效最终交付': 'Agent step budget exhausted without a valid final deliverable',
    '模型在最大步数内没有提交通过校验的最终产物。': 'The model did not submit a validated final artifact within the maximum number of steps.',
    '当前页面尚无特征，请先刷新页面': 'Current page features are not available; refresh the page first',
    '不允许读取其他标签页': 'Reading other tabs is not allowed', '需要当前页面上下文': 'Current page context is required',
    '不允许访问本地或内部主机': 'Access to local or internal hosts is not allowed',
    '不允许访问私有、本地或保留地址': 'Access to private, local, or reserved addresses is not allowed',
    'fetch_url 只允许 HTTPS URL': 'fetch_url accepts HTTPS URLs only', 'url 必须是完整的 HTTPS URL': 'URL must be a complete HTTPS URL',
    'URL 不允许包含账号凭据': 'URL must not include credentials', '只允许标准 HTTPS 端口': 'Only the standard HTTPS port is allowed',
    '重定向处理失败': 'Redirect processing failed',
  };

  // Dynamic messages include counts, rule names, and API errors. Exact entries above
  // handle static copy; these patterns preserve dynamic values while translating UI text.
  const patterns = [
    [/^命中 (\d+) 个指纹(.*)$/, (_, count, suffix) => `${count} fingerprints detected${translate(suffix)}`],
    [/^已扫 (\d+) 页，队列 (\d+)，失败 (\d+)…$/, (_, scanned, queued, failed) => `Scanned ${scanned} pages, queued ${queued}, failed ${failed}…`],
    [/^结束：成功 (\d+) 页，失败 (\d+) 页$/, (_, ok, failed) => `Finished: ${ok} succeeded, ${failed} failed`],
    [/^结束：没有成功页面，失败 (\d+) 页$/, (_, failed) => `Finished: no successful pages; ${failed} failed`],
    [/^自定义 (\d+) 条（内置 956 条）$/, (_, count) => `${count} custom entries (956 built in)`],
    [/^已保存 (\d+) \/ (\d+) 条，最新记录在前$/, (_, count, limit) => `${count} / ${limit} entries saved; newest first`],
    [/^(\d+) 条规则$/, (_, count) => `${count} rules`],
    [/^共 (\d+) 条规则，匹配 (\d+) 条(.*)$/, (_, total, matched, suffix) => `${total} rules; ${matched} matched${translate(suffix)}`],
    [/^仅显示前 (\d+) 条$/, (_, count) => `Showing first ${count}`],
    [/^显示前 (\d+) 条 \/ 共 (\d+) 条$/, (_, shown, total) => `Showing first ${shown} / ${total}`],
    [/^已选 (\d+) 个$/, (_, count) => `${count} selected`],
    [/^已导出 (\d+) 条扫描记录（(JSON|CSV)）$/, (_, count, type) => `Exported ${count} scan records (${type})`],
    [/^扫描历史上限已设为 (\d+) 条$/, (_, count) => `Scan history limit set to ${count}`],
    [/^导入 (\d+) 条自定义哈希$/, (_, count) => `Imported ${count} custom hashes`],
    [/^当前编辑集已切换到「(.+)」$/, (_, name) => `Active rule set switched to “${translateBuiltinName(name)}”`],
    [/^已新建并切换到「(.+)」$/, (_, name) => `Created and switched to “${translateBuiltinName(name)}”`],
    [/^已删除「(.+)」，已切换到「(.+)」$/, (_, deleted, next) => `Deleted “${translateBuiltinName(deleted)}”; switched to “${translateBuiltinName(next)}”`],
    [/^规则 (.+) 已改用「(.+)」版本$/, (_, id, name) => `Rule ${id} now uses “${name}”`],
    [/^还有 (\d+) 项，请输入规则 ID 继续筛选$/, (_, count) => `${count} more items; enter a rule ID to continue filtering`],
    [/^选择 (.+) 的生效版本$/, (_, id) => `Choose the effective version for ${id}`],
    [/^(.+)（(\d+) 条）$/, (_, name, count) => `${translateBuiltinName(name)} (${count} rules)`],
    [/^(\d+) 个重复规则 ID · 请选择生效版本（默认靠后优先）$/, (_, count) => `${count} duplicate rule IDs · choose the effective version (later sets win by default)`],
    [/^最终生效 (\d+)$/, (_, count) => `Effective: ${count}`],
    [/^被覆盖 (\d+)$/, (_, count) => `Overridden: ${count}`],
    [/^「(.+)」共 (\d+) 条规则，匹配 (\d+) 条(.*)$/, (_, name, total, matched, suffix) => `“${translateBuiltinName(name)}”: ${total} rules; ${matched} matched${translate(suffix)}`],
    [/^导入完成：新增 (\d+)，替换 (\d+)，保留旧版 (\d+)，未变化 (\d+)(.*)$/, (_, added, replaced, kept, unchanged, suffix) => `Import complete: ${added} added, ${replaced} replaced, ${kept} existing kept, ${unchanged} unchanged${translate(suffix)}`],
    [/^内置规则库导入完成：新增 (\d+)，替换 (\d+)，保留旧版 (\d+)$/, (_, added, replaced, kept) => `Built-in rule import complete: ${added} added, ${replaced} replaced, ${kept} existing kept`],
    [/^内置规则导入失败：(.*)$/, (_, error) => `Built-in rule import failed: ${error}`],
    [/^已导出「(.+)」的 (\d+) 条规则$/, (_, name, count) => `Exported ${count} rules from “${name}”`],
    [/^(.+)：拉取中…(?: (\d+)\/(\d+))?$/, (_, source, done, total) => `${source}: fetching…${done ? ` ${done}/${total}` : ''}`],
    [/^(.+)：转换中…(?: (\d+)\/(\d+))?$/, (_, source, done, total) => `${source}: converting…${done ? ` ${done}/${total}` : ''}`],
    [/^(.+)：已取消，没有修改当前编辑集$/, (_, source) => `${source}: cancelled; the active rule set was not changed`],
    [/^(.+)：导入完成，(.*)$/, (_, source, summary) => `${source}: import complete, ${translate(summary)}`],
    [/^(.+)：失败：(.*)$/, (_, source, error) => `${source}: failed: ${error}`],
    [/^已启用 (\d+) 个规则集，共 (\d+) 条匹配规则$/, (_, sets, rules) => `${sets} rule sets enabled; ${rules} matching rules`],
    [/^自定义 (\d+) 条（内置 956 条）$/, (_, count) => `${count} custom entries (956 built in)`],
    [/^共扫描 (\d+) 个书签：命中 (\d+)(.*)，已挪入分类文件夹 (\d+)，抓取失败 (\d+)，未识别跳过 (\d+)。$/, (_, total, matched, ai, moved, failed, skipped) => `Scanned ${total} bookmarks: ${matched} matched${translate(ai)}, moved ${moved} into category folders, ${failed} fetch failures, ${skipped} unmatched skipped.`],
    [/^分类：(.*)$/, (_, groups) => `Categories: ${groups}`],
    [/^爬取中：已扫 (\d+) 页，队列 (\d+)，失败 (\d+)，发现链接去重中…$/, (_, scanned, queued, failed) => `Crawling: ${scanned} scanned, ${queued} queued, ${failed} failed; deduplicating discovered links…`],
    [/^任务被系统中断（service worker 被回收）：已保留 (\d+) 页结果，失败 (\d+) 页$/, (_, kept, failed) => `Interrupted by service-worker shutdown: retained ${kept} page results, ${failed} failed`],
    [/^上次验证成功：(.*)$/, (_, date) => `Last verification succeeded: ${date}`],
    [/^验证成功：(.*)$/, (_, result) => `Verified: ${result}`],
    [/^验证失败：(.*)$/, (_, error) => `Verification failed: ${error}`],
    [/^(\d+) 条无效$/, (_, count) => `${count} invalid`],
    [/^(\d+) 条无锚点待复核$/, (_, count) => `${count} without anchors — review needed`],
    [/^显示前 (\d+) 条 \/ 共 (\d+) 条$/, (_, shown, total) => `Showing first ${shown} / ${total}`],
    [/^共 (\d+) 条$/, (_, count) => `${count} total`],
    [/^最弱分支代表锚点：$/, () => 'Representative anchor in weakest branch:'],
    [/^(\d+) 个字母\/数字$/, (_, count) => `${count} alphanumeric characters`],
    [/^共 (\d+) 条 regex pattern；有效率$/, (_, count) => `${count} regex patterns; validity rate `],
    [/^。其中$/, () => '. Of these, '],
    [/^具备潜在跳过条件，$/, () => ' have potential skip conditions; '],
    [/^条无法由字面量预筛跳过；实际跳过数取决于页面内容。$/, () => ' cannot be skipped by literal prefiltering; actual skips depend on page content.'],
    [/^规则冲突：(.+)（(.+)）$/, (_, name, id) => `Rule conflict: ${name} (${id})`],
    [/^规则列表加载失败：(.*)$/, (_, error) => `Failed to load rule list: ${error}`],
    [/^Agent 已完成(?: · (\d+) 步)?$/, (_, steps) => `Agent completed${steps ? ` · ${steps} steps` : ''}`],
    [/^Agent 未完成(?: · (\d+) 步)?$/, (_, steps) => `Agent did not complete${steps ? ` · ${steps} steps` : ''}`],
    [/^执行记录（(\d+) 项，不含模型私有推理）$/, (_, count) => `Execution log (${count} entries; excludes private model reasoning)`],
    [/^第 (\d+) 步 · (.*)$/, (_, step, message) => `Step ${step} · ${translate(message)}`],
    [/^Agent 后台连接中断：(.*)$/, (_, error) => `Agent background connection interrupted: ${error}`],
    [/^Agent 后台连接意外中断，请重试$/, () => 'Agent background connection ended unexpectedly; please try again'],
    [/^来源：(.*)$/, (_, citations) => `Sources: ${citations}`],
    [/^Agent 出错：(.*)$/, (_, error) => `Agent error: ${error}`],
    [/^规则入库失败：(.*)$/, (_, error) => `Failed to add rule: ${error}`],
    [/^(\d+) 个命中都低于置信度阈值$/, (_, count) => `${count} matches are below the confidence threshold`],
    [/^命中 (\d+) 个指纹，展示前 (\d+) 个$/, (_, total, shown) => `${total} fingerprints detected, showing first ${shown}`],
    [/^（隐藏 (\d+) 个低置信度）$/, (_, count) => ` (${count} low-confidence matches hidden)`],
    [/^implies 由 cdnjs 推导$/, () => 'implies Derived from cdnjs'],
    [/^优化规则必须保留原 id：(.*)$/, (_, id) => `Optimized rule must retain its original ID: ${id}`],
    [/^规则 (.+) 不存在$/, (_, id) => `Rule ${id} does not exist`],
    [/^AI 请求失败: HTTP (\d+)$/, (_, status) => `AI request failed: HTTP ${status}`],
    [/^响应体超过 (\d+) 字节上限$/, (_, bytes) => `Response body exceeds the ${bytes}-byte limit`],
    [/^重定向超过 (\d+) 次上限$/, (_, count) => `Redirect limit of ${count} exceeded`],
    [/^跨来源重定向需要单独授权：(.*)$/, (_, url) => `Cross-origin redirect requires separate authorization: ${url}`],
    [/^读取失败: HTTP (\d+)$/, (_, status) => `Read failed: HTTP ${status}`],
    [/^不支持的内容类型：(.*)$/, (_, type) => `Unsupported content type: ${type}`],
    [/^读取 URL 超时（(\d+) 秒）$/, (_, seconds) => `Timed out reading URL after ${seconds} seconds`],
    [/^跳过重复调用：(.*)$/, (_, name) => `Skipped duplicate call: ${name}`],
    [/^未知 Agent 工具：(.*)$/, (_, name) => `Unknown Agent tool: ${name}`],
    [/^工具失败：(.*)（未知 Agent 工具）$/, (_, name) => `Tool failed: ${name} (unknown Agent tool)`],
    [/^工具失败：(.*)（(.*)）$/, (_, name, error) => `Tool failed: ${name} (${error})`],
    [/^工具完成：(.*)$/, (_, name) => `Tool completed: ${name}`],
    [/^模型请求工具：(.*)$/, (_, tools) => `Model requested tools: ${tools}`],
    [/^等待授权：(.*)$/, (_, label) => `Awaiting authorization: ${label}`],
    [/^已授权本次调用：(.*)$/, (_, label) => `Authorized for this call: ${label}`],
    [/^本次会话已始终允许：(.*)$/, (_, label) => `Always allowed this session: ${label}`],
    [/^延后需授权调用：(.*)$/, (_, name) => `Deferred call requiring authorization: ${name}`],
    [/^并发执行 (\d+) 个自动只读工具（并发上限 5）$/, (_, count) => `Running ${count} automatic read-only tools concurrently (limit 5)`],
    [/^(.+)（当前生效）$/, (_, name) => `${name} (currently effective)`],
    [/^(\d+) 条$/, (_, count) => `${count} entries`],
    [/^(.+): 文件超过 5MB，跳过了$/, (_, name) => `${name}: file exceeds 5 MB; skipped`],
    [/^；失败：(.*)$/, (_, errors) => `; failures: ${translate(errors)}`],
    [/^；另有 (\d+) 个$/, (_, count) => `; ${count} more`],
    [/^删除规则集「(.+)」及其中 (\d+) 条规则？$/, (_, name, count) => `Delete rule set “${name}” and its ${count} rules?`],
    [/^仅显示最新 (\d+) 条；导出仍包含全部记录$/, (_, count) => `Showing newest ${count}; exports still include all records`],
    [/^(页面|爬取) · (.*)（HTTP (.*)）$/, (_, kind, url, status) => `${kind === '页面' ? 'Page' : 'Crawl'} · ${url} (HTTP ${status})`],
    [/^，其中 AI 判断 (\d+)$/, (_, count) => `, including ${count} AI classifications`],
    [/^(.+)（(\d+)）$/, (_, name, count) => `${name} (${count})`],
    [/^Agent 请求联网搜索公开网页（DuckDuckGo）。搜索结果属于外部不可信内容，并会产生一次网络请求。(.*)$/, (_, query) => `Agent requests a web search for public pages (DuckDuckGo). Search results are untrusted external content and this makes one network request.${translate(query)}`],
    [/^\s*搜索词：(.*)$/, (_, query) => `\nSearch query: ${query}`],
    [/^Agent 请求读取 HTTPS 页面：\s*(.*?)\s*只执行有界 GET；外部内容不可信。拒绝显式本地\/私有地址，并尽力降低 SSRF 风险，但浏览器 fetch 无法提供 DNS pinning。会话记忆仅适用于 (.*)。$/, (_, url, scope) => `Agent requests to read HTTPS page:\n${url}\n\nOnly a bounded GET is performed; external content is untrusted. Explicit local/private addresses are rejected and SSRF risk is reduced where possible, but browser fetch cannot provide DNS pinning. Session memory applies only to ${scope}.`],
    [/^Agent 请求调用工具「(.*)」。该调用需要你的明确授权。$/, (_, name) => `Agent requests to call tool “${name}”. This call requires your explicit permission.`],
    [/^模型返回了空交付，已回填状态并继续同一会话$/, () => 'The model returned an empty deliverable; status was fed back and the same session continues'],
  ];

  // Last-resort UI fragments for messages composed by legacy template strings.
  // Keep these specific enough that fingerprint names and page content are untouched.
  const fragments = [
    ['规则集', 'rule set'], ['规则', 'rule'], ['指纹', 'fingerprint'], ['置信度', 'confidence'],
    ['扫描历史', 'scan history'], ['自定义哈希', 'custom hashes'], ['内置规则库', 'built-in rules'],
    ['当前编辑集', 'active rule set'], ['规则版本', 'rule version'], ['规则 ID', 'rule ID'],
    ['匹配规则', 'matching rules'], ['技术名', 'technology name'], ['生效版本', 'effective version'],
    ['重复规则 ID', 'duplicate rule IDs'], ['全部规则集', 'all rule sets'], ['规则详情', 'rule details'],
    ['规则冲突', 'rule conflict'], ['保留旧版', 'keep existing'], ['保留旧规则', 'keep existing'],
    ['覆盖规则', 'replace rule'], ['覆盖当前规则', 'replace current rule'], ['导入完成', 'import complete'],
    ['导入失败', 'import failed'], ['拉取失败', 'fetch failed'], ['拉取中…', 'fetching…'], ['转换中…', 'converting…'],
    ['已取消导入', 'import cancelled'], ['没有修改当前编辑集', 'the active rule set was not changed'],
    ['新增', 'added'], ['替换', 'replaced'], ['保留', 'kept'], ['未变化', 'unchanged'],
    ['已导出', 'exported'], ['已保存', 'saved'], ['已清空', 'cleared'], ['已删除', 'deleted'],
    ['已启用', 'enabled'], ['启用中…', 'enabling…'], ['切换中…', 'switching…'], ['已切换到', 'switched to'],
    ['正在加载', 'loading'], ['正在体检', 'checking'], ['体检失败', 'health check failed'],
    ['无效正则', 'invalid regex'], ['无锚点', 'no anchor'], ['短锚点榜', 'short anchor list'], ['长锚点榜', 'long anchor list'],
    ['最弱分支代表锚点', 'representative anchor in weakest branch'], ['个字母/数字', ' alphanumeric characters'],
    ['生产引擎无法解析', 'not parseable by production engine'], ['实际跳过数取决于页面内容', 'actual skips depend on page content'],
    ['参与匹配', 'used for matching'], ['最终生效', 'effective'], ['被覆盖', 'overridden'],
    ['抓取失败', 'fetch failed'], ['爬取中', 'crawling'], ['已中断', 'interrupted'], ['未识别', 'no match'],
    ['未知错误', 'unknown error'], ['未知时间', 'unknown time'], ['最新记录在前', 'newest first'],
    ['仅显示最新', 'showing newest'], ['仅显示前', 'showing first'], ['显示前', 'showing first'],
    ['书签', 'bookmarks'], ['分类', 'classification'], ['整理中…', 'organizing…'], ['出错：', 'Error: '],
    ['已选', 'selected'], ['全选', 'select all'], ['命中', 'matched'], ['失败', 'failed'],
    ['开始爬取', 'start crawl'], ['停止', 'stop'], ['最大页数', 'maximum pages'], ['起始 URL', 'start URL'],
    ['任务被系统中断', 'task interrupted by the system'], ['已保留', 'retained'], ['发现链接去重中…', 'deduplicating discovered links…'],
    ['测试中：', 'testing: '], ['验证成功：', 'verified: '], ['验证失败：', 'verification failed: '],
    ['测试未完成', 'test did not complete'], ['保存 AI 配置', 'save AI settings'], ['恢复默认', 'restore default'],
    ['生成失败：', 'generation failed: '], ['优化失败：', 'optimization failed: '], ['生成中…', 'generating…'], ['优化中…', 'optimizing…'],
    ['新建规则', 'new rule'], ['优化规则：', 'optimize rule: '], ['新建规则：', 'new rule: '],
    ['执行记录', 'execution log'], ['不含模型私有推理', 'excluding private model reasoning'], ['第 ', 'Step '], [' 步', ''],
    ['需要授权', 'permission required'], ['本次会话', 'this session'], ['允许此来源', 'allow this origin'],
    ['请刷新后重试', 'refresh and try again'], ['请填写', 'enter '], ['不能为空', 'cannot be empty'],
    ['（空）', '(empty)'], ['（无标题）', '(untitled)'], ['（当前生效）', '(currently effective)'],
    ['条规则', ' rules'], ['条扫描记录', ' scan records'], ['条自定义哈希', ' custom hashes'], ['页结果', ' page results'],
    [' 页', ' pages'], [' 条', ' entries'], [' 个', ''], ['项', 'items'], ['成功', 'succeeded'], ['结束：', 'Finished: '],
    ['文件超过 5MB，跳过了', 'file exceeds 5 MB; skipped'], ['YAML 里没有有效规则', 'YAML contains no valid rules'],
    ['finger.json 不是数组格式', 'finger.json is not an array'], ['finger.json 解析失败', 'finger.json parse failed'],
    ['finger.json 已拉取，但没有转换出有效规则', 'finger.json was fetched but produced no valid rules'],
    ['后台转换无响应', 'background conversion did not respond'], ['列目录失败', 'directory listing failed'],
    ['可能触发了 GitHub 限流，过会儿再试', 'GitHub rate limiting may apply; try again later'],
    ['目录中没有找到可导入的 YAML 模板', 'no importable YAML templates were found in this directory'],
    ['模板文件下载完成，但没有解析出 YAML 文档', 'template download completed but no YAML documents could be parsed'],
    ['确定清空当前编辑集中的所有规则？', 'Clear every rule in the active rule set?'],
    ['确定清空全部扫描历史？此操作无法撤销。', 'Clear all scan history? This cannot be undone.'],
    ['最大页数要么留空，要么填正整数', 'maximum pages must be blank or a positive integer'],
    ['最大页数要么是空，要么是正整数', 'maximum pages must be blank or a positive integer'],
    ['上次验证成功：', 'Last verification succeeded: '], ['默认提示词：', 'Default prompt:'],
    ['工具调用测试会发送两次极短 API 请求，可能产生 token/API 费用；仅调用本地无副作用的', 'Tool-call testing sends two very small API requests and may incur token/API costs; it only calls the local, side-effect-free'],
    ['当前页面不支持分析（仅 http/https）', 'This page cannot be analyzed (http/https only)'],
    ['尚未采集到页面特征', 'Page features are not available yet'], ['请刷新页面后重试', 'Refresh the page and try again'],
    ['尚未导入任何规则', 'No rules have been imported'], ['未命中任何规则', 'No rules matched'],
    ['可点击下方 AI 辅助识别', 'Use AI-assisted identification below'], ['可在设置里调低阈值', 'Lower the threshold in Settings'],
    ['个命中都低于置信度阈值', 'matches are below the confidence threshold'],
    ['优化此规则', 'Optimize this rule'], ['新建规则', 'New rule'], ['覆盖入库', 'Replace in rule set'],
    ['生成失败：', 'Generation failed: '], ['优化失败：', 'Optimization failed: '], ['入库失败：', 'Failed to add rule: '],
    ['执行记录', 'Execution log'], ['当前 AI 无合理优化建议', 'The AI has no reasonable optimization suggestion'],
    ['Agent 已完成', 'Agent completed'], ['Agent 未完成', 'Agent did not complete'],
    ['Agent 请求联网搜索公开网页', 'Agent requests a web search for public pages'], ['搜索词：', 'Search query: '],
    ['搜索结果属于外部不可信内容，并会产生一次网络请求。', 'Search results are untrusted external content and this makes one network request.'],
    ['Agent 请求读取 HTTPS 页面：', 'Agent requests to read an HTTPS page:'], ['只执行有界 GET；外部内容不可信。', 'Only a bounded GET is performed; external content is untrusted.'],
    ['拒绝显式本地/私有地址，并尽力降低 SSRF 风险，但浏览器 fetch 无法提供 DNS pinning。', 'Explicit local/private addresses are rejected and SSRF risk is reduced where possible, but browser fetch cannot provide DNS pinning.'],
    ['会话记忆仅适用于', 'Session memory applies only to '], ['这个来源', 'this origin'],
    ['Agent 请求调用工具', 'Agent requests to call tool'], ['该调用需要你的明确授权。', 'This call requires your explicit permission.'],
  ];

  const attrs = {
    '筛选重复规则 ID': 'Filter duplicate rule IDs', '新规则集名称': 'New rule set name',
    '筛选规则 ID 或名称': 'Filter rule ID or name', '0': '0',
    '每行一条：哈希 名称（如 -1010568750 Phpmyadmin）\n或者直接贴 JSON：{"-1010568750": "Phpmyadmin"}': 'One per line: hash name (e.g. -1010568750 Phpmyadmin)\nOr paste JSON: {"-1010568750": "Phpmyadmin"}',
    'https://api.openai.com/v1 或 http://localhost:11434/v1': 'https://api.openai.com/v1 or http://localhost:11434/v1',
    '筛选技术名或规则 ID': 'Filter technology name or rule ID', '例如 React、WordPress': 'e.g. React, WordPress',
    '设置分区': 'Settings sections', '点击查看该规则': 'View this rule', '删除': 'Delete',
  };

  function normalized(value) { return String(value).trim().replace(/\s+/g, ' '); }
  function translateBuiltinName(value) { return value === '默认规则集' ? 'Default rule set' : value; }
  function translate(value, table = en) {
    if (locale !== 'en') return value;
    const key = normalized(value);
    if (table[key]) return table[key];
    for (const [pattern, format] of patterns) {
      if (pattern.test(key)) return key.replace(pattern, format);
    }
    // Do not translate unknown text piecemeal: rule names, page titles, AI output,
    // and server errors can be user or third-party data rather than interface copy.
    return value;
  }

  function translateText(root = document) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || ['SCRIPT', 'STYLE', 'CODE', 'PRE'].includes(parent.tagName) || !node.data.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (!originals.has(node)) originals.set(node, node.data);
      const next = locale === 'en' ? translate(originals.get(node)) : originals.get(node);
      if (node.data !== next) {
        translatedNodes.set(node, next);
        node.data = next;
      }
    }
  }

  function translateAttributes(root = document) {
    for (const el of root.querySelectorAll('[placeholder], [title], [aria-label]')) {
      let originalAttrs = attributeOriginals.get(el);
      if (!originalAttrs) {
        originalAttrs = new Map();
        attributeOriginals.set(el, originalAttrs);
      }
      for (const attr of ['placeholder', 'title', 'aria-label']) {
        if (!el.hasAttribute(attr)) continue;
        if (!originalAttrs.has(attr)) originalAttrs.set(attr, el.getAttribute(attr));
        const original = originalAttrs.get(attr);
        el.setAttribute(attr, locale === 'en' ? (attrs[original] || en[original] || translate(original)) : original);
      }
    }
  }

  function updateToggle(root = document) {
    for (const toggle of root.querySelectorAll('[data-locale-toggle]')) {
      toggle.textContent = locale === 'en' ? '中文' : 'EN';
      toggle.title = locale === 'en' ? 'Switch to Chinese' : '切换到英文';
      toggle.setAttribute('aria-label', toggle.title);
    }
  }

  function apply(root = document) {
    document.documentElement.lang = locale;
    document.title = locale === 'en' ? translate(originalTitle) : originalTitle;
    translateText(root);
    translateAttributes(root);
    updateToggle(root);
  }

  async function setLocale(next) {
    locale = next === 'en' ? 'en' : DEFAULT_LOCALE;
    apply();
    window.dispatchEvent(new CustomEvent('gopainter:localechange'));
    await chrome.storage.local.set({ [LOCALE_KEY]: locale });
  }

  function t(zh, fallback = zh) { return locale === 'en' ? (en[zh] || fallback) : zh; }

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-locale-toggle]')) setLocale(locale === 'en' ? DEFAULT_LOCALE : 'en');
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LOCALE_KEY]) {
      locale = changes[LOCALE_KEY].newValue === 'en' ? 'en' : DEFAULT_LOCALE;
      apply();
      window.dispatchEvent(new CustomEvent('gopainter:localechange'));
    }
  });
  chrome.storage.local.get(LOCALE_KEY).then((stored) => {
    locale = stored[LOCALE_KEY] === 'en' ? 'en' : DEFAULT_LOCALE;
    apply();
  });

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const node = mutation.target;
        if (translatedNodes.get(node) === node.data) {
          translatedNodes.delete(node);
          continue;
        }
        translatedNodes.delete(node);
        originals.set(node, node.data);
        if (node.parentElement) translateText(node.parentElement);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) apply(node);
        else if (node.nodeType === Node.TEXT_NODE && node.parentElement) apply(node.parentElement);
      }
    }
  });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });

  globalThis.GoPainterI18n = Object.freeze({ apply, setLocale, t, translate, get locale() { return locale; } });
})();
