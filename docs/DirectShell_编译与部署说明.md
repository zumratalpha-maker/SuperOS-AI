# target/release 编译产物说明 — directshell 与 SuperEye

> `D:\SuperOS\target\release\` 目录下存在 **两套** 自编译可执行文件，分别用于不同自动化场景。本文档详细说明两者来源、区别与编译方式。

---

## 一、target/release 下的两个可执行文件

| 文件名 | 大小（约） | 来源 | 用途 |
|--------|------------|------|------|
| **directshell.exe** | ~16KB | C# UiaSniper（`scripts/uia_sniper/`） | 桌面 UIA 点击/输入/滚动，RootElement 扫描，解决官方单窗口附着缺陷 |
| **supereye.exe** | ~420KB | Rust SuperEye（`crates/supereye/`） | 「万能眼睛」daemon，UTF-8 友好 locator，`USE_SUPEREYE=1` 时启用 |

**说明**：两者都输出到同一目录 `target/release/`，因为 C# 的 build.bat 与 Rust 的 Cargo 共用该目录。

---

## 二、directshell.exe — C# UiaSniper

### 2.1 为何要自编译？

官方/旧版 DirectShell 存在 **单窗口附着缺陷**：附着当前焦点窗口，或按名称取第一个，无法穿透全屏、副屏、后台，同名多实例无法区分。

本仓库自编译版采用 **RootElement 扫描顶级窗口**，支持多窗、多屏、`/pid:N` 锁定指定进程。详见 `JARVIS_FULL_REFACTOR_BLUEPRINT_PLAN.md`、`UIA_SNIPER_REFACTOR_DRAFT.md`。

### 2.2 编译（推荐：一键脚本）

**前置**：Windows + .NET Framework 4.7.2+（Win10/11 通常已带），无需 Rust。

```bat
cd d:\SuperOS\scripts\uia_sniper
build.bat
```

或双击 `scripts\uia_sniper\build.bat`。

**产出**：
- `scripts\uia_sniper\UiaSniper.exe`（编译产物）
- `target\release\directshell.exe`（自动复制，供 directShellBridge 使用）

### 2.3 手动编译（脚本失败时）

```bat
cd d:\SuperOS\scripts\uia_sniper
csc /target:exe /out:UiaSniper.exe /reference:"C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8\UIAutomationClient.dll" /reference:"C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8\UIAutomationTypes.dll" /reference:"C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8\WindowsBase.dll" UiaSniper.cs
mkdir d:\SuperOS\target\release 2>nul
copy /Y UiaSniper.exe d:\SuperOS\target\release\directshell.exe
```

若 .NET 4.8 不存在，将路径中的 `v4.8` 改为 `v4.7.2`。

### 2.4 查找顺序

`directShellBridge.getSniperExePath()` 按以下顺序查找：
1. `项目根/target/release/directshell.exe`
2. `scripts/uia_sniper/UiaSniper.exe`（兜底）

---

## 三、supereye.exe — Rust SuperEye Daemon

### 3.1 是什么？

SuperEye 是自研的「万能眼睛」daemon，用 Rust 编写，解决 UiaSniper 在 **中文编码**、**locator 按名查找** 等方面的不足。详见 `SUPEREYE_DAEMON_BLUEPRINT.md`。

### 3.2 何时使用？

当环境变量 `USE_SUPEREYE=1` 时，`directShellBridge` 会优先通过 `supereyeClient` 调用 supereye.exe，执行 `findWindow`、`click`、`clickByLocator`、`waitForElement` 等。

### 3.3 编译

**前置**：已安装 Rust（`rustup` + `cargo`）。

```bat
cd d:\SuperOS
npm run build:supereye
```

或：

```bat
cargo build -p supereye --release
```

**产出**：`target\release\supereye.exe`

### 3.4 启动方式

`supereyeClient` 通过 `supereye --stdio` 启动，与 Node 进程通过 stdio JSON-RPC 通信。无需单独运行，验证脚本或 Jarvis 在 `USE_SUPEREYE=1` 时会自动拉起。

---

## 四、两者关系与优先级

| 场景 | 使用方 |
|------|--------|
| `USE_SUPEREYE=1` | supereye.exe（locator、waitForElement、UTF-8 友好） |
| 默认 | directshell.exe（UiaSniper click/text/scroll） |

两者可并存：SuperEye 负责「眼睛」层（找窗口、找元素），directshell 负责部分「手」操作（尤其是 inject 失败时的兜底）。部分流程中 SuperEye 的 click 会替代 directshell 的 click。

---

## 五、验证

```bat
cd d:\SuperOS
.\target\release\directshell.exe find "记事本"
```

或运行 `npm run verify:orchestrator`，若能正常点击/查找，说明 directshell 已生效。

若要测试 SuperEye：`set USE_SUPEREYE=1` 后再运行验证脚本。

---

## 六、源码位置

| 产物 | 源码 | 设计文档 |
|------|------|----------|
| directshell.exe | `scripts/uia_sniper/UiaSniper.cs` | `docs/UIA_SNIPER_REFACTOR_DRAFT.md` |
| supereye.exe | `crates/supereye/` | `docs/SUPEREYE_DAEMON_BLUEPRINT.md` |

---

*创建于 2026-03，随 target/release 双产物说明完善。*
