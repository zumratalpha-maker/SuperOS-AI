# 应用启动路径问题排查与修复方案

## 问题现象

用户执行「打开微信，给阿尔法发微信」时，系统报错：
```
Windows 找不到文件 'D:weixinWeixin.exe'。请检查文件名并重试。
```

路径 `D:weixinWeixin.exe` 明显错误：盘符后缺少反斜杠，应为 `D:\weixin\Weixin.exe`。

---

## 根因分析

### 1. 字符串转义导致路径被截断

**位置**：`src/config/appRegistry.ts` 第 13 行

```typescript
微信: "D:\weixin\Weixin.exe",
```

在 JavaScript/TypeScript 字符串中，`\w`、`\W` 等会被解析为转义序列，导致反斜杠被吞掉：
- `\w` → 可能变为 `w`
- `\W` → 可能变为 `W`  
实际结果类似 `"D:weixinWeixin.exe"`，盘符和路径被连在一起。

**影响范围**：所有在 appRegistry 中用单反斜杠写的 Windows 路径，只要路径中包含 `\w`、`\n`、`\t`、`\r` 等转义序列，都可能出错。

---

### 2. isSystemCommand 逻辑误判

**位置**：`src/tools/appExecutor.ts` 第 425–430 行

```typescript
const isSystemCommand =
  /^(notepad|calc|mspaint|explorer|cmd|powershell)$/i.test(expandedFromRegistry ?? name) ||
  !(expandedFromRegistry ?? name).includes("\\");
if (isSystemCommand && (expandedFromRegistry ?? name)) {
  await launchByPath(expandedFromRegistry ?? name);  // 直接启动
  return { ok: true };
}
```

原意：`notepad`、`calc` 等不含 `\`，视为系统命令；`C:\Program Files\...` 含 `\`，视为文件路径。

问题：被转义破坏后的 `"D:weixinWeixin.exe"` 不含 `\`，满足 `!(...).includes("\\")`，被当成“系统命令”直接传给 `launchByPath`，跳过桌面快捷方式、注册表、COMMON_APP_PATHS 等后续解析，最终启动失败。

---

### 3. 预设路径可能不存在

`D:\weixin\Weixin.exe` 很可能是示例路径，实际安装位置多为：
- `C:\Program Files (x86)\Tencent\WeChat\WeChat.exe`
- `D:\Program Files\Tencent\WeChat\WeChat.exe`
- 等

appExecutor 已有 `COMMON_APP_PATHS` 兜底，但上述两个问题会使流程在“系统命令”分支提前结束，永远走不到这些兜底逻辑。

---

## 其他应用是否受影响？

| 场景 | 是否受影响 |
|------|------------|
| 记事本、计算器（notepad, calc） | 否，直接用名称启动 |
| 剪映（双反斜杠 `%LOCALAPPDATA%\\JianyingPro\\...`） | 否，转义正确 |
| 百度（URL） | 否 |
| **微信**（`D:\weixin\Weixin.exe`） | 是，路径被破坏 + 被当成系统命令 |
| 未来在 appRegistry 中新增的 exe 路径，若使用单反斜杠且路径中包含 `\n`、`\t`、`\w` 等 | 是，存在相同风险 |

---

## 修复方案

### 修改 1：appRegistry 路径转义与默认值

**文件**：`src/config/appRegistry.ts`

**做法**：
1. 将微信路径改为双反斜杠，例如：`"D:\\weixin\\Weixin.exe"`
2. 更稳妥：删除微信的硬编码路径，改由自动发现（桌面快捷方式、注册表、COMMON_APP_PATHS）定位 exe

**建议**：移除或注释掉微信的预设路径，让解析流程走桌面快捷方式、注册表、`COMMON_APP_PATHS`。

---

### 修改 2：收紧 isSystemCommand 判断

**文件**：`src/tools/appExecutor.ts`

**原逻辑**：
```typescript
const isSystemCommand =
  /^(notepad|calc|mspaint|explorer|cmd|powershell)$/i.test(...) ||
  !(...).includes("\\");
```

**新逻辑**：
```typescript
// 仅对已知系统命令按名称启动；含盘符或反斜杠的一律视为路径，走后续解析
const exact = (expandedFromRegistry ?? name).trim();
const isSystemCommand =
  /^(notepad|calc|mspaint|explorer|cmd|powershell)$/i.test(exact) &&
  !/^[A-Za-z]:/.test(exact) &&
  !exact.includes("\\");
```

或更简洁：**只保留白名单判断**，删除 `includes("\\")` 分支，避免被错误路径触发：
```typescript
const isSystemCommand = /^(notepad|calc|mspaint|explorer|cmd|powershell)$/i.test((expandedFromRegistry ?? name).trim());
```

---

### 修改 3：appRegistry 路径书写规范

在 `appRegistry.ts` 顶部增加注释，说明 Windows 路径必须使用双反斜杠，例如：

```typescript
/**
 * Windows 本地 exe 路径必须使用双反斜杠，如 "C:\\Program Files\\App\\app.exe"
 * 单反斜杠会导致 \n、\t、\w 等被转义，路径错误
 */
```

---

## 修改清单

| 文件 | 变更 |
|------|------|
| `src/config/appRegistry.ts` | 移除或修正微信预设路径；增加路径书写说明注释 |
| `src/tools/appExecutor.ts` | 将 `isSystemCommand` 改为仅依赖白名单，去掉 `includes("\\")` |

---

## 预期效果

1. 微信：不再依赖错误的 `D:weixinWeixin.exe`，改由桌面快捷方式、注册表、`COMMON_APP_PATHS` 定位真实 exe。
2. 其他应用：appRegistry 中的路径书写错误不会再把错误路径当作系统命令提前启动。
3. 未来新增 exe：只要按规范写双反斜杠，或交给自动发现，均可正常启动。

---

若以上方案无异议，回复「批准」或「OK」后开始执行修改。
