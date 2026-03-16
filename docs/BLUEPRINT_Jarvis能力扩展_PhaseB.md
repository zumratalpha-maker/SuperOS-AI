# Blueprint Plan：Jarvis 能力扩展（Phase B）

> 按顺序执行，完成 A 语音模块后的 **B. Jarvis 能力扩展**。
> 批准后将按本 Blueprint 分阶段实现。

---

## 一、思考步骤

1. **目标**：在记事本完整链已验收基础上，扩展支持更多应用（剪映、Excel、WPS 等），使「打开 X」及「打开 X 做 Y」能正确启动并执行基础操作。
2. **约束**：遵守 .cursorrules；复用现有 appRegistry、appExecutor、directShellBridge 能力；不引入截图/视觉方案。
3. **范围**：优先「打开 + 单步」（如打开剪映、打开 Excel）；复杂多步（剪映导出、Excel 保存）可先产出 a11y_sequence 骨架，由 planWithLocal 填充步骤，执行层已有能力支持。

---

## 二、分阶段计划

### 阶段 1：扩展应用注册与启动

| 步骤 | 位置 | 动作 |
|------|------|------|
| 1.1 | `src/config/appRegistry.ts` | 新增 Excel、WPS、CapCut（剪映国际版）等入口；Excel 用 `excel`（Shell 协议）或 `"%ProgramFiles%\\Microsoft Office\\...\\EXCEL.EXE"`；WPS 用常见路径或 `wps`。 |
| 1.2 | `src/tools/appExecutor.ts` | 在 `TARGET_TO_EXE_NAMES`、`CHINESE_NAME_TO_LNK_STEMS` 中补充 Excel、WPS、CapCut；在 `COMMON_APP_PATHS` 中补充 Excel、WPS 常见安装路径。 |
| 1.3 | 同上 | 确保 `resolveAndLaunch` 能正确解析「Excel」「WPS」「剪映」「CapCut」并启动。 |

**验收**：`打开 Excel`、`打开 WPS`、`打开剪映` 能成功启动对应应用。

---

### 阶段 2：扩展窗口查找别名与进程兜底

| 步骤 | 位置 | 动作 |
|------|------|------|
| 2.1 | `src/runA11ySequence.ts` | 在 `WINDOW_NAME_ALIASES` 中新增：`Excel`、`WPS`、`剪映` 的中/英窗口标题别名。 |
| 2.2 | 同上 | 在 `APP_TO_PROCESS` 中新增：`Excel`→`EXCEL`、`WPS`→`wps`、`剪映`→`JianyingPro` 等。 |
| 2.3 | `src/tools/directShellBridge.ts` | 在 `PROCESS_NAME_FALLBACK`、进程名兜底逻辑中补充 Excel、WPS、剪映（参考记事本兜底）。 |

**验收**：open_app Excel / WPS / 剪映 后，findWindowByAppWithRetry 能正确找到窗口。

---

### 阶段 3：扩展 plan 与规则兜底（可选）

| 步骤 | 位置 | 动作 |
|------|------|------|
| 3.1 | `src/jarvis/parseIntent.ts` | 在 `buildRuleFallbackSteps` 或新增规则中，支持「打开 Excel + 输入/保存」类指令（若匹配则构造最小 steps）。 |
| 3.2 | `src/llm/hybridRouter.ts` | 微调 `LOCAL_PLAN_PROMPT`：补充 Excel（新建、保存）、剪映（导出）等应用常见步骤示例，便于 planWithLocal 产出合理 steps。 |

**验收**：输入「打开 Excel，输入测试，保存」能产出 a11y_sequence 并执行（或在 Excel 未安装时优雅失败）。

---

## 三、目录与文件（计划）

```
src/config/appRegistry.ts       # 新增 Excel、WPS 等
src/tools/appExecutor.ts        # TARGET_TO_EXE_NAMES、COMMON_APP_PATHS 扩展
src/runA11ySequence.ts          # WINDOW_NAME_ALIASES、APP_TO_PROCESS 扩展
src/tools/directShellBridge.ts  # PROCESS_NAME_FALLBACK、进程名兜底
src/jarvis/parseIntent.ts       # 可选：Excel 等规则兜底
src/llm/hybridRouter.ts         # 可选：LOCAL_PLAN_PROMPT 扩展
```

---

## 四、风险与注意

- **安装路径差异**：Excel、WPS、剪映 安装位置因用户而异；优先用 Shell 协议（`excel`）、开始菜单、注册表，其次常见路径。
- **窗口标题**：Excel 可能为「Book1 - Excel」、剪映为「未命名 - 剪映」等；别名需覆盖常见变体。
- **执行层**：clickByName、typeText 已支持任意窗口，扩展仅需确保 findWindow 能定位到目标窗。

---

## 五、实现顺序（批准后执行）

1. 扩展 appRegistry（Excel、WPS）
2. 扩展 appExecutor（TARGET_TO_EXE_NAMES、COMMON_APP_PATHS）
3. 扩展 runA11ySequence（WINDOW_NAME_ALIASES、APP_TO_PROCESS）
4. 扩展 directShellBridge（进程名兜底）
5. 可选：parseIntent 规则兜底、hybridRouter prompt 扩展

---

**状态**：本 Blueprint 已输出，等待用户批准。批准后将按上述顺序编写代码。
