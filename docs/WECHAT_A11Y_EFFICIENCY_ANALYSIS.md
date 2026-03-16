# 微信发消息 A11y 链路效率分析

**分析视角**：高级项目经理  
**数据来源**：终端 9.txt 第 104-167 行执行日志  
**用户指令**：打开微信,给阿尔法说我很忙  

---

## 一、执行概览

| 指标 | 当前值 | 理想值 |
|------|--------|--------|
| 总步骤数 | 8 | 7 |
| 实际发送内容 | 我很忙我很忙 | 我很忙 |
| UiaSniper 失败次数 | 15+ | 0~3 |
| focusWeChatInputBox 调用 | 3 次 | 1 次 |
| 是否成功发送 | ✓ | ✓ |

---

## 二、根因分析

### 2.1 重复步骤：type "我很忙" 执行两次

**现象**：第 6、7 步均为 `type "我很忙…"`，导致发送 "我很忙我很忙"。

**根因**：`injectWeChatMessage` 逻辑缺陷。

```typescript
// parseIntent.ts 当前逻辑
if (lastTypeIdx >= 0 && !(out[lastTypeIdx].text?.trim())) {
  out[lastTypeIdx] = { type: "type", text };  // 替换空 type
} else {
  out.push({ type: "type", text });  // 否则追加 ← 问题在此
}
```

当云端已返回 `type 我很忙` 时，最后一个 type 已有内容，走入 `else` 分支，再次 `push` 一条相同 type，造成重复。

**影响**：多执行一步、多一次 focusWeChatInputBox、多发一次「我很忙」。

---

### 2.2 冗余聚焦：focusWeChatInputBox 被重复调用

**现象**：步骤 5（click 输入）已成功点击输入框，步骤 6、7 的 type 仍然再次调用 `focusWeChatInputBox`。

**根因**：type 步骤处理逻辑中，只要 `weChatPhase === "input"` 就会调用聚焦，未判断上一步是否为 click 输入。

**调用链**：
- 步骤 5 `click 输入` → focusWeChatInputBox（坐标点击成功）
- 步骤 6 `type 我很忙` → focusWeChatInputBox 再调一次（冗余）
- 步骤 7 `type 我很忙` → focusWeChatInputBox 再调一次（冗余 + 重复步骤）

**影响**：每次 focusWeChatInputBox 都会尝试 3 个 keyword（输入/输入框/请输入）→ 3 次 UiaSniper 失败 → 再坐标点击。2 次多余调用 ≈ 6 次无效 UiaSniper 调用。

---

### 2.3 UiaSniper 持续失败

**现象**：每次 `clickByName("微信|输入")` 等均出现 `Element not found: ����`（乱码，疑为编码问题）。

**根因**：微信 Weixin 对 UIA 暴露不完整或命名不符合 UiaSniper 预期，导致按名称查找失败。

**当前策略**：3 个 keyword 依次尝试 → 全部失败 → 退回到坐标点击 → 坐标点击成功。

**影响**：每次 focusWeChatInputBox 约 3 次 UiaSniper 调用（~1–2s/次），整体耗时显著增加。

---

## 三、效率优化方案（按 ROI 排序）

### 优先级 1：修复重复 type（高收益、零风险）

**改动**：`injectWeChatMessage` 中，当最后一个 type 已有非空内容时，不再 `push`。

```typescript
if (lastTypeIdx >= 0) {
  const last = out[lastTypeIdx] as { text?: string };
  if (!last.text?.trim()) out[lastTypeIdx] = { type: "type", text };
  // else: 已有内容，不追加
} else {
  out.push({ type: "type", text });
}
```

**收益**：消除第 7 步、修复「我很忙我很忙」、省去 1 次 focusWeChatInputBox（约 3 次 UiaSniper + 坐标点击 + 粘贴）。

---

### 优先级 2：type 消息时跳过冗余 focusWeChatInputBox（高收益、低风险）

**改动**：在 StepState 中增加 `weChatInputJustFocused`。  
- `click 输入` 执行后设为 `true`。  
- `type 消息` 时若为 `true`，则不再调用 `focusWeChatInputBox`，直接 `typeText`，并置回 `false`。

**收益**：省去 1 次 focusWeChatInputBox（约 3 次 UiaSniper + 坐标点击）。

---

### 优先级 3：微信输入框优先坐标点击（中收益、需验证）

**改动**：在 `focusWeChatInputBox` 中，对微信先尝试 1 次 keyword（如「输入」），失败后直接进入坐标点击，而不是再试「输入框」「请输入」。

**收益**：每次 focus 约减少 2 次 UiaSniper 调用。  
**风险**：需确认坐标在不同分辨率下仍可靠。

---

### 优先级 4：UiaSniper 编码/兼容（长期）

**方向**：排查 `Element not found: ����` 的编码问题，或为微信单独配置查找策略，减少无意义重试。

---

## 四、预期效果（实施优先级 1+2）

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| 总步骤 | 8 | 7 |
| 发送内容 | 我很忙我很忙 | 我很忙 |
| focusWeChatInputBox 调用 | 3 | 1 |
| UiaSniper 失败次数 | 15+ | 3 |
| 预估耗时 | ~15–20s | ~6–8s |

---

## 五、实施建议

1. **立即实施**：优先级 1、2。  
2. **验证后实施**：优先级 3，需在不同分辨率/窗口尺寸下测试坐标点击成功率。  
3. **立项调研**：优先级 4，作为 UiaSniper/微信兼容性专项。
