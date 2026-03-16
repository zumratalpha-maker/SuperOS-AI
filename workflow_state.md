# 当前状态
已完成：Phase 1（DirectShell 配置、MCP 骨架、语音预留、Orchestrator 合体）；Phase 2 路由改进（JARVIS_A11Y_FIX 阶段 1–5）。
当前阶段：Phase 2 — 路由与规划 100% 复合指令。

## 已完成（备用方案）
- **MCP 骨架配置**：已在项目内创建 `.cursor/mcp.json`，并编写 `docs/CURSOR_MCP_配置说明.md`。
- **语音预留设计**：已创建 `docs/voice_module_spec.md`，定义「唤醒词 + 简单命令 → JSON Action Schema」接口。

## 当前任务
- **DirectShell 编译与 MCP**：`directshell.exe` 已编译；`ds-mcp/server.py` 已就绪。
- **Orchestrator 合体**：`snapshotAndClickStep` 闭环已完成。
- **Phase 2 路由改进（IMPLEMENTED）**：
  - 阶段 1：关键词强判强制「打开+写/输入/保存」走 COMPLEX_A11Y_PLANNING
  - 阶段 2：open_target 回退前再试 planWithLocal
  - 阶段 3.2：planWithLocal 解析鲁棒性（JSON 失败时用正则提取 steps）
  - 阶段 4：规则兜底（打开记事本+写+保存 → 构造最小 a11y_sequence）
  - 阶段 5：统一日志「[parseIntent] 产出 a11y_sequence，steps 数: N」

## 状态
**Phase B 已完成**。Phase 2 语音模块、Phase B Jarvis 能力扩展均已实现。
**Phase C P0 已实现**：打开剪映 + 导出到指定路径（含文件名）。实现内容：
- directShellBridge：findExportDialogHwnd 剪映导出对话框
- runA11ySequence：StepState.exportDialogHwnd、lastClickedExport，剪映导出流程支持，链补全 type 文件名后追加 click 导出
- parseIntent：buildRuleFallbackStepsJianying（打开剪映+导出规则兜底）
- pipeline：jianyingSteps、videoPipeline.runJianyingExport
- PhaseC_需求说明：已补齐待补充项默认值（素材来源、发布平台、启动入口）
**Phase A（系统融合基础）已执行**：
- A1 P0 收尾：findExportDialogHwnd 增强（parentPid 限定、顶级窗口名检查、扩展关键字）
- A2 自动化知识库：`docs/automation_memory.md` 已创建，记录剪映/微信等已知失效模式
- A3 Ralph Loop：runA11ySequence 单步失败时重试 2 次（间隔 800ms）

**P0 收尾增强（2026-03）**：
- jianyingSteps：开始创作(弹窗) 后新增 wait 1000ms，待主窗稳定
- runA11ySequence：dismiss 后 re-fetch 主窗 hwnd，点击导出前若为剪映则 refresh lastWindowHwnd

**Phase C 文案+分镜（2026-03）**：
- src/copywriting：generateCopywriting(topic)、generateStoryboard(copywriting)
- 验证：`npm run verify:copywriting [话题]`

**Phase C 网页创作（2026-03）**：
- appRegistry：豆包、通义万相、Gemini、可灵、即梦 URL
- webGenSteps：buildTongyiWanxiangImageSteps、buildDoubaoImageSteps、buildGeminiCopywritingSteps、buildKlingVideoSteps、buildJimengVideoSteps
- parseIntent：buildRuleFallbackStepsWebGen、hasWebGenIntent
- runA11ySequence：WINDOW_NAME_ALIASES 浏览器窗口
- 验证：`npm run verify:web-gen [文案|文生图]`、`npm run verify:web-gen --run 文生图` 可实机执行

**Phase C 端到端流水线（2026-03）**：
- videoPipeline.runFullE2EPipeline(topic, { imagePath? })：话题 → 文案 → 文生图 → [可选] 剪映
- 验证：`npm run verify:e2e-pipeline [话题] [--run] [--imagePath 路径]`
- verify:web-gen 图生视频：`npm run verify:web-gen -- --run 图生视频 --imagePath C:\...\a.png`（可灵/即梦文件上传对话框已支持）

