# GoPainter 🎨

[English](./README.md) | **简体中文**

基于 YAML 指纹规则的 Web 资产测绘工具：**TinyGo** 编译的 WASM 匹配引擎 + AI 辅助识别。

GoPainter 只负责检测与爬取（引擎），规则（颜料）来自社区规则源或你自己的 YAML，仓库本身不内置任何规则数据。

浏览网页时自动对当前站点做指纹识别，命中结果实时展示——工具栏图标**灰色 = 未命中，彩色 + 数字角标 = 命中 N 个指纹**。

## 特性

- 🧩 **YAML 指纹规则**：word / regex / status / icon_hash / dsl / js / dom 七种 matcher，支持 and/or 组合与 negative 取反
- 🔁 **兼容 nuclei 模板**：导入时自动提取 http matchers 子集，社区海量规则可直接使用
- 🌐 **第三方规则源**：Wappalyzer / EHole / nuclei-templates 一键拉取转换，是否下载由你决定，仓库本身不含任何规则数据
- ⚡ **TinyGo WASM 引擎**：匹配逻辑用 Go 编写，编译产物仅约 750KB，毫秒级匹配
- 🔍 **命中证据展示**：每个指纹附带具体命中的关键词/正则/状态码/哈希
- 🎨 **图标状态感知**：灰色 = 未命中，彩色 + 角标数字 = 命中数
- ✨ **AI 辅助识别**：规则未命中时一键调用 LLM 分析（任意 OpenAI 兼容接口）

## 快速开始

### 1. 安装 TinyGo

**macOS**
```bash
brew tap tinygo-org/tools
brew install tinygo
```

**Windows**
```powershell
winget install TinyGo.TinyGo
# 或者用 Scoop: scoop install tinygo
```

**Linux**
```bash
sudo pacman -S tinygo        # Arch
sudo apt install tinygo      # Debian/Ubuntu（或参考官网用预编译包）
```

