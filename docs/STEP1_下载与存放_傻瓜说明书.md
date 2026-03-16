# 第一步：下载 directshell.exe 并放到该放的文件夹（傻瓜说明书）

下面一步一步来，**只做两件事**：① 去哪里、点哪里下载；② 下载后放在电脑的哪个文件夹。

---

## 一、先准备好“该放的文件夹”

1. 打开 **文件资源管理器**（就是平时看 C 盘 D 盘那个窗口）。
2. 选一个盘，比如 **D 盘**，在空白处 **右键** → 点 **新建** → 点 **文件夹**。
3. 把新文件夹改名为：**DirectShell**（不要有空格，就这一个词）。
4. 记住这个路径，例如：**D:\DirectShell**。  
   → 后面下载好的东西，就都放在这个文件夹里。

---

## 二、打开 GitHub 的 Releases 页面

1. 打开浏览器（Edge、Chrome 都可以）。
2. 在地址栏里输入下面这一行（可以复制粘贴），按回车：
   ```
   https://github.com/IamLumae/DirectShell/releases
   ```
3. 回车后，会打开 DirectShell 的 **Releases（发布）** 页面。

---

## 三、页面上会看到两种可能

### 情况 A：页面上有“发布”和“Assets”

- 往下滚动，找到 **Assets**（资产）这一块。
- 里面会有一个或多个可下载的文件，比如：
  - `directshell-win64.zip` 或
  - `directshell.exe` 或
  - 名字里带 `windows`、`win`、`x64` 的压缩包/exe。
- **用鼠标左键点一下** 那个 **.exe** 或 **.zip** 文件名，浏览器就会开始下载。
- 下载完成后，到您电脑的 **“下载”** 文件夹里找到刚下的文件：
  - 如果是 **.zip**：**右键** → **解压到当前文件夹**（或“解压到 DirectShell”），然后把解压出来的 **directshell.exe** 和（若有）**ds-mcp** 文件夹，**全部复制**到您刚建好的 **D:\DirectShell** 里。
  - 如果是 **.exe**：直接把 **directshell.exe** **复制**到 **D:\DirectShell** 里。
- 放好后，**第一步就做完了**。下次我会教您怎么在 Cursor 里配置 MCP。

### 情况 B：页面上写着 “There aren’t any releases here”

- 说明作者 **还没有发布** 预编译的安装包，所以您暂时 **看不到任何可下载的 .exe 或 .zip**。
- 请您 **不用着急**，可以任选其一：
  1. **到仓库里留言请求**：点页面顶上的 **DirectShell** 回到仓库首页，再点 **Issues** → **New issue**，写一句类似：“Could you please add a Windows pre-built release (e.g. directshell.exe or a zip) in Releases? I don’t have Rust installed. Thank you!” 发出去，等作者发布。
  2. **先告诉我**：您可以在对话里跟我说“我打开 Releases 是空的”，我会给您 **备用方案**（例如先做 MCP 配置和语音预留，等有预编译包再补下载这一步）。

---

## 四、最后确认一下

- **您要放到的位置**：**D:\DirectShell**（或您自己建的那个“DirectShell”文件夹）。
- **里面最终要有**：至少一个 **directshell.exe**；如果下载包里还有 **ds-mcp** 或别的脚本/文件夹，也一并放进 **D:\DirectShell**，后面配置 MCP 会用到。

做完“下载 + 放到 D:\DirectShell”后，告诉我一声，我们再进行下一步（Cursor 里怎么填 MCP）。
