# GoPainter

[![CI](https://img.shields.io/github/actions/workflow/status/J1407B-K/GoPainter/ci.yml?branch=master&style=flat-square&label=CI)](https://github.com/J1407B-K/GoPainter/actions/workflows/ci.yml)
[![CodeFactor](https://www.codefactor.io/repository/github/j1407b-k/gopainter/badge)](https://www.codefactor.io/repository/github/j1407b-k/gopainter)
[![Release](https://img.shields.io/github/v/release/J1407B-K/GoPainter?style=flat-square)](https://github.com/J1407B-K/GoPainter/releases/latest)
[![License](https://img.shields.io/github/license/J1407B-K/GoPainter?style=flat-square)](./LICENSE)
![Go WASM](https://img.shields.io/badge/Go-WASM-00ADD8?style=flat-square&logo=go&logoColor=white)
![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white)

[English](./README.md) | **简体中文** · [示例规则](./rules/examples.yaml) · [性能记录](./BENCHMARK_CN.md)

> **最好用的开源浏览器 Web 指纹识别工具。**
>
> 基于 Go/WASM 和 Google RE2 在本地运行，每个识别结果都能看到对应证据。

GoPainter 从 HTTP、HTML、DOM、JavaScript 运行时和 favicon 信号识别当前页面使用的
技术。匹配过程确定、本地且可解释：每个结果都会明确展示为什么命中。可选 AI 工具
只负责辅助研究和提出指纹，最终仍由 Go Core 校验。

浏览网页时，未命中则工具栏图标保持灰色；发现指纹后，图标变为彩色并显示命中数量。

## GoPainter 有什么不同

- **可解释识别**：查看每个命中对应的关键词、正则、状态码、运行时值、DOM 选择器、favicon 哈希和提取出的版本号。
- **确定性规则引擎**：七种 matcher、`and`/`or`、negative、置信度传播和 Google RE2 语义。
- **规则集组合**：不同来源分集管理，可任意组合启用；同 ID 冲突通过 YAML diff 明确选择。
- **第三方规则源**：由用户主动更新 Wappalyzer、EHole 和 nuclei-templates；下载有界，提供变化摘要和单版本回滚。
- **规则工具**：导入原生 YAML 或支持的 nuclei HTTP 子集；命中后可直接编辑，并用当前页面实时校验。
- **浏览器工作流**：当前标签自动识别、批量 URL 扫描、站点爬取、书签整理、扫描历史及 JSON/CSV 报告。
- **可审计 AI Agent**：受限的“检查 → 搜索 → 测试 → 验证”流程，展示工具记录，并对敏感操作明确授权。

## 当前版本：v0.7.2

v0.7.2 增加证据定位：点击 DOM、正文关键词或正文正则证据，即可跳转并高亮当前页面中的
对应来源。第三方规则源在手动和定时更新间保持稳定规则集标识；其完整已安装规则也可重新
打开并保存，不再误受 AI 候选规则 50 个 matcher 的限制。设置页可批量扫描最多 500 个 URL，
并导出 JSON/CSV；批量扫描固定为 4 路并发，页面响应按字节流截断，session 结果使用独立的
2.5 MB 预算。

Chromium 资源测量、浏览器 E2E 基线和历史性能记录见 [BENCHMARK_CN.md](./BENCHMARK_CN.md)。

## 快速开始

### 1. 构建

安装标准 [Go 工具链](https://go.dev/dl/) 后运行：

```bash
make build
```

命令会生成 `extension/wasm/matcher.wasm` 和 `extension/wasm/wasm_exec.js`。唯一受支持
的生产目标是标准 Go WASM + 内嵌 Google RE2；Makefile 中的 TinyGo 和标准库 regexp
目标只是遗留实验入口。

Windows 使用 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
```

### 2. 加载扩展

1. 打开 `chrome://extensions`。
2. 开启右上角的**开发者模式**。
3. 点击**加载已解压的扩展程序**。
4. 选择本仓库的 `extension/` 目录。

Edge 和 Brave 也可以在各自的扩展页面使用相同方式加载。

### 3. 识别网站

1. 打开 GoPainter 弹窗并进入**规则**。
2. 导入 [`rules/examples.yaml`](./rules/examples.yaml)、其他原生规则文件或支持的 nuclei 模板。
3. 访问页面，再打开弹窗查看命中结果与证据。

使用 **Agent** 可以识别当前标签页、研究指纹或准备规则优化建议。Agent 不会自动写入
规则；你需要检查并导入经过校验的结果。

### 爬取站点

在弹窗选择**爬取本站**，确认起始 URL 和可选页数上限，然后在 Side Panel 查看进度。
爬取只访问同站页面，自动去重，并实时展示队列、失败数和每页命中。也可以从
**设置 → 站点爬取**发起任务。

自动打开 Side Panel 需要 Chrome 126+；旧版 Chromium 仍可在设置页查看爬取进度。

### 批量扫描与实时编辑

在 **设置 → 批量扫描** 中粘贴 URL 列表即可启动任务。每行一个 URL；任务会去重、拒绝
非 HTTP(S) 地址，并保持固定并发与存储边界。它不会打开标签页或执行页面 JS/DOM，匹配
范围是 HTTP、HTML、meta、script 和 favicon 信号。完成后可以下载 JSON 或 CSV。

在 popup 的命中结果中点击规则名称或 **编辑规则**，即可查看有效规则 YAML。输入时会用
当前页面的缓存特征实时校验；只有严格校验通过的规则才能保存并应用。如果命中来自另一个
规则集，保存时会复制到当前编辑集，并显式选择这个版本。

## 规则模型

完整示例见 [`rules/examples.yaml`](./rules/examples.yaml)。

| 类型 | 匹配内容 | 载荷字段 |
|---|---|---|
| `word` | 文本包含 | `words` |
| `regex` | Google RE2 正则 | `regex` |
| `status` | HTTP 状态码 | `status` |
| `icon_hash` | favicon mmh3 哈希（FOFA 格式） | `hash` |
| `dsl` | 支持的 nuclei 风格表达式子集 | `dsl` |
| `js` | 页面运行时全局变量及可选 pattern | `js: [{path, pattern?}]` |
| `dom` | CSS 选择器及可选文本/属性 pattern | `dom: [{sel, text?, attrs?}]` |

规则组合方式：

- `part`：`body`、`title`、`url`、`header`、`raw`、`meta` 或 `script`，默认 `body`。
- `condition`：用 `and` 或 `or` 组合单个 matcher 内的条目，默认 `or`。
- `matchers-condition`：组合一条规则内的多个 matcher。
- `negative: true`：反转有效匹配结果；无效条件绝不会被反转成命中。
- `implies`：推导关联技术，并记录“由 X 推导”的证据。
- `confidence: 0-100`：可选的 matcher 或规则信号强度；未标注时保持 `null`，不会编造成 100。
- `version`：可选版本模板；regex 与 JavaScript pattern 支持 `\1`、`\2` 和 `\1?存在:缺失`，结果最长 120 个字符。

置信度合成时，`or` 取最强命中信号，`and` 取最弱信号；规则级置信度作为缩放系数，
`implies` 命中继承来源置信度，但不会凭空生成版本。Wappalyzer 的 `\;confidence:N` 与
`\;version:\1` 后缀会在导入时转换。

DSL 子集支持：

- 标识符：`body`、`title`、`url`、`header`、`raw`、`meta`、`script`、`status`、`favicon_hash`
- 函数：`contains(a, "文本")`、`matches(a, "正则")`
- 运算符：`&&`、`||`、`!`、`==`、`!=` 和括号

示例：`contains(body, "wp-content") && status == 200`

## 第三方规则源

设置页提供三个固定社区来源。只有用户点击**立即刷新**，或主动开启每日/每周检查后，
扩展才会下载规则。

| 来源 | 大致规模 | 用途 |
|---|---:|---|
| [enthec/webappanalyzer](https://github.com/enthec/webappanalyzer) | 数千条 | 社区维护的 Wappalyzer Web 指纹 |
| [EdgeSecurityTeam/EHole](https://github.com/EdgeSecurityTeam/EHole) | 约 958 条 | 棱洞指纹，国产系统覆盖较好 |
| [projectdiscovery/nuclei-templates](https://github.com/projectdiscovery/nuclei-templates) | 数百条 | `http/technologies` 技术识别模板 |

扩展只从固定 HTTPS 主机下载，验证重定向，不携带凭据；单文件最多 3 MB、单次更新总计
最多 30 MB，使用 4 个下载 worker，转换结果最多 25,000 条规则。每个来源均在本地转换、
校验并原子替换自己的规则集。ETag、Last-Modified 和内容哈希用于跳过无变化的写入，
IndexedDB 在本地保留一个旧版本用于回滚。项目有意不支持任意来源 URL。

转换代码位于 `wasm/engine/convert.go`。GoPainter 仅提供格式转换能力，**不内置、不分发**
这些第三方完整规则库。规则内容、许可证与合规责任仍属于各自维护者和使用者。请遵守每个
来源的许可证和适用法律，仅在授权范围内用于测试与研究。

内置 favicon 哈希库是另一份生成数据，来源为
[BishopFox/Favicons](https://github.com/BishopFox/Favicons)；归属说明和数据源保留在
`data/favicon-hashes.json`。

## AI 与 Agent

AI 功能完全可选。在设置页选择 OpenAI 兼容或 Anthropic 协议，填写 endpoint 和模型，
首次执行任务前先运行**测试 Agent 工具**。

| 服务 | Base URL | 模型示例 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5` |

自动只读 Agent 工具最多并发 5 路。需要授权的联网工具保持串行，并在调用前暂停确认。
`fetch_url` 只接受 HTTPS，执行有界读取和本地/私有地址防护；记住的授权仅对已批准的
origin 生效。外部结果只是不可信参考资料，不是可以执行的指令。

## 安全与隐私边界

- **没有 GoPainter 服务端**：API Key 只保存在扩展本地存储中，请求直接发送到你配置的 endpoint。
- **模型数据披露明确**：云端 AI 会收到页面特征；Agent 先发送紧凑概览，仅在需要时发送 HTML 片段，直接 AI 辅助功能可能发送截断后的 HTML。除非可以接受交给对应服务商处理，否则不要在敏感页面启用 AI。
- **页面证据不可信**：DOM 和运行时值来自被测页面。命中只能说明某个信号存在，不能证明对应技术真实可信。
- **浏览器资源有边界**：页面快照、UI 列表、扫描队列、favicon URL 数量、下载并发、响应字节、重定向和历史窗口均设有上限；批量扫描最多接收 500 个 URL，并为结果单独保留 2.5 MB session 预算。
- **AI 结果需要复核**：AI 识别、生成规则和书签兜底都可能出错。确定性 Go Core 校验的是结构与语义，不是现实世界中的真实性。

## 开发与验证

| 命令 | 用途 |
|---|---|
| `make build` | 构建生产 Go WASM + 内嵌 RE2 引擎 |
| `make test` | 运行 Go/WASM 与 JavaScript 测试，再运行 WASM 冒烟测试 |
| `make test-go` | 通过 js/wasm target 运行 Go 测试 |
| `make test-js` | 运行 Node 测试和 JavaScript 语法检查 |
| `make test-browser-e2e` | 验证 Chromium 采集、版本提取、popup、实时规则编辑、批量扫描及 SPA 结果替换 |
| `make bench-js` | 测量 UI、采集、序列化和 Agent 规则搜索路径 |
| `make bench-chromium` | 运行 30/50 标签页 Chromium 资源压测 |
| `make icons` | 重新生成扩展图标 |
| `make clean` | 删除生成的 WASM 文件 |

浏览器 E2E 和 Chromium 压测需要本机 Chrome/Chromium。其他生成器和脚本入口位于
`scripts/`，详细命令以 Makefile 为准。

<details>
<summary><strong>架构与目录结构</strong></summary>

### 架构

```text
JavaScript Host / Runtime                 Go WASM Core / Authority
浏览器、网络、存储、生命周期                 确定性产品语义，零 I/O
────────────────────────────────────      ─────────────────────────────
content.js ─ 页面/DOM 采集 ──────────┐
background ─ 响应头、图标、AI ───────┼──→ 匹配、证据、mmh3
options ─ YAML 解析和设置 ───────────┘    规范化、校验、
popup / sidepanel ─ 用户交互               probe 规划、爬取调度
```

这条边界是有意设计的：浏览器、模型、用户、存储、网络与生命周期属于 JavaScript Host；
规则语法、matcher 语义、规范化、严格候选校验、probe 规划及其他确定性产品规则属于 Go。

不要在 JavaScript 中重复 Core 语义，也不要为了增加 Go 代码量，把 Chrome API、DOM、
网络 I/O、Provider、权限或 Agent loop 搬进 WASM。

### 目录结构

```text
├── wasm/
│   ├── main.go, bridge.go       # 暴露给 JavaScript 的薄 JSON bridge
│   └── engine/                  # 纯 Go 匹配、转换与校验逻辑
├── extension/
│   ├── background.js            # MV3 装配入口与消息路由
│   ├── background/              # 页面、规则源、爬取、历史与 AI Host
│   ├── agent/                   # 有界 Agent loop、工具与技能
│   ├── content.js               # 页面特征采集
│   ├── popup.*, options.*       # 结果、规则与设置
│   └── sidepanel.*              # 爬取进度与控制
├── scripts/                     # 构建、生成、压测与冒烟脚本
├── data/favicon-hashes.json     # favicon 数据库源文件
├── rules/examples.yaml          # 原生规则示例
└── Makefile
```

</details>

## 项目状态

浏览器核心工作流已经实现，并由单元测试、冒烟测试和浏览器 E2E 覆盖。GoPainter 负责
可靠采集、匹配、校验和结果工作流；v0.7.2 不扩充指纹规则内容。实际使用的规则由使用者
导入、编辑，或主动从兼容来源更新。

## License

[MIT](./LICENSE)