**Puppeteer 浏览器桥接（2026-03）**：
- src/tools/browserBridge.ts：Puppeteer 直控网页应用（通义万相、豆包、可灵、即梦、Gemini）
- 解决 UIA/OCR 对网页应用不稳定的根本问题（UiaSniper 中文编码乱码、OCR getWindowRect 失败）
- parseIntent：网页创作意图优先返回 puppeteer_web_gen，Jarvis 主循环已支持
- webGenSteps：新增 runTongyiWanxiangViaPuppeteer 等 Puppeteer 路径导出
- videoPipeline：runFullE2EPipeline 优先 Puppeteer 文生图，失败回退 UIA
- verify:web-gen：新增 --puppeteer 参数，可直接验证 Puppeteer 路径
- directShellBridge：runUiaSniper 中文参数改用临时 UTF-8 文件传递；tryClickByHwndAndElement 自动包含别名；screenshotRegion getWindowRect 兜底

**六层能力架构升级（2026-03-16）**：
- src/core/systemSensor.ts：层1 硬件/系统感知（磁盘空间、内存占用、网络连通性、进程列表、管理员权限、前置校验 preflightCheck）
- src/core/validator.ts：层5 结果校验（文件存在/大小/格式、目录文件数、等待新文件、窗口存在、进程运行、剪贴板内容、通用 runValidation）
- src/core/executor.ts：层4 多维度执行引擎矩阵（UIA/Puppeteer/快捷键/OCR/模拟输入 5 引擎统一接口，自动选最优引擎 + 失败降级链 + 重试）
- src/core/taskStore.ts：SQLite 任务持久化（任务 CRUD、优先级、依赖关系、进度、子任务、执行日志、统计）
- src/core/taskScheduler.ts：任务调度器（依赖执行、并行限流、定时执行、断点续跑、人机协同 waiting_user、长计划拆解）
- browserBridge.ts 升级：登录状态检测 + 等待用户登录、smartWait 替代固定 setTimeout、waitForGeneration 智能等待生成完成、统一下载路径、错误分类 BrowserErrorKind、系统 Chrome 优先
- DeepSeek API 文案生成：browserBridge.deepseekCopywriting()，parseIntent 文案意图有 key 时走 API 而非 Gemini Puppeteer
- 验证：npm run verify:core（systemSensor ✓ validator ✓ taskStore ✓ taskScheduler ✓ DeepSeek API ✓）

**Phase 3 意图解析深化 + 场景闭环（2026-03-16）**：
- parseIntent 长计划意图：LongPlanIntent 类型，支持 deadline/priority/stages 分解，DeepSeek 云端规划 + 本地规则兜底
- src/core/pluginManager.ts：场景插件化架构（IPlugin 接口、manifest 声明、intentPatterns 匹配、动态注册/卸载）
- src/plugins/shortVideoPlugin.ts：短视频生产插件（文案→文生图→图生视频）
- src/plugins/resourceDownloadPlugin.ts：资源下载+智能整理插件（搜索→下载→按类型分类）
- src/core/memoryGraph.ts：层6 知识图谱（场景→操作→结果 关系存储，最优路径查询，能力迁移，成功率/耗时统计）
- src/core/habitLearner.ts：层6 习惯学习（操作日志、偏好管理、常用序列、活跃时段分析、智能推荐）
- 验证：npm run verify:phase3（长计划解析 ✓ 插件管理 ✓ 知识图谱 ✓ 习惯学习 ✓）

