# SuperOS 四层降级执行架构 (Four-Layer Degradation Architecture)

## 概览

SuperOS 采用**四层降级执行架构**实现"完全控制电脑"的终极目标。每层拥有明确的职责边界与能力范围，当高优先级层失败时，自动降级到下一层。系统通过**记忆闭环**（成功路径缓存）持续优化路由决策。

```
┌────────────────────────────────────────────────────────────┐
│                  用户输入（自然语言）                         │
│               ↓ parseIntent → IntentResult                 │
├────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Layer 1: 原生接口层 (Native Interface)               │  │
│  │ COM / 项目文件直连 / CLI                              │  │
│  │ 优先级: ★★★★★ (最高)                                │  │
│  │ 典型场景: Word 排版 (COM), 剪映草稿注入               │  │
│  │          (draft_content.json), CLI 工具               │  │
│  └──────────────────┬───────────────────────────────────┘  │
│                     │ 失败 ↓                               │
│  ┌──────────────────┴───────────────────────────────────┐  │
│  │ Layer 2: 结构化界面层 (Structured UI)                 │  │
│  │ Windows UIA / 窗口句柄 / SendKeys                     │  │
│  │ 优先级: ★★★★                                        │  │
│  │ 典型场景: 标准 Win 桌面软件的控件操作                    │  │
│  │ 实现: directShellBridge.ts + supereye (Rust UIA)     │  │
│  └──────────────────┬───────────────────────────────────┘  │
│                     │ 失败 ↓                               │
│  ┌──────────────────┴───────────────────────────────────┐  │
│  │ Layer 3: 视觉兜底层 (Vision Fallback)                 │  │
│  │ 截图 + Vision LLM 坐标定位 + 鼠标模拟                  │  │
│  │ 优先级: ★★★                                          │  │
│  │ 典型场景: 自绘 UI 软件, 黑盒桌面程序                    │  │
│  │ 实现: visionEngine.ts + OCR (Tesseract)              │  │
│  └──────────────────┬───────────────────────────────────┘  │
│                     │ 失败 ↓                               │
│  ┌──────────────────┴───────────────────────────────────┐  │
│  │ Layer 4: 系统控制与观测层 (System Control)             │  │
│  │ WMI / 进程管理 / 成功路径缓存 / 环境维稳               │  │
│  │ 优先级: ★★ (辅助层，贯穿全局)                         │  │
│  │ 典型场景: 前置校验, 进程监控, 策略缓存/记忆闭环          │  │
│  │ 实现: systemSensor.ts + automationSuccessCache.ts    │  │
│  └──────────────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────────────┤
│               记忆闭环 (Memory Feedback Loop)              │
│  成功路径 → automationSuccessCache.json → 下次优先复用      │
└────────────────────────────────────────────────────────────┘
```

---

## Layer 1: 原生接口层 (Native Interface)

**最高优先级**。直接通过程序级 API 或项目文件操控目标应用，零依赖 UI 交互，确定性最高。

| 能力 | 实现方式 | 适用目标 |
|------|---------|---------|
| COM 自动化 | Word/Excel/PowerPoint COM API | Office 全家桶深度排版 |
| 项目文件注入 | 直接读写 draft_content.json | 剪映草稿操作 |
| CLI 工具链 | child_process + 参数构建 | ffmpeg, ImageMagick, git |
| Puppeteer | 浏览器 DevTools 协议 | Web 应用 (Gemini, 通义万相) |

### 路由判据
- 目标应用是否暴露 COM 接口？
- 是否存在可直接修改的项目/配置文件？
- 是否有对应 CLI 工具可达成目标？
- 是否为 Web 应用（走 Puppeteer DevTools 协议）？

### 关键模块
- `src/pipeline/jianyingSteps.ts` — 剪映 draft_content.json 注入
- `src/tools/UniversalExecutor.ts` — CLI/PowerShell 执行
- `src/tools/browserBridge.ts` — Puppeteer 浏览器控制

---

## Layer 2: 结构化界面层 (Structured UI)

**标准路径**。通过 Windows UI Automation (UIA) 树或窗口句柄精确操控可访问性标记的 UI 元素。

| 能力 | 实现方式 | 适用目标 |
|------|---------|---------|
| UIA 控件遍历 | supereye Rust daemon | 标准 Win32/WPF/UWP 控件 |
| 窗口管理 | SetForegroundWindow | 窗口聚焦/切换 |
| 键盘模拟 | SendKeys / Clipboard+Ctrl+V | 文本输入 (剪贴板策略) |
| 快捷键映射 | 语义 → 快捷键表 | 保存(^s), 全选(^a) 等 |

### 路由判据
- UIA 树是否能发现目标控件？
- 是否有成功路径缓存命中（coordinate/tab_order/shortcut）？
- 窗口句柄是否有效？

### 关键模块
- `src/tools/directShellBridge.ts` — 8 级优先级 clickByName
- `crates/supereye/` — Rust UIA 底层
- `src/core/executor.ts` — UiaEngine / ShortcutEngine

---

## Layer 3: 视觉兜底层 (Vision Fallback)

**破局方案**。对自绘 UI（如剪映时间轴）、黑盒软件等 UIA 不可达的场景，通过截图 + AI 视觉定位 + 鼠标模拟实现操控。

