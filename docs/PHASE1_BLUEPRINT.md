# Phase 1 Blueprint：DirectShell 获取与配置 + 语音接口预留（已批准）

## 原则

- **不要求任何编程环境**：不安装 Rust，不使用 cargo build，不从源码编译。
- **获取方式**：从 GitHub Releases 页面下载作者打包好的 **预编译 directshell.exe** 和配套的 **Python 脚本**（ds-mcp 等）。
- 若作者尚未发布 Release，在仓库 Issues 中礼貌请求提供 Windows 预编译 exe；在获得预编译包之前，可先完成 MCP 配置说明与语音预留设计。

---

## 步骤概览

| 顺序 | 内容 | 说明 |
|------|------|------|
| 1 | 下载与存放 | 去 GitHub Releases 下载 .exe 和脚本，放到本机固定文件夹（见傻瓜说明书） |
| 2 | Cursor MCP 配置 | 在 Cursor 里配置 MCP，指向上述文件夹和 ds-mcp 的 Python 脚本 |
| 3 | 第一次连接测试 | 运行 directshell.exe，在 Cursor 中测试 MCP 工具调用 |
| 4 | 语音模块预留 | 写设计文档，预留「麦克风唤醒词 + 简单命令 → JSON Action」接口 |

---

## 获取方式（修订后）

- **Releases 页面**：https://github.com/IamLumae/DirectShell/releases  
- 在页面上找到 **Assets** 区域，下载 Windows 预编译包（如 `directshell-win64.zip` 或类似）以及所需 Python 脚本（若单独提供）。
- 解压到本机固定目录，例如：`D:\DirectShell`（或您指定的文件夹），保证后续 MCP 配置中的路径与此一致。

---

## MCP 与语音预留

- MCP 配置中的 `cwd` 与 `--profiles` 指向您解压后的目录（以及该目录下的 `ds_profiles` 文件夹，由 directshell.exe 运行后自动生成）。
- 语音模块：仅做接口与设计文档预留，输出严格 JSON Action Schema，与 DirectShell 对齐；不在此阶段实现具体识别逻辑。

---

**状态**：本计划已按“仅使用 Releases 预编译、无需 Rust/编译”修订，并已批准（APPROVED）。