**Phase 5 集成 + 控制面板 + 语音升级（2026-03-16）**：
- Phase 5.1: 端到端集成 — memoryGraph/habitLearner/pluginManager 接入 jarvis.ts 主循环（puppeteer_web_gen/a11y_sequence 自动记录知识图谱+习惯日志，启动加载插件+智能推荐）
- Phase 5.2: 可视化控制面板 — src/dashboard/api.ts（Express REST API：系统状态/任务看板/知识图谱/习惯统计/插件列表/智能推荐）+ src/dashboard/public/index.html（暗色主题 Web UI，9 个数据面板，30s 自动刷新）。npm run dashboard 启动
- Phase 5.3: TTS 语音反馈 — src/voice/tts.ts（Windows SAPI 朗读、非阻塞/异步两种模式、预设回复模板），jarvis.ts say() 自动触发 TTS（TTS_ENABLED=1 激活）

**Phase 6 安全边界（2026-03-16）**：
- src/core/safetyGuard.ts：三级风险分类（blocked/caution/safe）
  - 黑名单：格式化磁盘、删除系统文件、转账、密码操作、修改注册表等 → 直接拦截
  - 灰名单：下载、删除文件、安装、发送、发布、批量操作 → 需用户确认（回复「确认」继续）
  - 白名单：打开应用、搜索、点击、输入、快捷键 → 直接放行
- 脚本安全检查：checkScript() 拦截危险 PowerShell/Batch 命令
- 错峰调度：classifyTaskWeight() 分 light/medium/heavy，高峰时段（9-18点）中等任务推迟到 18:00，重量级推迟到凌晨 2:00
- 用户确认白名单：已确认的操作不再重复询问（本次会话内）
- 审计日志：所有安全检查记录可通过 getAuditLog() 和 /api/security/audit 查询
- jarvis.ts 集成：dispatch 前自动过安全网关，灰名单操作等待用户「确认」/「取消」
- dashboard API 新增：/api/security/audit、POST /api/security/check

**Phase 7 懒加载场景拓展（2026-03-16）**：
- src/core/pluginGenerator.ts：LLM 自动生成插件代码
  - tryGeneratePlugin(sceneName, description)：调用 DeepSeek 生成 IPlugin TypeScript 代码
  - 生成的插件自动保存到 src/plugins/generated/，下次启动自动加载
  - loadGeneratedPlugins()：启动时扫描 generated/ 目录动态注册
- jarvis.ts 集成：意图无法识别时 → 先匹配已有插件 → 无匹配则调用 LLM 生成新插件 → 执行
- 验证：npm run verify:phase6-7（安全拦截 ✓ 灰名单确认 ✓ 脚本检查 ✓ 错峰调度 ✓ 审计日志 ✓）

**竞品对标升级（2026-03-16）**：
- 功能1 Electron 桌面界面：src/electron/main.ts（系统托盘 + Alt+Space 全局唤醒 + Spotlight 风格输入框 + IPC 桥接 Jarvis 后端）、preload.ts、renderer/spotlight.html（暗色透明窗口、毛玻璃效果）、jarvis-backend.ts（独立子进程避免主进程加载重模块）、tsconfig.electron.json
- 功能3 Vision 兜底引擎：src/core/visionEngine.ts（PowerShell 全屏截图 + Vision LLM 定位坐标 + 模拟鼠标点击）、集成到 executor.ts 降级链末尾（UIA→快捷键→OCR→模拟输入→Vision）
- 功能4 工作流录制与回放：src/core/workflowRecorder.ts（SQLite 存储、startRecording/captureStep/stopRecording/replayWorkflow、成功率统计）、jarvis.ts 新增「开始录制」「结束录制」「回放 X」「列出工作流」指令、A11y 执行时自动捕获步骤
- 功能5 端到端短视频测试：scripts/e2e-short-video.ts（DeepSeek 文案→通义万相文生图→输出验证，--dry 模式验证所有模块导入）、npm run e2e:short-video / e2e:short-video:dry
- 功能6 进度浮窗：src/core/progressOverlay.ts（PowerShell WPF 桌面右下角 always-on-top 半透明浮窗、进度条 + 步骤描述、withProgress 便捷函数）、jarvis.ts A11y/Puppeteer 路径自动显示进度
- 验证：tsc --noEmit 零错误，e2e:short-video:dry 全通过（DeepSeek 文案 ✓、5 个核心模块导入 ✓）

