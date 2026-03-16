# Scrapling 开源项目集成分析

> 执行 A（verify:jianying-export）+ 调研 GitHub Scrapling + 融入可行性评估  
> 更新于 2026-03-15

---

## 一、执行 A 结果：`npm run verify:jianying-export`

### 1.1 运行概况

| 项目 | 结果 |
|------|------|
| 脚本 | `tsx scripts/verify-jianying-export.ts` |
| 流程 | 7 步：open_app 剪映 → click 开始创作 → wait 3500ms → click 导出 → click 桌面 → type → click 导出 |
| 状态 | **部分通过**：步骤 1–4 成功（含坐标点击修复），步骤 5 起依赖导出对话框检测 |

### 1.2 已修复

1. **剪映「开始创作」坐标点击**
   - 根因：同窗口分支传 `step.name` 不含窗口名，`isJianyingStartCreating` 不匹配
   - 修复：传 `sameWindowTarget = "剪映|开始创作"` + `targetHwnd`
   - 结果：`剪映 开始创作：自研坐标点击优先 (400,228)` ✅

2. **剪映「导出」坐标点击**
   - 新增主窗导出按钮坐标分支 (0.92, 0.06)
   - 结果：`剪映 导出：自研坐标点击优先 (736,36)` ✅

3. **导出对话框等待**
   - 初始延迟 800ms → 1200ms
   - 重试 6 次 300ms → 8 次 400ms

### 1.3 待优化

- **findExportDialogHwnd**：未找到导出对话框时，需根据具体剪映版本检查窗口标题/子窗口结构
- **UiaSniper 中文编码**：仍存在乱码，但不影响当前坐标优先流程

---

## 二、Scrapling 开源项目概况

### 2.1 基本信息

