# SuperOS — 全能桌面自主智能体

> 你说话，它做事。不会的自己上网学。

SuperOS 是一个 Win11 桌面自主智能体系统。用自然语言下达任何指令，系统自动拆解任务、选择工具、执行操作，遇到不会的还能自动上网搜教程学习。

---

## 核心能力

| 能力 | 说明 |
|------|------|
| 自然语言控制 | 说「帮我发微信给张三」「下载这个视频」，系统自动理解并执行 |
| 多引擎执行 | UIA → 快捷键 → Puppeteer → OCR → 视觉AI → 模拟输入，自动选最优引擎 |
| 创作流水线 | 口播视频、图文、漫剧、广告 — 交互式引导，从文案到发布全自动 |
| 全网自学 | 遇到不会的任务，自动搜索教程、提取步骤、存入技能库，永久记住 |
| 桌面App优先 | 自动检测已安装的桌面应用（Grok、豆包等），优先使用已登录的App |
| 知识图谱 | 记住操作路径、成功率、你的习惯偏好，越用越聪明 |
| 安全边界 | 高风险操作自动拦截，敏感操作需确认，全程审计日志 |
| 插件自生成 | 遇到未知场景，AI 自动写插件代码并加载执行 |

---

## 快速开始

### 环境要求

- Windows 11
- Node.js >= 18
- Chrome 浏览器（Puppeteer 自动化用）

### 安装

```bash
git clone <repo-url> SuperOS
cd SuperOS
npm install
```

### 配置

编辑 `.env` 文件：

```env
# 必填：云端LLM（DeepSeek）
CLOUD_API_KEY=sk-xxxxxxxxxxxxxxxx
CLOUD_API_BASE_URL=https://api.deepseek.com/v1
CLOUD_API_MODEL=deepseek-chat

# 可选：本地LLM（Ollama）
LOCAL_LLM_HOST=http://127.0.0.1:11434
LOCAL_LLM_MODEL=qwen2:7b
```

### 启动

**命令行模式**（推荐先试）：
```bash
npm run start:jarvis
```
然后直接输入自然语言指令。

**桌面版**（Electron）：
```bash
npm run electron:dev
```
按 `Alt+Space` 唤醒指令窗口。

**控制面板**：
```bash
npm run dashboard
```
浏览器打开 `http://localhost:3200`

---

## 使用方式

### 文字输入
在命令行或 Electron 指令窗口中直接输入。

### 语音输入
在 Electron 指令窗口中，点击右上角切换到「语音」模式，点麦克风图标即可语音输入。

### 示例指令

```
帮我打开微信发消息给张三
在通义万相生成一张山水画
做一个口播短视频，主题是AI改变生活
下载这个YouTube视频
帮我整理桌面文件到D盘
每天19点自动发小红书
录制工作流 日报
回放 日报
```

---

## 创作流水线

输入包含「做/制作/生成」+「口播/图文/漫剧/广告」的指令会进入交互式创作模式：

1. **选择内容类型** — 口播视频 / 图文帖 / 漫剧 / 广告
2. **选择工具** — 系统推荐最优工具组合（DeepSeek文案、通义万相图片、可灵视频等）
3. **检查登录** — 自动检测各工具登录状态，未登录则引导你登录
4. **确认计划** — 展示完整执行计划，你确认后才开始
5. **自动执行** — 全程进度浮窗显示，关键节点暂停让你确认
6. **完成交付** — 所有产出存到指定目录

支持 22 种创作工具，包括：
- 文案：DeepSeek / GPT / Claude / Gemini / 通义千问
- 图片：通义万相 / 豆包 / Gemini / Grok / ChatGPT DALL-E / Midjourney / 本地SD
- 视频：可灵 / 即梦 / Runway / Pika
- 配音：系统TTS / 讯飞 / ElevenLabs
- 口型：HeyGen / D-ID
- 剪辑：剪映

---

## 技能库（自学能力）