| 能力 | 实现方式 | 适用目标 |
|------|---------|---------|
| 全屏/窗口截图 | PowerShell GDI | 任意桌面区域 |
| 元素定位 | Vision LLM (GPT-4o/Claude) | 自绘 UI 按钮/输入框 |
| OCR 文本识别 | Tesseract.js | 从截图中提取文字 |
| 坐标点击 | user32.dll mouse_event | 像素级鼠标模拟 |

### 路由判据
- UIA 层是否失败/不适用？
- 目标是否为自绘 UI 控件？
- 是否有 Vision LLM API Key 可用？

### 关键模块
- `src/core/visionEngine.ts` — 截图 + LLM 定位 + 点击
- `src/core/executor.ts` — OcrEngine / VisionEngine

---

## Layer 4: 系统控制与观测层 (System Control & Observation)

**辅助层**，贯穿所有层的前置校验、环境维稳与执行策略记忆。

| 能力 | 实现方式 | 用途 |
|------|---------|------|
| 系统前置校验 | WMI / Get-PSDrive / Test-Connection | 磁盘/内存/网络健康检查 |
| 进程管理 | Get-Process / tasklist | 目标应用存活监控 |
| 成功路径缓存 | automation_success_cache.json | 记忆闭环 — 复用成功策略 |
| 安全守卫 | safetyGuard.ts | 危险操作拦截 |

### 记忆闭环机制
1. 每次 Layer 1-3 执行成功，记录 `(target, strategy, data)` 到缓存
2. 下次遇到相同 target，从缓存读取上次成功策略，跳过试错
3. 缓存策略包括：坐标定位 (coordinate)、Tab 序 (tab_order)、快捷键 (shortcut)

### 关键模块
- `src/core/systemSensor.ts` — 硬件/系统状态感知
- `src/tools/automationSuccessCache.ts` — 成功路径缓存
- `src/core/safetyGuard.ts` — 安全检查

---

## 混合路由策略 (Hybrid Routing)

四层降级由 `FourLayerRouter` 统一调度，核心流程：

```
用户输入
  ↓
parseIntent() → IntentResult
  ↓
FourLayerRouter.dispatch(action, context)
  ↓
┌─ Layer 4: preflightCheck() → 系统健康？
│    ↓ OK
├─ 查询 SuccessCache → 有缓存命中？ → 直接执行缓存策略
│    ↓ 无缓存
├─ Layer 1: tryNativeInterface() → 成功？ → 记录缓存 → 返回
│    ↓ 失败
├─ Layer 2: tryStructuredUI() → 成功？ → 记录缓存 → 返回
│    ↓ 失败
├─ Layer 3: tryVisionFallback() → 成功？ → 记录缓存 → 返回
│    ↓ 失败
└─ 全层失败 → 返回错误 + 诊断信息
```

### 路由配置
- `src/core/fourLayerRouter.ts` — 四层降级路由器主体
- `src/config/llmConfig.ts` — LLM 模型配置（本地守门 + 云端规划）
- `src/llm/hybridRouter.ts` — 意图分类 + 步骤规划

---

## 文件映射总览

| 架构层 | 核心文件 | 职责 |
|--------|---------|------|
| 意图解析 | `src/jarvis/parseIntent.ts` | 自然语言 → IntentResult |
| 混合路由 | `src/llm/hybridRouter.ts` | 本地分类 + 云端规划 |
| **四层路由** | **`src/core/fourLayerRouter.ts`** | **四层降级调度器** |
| Layer 1 | `src/tools/UniversalExecutor.ts` | CLI/PowerShell |
| Layer 1 | `src/tools/browserBridge.ts` | Puppeteer |
| Layer 1 | `src/pipeline/jianyingSteps.ts` | 剪映项目文件 |
| Layer 2 | `src/tools/directShellBridge.ts` | UIA + SendKeys |
| Layer 2 | `crates/supereye/` | Rust UIA daemon |
| Layer 3 | `src/core/visionEngine.ts` | Vision LLM + 截图 |
| Layer 4 | `src/core/systemSensor.ts` | 系统感知 |
| Layer 4 | `src/tools/automationSuccessCache.ts` | 成功缓存 |
| Layer 4 | `src/core/safetyGuard.ts` | 安全守卫 |
| 执行引擎 | `src/core/executor.ts` | 多引擎降级 |
| UI 前端 | `src/electron/renderer/spotlight.html` | Spotlight 输入框 |

---

## 设计决策与权衡

### 为什么四层而非更多？
- 三层（COM/UIA/Vision）覆盖 95% 场景，第四层（系统观测）提供环境维稳
- 过多层级增加降级链延迟，四层是"覆盖率 vs 响应速度"的最优平衡

### 为什么 Layer 4 贯穿全局而非最底层？
- 系统健康检查必须在执行前（前置校验）
- 成功路径缓存需要跨层收集和分发
- 进程监控需要在执行中持续运行

### 文本输入为什么只用剪贴板策略？
- `SendKeys` 对中文/特殊字符支持差
- 剪贴板 + Ctrl+V 是唯一可靠的跨应用文本输入方式
- 参见 `directShellBridge.ts` 中的 `typeText()` 实现
