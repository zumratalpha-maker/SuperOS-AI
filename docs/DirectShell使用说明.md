# DirectShell 使用说明（说明书）

## 1. DirectShell 是什么？

**一句话**：DirectShell 是一套放在你电脑 **D:\DirectShell** 文件夹里的程序，用来「看到」当前窗口里的按钮、输入框等，并支持用名字点击它们。  
**你平时不用打开它**，只要 Cursor 连上它、你按说明点该点的地方就行。

---

## 2. 它在你电脑的哪里？

| 是什么 | 路径 |
|--------|------|
| 程序所在文件夹 | **D:\DirectShell** |
| 会写“界面快照”的程序 | **D:\DirectShell\target\release\directshell.exe** |
| 快照文件（我们读的） | **D:\DirectShell\ds_profiles\cursor.a11y** |
| Cursor 用来调它的配置 | **D:\SuperOS\.cursor\mcp.json** |

你不用去记这些路径，只要知道：**没有单独一个叫“DirectShell”的软件图标**，它只是 D 盘下那个文件夹里的 exe + 一堆文件。

---

## 3. 你怎么和它“打交道”？

有两种方式，都**不用你去找 DirectShell 菜单**：

### 方式 A：你用手点界面（我们一直在用的）

1. 我告诉你要点哪里（比如：左下角第 4 个图标）。
2. 你用鼠标点一下。
3. 你回复「已点击」。
4. 我这边跑脚本，读 `cursor.a11y` 做对比。

### 方式 B：用 Cursor 的 MCP 工具“代你点击”（可选）

1. 在 Cursor 里打开 **能调用 MCP 的对话** 或 **MCP 工具面板**（不是 mcp.json 文件）。
2. 选择/调用 **DirectShell** 提供的工具，例如：
   - **ds_click("Search Agents")**：按名字点击“Search Agents”
   - **ds_update_view()**：让程序刷新一次界面快照到 `cursor.a11y`
3. 调用完后，再让我跑“抓快照 + 对比”的脚本。

**重点**：你**不需要**在桌面或开始菜单里找“DirectShell”；只要在 Cursor 里用 MCP 调用，或按我说的用鼠标点界面即可。

---

## 4. “刷新 cursor.a11y”是什么意思？谁在做？

- **cursor.a11y**：是 DirectShell 的 exe 写出来的一个**文本文件**，里面是当前 Cursor 窗口的“界面树”（有哪些按钮、输入框等）。
- **刷新**：就是让 exe **再写一次**这个文件，把最新界面写进去。
- **谁在写**：  
  - 平时是 **directshell.exe**（在后台跑的时候）按自己的节奏写。  
  - 如果 Cursor 通过 MCP 调用了 **ds_update_view()**，会触发它马上刷新一次。

所以“DirectShell 刷新”= 让 **D:\DirectShell** 里的程序把当前界面**再写一遍**到 **cursor.a11y**；**你不需要自己去打开 DirectShell**，只要用上面 3 里的方式 A 或 B 即可。

---

## 5. 想看到“点击前后有差异”（diff 不是 0）时，你可以怎么做？

1. **先做一次明显操作**  
   - 例如：用鼠标点 Cursor 左下角第 4 个图标（Agents），打开侧边栏。

2. **（可选）让快照更新一下**  
   - 在 Cursor 的 **MCP 工具**里调用一次 **ds_update_view()**（没有 MCP 就跳过这步）。

3. **马上回复「已点击」**  
   - 我这边会立刻跑脚本：等 800ms → 读 `cursor.a11y` → 和之前的快照对比 → 把结果和轨迹发给你。

这样，只要 **cursor.a11y** 在点击/刷新后被更新了，对比结果里就可能出现 **added / changed 不是 0**。

---

## 6. 小结

- **DirectShell** = D:\DirectShell 里的程序，没有单独的“DirectShell”软件图标。
- **你不用去找 DirectShell**：要么在 Cursor 里用 MCP 调 ds_click / ds_update_view，要么按我说的用鼠标点界面。
- **想看到 diff 非零**：先做明显点击（或 MCP 点击），有 MCP 就调一下 ds_update_view，然后回复「已点击」让我跑脚本。
