# 语音视觉学习系统 — 蓝图

> 用户通过麦克风教系统「这是剪映的图标」「剪映有哪些功能」，系统截图看画面、记住知识，下次类似场景自动执行。

---

## 一、核心流程

```
[学习模式]
  你：打开剪映 → 说「这是剪映的图标」
  我：截图当前画面 → Vision 描述 → 记住「剪映图标」≈ 某窗口/进程
  你：点开始创作 → 说「这是开始创作按钮」
  我：截图 + 记录光标位置/元素 → 记住「剪映|开始创作」→ (xRel, yRel)
  你：继续说功能名… 我逐一记住

[执行模式]
  你：打开剪映，点开始创作
  我：查知识库 → 找到 剪映|开始创作 → 用学到的坐标执行点击
```

---

## 二、知识结构

```json
{
  "apps": {
    "剪映": {
      "identifiers": ["JianyingPro", "CapCut", "剪映专业版"],
      "features": {
        "开始创作": { "type": "click", "xRel": 0.68, "yRel": 0.14, "context": "欢迎页" },
        "导入": { "type": "click", "xRel": 0.06, "yRel": 0.4, "context": "编辑界面" },
        "导出": { "type": "click", "xRel": 0.92, "yRel": 0.06, "context": "编辑界面" }
      }
    }
  }
}
```

---

## 三、UI 设计（特色）

- **深色主题**，科技感
- **左侧**：实时屏幕预览（或占位）
- **右侧**：对话区（你的语音 → 转文字 → 我的回复）
- **底部**：麦克风按钮，按住说话 / 点击开始持续监听
- **状态**：学习模式 | 执行模式 | 待命
- **知识面板**：已学应用与功能列表，可编辑/删除

---

## 四、技术栈

| 模块 | 方案 |
|------|------|
| UI | 本地 HTTP 服务 + 单页 HTML/CSS/JS（无框架，轻量） |
| 语音 | 浏览器 Web Speech API（免后端 ASR） |
| 视觉 | 后端截图 + Ollama llava / 云端 Vision API |
| 知识 | data/app_knowledge.json，Local-First |
| 执行 | 复用 directShellBridge clickByName 等 |

---

## 五、API 设计

| 端点 | 方法 | 说明 |
|------|------|------|
| GET /api/screenshot | - | 截取前台窗口，返回 base64 或描述 |
| POST /api/describe | body: { imageBase64? } | Vision 描述当前画面 |
| POST /api/teach | body: { app, feature, xRel, yRel, context? } | 存入知识库 |
| GET /api/knowledge | - | 返回完整知识库 |
| POST /api/execute | body: { app, feature } | 按知识库执行 |
| GET /api/foreground | - | 当前前台窗口 + 光标 (xRel,yRel) |

---

## 六、实现阶段

| 阶段 | 内容 |
|------|------|
| P0 | 本地 Learn UI 服务 + 基础页面（麦克风 + 对话区） |
| P1 | 语音转文字（Web Speech API）+ 后端 describe/teach |
| P2 | 知识库 CRUD + 执行桥接 |
| P3 | 持续记录模式（可选：定期截图+对比） |

---

## 七、使用说明

```bash
npm run learn:ui
```

浏览器打开 http://localhost:3856 ，推荐流程：

1. **看画面**：把目标应用放前台 → 说「看看画面」→ 系统截图 + Vision 描述
2. **教功能**：光标移到按钮上 → **按 F12**（不抢焦点）→ 切回本页说「这是开始创作按钮」
3. **执行**：说「执行开始创作」或在右侧知识面板点「执行」

F12 热键由服务端内置，启动后自动生效，2 分钟内有效。

---

*创建于 2026-03-15*
