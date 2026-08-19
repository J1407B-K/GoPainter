# GoPainter 基准测试与浏览器验证

[README](./README_CN.md) | [English](./BENCHMARK.md)

这是项目可复现的性能与浏览器验证档案。文档明确区分三类证据：浏览器 E2E 正确性、
有界资源行为，以及历史性能测量。每项结果都标明负载和复现命令；负载不同的数据不应
直接横向比较。

最新的浏览器正确性实测版本是 v0.6.10。多标签页资源数据仍保留 v0.6.8 基线，因为
v0.6.10 没有改变对应负载或资源上限。旧版本数据折叠保留，用于追溯设计取舍与检查性能回归。

## 当前浏览器验证与资源基线

### 1. 浏览器 E2E 正确性：v0.6.10

v0.6.10 运行真实的 Chromium unpacked 扩展。它不同于下方的资源压测，
是一项确定性的正确性测试：本地 fixture 提供已知的 title、meta、body、script、响应 Cookie、
JavaScript 运行时、DOM、favicon 和 SPA 路由信号，然后验证“采集 → 匹配 → session storage
→ popup”完整链路。

发布基线通过 7 类初始指纹信号、2 个 favicon hash、替换后的 SPA 结果（`e2e-spa`）和 popup
渲染，并确认 SPA 新结果不再保留旧页面命中。测试不会访问真实第三方仓库：上游网络、限流和
持续变化的规则数据会让 CI 变得不确定。第三方规则源的下载边界和消息路由改由确定性测试覆盖。

成功结果的机器可读输出为：

```json
{"e2e":"passed","initialHits":7,"spaHit":"e2e-spa","faviconHashes":2,"popupRendered":true}
```

### 2. 多标签页资源边界：v0.6.8

v0.6.8 用真实 Chromium，而不是只靠源码层的队列断言，完成多标签页资源加固验证。压测使用全新 profile，通过 CDP 加载 unpacked 扩展；每页提供 10 个刻意放慢且互不相同的 favicon 响应，并在运行期间轮询 extension service worker。它检查扫描 / favicon 的活动与等待队列、`storage.session` 用量、storage error、stale result commit、每 tab 孤儿 key，以及所有仍打开标签页的最终结果。

首次 50 标签页压测暴露了一个真实丢工作问题：队列满时淘汰仍有效的 scan，会使对应 tab 没有结果。最终实现保留有界队列，并让 content script 复用已受限的特征快照后重试；以下是修复后的实测数据。

| 全新 profile Chromium 负载 | 存活标签 | 扫描 active / pending 峰值 | Favicon active / pending 峰值 | Session 峰值字节 | Storage error / stale commit / 孤儿 key | 有最终结果的存活标签 |
|---|---:|---:|---:|---:|---:|---:|
| 30 个标签页 | 30 | 3 / 26 | 6 / 74 | 125,792 | 0 / 0 / 0 | 30 / 30 |
| 50 个标签页 | 50 | 3 / 32 | 6 / 97 | 200,960 | 0 / 0 / 0 | 50 / 50 |
| 30 个标签页；10 个快速 SPA 路由；10 个立即关闭 | 20 | 3 / 18 | 6 / 197 | 104,688 | 0 / 0 / 0 | 20 / 20 |

全部运行均保持在发布边界内：scan active ≤3、scan pending ≤32、favicon active ≤6、favicon pending ≤256，且页面快照 session storage ≤6,500,000 字节。这只证明资源与生命周期行为，不代表识别准确率。

### 复现当前基线

两项浏览器命令均需要本机安装 Chrome 或 Chromium。

| 目的 | 命令 |
|---|---|
| 构建并运行确定性的浏览器正确性测试 | `make build && make test-browser-e2e` |
| 构建并运行多标签页资源压测 | `make build && make bench-chromium` |
| 运行完整 Go、JavaScript、WASM 与冒烟测试 | `make test` |

## 历史测量

| 版本 | 重点 | 核心结果 |
|---|---|---|
| v0.6.4 | Host 模块化与有界 UI 工作量 | 50,000 条规则索引搜索：1.15 ms |
| v0.6.1 | 消除 JavaScript 与 DOM 长任务 | 20,000 条规则限制为 300 行，32 ms 加载 |
| v0.5.1 | 内嵌 Google RE2 verifier | 20 页爬取：12.52 s → 7.61 s |
| v0.5.0 | 正则候选预筛与 Go WASM | 真实负载热扫描：5–13 s → 约 100–200 ms |

