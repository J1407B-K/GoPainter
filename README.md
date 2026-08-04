# GoPainter 🎨

Chrome 扩展：基于 YAML 指纹规则的 Web 资产测绘。**TinyGo** 编译的 WASM 匹配引擎 + AI 辅助识别。

浏览网页时自动对当前站点做指纹识别，命中结果实时展示——工具栏图标**灰色 = 未命中，彩色 + 数字角标 = 命中 N 个指纹**。

## 特性

- 🧩 **YAML 指纹规则**：word / regex / status / icon_hash 四种 matcher，支持 and/or 组合与 negative 取反
- 🔁 **兼容 nuclei 模板**：导入时自动提取 http matchers 子集，社区海量规则直接可用
- ⚡ **TinyGo WASM 引擎**：匹配逻辑用 Go 编写，编译产物仅 ~620KB，毫秒级匹配
- 🔍 **命中证据展示**：每个指纹附带具体命中的关键词/正则/状态码/哈希
- 🎨 **图标状态感知**：灰色 = 未命中，彩色 + 角标数字 = 命中数
- ✨ **AI 辅助识别**：规则未命中时一键调用 LLM 分析（任意 OpenAI 兼容接口）
- 🔒 **纯本地**：规则与 AI Key 存在浏览器本地，页面数据不出浏览器（除主动调用 AI）

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

### 3. 安装到 Chrome（Windows / macOS 相同）

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

- `part`：`body` / `title` / `url` / `header` / `raw`（默认 `body`）
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
content.js   采集 DOM 特征    ─┐
background   采集响应头/状态码  ├─→  matcher.wasm：goMatch(rules, features)
  .js        favicon + mmh3   ─┘      word / regex / status / icon_hash
             AI API 调用      ←──────  返回命中结果 + 证据 JSON
             图标状态切换
options      YAML 导入（js-yaml，兼容 nuclei 模板）
popup        结果与证据展示 / AI 识别按钮
```

核心边界：**WASM 只做纯计算**（进 JSON 出 JSON，不碰网络/YAML/DOM），
因此 TinyGo 的短板（反射不完整、标准库缺失）完全不会踩到。

## 目录

```
├── wasm/main.go              # Go 匹配引擎（TinyGo 编译为 WASM）
├── extension/                # Chrome 扩展（MV3）
│   ├── manifest.json
│   ├── background.js         # service worker：WASM 加载、webRequest、favicon、AI、图标状态
│   ├── content.js            # 页面特征采集
│   ├── popup.*               # 结果与证据展示
│   ├── options.*             # 规则导入 / AI 配置
│   ├── icons/                # 彩色/灰色两套图标（脚本生成）
│   └── lib/                  # js-yaml、mmh3
├── scripts/
│   ├── generate-icons.mjs    # 图标生成器（纯 Node，零依赖）
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
- [x] AI 辅助识别（OpenAI 兼容接口）

**进行中 / 计划** 🚧
- [ ] SPA 路由变化监听（pushState / popstate 触发重新分析）
- [ ] matcher 支持 dsl 表达式子集（`contains(body, "x") && status == 200`）
- [ ] AI 反向生成规则：未识别页面 → AI 建议 YAML 规则 → 一键入库
- [ ] 规则集管理：分组启用/禁用、远程规则源订阅与自动更新
- [ ] 扫描历史与报告导出（JSON/CSV）
- [ ] 内置常见 favicon 哈希库（fofa 公开数据）
- [ ] wasm 体积进一步优化（当前 ~620KB，目标 < 300KB）
- [ ] CI 自动构建 + 发布 zip 包
- [ ] Firefox 适配（MV2/MV3 兼容层）

## 开发提示

- 改了 Go 代码：`make build` → `chrome://extensions` 点刷新
- 改了 JS/HTML：刷新扩展；改了 `content.js` 还需刷新目标网页
- 规则更新：options 页重新导入即可（同 id 覆盖），无需刷新扩展
