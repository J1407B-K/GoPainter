# GoPainter 性能记录

这是项目的长期性能档案。每一次重要性能改动、所用负载、取舍和复现命令都应记录在这里。它不是收集微基准的地方，而是让后续设计决策可以被复核的依据。

## v0.6.8 —— Chromium 验证

### 浏览器 E2E 正确性基线

v0.6.8 运行真实的 Chromium unpacked 扩展。它不同于下方的资源压测，
是一项确定性的正确性测试：本地 fixture 提供已知的 title、meta、body、script、JavaScript
运行时、DOM、favicon 和 SPA 路由信号，然后验证“采集 → 匹配 → session storage → popup”
完整链路。

发布基线通过 6 种初始 matcher、2 个 favicon hash、替换后的 SPA 结果（`e2e-spa`）和 popup
渲染，并确认 SPA 新结果不再保留旧页面命中。测试不会访问真实第三方仓库：上游网络、限流和
持续变化的规则数据会让 CI 变得不确定。第三方规则源的下载边界和消息路由改由确定性测试覆盖。

使用 `make build && make test-browser-e2e` 复现（需要本机 Chrome）。成功结果的机器可读输出为：

```json
{"e2e":"passed","initialHits":6,"spaHit":"e2e-spa","faviconHashes":2,"popupRendered":true}
```

### Chromium 多标签页资源边界

v0.6.8 用真实 Chromium，而不是只靠源码层的队列断言，完成多标签页资源加固验证。压测使用全新 profile，通过 CDP 加载 unpacked 扩展；每页提供 10 个刻意放慢且互不相同的 favicon 响应，并在运行期间轮询 extension service worker。它检查扫描 / favicon 的活动与等待队列、`storage.session` 用量、storage error、stale result commit、每 tab 孤儿 key，以及所有仍打开标签页的最终结果。

首次 50 标签页压测暴露了一个真实丢工作问题：队列满时淘汰仍有效的 scan，会使对应 tab 没有结果。最终实现保留有界队列，并让 content script 复用已受限的特征快照后重试；以下是修复后的实测数据。

| 全新 profile Chromium 负载 | 存活标签 | 扫描 active / pending 峰值 | Favicon active / pending 峰值 | Session 峰值字节 | Storage error / stale commit / 孤儿 key | 有最终结果的存活标签 |
|---|---:|---:|---:|---:|---:|---:|
| 30 个标签页 | 30 | 3 / 26 | 6 / 74 | 125,792 | 0 / 0 / 0 | 30 / 30 |
| 50 个标签页 | 50 | 3 / 32 | 6 / 97 | 200,960 | 0 / 0 / 0 | 50 / 50 |
| 30 个标签页；10 个快速 SPA 路由；10 个立即关闭 | 20 | 3 / 18 | 6 / 197 | 104,688 | 0 / 0 / 0 | 20 / 20 |

全部运行均保持在发布边界内：scan active ≤3、scan pending ≤32、favicon active ≤6、favicon pending ≤256，且页面快照 session storage ≤6,500,000 字节。这只证明资源与生命周期行为，不代表识别准确率。

使用 `make build && make bench-chromium` 复现（需要本机 Chrome）。

## v0.6.4 —— 受限的 Host 运行时与规则体检

v0.6.4 继续让 JavaScript 负责浏览器 I/O 编排，但移除了单体 service worker 控制路径。
`background.js` 现在只是精简的装配入口；页面、规则、历史、爬虫、书签、AI 与 Agent
生命周期分别由独立 Host 模块持有，消息注册会拒绝重复类型。popup、设置页、content
采集、Markdown 和 Agent trace 路径均只更新受限的数据与 DOM，不再反复重建大型视图。

规则体检由 Go Core 根据解析后的 regex AST 计算，展示有效性、结构上的预筛潜力、
必定执行项及长短代表锚点。这些数据描述规则扫描成本，不代表指纹识别准确率，也不是
特定页面上的实测热度。

