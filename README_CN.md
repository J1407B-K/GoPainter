# GoPainter 🎨

[![CI](https://img.shields.io/github/actions/workflow/status/J1407B-K/GoPainter/ci.yml?branch=master&style=flat-square&label=CI)](https://github.com/J1407B-K/GoPainter/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/J1407B-K/GoPainter?style=flat-square)](https://github.com/J1407B-K/GoPainter/releases/latest)
[![License](https://img.shields.io/github/license/J1407B-K/GoPainter?style=flat-square)](./LICENSE)
![Go WASM](https://img.shields.io/badge/Go-WASM-00ADD8?style=flat-square&logo=go&logoColor=white)
![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white)

[English](./README.md) | **简体中文** · [示例规则](./rules/examples.yaml)

**浏览器原生的 Web 技术指纹识别，提供实时且可解释的证据。**

GoPainter 直接从浏览器中的 HTTP、HTML、DOM、JavaScript 运行时和 favicon
特征识别技术栈。它结合确定性的 **Go/WASM + Google RE2** 引擎、Wappalyzer/EHole/nuclei
规则源、站点爬取，以及能够研究、测试和验证新指纹规则的 AI Agent。

GoPainter 强调可审计结果：每个命中都附带实际匹配的证据，Agent 可以提出规则，
但最终规则始终由 Go Core 验证。

浏览网页时自动对当前站点做指纹识别，命中结果实时展示——工具栏图标**灰色 = 未命中，彩色 + 数字角标 = 命中 N 个指纹**。

## 为什么是 GoPainter？

- ⚡ **确定性匹配**：Go/WASM + Google RE2，性能边界清晰且适合浏览器
- 🌐 **浏览器原生证据**：HTTP、HTML、DOM、JavaScript 运行时和 favicon
- 🧩 **兼容现有生态**：可导入并转换 Wappalyzer、EHole 和 nuclei 规则源
- 🔍 **可解释结果**：每个命中都展示实际匹配的关键词、正则、状态码或哈希
- 🤖 **Agent 辅助研究**：检查 → 搜索 → 测试 → 验证，全程保留可审计记录

## 特性

- 🧩 **YAML 指纹规则**：word / regex / status / icon_hash / dsl / js / dom 七种 matcher，支持 and/or 组合与 negative 取反
- 🩺 **规则体检**：检查 regex 有效性和结构上的预筛机会，提供长/短锚点榜及可定位的无效/无锚点明细
- 🗂️ **规则集组合启用**：不同来源分集管理，可批量启用任意多个规则集；同 ID 规则覆盖前展示 YAML diff 并由用户选择
- 🔁 **兼容 nuclei 模板**：导入时自动提取 http matchers 子集，社区海量规则可直接使用
- 🌐 **第三方规则源**：Wappalyzer / EHole / nuclei-templates 一键拉取转换，是否下载由你决定，仓库不会打包这些第三方完整规则库
- ⚡ **性能导向的运行时**：Go WASM + Google RE2 匹配、受限的页面/UI 数据路径，以及索引化的 Agent 规则搜索
- 🔍 **命中证据展示**：每个指纹附带具体命中的关键词/正则/状态码/哈希
- 🎨 **图标状态感知**：灰色 = 未命中，彩色 + 角标数字 = 命中数
- 🤖 **Agent 指纹研究**：受限的流式工具循环可识别当前标签页、研究指纹或给出规则优化建议；执行记录可审计，最终交付基于证据的任务报告
- 🕘 **扫描历史与报告**：自定义 50–5,000 条滚动窗口，可导出 JSON/CSV 报告

## 当前版本：v0.6.4

v0.6.4 把规则交付链路彻底收紧：Agent 最终 YAML 的规范产物必须与本会话中经生产 Go/WASM Core 成功验证的候选完全一致。新增规则体检，可定位无效 regex、结构上的预筛潜力、必定执行项及长短代表锚点，同时明确不把结构性能指标冒充识别准确率。扩展 Host 也按页面、规则、历史、爬虫、书签、AI 与 Agent 生命周期拆分；配合受限 UI 渲染和自动只读工具并发，避免长任务侵入交互路径。当前测量及各历史版本见[性能记录](BENCHMARK_CN.md)。

## 快速开始

### 1. 安装 Go

构建只需标准 Go 工具链（`make build` 默认构建生产 Go WASM + RE2 引擎）。

- macOS：`brew install go`
- Windows / Linux：见 [Go 官方下载页](https://go.dev/dl/)

### 2. 构建 WASM 引擎

**macOS / Linux**
```bash
make build        # 产出 extension/wasm/matcher.wasm + wasm_exec.js
make icons        # 如需重新生成图标（可选，仓库已内置）
```

`make build` 是唯一受支持的生产构建：标准 Go WASM + 内嵌 Google RE2。Makefile 中仍保留 TinyGo 和标准库 regex 的遗留实验 target，但它们不再维护，也不作为受支持的发布目标。

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
3. 点击「🤖 Agent」可识别当前标签页、研究指纹或准备规则优化建议。自动只读工具最多 5 路并发；需要授权的工具仍串行执行并在调用前确认。执行记录会实时展示，且不会自动写入规则。

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
| `dom` | CSS 选择器及可选文本/属性约束 | `dom: [{sel, text?, attrs?}]` |

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
  在设置页「🎚 置信度」开启后，弹窗每条都会显示置信度：已标注显示百分比，未标注显示 `null`；
  排序和阈值只作用于数字置信度（默认关闭）。

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

## AI / Agent 配置

在设置页选择 OpenAI 兼容或 Anthropic 协议，并填写接口与模型；首次使用前先点击「测试 Agent 工具」。

| 服务 | Base URL | 模型示例 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5` |

## AI 安全提示

- GoPainter 不内置、不代管、不上传你的 API Key；API Key 只保存在浏览器扩展本地存储里，由扩展直接请求你填写的 Base URL。
- 使用云端 LLM 时，页面特征会发送给你配置的模型服务。Agent 工作流先发送紧凑概览，只有调用正文搜索工具时才发送 HTML 片段；直接 AI 识别/规则辅助流程可能发送截断后的 HTML。除非确认这些信息可以交给对应服务商处理，否则不要在敏感站点上启用 AI。
- AI 辅助识别、AI 生成规则、书签 AI 兜底分类都可能出错或编造结果。请人工确认后再把 AI 生成的规则加入长期规则库；本项目不对 AI 输出的准确性、合规性或外部服务费用负责。
- Agent 工具调用限定于所选任务；自动只读工具最多 5 路并发，需要授权的联网工具仍串行执行并在调用前暂停确认，返回内容仅是不可信参考资料。
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
| `make build` | 构建生产 Go WASM + 内嵌 RE2 引擎 |
| `make test` | 跑 Go、JS 单元测试，再跑 WASM 冒烟测试 |
| `make test-go` | 只跑 Go 单元测试（js/wasm 目标，经 node 执行，无需先构建） |
| `make test-js` | 只跑扩展共享逻辑的 Node 单元测试 |
| `make bench-js` | 测量 popup、大集合、序列化与 Agent 规则搜索路径 |
| `make icons` | 重新生成扩展图标 |
| `make clean` | 删除 `extension/wasm/matcher.wasm` 和 `wasm_exec.js` |
| `node scripts/generate-icons.mjs` | 直接运行图标生成器 |
| `node scripts/generate-hashdb.mjs` | 从 `data/favicon-hashes.json` 生成 `wasm/engine/hashdb.go` |
| `node scripts/smoke-test.mjs` | 直接运行 WASM 冒烟测试 |
| `powershell -ExecutionPolicy Bypass -File scripts/build.ps1` | Windows 构建 WASM |

<details>
<summary><strong>架构与目录结构</strong></summary>

## 架构

```
GoPainter Host / Runtime（JS）       GoPainter Core / Authority（Go WASM）
负责一切外部 I/O 与生命周期            持有确定性产品语义，零 I/O
──────────────────────────────      ─────────────────────────────────
content.js   采集 DOM/原始 HTML ─┐
background   采集响应头/状态码    │     goMatch            规则匹配 + 证据
  .js        favicon 下载       ─┼─→  goMmh3             favicon 哈希（fofa 标准）
             AI / Agent API 调用 │     goExtractFeatures  HTML → title/meta/scripts
             图标状态切换        │     goNormalizeRules   YAML 文档 → 原生规则
             权限 / 生命周期     │     goValidateCandidate 严格校验 Agent 产物
                                 │     goPlanRequiredProbes 规则 → JS/DOM 特征计划
options      YAML 解析(js-yaml) ─┘    ←  全部进 JSON 出 JSON
popup        结果与证据展示 / Agent 任务运行器
sidepanel    爬取进度实时展示 / 启停（Side Panel，与页面并存）
```

核心边界：**WASM 只做纯计算**（进 JSON 出 JSON，不碰网络/YAML/DOM）。
规则语义——包括严格的 Agent 候选规则校验与 required-probe planning——统一放在 Go；JS 负责浏览器/模型 I/O、权限与生命周期。

> **架构红线——不要模糊这条边界。** 新增逻辑前先问：它描述的是 GoPainter 的确定性领域语义，还是在接触外部环境？规则是否合法、matcher 如何执行、规则如何规范化、需要采集哪些 probe、probe ID 如何生成，属于 Go Core；浏览器、模型、用户、存储、网络、权限和生命周期，属于 JS Host。禁止在 JS 中重复实现规则语法、matcher 语义、normalize、probe planning 或 probe-ID 算法；也不要为了增加 Go 代码量，把 Agent loop、Provider、权限、Chrome API、DOM 采集或网络 I/O 搬进 WASM。

## 目录

```
├── wasm/                     # WASM 入口包（薄 JS bridge）
│   ├── main.go               #   注册 JS 导出
│   ├── bridge.go             #   匹配/转换/hash/dsl 的 JSON 进出
│   ├── crawl_bridge.go       #   爬虫 API 的 JSON 进出
│   └── engine/               #   纯 Go 逻辑包
│       ├── matcher.go        #   匹配引擎（核心）
│       ├── candidate.go      #   严格 Agent 候选校验 + 运行时覆盖判断
│       ├── probes.go         #   JS/DOM 探针规划与稳定 probe ID
│       ├── mmh3.go           #   favicon 哈希
│       ├── extract.go        #   HTML 特征提取（title/meta/scripts/favicon/links）
│       ├── normalize.go      #   规则规范化（nuclei 转换）
│       ├── dsl.go            #   dsl 表达式求值器
│       ├── convert.go        #   Wappalyzer/EHole 指纹转换
│       ├── health.go         #   regex 有效性、预筛潜力与锚点质量体检
│       ├── crawl.go          #   爬虫调度（BFS/去重/同站过滤/上限）
│       └── hashdb.go         #   favicon 哈希库（生成）
├── extension/                # Chrome 扩展（MV3）
│   ├── manifest.json
│   ├── background.js         # 精简的 service worker 装配入口与消息路由
│   ├── background/           # Host 模块：页面/规则/历史/爬虫/书签/AI/Agent
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

</details>

## 项目状态

浏览器核心工作流已经完整：自动匹配与证据、规则集组合启用和导入、Agent 研究与可导入规则生成、站点爬取、历史/报告导出、书签整理和外接脚本。下一阶段计划是远程规则源订阅与更新。

## License

[MIT](LICENSE)