> 历史表格中的用户脚本数据早于外接脚本移除，只代表旧版本，不属于当前产品能力。

<details>
<summary><strong>v0.6.4 —— 受限的 Host 运行时与规则体检</strong></summary>

> **重点：**拆分 service worker 控制路径，并限制大型 UI 与数据操作。

- 页面、规则、历史、爬虫、书签、AI 与 Agent 生命周期拆为独立 Host 模块，消息注册会拒绝重复类型。
- popup、设置页、content 采集、Markdown 和 Agent trace 只更新有界的数据与 DOM。
- Go Core 规则体检展示 regex 有效性与预筛成本信号，不代表识别准确率或特定页面热度。

| JavaScript 基准 | v0.6.4 结果 |
|---|---:|
| 筛选 10,000 / 50,000 条规则 | 0.58 / 5.81 ms |
| 筛选排序 10,000 / 50,000 个命中 | 1.06 / 7.08 ms |
| 压缩 2,000 个命中、每项 40 条证据 | 0.31 ms |
| 编译 100 个用户脚本 / 执行缓存脚本 | 0.06 / 0.01 ms |
| 序列化 10,000 条自定义哈希 / 缓存读取 | 0.73 / <0.01 ms |
| 在 50,000 条规则中执行 3 次搜索，旧实现 / 索引后 | 44.08 / 1.15 ms |

**复现：**`make bench-js` · **验证：**`make test`

</details>

<details>
<summary><strong>v0.6.1 —— 消除 JavaScript 与 DOM 长任务</strong></summary>

| 新增边界 | 限制或行为 |
|---|---|
| 页面序列化 | 到 200 KB 即停止，不生成完整 DOM |
| Favicon 下载 | 6 个 worker |
| Popup 快照 | 100 个命中 × 每项 20 条证据 × 每条 500 字符 |
| 设置、历史、哈希与爬取列表 | 最多渲染 300 行 |
| Storage 读取 | 缓存到失效；重扫只读取已打开标签 |

| JavaScript 基准 | 结果 |
|---|---:|
| 筛选 10,000 / 50,000 条规则 | 0.56 / 5.12 ms |
| 筛选排序 10,000 / 50,000 个命中 | 0.98 / 6.46 ms |
| 压缩 2,000 个命中、每项 40 条证据 | 0.20 ms |
| 编译 100 个用户脚本 / 执行缓存脚本 | 0.06 / 0.01 ms |
| 序列化 10,000 条自定义哈希 / 缓存读取 | 0.70 / <0.01 ms |
| 在 50,000 条规则中执行 3 次搜索，旧实现 / 索引后 | 43.23 / 1.56 ms |

| 浏览器 / 运行时检查 | 结果 |
|---|---:|
| 20,000 条规则的设置页渲染 | 300 行、1,080 个 DOM 节点、32 ms 加载 |
| 8,000 条规则稳态匹配中位数 | 13.6 ms |
| 连续扫描 200 页 | p90 28.0 ms / p99 31.2 ms |
| 20,000 条规则 Agent 链路，popup 10 ms 心跳 | 最大延迟 37.1 ms |

**复现**

```bash
make bench-js                         # JS、popup、大集合和 Agent 规则搜索
node scripts/bench-cold.mjs 8000 12  # 匹配器冷启动曲线
node scripts/bench-steady.mjs 8000   # 匹配器稳态分布
node scripts/bench-scan.mjs 8000 200 # 连续 200 页分布
make test                             # Go、JS 与 WASM 冒烟测试
```

</details>

<details>
<summary><strong>v0.5.1 —— 从 Go regexp 迁移到内嵌 Google RE2</strong></summary>

> **决策：**只把最终 verifier 从 Go `regexp` 换成内嵌 Google RE2；AST + AC planner、
> 缓存、规则语义和标准 Go WASM runtime 均不改变。

这不是根据微基准拍板，而是 Chrome 端到端实测：同一份 1.85 MB / 6,908 条规则，从 `https://github.com/` 爬取相同的 20 页。

