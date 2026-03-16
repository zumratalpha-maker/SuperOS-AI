# 开发路径：P0 后续与 Phase 完善

> 开始创作已可正常进入编辑页，后续按本路径完善导出及 Phase C 全流程。  
> 更新于 2026-03-15

---

## 一、当前状态

| 步骤 | 状态 | 说明 |
|------|------|------|
| 1. open_app 剪映 | ✅ | 正常 |
| 2. click 开始创作 | ✅ | 坐标 (0.68, 0.12) 已调优 |
| 3. wait 3500ms | ✅ | 正常 |
| 4. click 导出 | ✅ | 坐标 (0.92, 0.06) |
| 5. click 桌面 | ✅ | Alt+D 兜底成功 |
| 6. type 文件名 | ✅ | 剪贴板粘贴 |
| 7. click 导出(确认) | ✅ | exportDialogConfirm Enter 兜底 |

---

## 二、近期开发路径（P0 收尾）

### 路径 2.1：导出对话框定位

**目标**：步骤 5 前正确获取导出对话框 hwnd。

| 序号 | 动作 | 产出 |
|------|------|------|
| 1 | **调试输出**：`npm run verify:jianying-export` 时，若 findExportDialogHwnd 失败，控制台会自动打印剪映进程的所有窗口 `hwnd` 与 `name`，用于确定导出对话框的实际标题 | 将输出的 `name` 加入 `EXPORT_DIALOG_NAMES`（directShellBridge.ts） |
| 2 | 根据实际标题扩展 EXPORT_DIALOG_NAMES 或 findExportDialogHwnd 逻辑 | 能稳定定位导出对话框 |
| 3 | （可选）导出对话框作为顶级窗口时，尝试不传 parentPid 的 findWindowByName | 提高鲁棒性 |

### 路径 2.2：导出对话框内操作兜底

**目标**：click 桌面、type 文件名、click 导出 在导出对话框内可靠执行。

| 序号 | 动作 | 产出 |
|------|------|------|
| 1 | 确认 runA11ySequence 中 saveDialogDesktop、type、导出确认的 targetHwnd 正确传入 exportDialogHwnd | 步骤 5～7 作用于导出对话框 |
| 2 | 若 UIA 仍失败，为导出对话框内「桌面」「导出」增加坐标兜底（类似主窗 开始创作/导出） | directShellBridge 内新增分支 |
| 3 | 验收：`npm run verify:jianying-export` 全流程通过 | P0 闭环完成 |

---

## 三、Phase C 后续路径

### 路径 3.1：P1 导入本地素材 ✅

| 序号 | 动作 | 产出 |
|------|------|------|
| 1 | 手动走一遍剪映导入流程：点击入口 → 选路径 → 确认 | 明确 UI 步骤 |
| 2 | 扩展 jianyingSteps：`buildJianyingImportAndExportSteps` | 已实现 |
| 3 | 剪映导入按钮/路径框坐标兜底（directShellBridge 已有 isJianyingImport） | 多环境可用 |
| 4 | videoPipeline：`runJianyingFullPipeline({ importPath, exportPath })` | 已实现 |

### 路径 3.2：P2 TTS 与字幕

| 序号 | 动作 | 产出 |
|------|------|------|
| 1 | TTS 模块：Ollama TTS 或云端 API → 音频文件 | src/tts/ |
| 2 | 字幕：Whisper 或接口 → SRT | src/subtitles/ |
| 3 | 剪映字幕步骤：导入 SRT / 自动识别 | jianyingSteps |
| 4 | 编排：文案 → TTS → 字幕 → 剪映 → 导出 | videoPipeline |

### 路径 3.3：P3 发布 + Scrapling

| 序号 | 动作 | 产出 |
|------|------|------|
| 1 | 接入 Scrapling MCP（.cursor/mcp.json） | AI 可调 Scrapling |
| 2 | 选定一平台（如 B 站）做 POC | 发布 Blueprint |
| 3 | Scrapling 抓取发布页结构 → 填标题、选分区 | 发布流程编排 |
| 4 | videoPipeline 末端：导出 → 发布 | 端到端 |

---

## 四、自我进化与多策略（长期）

| 路径 | 动作 |
|------|------|
| 知识库 | 持续维护 automation_memory：新版本坐标、失效模式 |
| 多策略 | Name → AutomationId → 相似度 → 坐标，可配置 |
| 坐标漂移 | 从知识库加权/投票，减少单点失效 |

---

## 五、建议执行顺序

```
当前：P0 收尾（路径 2.1 → 2.2）
  ↓
P1 导入（路径 3.1）
  ↓
P2 TTS/字幕（路径 3.2）
  ↓
P3 发布 + Scrapling（路径 3.3）
  ↓
长期：多策略、知识库积累（路径 四）
```

---

## 六、验收标准

| 阶段 | 验收 |
|------|------|
| P0 收尾 | `npm run verify:jianying-export` 无报错，桌面出现 output.mp4 |
| P1 | 可执行「导入 C:\xxx\video.mp4 → 导出」 |
| P2 | 可执行「文案 → TTS → 字幕 → 导出」 |
| P3 | 可执行「导出 → 发布到指定平台」 |

---

*本路径与 `BLUEPRINT_系统融合与Phase执行计划.md` 对应，供迭代开发参考。*