**交互式创作流水线引擎（2026-03-16）**：
- src/pipeline/toolRegistry.ts：统一工具注册表（22 个创作工具：文案 5 个 + 图片 7 个 + 视频 4 个 + 配音 3 个 + 口型 2 个 + 剪辑 1 个），每个工具声明 category/accessMethod/needsLogin/loginUrl/checkAvailable
- src/pipeline/pipelineTemplates.ts：4 套流水线模板
  - 口播视频：脚本→配音→数字人口型同步→剪辑导出
  - 图文帖子：文案+标签→图片提示词→批量配图→排版
  - 漫剧/动画：剧本分镜→角色定妆照[确认]→画面风格确认[确认]→逐镜头图片→图生视频→配音字幕
  - 广告/产品：产品分析脚本→视觉分镜→素材生成→视频合成→多尺寸导出
- src/pipeline/loginManager.ts：登录状态管理器（SQLite 缓存 30 分钟、guideLogin 自动打开登录页、markAsLoggedIn 用户确认后标记、批量检查 batchCheckLogin）
- src/pipeline/interactivePlanner.ts：多轮对话状态机（9 状态：classifying→selecting_type→selecting_tools→checking_login→waiting_login→confirming→ready_to_execute→executing→paused→done），逐步骤询问工具选择、自动推荐最优工具、登录引导
- src/pipeline/pipelineExecutor.ts：流水线执行器（逐步执行、checkpoint 确认暂停、失败自动尝试备选工具、步骤间数据传递、执行报告 JSON）
- browserBridge.ts 新增 6 个适配器：grokTextToImage、chatgptTextToImage、runwayImageToVideo、systemTtsGenerate、heygenLipsync、pikaImageToVideo
- pipelineExecutor 内置 15 个工具适配器注册（deepseek/gpt/claude/qwen/gemini_copywriting/tongyi_wanxiang/doubao/gemini_image/grok/chatgpt_dalle/kling/jimeng/runway/pika/system_tts/heygen）
- jarvis.ts 集成：activePlanSession 会话管理、创作关键词触发（做/制作/生成/创作/生产 + 口播/图文/漫剧/广告/视频等）、puppeteer_web_gen 意图匹配模板时自动进入交互流水线、checkpoint readline 确认回调、memoryGraph 记录流水线执行结果
- shortVideoPlugin.ts v2：基于新引擎重写，自动匹配模板+推荐工具+执行流水线，回退到基础 DeepSeek 文案
- 验证：tsc --noEmit 零错误

**全网自学引擎（2026-03-16）**：
- src/core/skillLibrary.ts：技能库（SQLite 结构化存储）
  - 6 种技能类型：url_transform / shell_command / multi_step / api_call / tool_usage / knowledge
  - 每个技能含 steps（结构化步骤）、confidence（置信度）、successCount/failureCount（成功率跟踪）
  - 智能匹配：多关键词模糊搜索，按有效得分排序
  - 自动淘汰：连续失败 3 次自动废弃，定期清理低质量过期技能
  - 分页列表、统计概况、按类型查询
- src/core/skillLearner.ts：全网自学引擎
  - LLM 自动生成搜索关键词（中英文多组）
  - Puppeteer headless 抓取 Bing 搜索结果 + 前 N 个网页内容
  - LLM 从网页中提取结构化技能（action/params/confidence）
  - 安全检查：所有学到的技能经过 safetyGuard 校验，危险技能直接拒绝
  - findOrLearn()：先查技能库 → 没有就上网自学 → 学会就返回
- src/core/skillExecutor.ts：技能执行器
  - 支持 7 种 action：url_replace / shell / puppeteer_goto / puppeteer_click / puppeteer_type / download / install_tool / note
  - 变量解析：步骤间传递数据（{step_0_output} 等）
  - 安全双重检查：执行前 checkScript 校验命令安全性
  - 执行结果自动反馈到技能库（recordSuccess/recordFailure）
- jarvis.ts 集成：
  - 意图未识别时：场景插件 → 自动生成插件 → **技能库查找 → 上网自学** → ResearchAgent 研究
  - 技能命中后展示预览，执行成功/失败自动更新置信度