| 项目 | 值 |
|------|-----|
| 仓库 | [D4Vinci/Scrapling](https://github.com/D4Vinci/Scrapling) |
| 语言 | Python 3.10+ |
| 许可 | BSD-3-Clause |
| Stars | ~29.7k |
| 用途 | **Web Scraping**（网页抓取），非桌面 UI 自动化 |

### 2.2 核心能力

- **反爬 bypass**：Cloudflare Turnstile 等防护，开箱即用
- **自适应解析（Adaptive Parsing）**：网站改版后仍能重新定位目标元素
- **多种 Fetcher**：Fetcher、StealthyFetcher、DynamicFetcher（含 Playwright）
- **Spider 框架**：类 Scrapy，支持并发、暂停/恢复、代理轮换
- **MCP Server**：内置 MCP，可与 AI（Claude/Cursor）配合做网页抓取

### 2.3 与「自适应」相关的算法要点

根据 [Scrapling 文档](https://scrapling.readthedocs.io/en/latest/)：

| 能力 | 说明 |
|------|------|
| Smart Element Tracking | 网站结构变化后，用**相似度算法**重新定位元素 |
| Find Similar Elements | 自动查找与已知元素相似的元素 |
| Smart Flexible Selection | CSS/XPath/文本/正则等多策略选择 |
| Adaptive 参数 | `page.css('.product', adaptive=True)` 启用自适应查找 |

本质：用**多策略选择 + 相似度匹配**，在 DOM 结构变化时仍能找到「等价」元素。

---

## 三、SuperOS 与 Scrapling 的领域对比

| 维度 | SuperOS | Scrapling |
|------|---------|-----------|
| 目标 | Win11 桌面自动化（剪映、微信等） | Web 网页抓取、数据提取 |
| 技术栈 | TypeScript、DirectShell、UIA、坐标点击 | Python、HTTP/Playwright、HTML/DOM |
| 元素定位 | UIA 树 + 坐标 fallback | CSS/XPath + 相似度算法 |
| 典型场景 | 剪映导出、微信发消息 | 反爬 bypass、抓商品列表、表单结构 |

结论：**领域不同**（桌面 vs Web），但**策略思想可借鉴**。

---

## 四、融入我们代码的可行性

### 4.1 直接集成（Python 作为子服务）

| 方式 | 可行性 | 说明 |
|------|--------|------|
| MCP 集成 | ✅ 高 | Scrapling 自带 MCP，可加入 `.cursor/mcp.json`，与 DirectShell 并列 |
| Node 子进程调用 | ✅ 可行 | `child_process.spawn` 调 Python scrapling 脚本，类似 SD/Midjourney |
| 改写为 TypeScript | ⚠️ 低 | 算法复杂、依赖多，移植成本高 |

### 4.2 算法思想融入（桌面端「自适应」）

Scrapling 的「自适应」思想可迁移到我们的 UIA/坐标策略：

| 当前做法 | 借鉴后 |
|----------|--------|
| 单一策略：Name → 失败 → 坐标 | 多策略：Name → AutomationId → 相对位置 → 文本相似度 → 坐标 |
| 固定坐标 (0.5, 0.38) | 基于「相似控件」的相对位置（如「第一个可点击的按钮」） |
| 剪映 UI 改版后需人工调坐标 | 相似度算法自动找「开始创作」等价按钮 |

实现路径：在 `directShellBridge` 或独立模块中，增加「多策略 + 相似度」的控件查找，而不是直接复用 Scrapling 的 Python 实现。

---

## 五、融入后的潜在突破

### 5.1 高价值

1. **P3 发布流程（Web 端）**
   - 抖音、B 站、小红书等：需在 Web 端填标题、选分区
   - Scrapling 可：抓取页面结构、提取表单字段、 bypass 反爬
   - DynamicFetcher 基于 Playwright，可同时做「抓取 + 自动化操作」

2. **ResearchAgent `script_scrape`**
   - 项目已有 `script_scrape` 建议类型
   - 可对接 Scrapling MCP，由 AI 按需执行网页抓取，减少自研爬虫

3. **MCP 生态**
   - DirectShell：桌面 UIA
   - Scrapling：Web 抓取
   - AI 可根据任务类型选择工具

### 5.2 中等价值

4. **自适应思想用于桌面**
   - 剪映/微信 UI 改版时，减少人工维护坐标
   - 多策略 + 相似度，提升 UIA 失败时的鲁棒性

5. **素材/参考获取**
   - 若需从网页获取参考（标题模板、分区列表等），Scrapling 可承担

### 5.3 成本与风险

- 需团队具备 Python 环境，并执行 `scrapling install`（浏览器等依赖）
- Web 与桌面是两条线，需明确职责边界
- 相似度算法从 DOM 迁移到 UIA，需自研，不能直接照搬

---

## 六、建议执行步骤

### 短期（先解决 A）

1. **修复 verify:jianying-export**
   - 确认剪映 click 路由到坐标点击逻辑
   - 修复中文编码与 inject 超时
   - 目标：P0 验证通过

### 中期（Scrapling 融入）

2. **接入 Scrapling MCP（POC）**
   - 在 `.cursor/mcp.json` 增加 scrapling 配置
   - 用 Cursor 调用 Scrapling 抓取一次示例页面
   - 评估：是否满足 P3 发布前期的「获取页面结构」需求

3. **P3 发布 Blueprint 时纳入 Scrapling**
   - 明确：Web 填表/选分区由 Scrapling（或 Scrapling + Playwright）承担
   - 与 DirectShell 分工：桌面用 DirectShell，Web 用 Scrapling/Playwright

### 长期（算法借鉴）

4. **桌面端「多策略 + 相似度」**
   - 在 `directShellBridge` 增加多策略控件查找
   - 参考 Scrapling 的「Find Similar Elements」设计 UIA 等价逻辑

---

## 七、结论

| 问题 | 结论 |
|------|------|
| Scrapling 能否融入？ | **可以**：MCP 集成 + 子进程调用均可 |
| 融入有何突破？ | P3 发布 Web 抓取、ResearchAgent script_scrape、MCP 生态扩展；桌面端可借鉴自适应思想 |
| 建议执行顺序？ | ① 修复 verify:jianying-export → ② 接入 Scrapling MCP POC → ③ P3 Blueprint 纳入 → ④ 桌面端多策略/相似度 |

---

## 八、自我进化相关开源项目（GitHub 可学习参考）

> 自适应与自我进化是系统关键。以下为 GitHub 上可借鉴的开源实现。

### 8.1 代码级自我修改（Agent 改自己的代码）

| 项目 | Stars | 核心思路 | 与 SuperOS 的关联 |
|------|-------|----------|-------------------|
| [jennyzzt/dgm](https://github.com/jennyzzt/dgm) 达尔文哥德尔机 | ~1.9k | 读写自身代码、进化新工具/工作流；通过 SWE-bench 等验证改进 | 借鉴「失败→分析→改规则/步骤→再验证」闭环 |
| [joi-lab/ouroboros](https://github.com/joi-lab/ouroboros) | ~787 | 自我创造 Agent，通过 git 改自己代码；多模型审阅后才提交 | 借鉴「宪法约束 + 多模型审核」的安全进化 |
| [MaximeRobeyns/self_improving_coding_agent](https://github.com/MaximeRobeyns/self_improving_coding_agent) | ~281 | Agent 在自身代码库上迭代；Docker 隔离 + 基准测试 | 借鉴「基准→改代码→再测」的反馈 loop |

### 8.2 运行时自适应（不改权重、改环境/策略）

| 项目 | Stars | 核心思路 | 与 SuperOS 的关联 |
|------|-------|----------|-------------------|
| [vercel-labs/ralph-loop-agent](https://github.com/vercel-labs/ralph-loop-agent) | ~703 | Ralph Wiggum 模式：外层 loop 持续迭代直到验证通过 | **直接可借鉴**：click 失败→重试→反馈→换策略（坐标/UIA） |
| [EvoMap/evolver](https://github.com/EvoMap/evolver) | ~1.5k | GEP 基因组进化协议；运行时历史→提取信号→安全变异 | 借鉴「审计轨迹 + 约束变异」防止误改核心逻辑 |
| AGENTS.md / skills 模式 | - | 用仓库内存（文档、skills）编码本地规范与修正 | **易落地**：在项目中维护「剪映/微信已知失效模式」知识库 |

### 8.3 模型权重自改（研究方向）

| 项目 | 核心思路 | 备注 |
|------|----------|------|
| [DRawson5570/self-modifying-lora](https://github.com/DRawson5570/self-modifying-lora) | AI 通过 LoRA 修改自身权重；21 分钟 20%→45% 准确率 | 偏研究，与当前桌面自动化关联较弱 |

### 8.4 对 SuperOS 的落地启发

1. **ralph-loop**：为 `runA11ySequence` 加外层验证 loop——单步失败时注入「上次失败原因」再重试，而非直接抛错。
2. **AGENTS.md / 知识库**：维护 `docs/known_failures.md`，记录「剪映 xx 版本坐标漂移」「微信 xx 场景 UIA 失效」等，供 parseIntent/规则生成参考。
3. **DGM/ouroboros**：长期可让 Agent 在安全沙盒内修改 `jianyingSteps`、`CLICK_NAME_ALIASES` 等配置，经人工或自动化验证后合并。

---

*文档基于 verify 输出、Scrapling 官方文档、GitHub 调研及项目 Phase C 需求整理。*
