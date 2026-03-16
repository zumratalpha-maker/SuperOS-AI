# UIA + 本地 OCR 双引擎方案：对比分析与整体架构

> 目标：稳定 + 通用 + 0 token + 不重训；适配微信、剪映、Electron、浏览器等。  
> 更新于 2026-03

---

## 一、现状对比

### 1.1 我们当前方案（SuperOS）

| 能力 | 实现 | 优点 | 缺点 |
|------|------|------|------|
| **UIA** | UiaSniper、PowerShell .NET UIA、SuperEye locator | 标准软件精准、结构化 | 微信/剪映/Electron 暴露不完整 |
| **坐标兜底** | 应用专用 (0.68,0.14) 等 | 不依赖 UIA，本地 | UI 改版即失效，需人工维护 |
| **Tab 序扫描** | enumerateFocusableByTabOrder | 利用焦点遍历，有时可突破 UIA 盲区 | 耗时 5–10s，改变焦点，循环检测复杂 |
| **语义快捷键** | ^s、%f、Ctrl+F 等 | 稳定、跨应用 | 仅覆盖菜单/保存等，非任意按钮 |
| **用户教学** | Learn UI → app_knowledge + learned_actions | 可扩展 | 记录未持久化，流程依赖光标时机 |
| **Vision 描述** | 截图 → LLM Vision API | 能描述界面 | **高 token 消耗**，非 0 成本 |

**缺失**：无本地 OCR，对 UIA 盲区（微信输入框、剪映按钮等）只能靠坐标/Tab，通用性差。

---

### 1.2 拟议方案（UIA + 本地 OCR）

| 能力 | 说明 | 优点 | 缺点 |
|------|------|------|------|
| **UIA 优先** | 标准控件树查找 | 精准、零额外资源 | 非标应用失效 |
| **本地 OCR 兜底** | 截图 → 文字识别 → 文字定位 → 点击 | 通用、不依赖 UIA | 需处理分辨率/DPI、误识、多候选 |
| **模拟键鼠** | SendInput、clickAt | 最终动作 | 与现有一致 |
| **0 token** | 无 LLM | 成本可控 | 无语义理解，仅「找字→点」 |

---

### 1.3 业界做法（GitHub / 论坛）