- dashboard 新增 2 个面板：
  - 技能库统计：已学技能数 / 成功率 / 已废弃数 / 平均置信度
  - 已学技能列表：名称 / 类型 / 来源 / 置信度 / 成功率
- dashboard API 新增 6 个端点：GET /api/skills、GET /api/skills/stats、GET /api/skills/search、GET /api/skills/:id、DELETE /api/skills/:id、POST /api/skills/cleanup
- 验证：tsc --noEmit 零错误

**产品级完善（2026-03-16）**：
- Puppeteer Chrome profile 复用：browserBridge.ts findChromeUserDataDir()，Chrome 运行中自动复制 Cookies/Login Data 到 SuperOS 专用 profile，解决 Puppeteer 登录态丢失
- 进度浮窗中文乱码修复：progressOverlay.ts 写入 BOM + PowerShell 强制 UTF-8 InputEncoding/OutputEncoding + Buffer.from 写入
- 桌面 App 优先检测：toolRegistry.ts hasDesktopShortcut()/hasStartMenuEntry()，豆包/Grok 等有桌面快捷方式时 accessMethod 改为 local_app，scanDesktopApps() 扫描已安装创作工具
- Electron UI 全面重设计：spotlight.html 改为聊天式界面（消息历史 + 打字动画 + 文字/语音模式切换 + 麦克风按钮 + 渐变品牌色 + glassmorphism 毛玻璃），preload.ts 新增 onProgress/openDashboard 接口
- Dashboard UI 全面重设计：index.html 现代暗色主题（渐变 logo + 导航标签页 7 个 + hero 统计卡片 + 使用指南内置），新增标签：总览/任务/技能库/记忆/插件/安全/使用指南
- README.md 用户说明书：完整使用指南、核心能力说明、创作流水线文档、技能库原理、项目结构、安全说明

**微信远程指令（2026-03-16）**：
- src/wechat/wechatMonitor.ts：微信桌面 UIA 轮询监控
  - readWeChatMessages()：PowerShell UIAutomation 读取微信消息列表
  - switchToFileTransferChat()：自动切换到「文件传输助手」聊天
  - sendWeChatMessage()：通过剪贴板粘贴+回车发送消息
  - pollOnce()：每 3 秒检查新消息，新指令喂给 dispatch()，结果发回微信
  - 消息去重：基于 messageKey 的 Set + JSON 持久化
- jarvis.ts 集成：「启动微信监控」「停止微信监控」「微信监控状态」三个命令

**定时任务调度（2026-03-16）**：
- src/core/cronScheduler.ts：内置 cron 引擎（无外部依赖）
  - 5 段 cron 表达式解析：分 时 日 月 周
  - 自然语言→cron 转换：naturalToCron()（每天19点 / 每30分钟 / 每周一9点 / 每月1号10点 等）
  - 持久化：JSON 文件存储，重启恢复
  - startCronScheduler()：每 30 秒 tick 检查匹配任务并执行
- jarvis.ts 集成：「每天19点发小红书」直接创建定时任务，「查看定时任务」「删除定时任务 N」
- dashboard API 新增：GET/POST/DELETE/PATCH /api/cron

**本地语音识别（2026-03-16）**：
- src/voice/localAsr.ts：Windows SAPI 语音识别（零外部依赖）
  - recognizeOnce()：单次识别（10 秒超时）
  - startListening(callback)：持续监听模式，每句话回调
  - stopListening()：停止监听
- jarvis.ts 集成：「启动语音识别」「停止语音识别」，识别到的内容直接喂给 dispatch()

**DSB 类型提取（2026-03-16）**：
- src/tools/dsb/types.ts：directShellBridge 所有接口/类型抽取到独立文件
- src/tools/dsb/index.ts：barrel 导出

**状态**：Phase 1-7 + 竞品对标 + 创作流水线 + 自学引擎 + 产品完善 + 微信远程 + 定时任务 + 语音识别 全部完成。系统已具备完整的自主智能体能力。