这是系统最核心的能力：

1. 遇到不认识的任务 → 自动生成搜索关键词
2. 打开浏览器搜索教程 → 抓取网页内容
3. AI 提取可执行步骤 → 安全检查
4. 存入技能库 → 永久记忆
5. 下次遇到相同任务 → 直接从技能库调用

技能库支持 6 种技能类型：
- `url_transform` — URL 替换（如 youtube → youtube9x）
- `shell_command` — 终端命令
- `multi_step` — 多步骤操作
- `api_call` — API 调用
- `tool_usage` — 工具使用教程
- `knowledge` — 纯知识

在控制面板「技能库」标签页查看和管理已学技能。

---

## 工作流录制

```
录制工作流 我的日报流程    # 开始录制
# ... 手动操作 ...
停止录制                  # 保存
回放 我的日报流程          # 下次一键重复
```

---

## 控制面板

访问 `http://localhost:3200`，包含：

| 标签页 | 内容 |
|--------|------|
| 总览 | 系统状态、活跃时段、智能推荐、偏好 |
| 任务 | 任务列表、状态统计 |
| 技能库 | 已学技能、成功率、置信度 |
| 记忆 | 知识图谱、常用序列、操作目标 |
| 插件 | 已加载的场景插件 |
| 安全 | 审计日志 |
| 使用指南 | 内置帮助文档 |

---

## 项目结构

```
SuperOS/
├── src/
│   ├── jarvis.ts              # 主入口（命令行REPL）
│   ├── jarvis/parseIntent.ts   # 意图解析
│   ├── config/llmConfig.ts     # LLM 配置
│   ├── core/
│   │   ├── executor.ts         # 多引擎执行器
│   │   ├── taskScheduler.ts    # 任务调度器
│   │   ├── taskStore.ts        # 任务持久化
│   │   ├── safetyGuard.ts      # 安全边界
│   │   ├── memoryGraph.ts      # 知识图谱
│   │   ├── habitLearner.ts     # 习惯学习
│   │   ├── skillLibrary.ts     # 技能库
│   │   ├── skillLearner.ts     # 全网自学引擎
│   │   ├── skillExecutor.ts    # 技能执行器
│   │   ├── pluginManager.ts    # 插件管理
│   │   ├── pluginGenerator.ts  # AI插件生成
│   │   ├── visionEngine.ts     # 视觉AI引擎
│   │   ├── workflowRecorder.ts # 工作流录制
│   │   ├── progressOverlay.ts  # 进度浮窗
│   │   ├── systemSensor.ts     # 系统感知
│   │   └── validator.ts        # 结果校验
│   ├── pipeline/
│   │   ├── toolRegistry.ts     # 22种创作工具注册
│   │   ├── pipelineTemplates.ts# 创作流水线模板
│   │   ├── interactivePlanner.ts# 交互式计划器
│   │   ├── pipelineExecutor.ts # 流水线执行器
│   │   └── loginManager.ts     # 登录管理
│   ├── tools/
│   │   ├── browserBridge.ts    # Puppeteer 浏览器自动化
│   │   └── directShellBridge.ts# Windows UIA/OCR/键鼠
│   ├── plugins/                # 场景插件
│   ├── dashboard/              # 控制面板
│   ├── electron/               # 桌面版
│   └── voice/                  # 语音模块
├── data/                       # SQLite数据库、Chrome profile
├── .env                        # 环境变量
└── package.json
```

---

## 常用命令

```bash
npm run start:jarvis      # 命令行模式
npm run dashboard         # 控制面板
npm run electron:dev      # 桌面版
npm run build             # 编译
npx tsc --noEmit          # 类型检查
```

---

## 安全说明

- 高风险操作（删除、格式化、转账）自动拦截
- 中风险操作（下载、执行脚本）需用户确认
- 所有操作记录审计日志
- 敏感数据本地存储（Local-First），不上传
- 自学来的技能会经过安全检查才入库

---

## License

MIT
