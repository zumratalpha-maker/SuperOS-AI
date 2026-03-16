# Learn UI 剪映按钮排查与可操作论证

## 一、排查结果（2026-03）

### 1.1 数据文件状态

| 文件 | 状态 | 说明 |
|------|------|------|
| `data/app_knowledge.json` | **不存在** | Learn UI 说「这是XXX」时写入，供 Execute 与知识面板展示 |
| `data/learned_actions.jsonl` | **不存在** | teach 时同步写入，供 clickByName 自主学习优先命中 |
| `data/automation_success_cache.json` | 存在 | 历史成功点击的缓存，用于下次优先尝试 |

### 1.2 当前缓存内容（automation_success_cache）

| 目标 | 策略 | 坐标 | 来源 |
|------|------|------|------|
| 剪映\|开始创作 | coordinate | (68%, 14%) | 内置坐标兜底命中后缓存 |
| 剪映\|导出 | coordinate | (92%, 6%) | 内置坐标兜底命中后缓存 |

**说明**：这两项来自 `clickByName` 内建的剪映专用分支（`isJianyingStartCreating`、`isJianyingExportMain`），成功点击后写入缓存，并非 Learn UI 语音教学记录。

---

## 二、执行链路（clickByName）

```
用户说「执行开始创作」或点击知识面板「执行」按钮
    ↓
/api/execute { app: "剪映", feature: "开始创作" }
    ↓
clickByName("剪映|开始创作")
    ↓
1. waitForTarget → 轮询等待「剪映」窗口出现
2. resolveTargetHwnd → findWindowByName("剪映") 获取 hwnd
3. bringWindowToFront(hwnd)
4. 优先级顺序：
   ├─ 自主学习（getLearnedClick → learned_actions.jsonl）★ 用户教学
   ├─ 自动化成功缓存（getCachedSuccess）★ 当前有效
   ├─ 剪映内置分支（开始创作 0.68,0.14 / 导出 0.92,0.06 / 导入 0.06,0.4）
   ├─ UiaSniper / SuperEye / Tab 顺序 / 快捷键等兜底
   └─ 失败
```

---

## 三、当前能操作什么（论证）

### 3.1 依赖用户教学（Learn UI）的部分

**前提**：`app_knowledge.json` 和 `learned_actions.jsonl` 必须有数据。

**流程**：说「这是剪映的XXX按钮」→ 光标移到按钮上 → 3 秒后记录 → 写入两个文件。

**可操作**：你教过的任意按钮（图标、开始创作、导出、导入、文本、其他自定义名）均可通过「执行XXX」触发。

**当前状态**：上述两个文件不存在，说明 **尚未通过 Learn UI 成功记录任何新按钮**，或记录未持久化。

### 3.2 依赖内置逻辑（无需教学）的部分

| 操作 | 目标格式 | 能否执行 | 依据 |
|------|----------|----------|------|
| 开始创作 | 剪映\|开始创作 | ✅ 能 | 内置 (0.68, 0.14) + 缓存命中 |
| 导出（主窗） | 剪映\|导出 | ✅ 能 | 内置 (0.92, 0.06) + 缓存命中 |
| 导入素材 | 剪映\|导入 | ✅ 能 | 内置 (0.06, 0.4)，无缓存但可执行 |

**前置**：剪映主窗口已打开且位于前台（或可被 findWindowByName 找到）。

### 3.3 依赖语义快捷键的部分

| 操作 | 快捷键 | 能否执行 |
|------|--------|----------|
| 保存 | ^s | ✅ 能（主窗菜单内） |
| 另存为 | %fa | ✅ 能 |

当 `clickByName` 查不到 UIA/坐标时，会走 `resolveShortcut` 的快捷键兜底。

---

## 四、若通过 Learn UI 记录了按钮

1. **写入位置**：`app_knowledge.json` + `learned_actions.jsonl`
2. **执行优先级**：`clickByName` 先查 `getLearnedClick`，命中则用你记录的相对坐标点击
3. **命名规范**：`app|feature`，如 `剪映|开始创作`、`剪映|图标`
4. **排查命令**：`npx tsx scripts/inspect-learned-buttons.ts` 查看已记录内容

---

## 五、结论与建议

| 结论 | 说明 |
|------|------|
| **当前可操作** | 开始创作、导出、导入（内置坐标）+ 保存/另存为（快捷键） |
| **用户教学记录** | 暂无（app_knowledge / learned_actions 均不存在） |
| **建议** | 若 Learn UI 已教学成功，请检查 `data/` 下是否生成上述文件；必要时重启 `npm run learn:ui` 再录一次 |

---

*排查脚本：`scripts/inspect-learned-buttons.ts`*