| JavaScript 基准 | v0.6.4 结果 |
|---|---:|
| 筛选 10,000 / 50,000 条规则 | 0.58 / 5.81 ms |
| 筛选排序 10,000 / 50,000 个命中 | 1.06 / 7.08 ms |
| 压缩 2,000 个命中、每项 40 条证据 | 0.31 ms |
| 编译 100 个用户脚本 / 执行缓存脚本 | 0.06 / 0.01 ms |
| 序列化 10,000 条自定义哈希 / 缓存读取 | 0.73 / <0.01 ms |
| 在 50,000 条规则中执行 3 次搜索，旧实现 / 索引后 | 44.08 / 1.15 ms |

使用 `make bench-js` 复现；使用 `make test` 验证 Go、JavaScript、WASM、严格候选校验、
规则体检、Host 路由与冒烟链路。

## 历史版本

<details>
<summary><strong>v0.6.1 —— 消除 JavaScript 与 DOM 长任务</strong></summary>

## v0.6.1 —— 消除 JavaScript 与 DOM 长任务

v0.6.1 处理匹配引擎变快后仍残留的 UI 卡顿。content script 不再先生成完整页面
`outerHTML` 再截断，而是最多序列化 200 KB，到达上限后立即停止遍历。favicon 下载
改为 6 个 worker；规则、哈希库和用户脚本会缓存到 storage 发生变化；重扫只读取当前
已打开标签对应的 session 数据。

弹窗快照固定最多 100 个命中、每项 20 条证据、每条证据 500 字符。规则、历史、哈希和
爬取结果视图最多渲染 300 行，爬取轮询在结果未变化时不再重建 DOM。Chromium 临时配置中
灌入 20,000 条规则后，设置页实际只渲染 300 行，共 1,080 个 DOM 节点，导航加载 32 ms。

| JavaScript 基准 | 结果 |
|---|---:|
| 筛选 10,000 / 50,000 条规则 | 0.56 / 5.12 ms |
| 筛选排序 10,000 / 50,000 个命中 | 0.98 / 6.46 ms |
| 压缩 2,000 个命中、每项 40 条证据 | 0.20 ms |
| 编译 100 个用户脚本 / 执行缓存脚本 | 0.06 / 0.01 ms |
| 序列化 10,000 条自定义哈希 / 缓存读取 | 0.70 / <0.01 ms |
| 在 50,000 条规则中执行 3 次搜索，旧实现 / 索引后 | 43.23 / 1.56 ms |

本轮没有牺牲匹配性能：8,000 条规则稳态中位数为 13.6 ms；200 页连续扫描 p90 为
28.0 ms，p99 为 31.2 ms。使用 `make bench-js` 可复现 JS 基准。

Agent 现在读取不含正文的页面概览，并共享一个分批构建、主动让出事件循环的规则搜索索引。
Chromium 端到端测试灌入 20,000 条规则，一轮模型请求 `inspect_page`、3 次
`search_rules` 和 `search_page_js` 后完成归纳；popup 的 10 ms 心跳在全程观测到的
最大延迟为 37.1 ms。

### 复现 v0.6.1

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

以下为 v0.5.1 将最终正则执行器从 Go 标准库 `regexp` 迁移到 `wasilibs/go-re2` 的历史测量。主运行时在 v0.5.0 已经切换为标准 Go WASM；本版更换的是正则 verifier，不是 WASM 工具链。

## v0.5.1 —— 从 Go regexp 迁移到内嵌 Google RE2

v0.5.0 已把 planner 做到有效：AST + AC 能排除几乎所有可证明无关的正则。v0.5.1 将最后留下的 verifier 从 Go 标准库 `regexp` 迁移到 `wasilibs/go-re2`，在 Go WASM 中使用内嵌 Google RE2。它保持 RE2 的线性时间与安全模型；planner、缓存和规则语义均不改变。

这不是根据微基准拍板，而是 Chrome 端到端实测：同一份 1.85 MB / 6,908 条规则，从 `https://github.com/` 爬取相同的 20 页。