| 项目/方案 | 技术栈 | 适用场景 | 参考 |
|-----------|--------|----------|------|
| **UiPath** | UIA + OCR Text / Image | 企业 RPA | [Click OCR Text](https://docs.uipath.com/activities/other/latest/ui-automation/click-ocr-text) |
| **Power Automate** | UIA + “Move mouse to text (OCR)” | 微软官方 | [Troubleshoot](https://learn.microsoft.com/en-us/troubleshoot/power-platform/power-automate/desktop-flows/ui-automation/element-picker-cant-see-elements) |
| **SikuliX** | OpenCV 图像匹配 + Tesseract OCR | 跨平台 GUI 自动化 | [SikuliX](https://kaiyuanapp.cn/sikulix/) |
| **Kronsteen** | Tesseract + YOLO + PyAutoGUI | 开源 Vision RPA | [romaklym/kronsteen](https://github.com/romaklym/kronsteen) |
| **Untriseptium** | Tesseract + pyautogui | 轻量 Python | [norihiro/untriseptium](https://github.com/norihiro/untriseptium) |
| **Windows.Media.Ocr** | Win10+ 内置 | 零依赖、离线、中文支持 | [Microsoft Learn](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine) |
| **wxautomation** | UIA + 图像识别混合 | 微信专用 | [hongkai-Tang/wxautomation](https://github.com/hongkai-Tang/wxautomation) |
| **微信 UIA 激活** | 伪装无障碍客户端触发完整 Provider | 微信 4.1.5+ | [有客多开](http://www.wymduoke.com/h-nd-46.html) |

**共识**：UIA 失败时，**坐标 / 图像匹配 / OCR** 是通用兜底；微信/Electron 需混合策略。

---

## 二、客观对比：现有 vs UIA+OCR 双引擎

| 维度 | 我们当前 | UIA+OCR 双引擎 | 更优方 |
|------|----------|----------------|--------|
| **标准软件** | UIA + 快捷键 | UIA 为主 | 相当 |
| **微信/Electron** | 坐标 + Tab + 快捷键 | UIA 尝试 → OCR 兜底 | **双引擎** |
| **通用性** | 依赖应用 Profile | 任意可见文字可定位 | **双引擎** |
| **Token 成本** | Vision 描述有消耗 | 0 | **双引擎** |
| **维护成本** | 坐标改版即失效 | OCR 适配分辨率/字体 | **双引擎**（更少人工） |
| ** latency** | 坐标快；Tab 慢 | UIA 快；OCR 中等 | 相当 |
| **实现复杂度** | 已有大量逻辑 | 需新增 OCR 模块 | 我们 |
| **依赖** | 无额外二进制 | OCR 引擎（Tesseract/Windows.Media） | 我们 |

**结论**：**UIA + 本地 OCR 双引擎在通用性、0 成本、抗改版上更优**；我们现有坐标/Tab/快捷键仍有价值，应作为 OCR 之前的快速路径。取长补短：保留 UIA/坐标/快捷键，新增 OCR 兜底。

---

## 三、整体架构设计

### 3.1 分层逻辑

```
┌─────────────────────────────────────────────────────────────────┐
│                      任务流程执行引擎                              │
│  （解析意图 → 生成步骤 → 按序执行 click/type/keys → 失败重试）      │
└─────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                   定位引擎（双引擎）                               │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐          │
│  │ UIA 引擎    │───▶│ 命中？      │───▶│ 执行 click  │          │
│  │ (优先)      │    │ 否 → 切 OCR │    │ type/keys   │          │
│  └─────────────┘    └─────────────┘    └─────────────┘          │
│         │                    │                                   │
│         │                    ▼                                   │
│         │           ┌─────────────┐                              │
│         │           │ OCR 引擎    │ 截图 → 识别 → 文字定位       │
│         │           │ (兜底)      │                              │
│         │           └─────────────┘                              │
│         │                    │                                   │
│         └────────────────────┴─────▶ 坐标/快捷键/用户教学 (保留)  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 双引擎决策逻辑

```
定位请求 (target: "剪映|开始创作" 或 "微信|输入框")
    │
    ├─ 1. 语义快捷键？ ──有──▶ 直接 sendKeys，返回
    │
    ├─ 2. 用户教学 / 成功缓存？ ──有──▶ 用坐标点击，返回
    │
    ├─ 3. 应用专用坐标？（剪映 开始创作/导出/导入 等）──有──▶ 用坐标点击，返回
    │
    ├─ 4. UIA 查找 ──成功──▶ Invoke / 坐标点击，返回
    │         │
    │         └─失败──┐
    │                 ▼
    ├─ 5. 是否「已知 UIA 盲区」？ 微信/剪映/Electron/部分 Electron 应用
    │         │
    │         ├─ 是 ──▶ 直接走 OCR（跳过无效 UIA 重试）
    │         │
    │         └─ 否 ──▶ 可选再试一次 UIA（Tab 扫描）──失败──▶ OCR
    │
    └─ 6. OCR 引擎
              │
              ├─ 截图目标窗口 (hwnd)
              ├─ 本地 OCR 识别 (Windows.Media.Ocr / Tesseract)
              ├─ 按 target 文本模糊匹配，取 bbox 中心
              └─ clickAt(center)
```

### 3.3 何时用 UIA、何时切 OCR

| 条件 | 策略 | 说明 |
|------|------|------|
| 有快捷键映射 | 快捷键 | 保存、另存为、菜单等 |
| 有用户教学 / 缓存坐标 | 坐标 | 已证明有效 |
| 有应用专用坐标 | 坐标 | 剪映、微信输入框等 |
| 目标为标准 Windows 控件 | **UIA** | 记事本、系统对话框、Win32 应用 |
| 目标为微信/剪映/Electron 内控件 | **OCR**（或先短时 UIA 尝试） | UIA 常失效 |
| UIA 查找超时 / 空树 | **OCR** | 直接兜底 |
| OCR 多候选 | 取第一个 / 按位置启发式（如输入框在下方） | 可配置 |

**「已知 UIA 盲区」**：维护名单，如 `["微信","剪映","CapCut","JianyingPro","Electron","Chrome","Edge"]`，命中则减少 UIA 重试，尽快切 OCR。

---

## 四、微信类软件的具体策略

### 4.1 问题根因（综述）

- **DirectUI / 自绘**：微信、Electron 非标准控件，UIA 树不完整。
- **按需暴露**：微信 4.1.5+ 需「无障碍客户端」激活才暴露完整树。
- **Name/AutomationId 不稳定**：空、重复、动态生成。

### 4.2 分层策略（推荐）

| 优先级 | 策略 | 场景 |
|--------|------|------|
| 1 | 快捷键 | 搜索 Ctrl+F、发送 Enter |
| 2 | 坐标（含用户教学） | 输入框 (0.75, 0.92)、联系人列表等 |
| 3 | UIA 短时尝试 | 部分版本/窗口偶有可读控件 |
| 4 | **OCR 兜底** | 找「搜索」「输入」「发送」等文字 → 点击 |

### 4.3 OCR 在微信中的用法

1. 截取微信主窗口。
2. OCR 识别所有文字及其 bbox。
3. 对 target 做模糊匹配，如「输入」≈「请输入」。
4. 多候选时：输入框一般在下方、中部；发送在右下。
5. 点击 bbox 中心。

---

## 五、本地 OCR 选型

| 方案 | 优点 | 缺点 |
|------|------|------|
| **Windows.Media.Ocr** | 系统内置、离线、中文、0 依赖 | 需 Win10+、WinRT，与 Node 集成需 C#/PowerShell |
| **Tesseract** | 成熟、多语言、多平台 | 需安装、中文需语言包，精度一般 |
| **PaddleOCR** | 中文好 | 体积大、部署重 |
| **SikuliX** | 图+文一体化 | Java 依赖、生态独立 |

**推荐**：**Windows.Media.Ocr** 为主（0 依赖、本地、中文），Tesseract 为备选（跨平台、非 Windows）。

---

## 六、流程框图（执行引擎）

```
用户请求：「打开剪映，点开始创作，导出到桌面」
    │
    ▼
parseIntent ──▶ a11y_sequence: [open_app, click, click, type, click, ...]
    │
    ▼
┌───────────────────────────────────────────────────────────┐
│ for each step:                                             │
│   case open_app: runOpenApp(剪映)                           │
│   case click:                                               │
│       ┌─ 解析 target = "剪映|开始创作"                     │
│       └─ clickByName(target)                                │
│            ├─ 快捷键? → sendKeys                            │
│            ├─ 教学/缓存? → 坐标点击                         │
│            ├─ 应用坐标? → 坐标点击                          │
│            ├─ UIA? → 查找 → 点击/Invoke                     │
│            └─ OCR? → 截图 → 识别 → 匹配 → 点击              │
│   case type: typeText(hwnd, text)                          │
│   case keys: sendKeys(keys)                                 │
│   ...                                                       │
│   失败 → Ralph 重试（换策略 / 短延迟）                       │
└───────────────────────────────────────────────────────────┘
```

---

## 七、模块划分（实现阶段）

| 模块 | 职责 | 产出 |
|------|------|------|
| **UIA 遍历与查找** | 按 hwnd 获取树、按 name/role 查找、Tab 兜底 | 封装现有 + 整理接口 |
| **本地 OCR** | 截图 → OCR → 返回 `[{text, bbox}]` | 新模块，PowerShell/C# 调用 Windows.Media.Ocr |
| **文字定位与点击** | 根据 target 匹配 text、选 bbox、计算点击坐标 | 新模块 |
| **双引擎决策** | 快捷键→坐标→UIA→OCR 的优先级与切换 | 集成到 clickByName |
| **任务流程引擎** | 解析步骤、顺序执行、失败重试 | 现有 runA11ySequence 扩展 |

---

## 八、取长补短总结

| 来源 | 可借鉴 |
|------|--------|
| **我们** | UIA、坐标、快捷键、Tab、应用 Profile、教学坐标 |
| **UiPath / Power Automate** | UIA + OCR 的明确分工 |
| **SikuliX / Kronsteen** | 图像+OCR 混合、Region 限定 |
| **Windows.Media.Ocr** | 零依赖、离线、中文 |
| **wxautomation / 微信方案** | UIA 盲区名单、混合策略 |
| **GitHub 开源** | Tesseract + PyAutoGUI 的轻量模式 |

**合并策略**：保留现有全部能力，在其后增加 **OCR 兜底**；UIA 盲区名单加速切换；本地 OCR 以 Windows.Media.Ocr 优先，Tesseract 备选。

---

*文档完成。确认方案后，可进入分模块实现。*
