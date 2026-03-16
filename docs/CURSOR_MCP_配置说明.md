# Cursor 里 MCP 配置：在哪里填、填什么

本项目已在本仓库内写好 **MCP 配置骨架**，路径为：

- **项目内文件**：`牛逼系统\.cursor\mcp.json`

下面说明在 Cursor 里「在哪里填、填什么」。

---

## 方式一：使用项目自带的 .cursor/mcp.json（推荐先试）

1. 本仓库根目录下已有 **`.cursor`** 文件夹，里面有 **`mcp.json`**。
2. 用 Cursor 打开本项目（打开「牛逼系统」这个文件夹）。
3. **重启 Cursor**（关掉再开，或 Reload Window），让 Cursor 重新读取 `.cursor/mcp.json`。
4. 若 Cursor 识别到 MCP，在聊天/Composer 里应能看到 **directshell** 相关工具（需先有 directshell.exe 和 ds-mcp 才能真正调用成功）。

**注意**：Windows 11 上有时项目级 `.cursor/mcp.json` 不生效，若重启后仍看不到 directshell，改用方式二。

---

## 方式二：在 Cursor 设置界面里手动添加（最稳妥）

1. 在 Cursor 里按 **Ctrl + ,** 打开设置，或点击左下角齿轮 **设置**。
2. 在设置搜索框输入 **MCP**，或找到 **Cursor Settings → MCP**（或 **Features → MCP**）相关项。
3. 找到 **MCP Servers** 或 **Edit in mcp.json** 之类入口，点进去会打开或提示你编辑 MCP 配置文件。
4. 若打开的是**用户级**配置文件（一般在 `C:\Users\你的用户名\.cursor\mcp.json`），把下面整段复制进去（若已有 `mcpServers`，只把 `directshell` 这一段合并进去）：

```json
{
  "mcpServers": {
    "directshell": {
      "command": "python",
      "args": [
        "ds-mcp/server.py",
        "--profiles",
        "D:\\DirectShell\\ds_profiles"
      ],
      "cwd": "D:\\DirectShell"
    }
  }
}
```

5. **改路径**：把上面两处 **`D:\\DirectShell`** 改成你**将来**放 directshell.exe 和 ds-mcp 的文件夹路径（例如 `E:\\Tools\\DirectShell`，注意 JSON 里反斜杠要写两个 `\\`）。
6. 保存文件，**重启 Cursor**。

---

## 要填的代码（复制用）

```json
{
  "mcpServers": {
    "directshell": {
      "command": "python",
      "args": [
        "ds-mcp/server.py",
        "--profiles",
        "D:\\DirectShell\\ds_profiles"
      ],
      "cwd": "D:\\DirectShell"
    }
  }
}
```

- **cwd**：directshell.exe 和 ds-mcp 所在目录（目前用 `D:\DirectShell` 占位，等作者发布预编译包后你解压到某文件夹，把这里改成该路径）。
- **--profiles**：必须和 cwd 下运行 directshell.exe 时生成的 **ds_profiles** 目录一致，一般就是 `cwd + "\\ds_profiles"`。

---

## 当前状态

- 骨架已写好，路径为**占位**（`D:\DirectShell`）。
- 等 DirectShell 作者在 GitHub Releases 发布预编译包后，您把 exe 和 ds-mcp 解压到某文件夹，再把上述两处路径改成该文件夹即可生效。