| Chrome 爬虫，20 个成功页面 | 标准 Go `regexp` | go-re2（v0.5.1 默认） |
|---|---:|---:|
| 总耗时 | 12.52 s | **7.61 s** |
| 失败页数 | 0 | 0 |
| 总命中数 | 90 | 90 |
| 端到端提升 | — | **耗时减少 39%（吞吐 1.65×）** |
| WASM 体积 | 4.62 MB | 13.45 MB |

多出的约 8.8 MB 是有意取舍：这是自动扫描器和爬虫，每 20 页少约 5 秒，比减小二进制更有价值。v0.5.0 中保留的运行时数据仅作历史对照；TinyGo 与标准库 regex 后端均不是受支持的发布目标。

</details>

<details>
<summary><strong>v0.5.0 —— 正则规模化与运行时历史</strong></summary>

以下为 v0.5.0 匹配路径重构及运行时基线的历史测量。

## v0.5.0 —— 让正则规则能够规模化运行

v0.5.0 是一次性能导向的发布。在 v0.4.0 中，大型导入规则集可能让普通页面扫描耗时数秒：正则预筛本身是正确的，但数千条预筛仍各自重复搜索同一份 HTML body。

修复方案刻意保守：只有当解析后的正则语法树证明**所有**可匹配分支都不可能成立时，才跳过该正则。规则集构建时收集必需的 ASCII 字面量，将它们放入共享的 Aho–Corasick（AC）自动机；页面 body 只扫描一次。原始正则始终是最终裁决者。

这是执行策略的改变，不是削弱检测语义。

### 与 v0.4.0 的性能对比

#### v0.4.0 —— word 路径很快，但 regex 规模化不完整

v0.4.0 已经会缓存解析后的规则集，并为 `body + word` matcher 使用 AC。这让普通 word 规则集很快；但真实导入规则主要由 regex 驱动，它们的预筛仍是数千次彼此独立的 `Contains(body, literal)` 全文搜索。因此合成 word 基准漂亮，真实的大型 regex 规则集却会在页面扫描时进入秒级。

#### v0.5.0 —— 一次 body 扫描同时服务 word 与 regex 候选

v0.5.0 将既有的 body AC 索引扩展到 regex 的必需字面量，并加入保守的 AST 分支分析、Unicode 安全边界和 evidence / 结果路径的分配优化。连续扫描数据还证明：即使匹配工作显著减少，TinyGo 的 GC p99 仍比标准 Go 高 7–10 倍；因此 WASM runtime 切换为标准 Go。

这次更新不只是降低平均耗时：它把真实 6,908 条规则的多秒级阻塞操作，变成通常可在后台完成的扫描，同时保留原始 regex 作为最终确认。

| 真实负载：6,908 条规则、1.85 MB 规则 JSON、195 KB 中文 HTML body | 结果 |
|---|---:|
| 正则 pattern 数 | 6,350 |
| 被预筛安全跳过 | 6,341（99.86%） |
| 仍实际执行的正则 | 9 |
| 运行时验证的误跳过 | 0 |
| 常见预热后扫描 | ~100–200 ms |
| 首轮扫描（含规则解析和 AC 构建） | ~600 ms |
| 正则字面量 AC 预筛前 | ~5–13 s |

剩余成本来自少量泛 HTML 正则（例如 XenForo pattern）；这属于规则质量治理，而不是通用引擎瓶颈。

### 执行策略变化

| v0.4.0 | v0.5.0 |
|---|---|
| 每条正则预筛重复搜索完整 body | 一次 AC 扫描产出共享的字面量命中集合 |
| 195 KB 真实页面可能需 5–13 秒 | 常见预热后扫描约 100–200 ms |
| 编译器 / GC 看起来像主因 | profile 确认主因是重复的正则预筛扫描 |
| TinyGo 为默认构建 | 标准 Go 消除 TinyGo GC 尾延迟尖峰 |

## v0.5.0 的匹配路径

AC **不会取代正则**，它只负责筛选候选。