其他安装方式见 [TinyGo 官方文档](https://tinygo.org/getting-started/install/)。

### 2. 构建 WASM 引擎

**macOS / Linux**
```bash
make build        # 产出 extension/wasm/matcher.wasm + wasm_exec.js
make icons        # 如需重新生成图标（可选，仓库已内置）
```

**Windows（PowerShell）**
```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
```

### 3. 安装到 Chrome

1. 打开 `chrome://extensions`
2. 打开右上角「**开发者模式**」（Developer mode）
3. 点击「**加载已解压的扩展程序**」（Load unpacked）
4. 选择本项目的 **`extension/`** 目录

> Edge / Brave 等 Chromium 浏览器同样适用（`edge://extensions`）。

### 4. 导入规则 & 使用

1. 点击工具栏 GoPainter 图标 → 「⚙️ 规则」→ 导入 `rules/examples.yaml`（或任意 nuclei 模板）
2. 访问网站，图标变彩色即表示命中，点击图标查看详情与证据
3. 未命中时可点「✨ AI 辅助识别」（需先在设置页配置 API）

### 5. 爬取站点（Side Panel）

1. 点击工具栏 GoPainter 图标 → 「🕷 爬取本站」，确认起始 URL 与最大页数后启动
2. 右侧自动滑出**爬取侧边栏**（Side Panel），与页面并存，实时显示已扫页数 / 队列 / 失败数，以及每个页面的命中指纹
3. 爬取中工具栏的「爬取本站」会置灰，再次点击直接回到侧栏查看进度
4. 也可以在设置页「🕷 站点爬取」从任意 URL 发起爬取

> 侧栏依赖 Chrome 126+ 的 `chrome.sidePanel` API；早版本浏览器不会自动弹侧栏，但仍可在设置页查看进度。

## 规则格式

见 [`rules/examples.yaml`](rules/examples.yaml)。支持七种 matcher：

| type | 说明 | 条件字段 |
|---|---|---|
| `word` | 文本包含 | `words` |
| `regex` | 正则匹配 | `regex` |
| `status` | HTTP 状态码 | `status` |
| `icon_hash` | favicon mmh3 哈希（fofa 标准） | `hash` |
| `dsl` | 表达式求值（nuclei dsl 子集） | `dsl` |
| `js` | 页面运行时全局变量（MAIN world 探测） | `js: [{path, pattern?}]` |
| `dom` | CSS 选择器存在性 | `words` 装选择器 |

规则还支持 `implies: ["其他技术名"]`——命中后自动级联推导（如 Next.js → React），推导命中带「由 X 推导」证据。

dsl 表达式支持：标识符 `body` / `title` / `url` / `header` / `raw` / `meta` / `script` / `status` / `favicon_hash`，
函数 `contains(a, "子串")` / `matches(a, "正则")`，运算符 `&&` `||` `!` `==` `!=` 和括号。
示例：`contains(body, "wp-content") && status == 200`

- `part`：`body` / `title` / `url` / `header` / `raw` / `meta` / `script`（默认 `body`）
- `condition`：matcher 内部多条件组合，`and` / `or`（默认 `or`）
- `matchers-condition`：规则内多个 matcher 的组合方式
- `negative: true`：取反
- `confidence: 0-100`：可选，标在 matcher 或规则上，表示信号强度——强信号（meta generator、专有路径）给高分，
  弱信号（比如「页面声明了 manifest」只是 PWA 候选）给低分；未标注时输出 `confidence: null`，不会自动编成 100。
  合成规则：`or` 取命中 matcher 的最大值，`and` 取最小值（最短板），规则级 `confidence` 作为缩放系数；
  `implies` 推导的命中继承来源置信度。Wappalyzer 源里的 `\;confidence:N` 拉取时自动转进来，
  同字段不同置信度的模式会拆成独立 matcher，避免未命中的低分模式拉低高分命中。
  在设置页「🎚 置信度」开启后，弹窗只为已标注命中显示徽章、按已标注置信度排序，并可设阈值隐藏低置信度命中（默认关闭）。

## 第三方规则源

设置页「第三方规则源」支持从你的浏览器实时拉取社区指纹库并转换入库：

| 源 | 规模 | 说明 |
|---|---|---|
| [enthec/webappanalyzer](https://github.com/enthec/webappanalyzer) | 几千条 | Wappalyzer 社区维护版，Web 技术指纹 |
| [EdgeSecurityTeam/EHole](https://github.com/EdgeSecurityTeam/EHole) | 958 条 | 棱洞指纹，国产系统覆盖好 |
| [projectdiscovery/nuclei-templates](https://github.com/projectdiscovery/nuclei-templates) | 数百条 | http/technologies 技术识别模板 |

感谢以上社区的长期维护 🙏 转换逻辑在 `wasm/engine/convert.go`，均在用户侧运行时拉取。

**声明**：本项目仅提供格式转换工具，不内置、不分发任何第三方规则数据。第三方规则源的内容、
版权与合规性由其维护者负责；用户的拉取、使用行为及其后果与本项目无关。请遵守各源的许可证
和适用法律，仅用于授权范围内的安全测试与研究。

## AI 配置

设置页填入任意 **OpenAI 兼容接口**即可：

| 服务 | Base URL | 模型示例 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5` |

## AI 安全提示

- GoPainter 不内置、不代管、不上传你的 API Key；API Key 只保存在浏览器扩展本地存储里，由扩展直接请求你填写的 Base URL。
- 使用云端 LLM 时，页面特征会发送给你配置的模型服务：URL、标题、响应头、meta、script 路径、favicon 哈希，以及截断后的页面 HTML。除非确认这些信息可以交给对应服务商处理，否则不要在敏感站点上启用 AI。
- AI 辅助识别、AI 生成规则、书签 AI 兜底分类都可能出错或编造结果。请人工确认后再把 AI 生成的规则加入长期规则库；本项目不对 AI 输出的准确性、合规性或外部服务费用负责。
- 外接脚本会以扩展权限执行。只添加自己编写或完全信任的脚本，不要粘贴来源不明的代码。

## 外接脚本

设置页「外接脚本」允许在规则匹配和 favicon 哈希库命中之后追加自定义识别逻辑。脚本体会被当作函数体执行：

```js
// 参数：features, hits
// 返回：追加的指纹数组；不追加则无需 return
if (features.body.includes('hello-world-cta')) {
  return [{
    id: 'my-product',
    name: 'My Product',
    evidence: [{ type: 'script', detail: 'hello-world-cta' }],
  }];
}
```

可用输入：

- `features.url` / `features.title` / `features.body`
- `features.headers` / `features.status`
- `features.meta` / `features.scripts` / `features.links`
- `features.faviconHash` / `features.faviconHashes`
- `hits`：前置规则和哈希库已命中的结果

脚本返回项至少需要 `id` 和 `name`。同一个 `id` 已存在时会跳过，避免重复追加。

## 自定义脚本命令

| 命令 | 说明 |
|---|---|
| `make build` | macOS/Linux 构建 WASM。优先 TinyGo，未安装 TinyGo 时回退标准 Go |
| `make test` | 先跑 Go 单元测试，再跑 WASM 冒烟测试 |
| `make test-go` | 只跑 Go 单元测试（js/wasm 目标，经 node 执行，无需先构建） |
| `make icons` | 重新生成扩展图标 |
| `make clean` | 删除 `extension/wasm/matcher.wasm` 和 `wasm_exec.js` |
| `node scripts/generate-icons.mjs` | 直接运行图标生成器 |
| `node scripts/generate-hashdb.mjs` | 从 `data/favicon-hashes.json` 生成 `wasm/engine/hashdb.go` |
| `node scripts/smoke-test.mjs` | 直接运行 WASM 冒烟测试 |
| `powershell -ExecutionPolicy Bypass -File scripts/build.ps1` | Windows 构建 WASM |

## 架构

```
JS 侧（胶水层，一切 I/O）            Go WASM（纯函数，零 I/O）
─────────────────────────          ─────────────────────────
content.js   采集 DOM/原始 HTML ─┐
background   采集响应头/状态码    │     goMatch            规则匹配 + 证据
  .js        favicon 下载       ─┼─→  goMmh3             favicon 哈希（fofa 标准）
             AI API 调用        │     goExtractFeatures  HTML → title/meta/scripts
             图标状态切换        │     goNormalizeRules   YAML 文档 → 原生规则
options      YAML 解析(js-yaml) ─┘    ←  全部进 JSON 出 JSON
popup        结果与证据展示 / AI 按钮
sidepanel    爬取进度实时展示 / 启停（Side Panel，与页面并存）
```

核心边界：**WASM 只做纯计算**（进 JSON 出 JSON，不碰网络/YAML/DOM），
因此 TinyGo 的短板（反射不完整、标准库缺失）完全不会影响。
匹配、mmh3、HTML 特征提取、nuclei 模板转换全部在 Go 里。

## 目录

```
├── wasm/                     # WASM 入口包（薄 JS bridge）
│   ├── main.go               #   注册 JS 导出
│   ├── bridge.go             #   匹配/转换/hash/dsl 的 JSON 进出
│   ├── crawl_bridge.go       #   爬虫 API 的 JSON 进出
│   └── engine/               #   纯 Go 逻辑包
│       ├── matcher.go        #   匹配引擎（核心）
│       ├── mmh3.go           #   favicon 哈希
│       ├── extract.go        #   HTML 特征提取（title/meta/scripts/favicon/links）
│       ├── normalize.go      #   规则规范化（nuclei 转换）
│       ├── dsl.go            #   dsl 表达式求值器
│       ├── convert.go        #   Wappalyzer/EHole 指纹转换
│       ├── crawl.go          #   爬虫调度（BFS/去重/同站过滤/上限）
│       └── hashdb.go         #   favicon 哈希库（生成）
├── extension/                # Chrome 扩展（MV3）
│   ├── manifest.json
│   ├── background.js         # service worker：AI/书签/爬虫/消息路由
│   ├── background/           # service worker 分层：wasm、浏览器状态、匹配
│   ├── content.js            # 页面特征采集
│   ├── popup.*               # 结果与证据展示 / AI 识别 / AI 生成规则
│   ├── options.*             # 规则导入 / AI 配置 / 提示词 / 书签整理
│   ├── sidepanel.*           # 爬取进度实时展示 / 启停（Side Panel）
│   ├── icons/                # 彩色/灰色两套图标（脚本生成）
│   └── lib/                  # js-yaml（唯一的第三方 JS）
├── scripts/
│   ├── generate-icons.mjs    # 图标生成器（纯 Node，零依赖）
│   ├── generate-hashdb.mjs   # favicon 哈希库生成器（data/ → wasm/engine/hashdb.go）
│   ├── smoke-test.mjs        # wasm 冒烟测试
│   └── build.ps1             # Windows 构建脚本
├── data/favicon-hashes.json  # 哈希库源数据（BishopFox/Favicons）
├── rules/examples.yaml       # 示例规则
└── Makefile                  # macOS/Linux 构建
```

## 路线图

**已完成** ✅
- [x] TinyGo WASM 匹配引擎（word / regex / status / icon_hash）
- [x] nuclei 模板导入兼容（http matchers 子集）
- [x] 命中证据展示
- [x] 图标状态感知（灰色/彩色 + 角标）
- [x] AI 辅助识别（OpenAI 兼容接口，提示词可自定义）
- [x] AI 反向生成规则（未识别页面 → AI 写 YAML → 确认入库）
- [x] 书签自动分类（勾选想整理的书签，按指纹命中挪入「🎨 指纹分类」文件夹，可开 AI 兜底）
- [x] mmh3 / HTML 特征提取 / nuclei 转换收编进 Go（新增 meta、script 匹配维度）
- [x] 内置 favicon 哈希库（956 条，BishopFox 数据集）+ 自定义哈希导入
- [x] 内置 Top 130 常用指纹规则库（options 页一键导入）
- [x] 书签扫描补全 favicon 哈希（icon_hash 规则与哈希库对书签生效）
- [x] 外接脚本（自定义 JS 挂钩匹配管线，追加指纹）
- [x] 站点递归爬取（BFS/去重/同站过滤在 Go 侧，最大页数可配、留空不限，popup 一键爬本站）
- [x] 爬取进度侧边栏（Side Panel 实时展示已扫/队列/失败 + 命中指纹，爬取中按钮置灰）
- [x] 多 favicon 持续匹配（DOM + 网络包里所有 icon 都算哈希，晚到的 icon 触发重匹配）
- [x] SPA 路由变化监听（main world hook pushState/replaceState，变化即重扫）
- [x] matcher 支持 dsl 表达式子集（自研递归下降求值器，nuclei 模板的 dsl 也可转换）
- [x] 第三方规则源市场（Wappalyzer / EHole / nuclei-templates官方仓库地址）
- [x] js 运行时变量探测（MAIN world 探针）+ dom 选择器探测 + implies 级联推导
- [x] 英文 README

**进行中 / 计划** 🚧
- [ ] 规则集管理：分组启用/禁用、远程规则源订阅与自动更新
- [ ] 扫描历史与报告导出（JSON/CSV）
- [x] Go 侧单元测试（matcher / dsl / mmh3 / extract / normalize / crawl / convert，`make test-go`）
- [ ] JS 侧单元测试
- [ ] wasm 体积进一步优化（当前 ~750KB，目标 < 300KB，暂搁置）

## License

[MIT](LICENSE)