| Chrome 爬虫，20 个成功页面 | 标准 Go `regexp` | go-re2（v0.5.1 默认） |
|---|---:|---:|
| 总耗时 | 12.52 s | **7.61 s** |
| 失败页数 | 0 | 0 |
| 总命中数 | 90 | 90 |
| 端到端变化 | — | **耗时减少 39%（吞吐 1.65×）** |
| WASM 体积 | 4.62 MB | 13.45 MB |

> **取舍：**WASM 增加约 8.8 MB，换取每 20 页少约 5 秒。TinyGo 与标准库 regex
> 后端仅作历史对照，都不是受支持的发布目标。

</details>

<details>
<summary><strong>v0.5.0 —— 正则规模化与运行时历史</strong></summary>

> **核心结果：**真实 6,908 条规则的热扫描从 5–13 秒降到约 100–200 ms，
> 原始 regex 语义保持不变。

v0.4.0 已索引 `body + word` matcher，但正则预筛仍会对完整 body 做数千次独立搜索。
v0.5.0 将正则所需的 ASCII 字面量加入共享 Aho–Corasick 索引，只扫描一次 body，
再对剩余候选执行原始正则；WASM runtime 同时从 TinyGo 切换到标准 Go。

```text
正则 AST → 必需 ASCII 字面量 → 共享 AC 索引
                                      ↓
页面 body ──────────────────────→ 扫描一次
                                      ↓
                                候选正则集合
                                      ↓
                                  原始正则
```

**真实规则负载**

| 真实负载：6,908 条规则、1.85 MB 规则 JSON、195 KB 中文 HTML body | 结果 |
|---|---:|
| 正则 pattern 数 | 6,350 |
| 被预筛安全跳过 | 6,341（99.86%） |
| 仍实际执行的正则 | 9 |
| 运行时验证的误跳过 | 0 |
| 常见预热后扫描 | ~100–200 ms |
| 首轮扫描（含规则解析和 AC 构建） | ~600 ms |
| 正则字面量 AC 预筛前 | ~5–13 s |

剩余成本来自少量宽泛 HTML 正则，属于规则质量问题，不是引擎的普遍瓶颈。

**安全边界**

预筛是单向的：只有 `regexp/syntax` 解析出的 AST 证明所有可能路径都被排除时，才会跳过正则。

| AST 结构 | 安全排除规则 |
|---|---|
| 串联（`A B`） | 任一必需子项缺失即可排除 |
| 交替（`A|B`） | 只有所有分支都被排除才能跳过 |
| 可选项、字符类、锚点或未知结构 | 不做预筛，执行原正则 |

非 ASCII 字面量不参与预筛；遇到 `ſ`/`s`、`K`/`k` 等 Unicode 折叠时回退原始正则。
测试覆盖 AST 分支、Unicode 边界和真实 6,350 条正则，预筛误跳为 0。

<details>
<summary>补充 runtime 与合成基线</summary>

**标准 Go 与 TinyGo**

以下为 200 个不同页面的连续扫描：8,000 条规则、20–400 KB body、命中数浮动、规则集已缓存。

| 指标 | 标准 Go（4.5 MB） | TinyGo（935 KB） |
|---|---:|---:|
| p50 | ~15 ms | ~16 ms |
| p90 | ~28 ms | ~28 ms |
| p99 | **~30 ms** | **~222–234 ms** |
| max | **~31 ms** | **~290–322 ms** |

TinyGo 仍有 GC 尾延迟尖峰，因此标准 Go WASM 成为发布 runtime。

**合成 word-only 基线**

此基准隔离普通 `word` 路径，而非生产中的真实正则负载。body 约 98 KB，预热 30 轮后测量 50 轮。

| 规则数 | min | median | p90 | max |
|---:|---:|---:|---:|---:|
| 1,000 | 3.7 ms | 4.3 ms | 5.1 ms | 25.1 ms |
| 8,000 | 8.7 ms | 13.9 ms | 16.8 ms | 19.2 ms |

合成负载首次扫描约 150 ms，包含规则解析与 AC 构建；热扫描约 15 ms。

</details>

**复现**

```bash
make build                              # Go WASM + go-re2，生产默认
node scripts/bench-cold.mjs 8000        # 首轮扫描曲线
node scripts/bench-steady.mjs 8000      # 合成稳态分布
```

</details>