```text
正则 AST -> 必需 ASCII 字面量 -> AC 索引（每个规则集构建一次）
                                           |
页面 body ------------------------------- 扫描一次
                                           |
                                  字面量命中集合
                                           |
AST 是否证明所有分支都不可能？ ------ 是 ---> 跳过正则
                                           |
                                          否
                                           |
                                 执行原始正则确认
```

例如，`Powered by <a href="[^>]+phpfusion` 若要命中，页面必然包含 `phpfusion`。AC 能一次找出所有此类字面量，而不是让每条正则反复扫描完整 HTML。

### 正确性不可妥协

预筛是单向的：只有 `regexp/syntax` 解析出的 AST 证明所有可能路径都被排除时，才会跳过正则。

| AST 结构 | 安全排除规则 |
|---|---|
| 串联（`A B`） | 任一必需子项缺失即可排除 |
| 交替（`A|B`） | 只有所有分支都被排除才能跳过 |
| `*`、`?`、字符类、锚点和未知结构 | 不做预筛，执行原正则 |

匹配器采用 Go 的不区分大小写正则语义。为避免 Unicode 折叠导致漏报：非 ASCII 字面量不做预筛；body 中出现会与 ASCII 折叠等价的非 ASCII rune（如 `ſ`/`s`、`K`/`k`）时，也回退执行原正则。中文或 emoji 本身不会禁用 ASCII 字面量预筛。

单元测试覆盖分支语义、Unicode 折叠边界，以及 AC 命中集合与旧 `strings.Contains` 预筛的一致性。对真实页面与 6,350 条规则的运行时逐条复核得到零误跳；任何情况下原始正则仍是最终匹配器。

### 其他保留优化

- 规则 JSON、已编译正则、AC 索引和名称索引在规则集不变时缓存复用。
- `raw` 及其小写副本只在规则确实需要时构建。
- body AC 扫描在索引只含 ASCII 词时直接跳过非 ASCII 字节（每字节一次重置）——中文等非
  ASCII 页面完全省掉 fail 跳转的开销；语义不变（非 ASCII 字节不可能匹配 ASCII 词）。
- matcher 与 rule 的 `and` / `or` 结果增量折叠，避免临时结果切片。
- evidence 直接追加到 rule 结果，避免中间切片。
- 规则集未使用 `implies` / `excludes` 时跳过对应后处理。

## 历史运行时对照：Go WASM 与 TinyGo

以下为 200 个不同页面的连续扫描：8,000 条规则、20–400 KB body、命中数浮动、规则集已缓存。

| 指标 | 标准 Go（4.5 MB） | TinyGo（935 KB） |
|---|---:|---:|
| p50 | ~15 ms | ~16 ms |
| p90 | ~28 ms | ~28 ms |
| p99 | **~30 ms** | **~222–234 ms** |
| max | **~31 ms** | **~290–322 ms** |

即使预筛移除了绝大多数正则工作，TinyGo 仍会出现 GC 尾延迟尖峰。因此生产 runtime 选择 Go WASM；v0.5.1 再将其中的 regex verifier 升级为 go-re2。TinyGo 仅保留作历史/开发对照，不再作为维护中的发布目标。

## 基线：合成 word 规则

此基准隔离普通 `word` 路径，而非生产中的真实正则负载。body 约 98 KB，预热 30 轮后测量 50 轮。

| 规则数 | min | median | p90 | max |
|---:|---:|---:|---:|---:|
| 1,000 | 3.7 ms | 4.3 ms | 5.1 ms | 25.1 ms |
| 8,000 | 8.7 ms | 13.9 ms | 16.8 ms | 19.2 ms |

这个合成负载的首次扫描约 150 ms，包含规则 JSON 解析和 AC 构建；预热后约 15 ms。

## 复现测量

```bash
make build                              # Go WASM + go-re2，生产默认
node scripts/bench-cold.mjs 8000        # 首轮扫描曲线
node scripts/bench-steady.mjs 8000      # 合成稳态分布
```

</details>
