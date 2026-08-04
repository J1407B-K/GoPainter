# GoPainter 🎨

基于 YAML 指纹规则的 Web 资产测绘。**TinyGo** 编译的 WASM 匹配引擎 + AI 辅助识别。

浏览网页时自动对当前站点做指纹识别，命中结果实时展示——工具栏图标**灰色 = 未命中，彩色 + 数字角标 = 命中 N 个指纹**。

## 特性

- 🧩 **YAML 指纹规则**：word / regex / status / icon_hash 四种 matcher，支持 and/or 组合与 negative 取反
- 🔁 **兼容 nuclei 模板**：导入时自动提取 http matchers 子集，社区海量规则直接可用
- ⚡ **TinyGo WASM 引擎**：匹配逻辑用 Go 编写，编译产物仅 ~620KB，毫秒级匹配
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

1. 点击工具栏 GoPainter 图标 → 「⚙️ 规则」→ 导入 `rules/examples.yaml`（或任何 nuclei 模板）
2. 访问任意网站，图标变彩色即表示命中，点击图标查看详情与证据
3. 未命中时可点「✨ AI 辅助识别」（需先在设置页配置 API）

## 规则格式

见 [`rules/examples.yaml`](rules/examples.yaml)。支持四种 matcher：

| type | 说明 | 条件字段 |
|---|---|---|
| `word` | 文本包含 | `words` |
| `regex` | 正则匹配 | `regex` |
| `status` | HTTP 状态码 | `status` |
| `icon_hash` | favicon mmh3 哈希（fofa 标准） | `hash` |

- `part`：`body` / `title` / `url` / `header` / `raw` / `meta` / `script`（默认 `body`）
- `condition`：matcher 内部多条件组合，`and` / `or`（默认 `or`）
- `matchers-condition`：规则内多个 matcher 的组合方式
- `negative: true`：取反

## AI 配置

设置页填入任意 **OpenAI 兼容接口**即可：

| 服务 | Base URL | 模型示例 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5` |

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
```

核心边界：**WASM 只做纯计算**（进 JSON 出 JSON，不碰网络/YAML/DOM），
因此 TinyGo 的短板（反射不完整、标准库缺失）完全不会踩到。
匹配、mmh3、HTML 特征提取、nuclei 模板转换全部在 Go 里。

## 目录

```
├── wasm/                     # Go 引擎（TinyGo 编译为 WASM）
│   ├── main.go               #   JS 导出 + JSON 进出
│   ├── matcher.go            #   匹配引擎（核心）
│   ├── mmh3.go               #   favicon 哈希
│   ├── extract.go            #   HTML 特征提取
│   └── normalize.go          #   规则规范化（nuclei 转换）
├── extension/                # Chrome 扩展（MV3）
│   ├── manifest.json
│   ├── background.js         # service worker：wasm 加载、webRequest、favicon、AI、图标、书签
│   ├── content.js            # 页面特征采集
│   ├── popup.*               # 结果与证据展示 / AI 识别 / AI 生成规则
│   ├── options.*             # 规则导入 / AI 配置 / 提示词 / 书签整理
│   ├── icons/                # 彩色/灰色两套图标（脚本生成）
│   └── lib/                  # js-yaml（唯一的第三方 JS）
├── scripts/
│   ├── generate-icons.mjs    # 图标生成器（纯 Node，零依赖）
│   ├── smoke-test.mjs        # wasm 冒烟测试
│   └── build.ps1             # Windows 构建脚本
├── rules/examples.yaml       # 示例规则
├── Makefile                  # macOS/Linux 构建
└── build.ps1（scripts/）     # Windows 构建
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

**进行中 / 计划** 🚧
- [ ] SPA 路由变化监听（pushState / popstate 触发重新分析）
- [ ] matcher 支持 dsl 表达式子集（`contains(body, "x") && status == 200`）
- [ ] 规则集管理：分组启用/禁用、远程规则源订阅与自动更新
- [ ] 扫描历史与报告导出（JSON/CSV）
- [ ] 内置常见 favicon 哈希库（fofa 公开数据）
- [ ] wasm 体积进一步优化（当前 ~620KB，目标 < 300KB）
## License

[MIT](LICENSE)
