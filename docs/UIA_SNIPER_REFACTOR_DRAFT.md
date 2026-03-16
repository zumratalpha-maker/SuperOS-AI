# DirectShell / UiaSniper 底层 C# 核心重构草案

## 一、现有源码逆向解析（结构概览）

当前仓库中仅存在 **`scripts/uia_sniper/UiaSniper.cs`**，无独立 `directshell.exe` 的 C# 源码；以下按该单文件解析为“完整 C# 源代码结构”。

### 1.1 入口与参数

- **Main(string[] args)**  
  - 要求 `args.Length >= 2`，否则打印 Usage 并返回 1。  
  - `args[0]` = action（click | text | scroll），`args[1]` = target（"WindowTitle|ElementName" 或 "ElementName"），`args[2]` = 可选（text 内容或 scroll 方向）。  
  - 调用 **ParseTarget** 得到 `windowName`、`elementName`。

### 1.2 窗口解析与“附着”逻辑（当前缺陷所在）

- **ParseTarget(target, out windowName, out elementName, elementOnly)**  
  - 按 `|` 拆分；无 `|` 时 `windowName == ""`，`elementName == target`。
- **当 windowName 非空**  
  - 调用 **FindTopLevelWindow(windowName)**（见下），得到**第一个** Name 包含 `windowName` 的顶级窗口。  
  - 找到则 **EnsureWindowFocused(window)**，再 Sleep(80)。  
  - **未做 PID 过滤**，多窗/双屏下同名窗口只取第一个，属于“单窗口硬附着”的语义。
- **当 windowName 为空**  
  - **window = AutomationElement.FocusedElement**，再沿 **TreeWalker.RawViewWalker.GetParent** 上溯直到 **ControlType.Window**；若未找到则 **window = RootElement**。  
  - 即**完全依赖当前焦点所在窗口**，无 target 时即“附着当前焦点窗口”，属单次、单焦点附着。

### 1.3 UIA 初始化与查找核心

- **UIAutomation**：无显式初始化代码，依赖 **System.Windows.Automation** 首次使用时自动加载。
- **FindTopLevelWindow(string windowName)**  
  - **root = AutomationElement.RootElement**（已是桌面根）。  
  - **cond = PropertyCondition(ControlTypeProperty, ControlType.Window)**。  
  - **root.FindAll(TreeScope.Children, cond)** 仅扫**第一层子节点**（顶级窗口）。  
  - 遍历返回集合，取 **Current.Name** 包含 `windowName` 的**第一个**元素并返回；**未使用 ProcessId**，无法区分同名进程/多实例。
- **FindElementInScope(AutomationElement scope, string elementName, int depth)**  
  - 在 `scope` 内用 **TreeWalker(Condition.TrueCondition)** 递归子节点，深度上限 MAX_DEPTH=25。  
  - 只考虑 **!IsOffscreen && IsEnabled**，按 **Name** 包含 `elementName` 匹配，返回第一个命中。

### 1.4 窗口附着与置顶

- **EnsureWindowFocused(AutomationElement window)**  
  - 若 **WindowPattern** 存在且 **WindowVisualState == Minimized**，则 **SetWindowVisualState(WindowVisualState.Normal)**。  
  - 然后 **Win32.BringToFront(NativeWindowHandle)**。  
- **Win32.BringToFront(IntPtr hwnd)**  
  - **SetWindowPos(hwnd, HWND_TOP, 0,0,0,0, SWP_NOMOVE|SWP_NOSIZE)** + **SetForegroundWindow(hwnd)**。  
  - **未调用 ShowWindow(hwnd, SW_RESTORE)**；部分环境下仅 SetWindowPos 可能不足以从最小化恢复，需与 ShowWindow 双保险。

### 1.5 动作执行

- **ClickElement**：优先 **InvokePattern.Invoke()**，否则 **BoundingRectangle** 中心 + **SendInput** 物理点击。  
- **SetValue / SetFocusAndValue**：ValuePattern.SetValue 或 SetFocus。  
- **Scroll**：ScrollPattern 的 LargeIncrement / LargeDecrement。

---

## 二、“附着”硬伤诊断

| 位置 | 问题 | 后果 |
|------|------|------|
| **FindTopLevelWindow** | 仅按 **Name** 包含匹配，返回**第一个**命中；无 **ProcessId** 参数 | 多实例/双屏同名窗口（如多个“记事本”）无法区分，永远命中第一个 |
| **Main 中 else 分支** | **window = AutomationElement.FocusedElement** 再上溯到 Window | target 无窗口部分时“附着当前焦点窗口”，单次锁定、无法指定后台或副屏窗口 |
| **无句柄缓存** | 每次请求都 **RootElement.FindAll** 全量扫顶级窗口 | 多窗/多屏下重复扫描、无法利用“刚操作过的窗口”做快速路径 |
| **无 PID 入参** | 命令行与内部 API 均未接收 **processId** | 无法实现“同名 + 指定进程”的精准附着 |
| **EnsureWindowFocused** | 仅 **WindowPattern + SetWindowPos + SetForegroundWindow**，无 **ShowWindow(SW_RESTORE)** | 部分窗口从最小化恢复不够可靠 |
| **单次查找、单次使用** | 查到的 **AutomationElement** 未与 hwnd 一起缓存 | 无法实现“先查缓存再 IsWindow 校验”的快速路径 |

“单窗口硬附着”的本质：**要么按名称取第一个窗口，要么按当前焦点取一个窗口，且无缓存、无 PID，无法在多窗/多屏下稳定锁定同一目标**。

---

## 三、补全后的 C# 源代码草案（完整类结构 + 关键方法）

以下为重构后的**完整 C# 草案**，仅以 Markdown 形式给出，不编译、不生成 exe。目标：**搜索起点统一 RootElement、支持 findWindowByName(name, pid?)、句柄缓存、双屏/多窗、ShowWindow(SW_RESTORE)+SetForegroundWindow**。

```csharp
/*
 * 系统级 UIA 执行器 - 全域上帝视角
 * 搜索起点：AutomationElement.RootElement
 * 支持：FindWindowByName(name, pid?)、句柄缓存、ShowWindow(SW_RESTORE)+SetForegroundWindow、双屏/多窗
 *
 * 编译: csc /reference:UIAutomationClient.dll /reference:UIAutomationTypes.dll UiaSniper.cs
 * 用法: UiaSniper.exe click "微信|发送"
 *       UiaSniper.exe click "记事本|保存" /pid:12345
 *       UiaSniper.exe text "记事本|编辑" "内容"
 */

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace UiaSniper
{
    internal static class Win32
    {
        public const int SW_RESTORE = 9;

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private static readonly IntPtr HWND_TOP = new IntPtr(0);

        /// <summary>强力置顶：先恢复最小化，再置前。</summary>
        public static void BringToFront(IntPtr hwnd)
        {
            ShowWindow(hwnd, SW_RESTORE);
            SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            SetForegroundWindow(hwnd);
        }

        // SendInput 等与现有 UiaSniper 相同，此处省略重复定义…
        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public int type; public MOUSEKEYBDHARDWAREINPUT mi; }
        [StructLayout(LayoutKind.Explicit)]
        public struct MOUSEKEYBDHARDWAREINPUT { [FieldOffset(0)] public MOUSEINPUT mi; }
        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx, dy, mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
        public const int INPUT_MOUSE = 0;
        public const int MOUSEEVENTF_ABSOLUTE = 0x8000;
        public const int MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const int MOUSEEVENTF_LEFTUP = 0x0004;
        public const int MOUSEEVENTF_MOVE = 0x0001;
        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);
        public const int SM_CXSCREEN = 0;
        public const int SM_CYSCREEN = 1;
        public static void MouseClickAbsolute(int x, int y) { /* 同现有实现 */ }
    }

    /// <summary>句柄缓存项：用于在未失效时跳过全屏 Root 扫描。</summary>
    internal sealed class CacheEntry
    {
        public int Hwnd { get; set; }
        public string Name { get; set; }
        public int ProcessId { get; set; }
    }

    /// <summary>句柄缓存：key = "name" 或 "name|pid"，value = CacheEntry。容量上限防内存堆积。</summary>
    internal static class HandleCache
    {
        private const int MaxSize = 64;
        private static readonly Dictionary<string, CacheEntry> _cache = new Dictionary<string, CacheEntry>();
        private static readonly List<string> _order = new List<string>();

        public static string MakeKey(string name, int? pid)
        {
            var n = (name ?? "").Trim().ToLowerInvariant();
            return (pid != null && pid.Value > 0) ? n + "|" + pid.Value : n;
        }

        public static CacheEntry Get(string key)
        {
            if (string.IsNullOrEmpty(key)) return null;
            lock (_cache)
            {
                if (!_cache.TryGetValue(key, out var entry)) return null;
                if (!Win32.IsWindow(new IntPtr(entry.Hwnd))) { _cache.Remove(key); _order.Remove(key); return null; }
                return entry;
            }
        }

        public static void Set(string key, int hwnd, string name, int processId)
        {
            if (string.IsNullOrEmpty(key) || hwnd == 0) return;
            lock (_cache)
            {
                while (_order.Count >= MaxSize && _order.Count > 0)
                {
                    var first = _order[0];
                    _order.RemoveAt(0);
                    _cache.Remove(first);
                }
                var entry = new CacheEntry { Hwnd = hwnd, Name = name, ProcessId = processId };
                _cache[key] = entry;
                _order.Remove(key);
                _order.Add(key);
            }
        }
    }

    internal static class Program
    {
        private const int MaxTopLevel = 512;

        /// <summary>从 RootElement 第一层子节点（顶级窗口）查找：Name 包含 namePart，可选 ProcessId 精准匹配。双屏/多窗：UIA Root 已包含所有显示器上的窗口。</summary>
        private static AutomationElement FindWindowByName(string namePart, int? filterPid)
        {
            var root = AutomationElement.RootElement;
            var cond = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window);
            var coll = root.FindAll(TreeScope.Children, cond);
            if (coll == null || coll.Count == 0) return null;

            var nameLower = (namePart ?? "").Trim().ToLowerInvariant();
            for (int i = 0; i < Math.Min(coll.Count, MaxTopLevel); i++)
            {
                AutomationElement el = null;
                try
                {
                    el = coll[i];
                    var pid = el.Current.ProcessId;
                    if (filterPid != null && filterPid.Value != 0 && pid != filterPid.Value) continue;
                    var name = el.Current.Name ?? "";
                    if (!string.IsNullOrEmpty(nameLower) && !name.ToLowerInvariant().Contains(nameLower)) continue;
                    return el;
                }
                catch { /* 窗口已关闭等 */ }
            }
            return null;
        }

        /// <summary>先查缓存（IsWindow 有效则直接返回），未命中再 FindWindowByName 并写回缓存。</summary>
        private static AutomationElement FindWindowByNameWithCache(string namePart, int? filterPid, out int hwndOut, out int processIdOut)
        {
            hwndOut = 0;
            processIdOut = 0;
            var key = HandleCache.MakeKey(namePart, filterPid);
            var cached = HandleCache.Get(key);
            if (cached != null)
            {
                hwndOut = cached.Hwnd;
                processIdOut = cached.ProcessId;
                try
                {
                    return AutomationElement.FromHandle(new IntPtr(cached.Hwnd));
                }
                catch { return null; }
            }
            var el = FindWindowByName(namePart, filterPid);
            if (el == null) return null;
            try
            {
                var h = el.Current.NativeWindowHandle;
                hwndOut = (int)h;
                processIdOut = el.Current.ProcessId;
                HandleCache.Set(key, hwndOut, el.Current.Name ?? "", processIdOut);
                return el;
            }
            catch { return el; }
        }

        private const int MaxDepth = 25;

        private static AutomationElement FindElementInScope(AutomationElement scope, string elementName, int depth = 0)
        {
            if (scope == null || string.IsNullOrEmpty(elementName?.Trim()) || depth >= MaxDepth) return null;
            var elLower = elementName.Trim().ToLowerInvariant();
            var walker = new TreeWalker(Condition.TrueCondition);
            var node = walker.GetFirstChild(scope);
            while (node != null)
            {
                try
                {
                    if (!node.Current.IsOffscreen && node.Current.IsEnabled)
                    {
                        var name = node.Current.Name ?? "";
                        if (name.ToLowerInvariant().Contains(elLower)) return node;
                    }
                    var inner = FindElementInScope(node, elementName, depth + 1);
                    if (inner != null) return inner;
                }
                catch { }
                node = walker.GetNextSibling(node);
            }
            return null;
        }

        /// <summary>强力置顶：ShowWindow(SW_RESTORE) + SetForegroundWindow。</summary>
        private static void EnsureWindowFocused(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return;
            Win32.BringToFront(hwnd);
        }

        private static void EnsureWindowFocused(AutomationElement window)
        {
            if (window == null) return;
            try
            {
                var wp = window.GetCurrentPattern(WindowPattern.Pattern) as WindowPattern;
                if (wp != null && wp.Current.WindowVisualState == WindowVisualState.Minimized)
                    wp.SetWindowVisualState(WindowVisualState.Normal);
            }
            catch { }
            try
            {
                var hwnd = new IntPtr(window.Current.NativeWindowHandle);
                EnsureWindowFocused(hwnd);
            }
            catch { }
        }

        private static bool TryInvoke(AutomationElement el)
        {
            try
            {
                var inv = el.GetCurrentPattern(InvokePattern.Pattern) as InvokePattern;
                if (inv != null) { inv.Invoke(); return true; }
            }
            catch { }
            return false;
        }

        private static void ClickElement(AutomationElement el)
        {
            if (TryInvoke(el)) return;
            try
            {
                var rect = el.Current.BoundingRectangle;
                if (rect.Width > 0 && rect.Height > 0)
                {
                    int cx = (int)(rect.X + rect.Width / 2);
                    int cy = (int)(rect.Y + rect.Height / 2);
                    Win32.MouseClickAbsolute(cx, cy);
                }
            }
            catch { }
        }

        private static bool SetValue(AutomationElement el, string value)
        {
            try
            {
                var vp = el.GetCurrentPattern(ValuePattern.Pattern) as ValuePattern;
                if (vp != null) { vp.SetValue(value); return true; }
            }
            catch { }
            return false;
        }

        private static void SetFocusAndValue(AutomationElement el, string value)
        {
            try { el.SetFocus(); } catch { }
            if (SetValue(el, value)) return;
        }

        /// <summary>解析 target 为 "窗口|元素"；解析可选 /pid:12345。</summary>
        private static void ParseTarget(string target, string[] args, out string windowName, out string elementName, out int? pid)
        {
            windowName = "";
            elementName = (target ?? "").Trim();
            pid = null;
            int pipe = elementName.IndexOf('|');
            if (pipe >= 0)
            {
                windowName = elementName.Substring(0, pipe).Trim();
                elementName = elementName.Substring(pipe + 1).Trim();
            }
            for (int i = 0; i < (args?.Length ?? 0); i++)
            {
                if (args[i] != null && args[i].StartsWith("/pid:", StringComparison.OrdinalIgnoreCase))
                {
                    if (int.TryParse(args[i].Substring(5).Trim(), out int p)) pid = p;
                    break;
                }
            }
        }

        private static int Main(string[] args)
        {
            if (args == null || args.Length < 2)
            {
                Console.Error.WriteLine("Usage: UiaSniper.exe <action> <target> [extra] [/pid:processId]");
                Console.Error.WriteLine("  action: click | text | scroll");
                Console.Error.WriteLine("  target: \"WindowTitle|ElementName\" or \"ElementName\"");
                Console.Error.WriteLine("  /pid:N  optional, pin to process ID (multi-window/multi-screen)");
                return 1;
            }
            var action = (args[0] ?? "").Trim().ToLowerInvariant();
            var target = args.Length > 1 ? args[1] : "";
            var extra = args.Length > 2 ? args[2] : "";
            ParseTarget(target, args, out string windowName, out string elementName, out int? filterPid);

            AutomationElement window = null;
            int hwndVal = 0;
            int processIdVal = 0;

            if (!string.IsNullOrEmpty(windowName))
            {
                window = FindWindowByNameWithCache(windowName, filterPid, out hwndVal, out processIdVal);
                if (window == null)
                {
                    Console.Error.WriteLine("Window not found: " + windowName);
                    return 2;
                }
                EnsureWindowFocused(window);
                System.Threading.Thread.Sleep(80);
            }
            else
            {
                window = AutomationElement.FocusedElement;
                while (window != null)
                {
                    try
                    {
                        if (window.Current.ControlType.ProgrammaticName.Contains("Window")) break;
                    }
                    catch { }
                    try { window = TreeWalker.RawViewWalker.GetParent(window); } catch { window = null; }
                }
                if (window == null) window = AutomationElement.RootElement;
            }

            if (string.IsNullOrEmpty(elementName))
            {
                if (action == "click" && window != null)
                {
                    EnsureWindowFocused(window);
                    Console.WriteLine("ok");
                    return 0;
                }
                Console.Error.WriteLine("Element name required");
                return 3;
            }

            var element = FindElementInScope(window, elementName, 0);
            if (element == null)
            {
                Console.Error.WriteLine("Element not found: " + elementName);
                return 4;
            }

            switch (action)
            {
                case "click":
                    EnsureWindowFocused(window);
                    System.Threading.Thread.Sleep(30);
                    ClickElement(element);
                    break;
                case "text":
                    EnsureWindowFocused(window);
                    System.Threading.Thread.Sleep(30);
                    SetFocusAndValue(element, extra);
                    break;
                case "scroll":
                    try
                    {
                        var sp = element.GetCurrentPattern(ScrollPattern.Pattern) as ScrollPattern;
                        if (sp != null)
                        {
                            var dir = (extra ?? "down").Trim().ToLowerInvariant();
                            if (dir == "down" || dir == "right") sp.Scroll(ScrollAmount.LargeIncrement);
                            else if (dir == "up" || dir == "left") sp.Scroll(ScrollAmount.LargeDecrement);
                        }
                    }
                    catch { }
                    break;
                default:
                    Console.Error.WriteLine("Unknown action: " + action);
                    return 5;
            }
            Console.WriteLine("ok");
            return 0;
        }
    }
}
```

---

## 四、草案要点对照

| 要求 | 实现方式 |
|------|----------|
| 搜索起点改为 RootElement | **FindWindowByName** 与 **FindWindowByNameWithCache** 均从 **AutomationElement.RootElement** 出发，**FindAll(TreeScope.Children, ControlType.Window)** 仅第一层；未使用 Process 或 MainWindowHandle 做入口 |
| findWindowByName(name, pid?) | **FindWindowByName(namePart, filterPid)**：遍历 Root 第一层 Window，按 **Name** 包含 namePart 且（若 **filterPid** 非空）**ProcessId == filterPid** 返回；**FindWindowByNameWithCache** 在此基础上加缓存与 IsWindow 校验 |
| 句柄缓存 | **HandleCache**：**Dictionary&lt;string, CacheEntry&gt;**，key = **MakeKey(name, pid)**（"name" 或 "name|pid"），value = **Hwnd, Name, ProcessId**；**Get** 时 **IsWindow** 无效则删除；**Set** 时 FIFO 淘汰保持 **MaxSize=64** |
| 双屏/多窗口 | UIA 的 **RootElement** 已包含所有显示器上的顶级窗口，无需额外 API；遍历第一层即可“扫描所有显示器” |
| SetForegroundWindow + ShowWindow(SW_RESTORE) | **Win32.BringToFront(IntPtr)** 内先 **ShowWindow(hwnd, SW_RESTORE)**，再 **SetWindowPos(..., HWND_TOP)**，再 **SetForegroundWindow(hwnd)**；**EnsureWindowFocused(AutomationElement)** 仍保留 **WindowPattern.SetWindowVisualState(Normal)** 后调用 **EnsureWindowFocused(hwnd)** |

按此草案替换/扩展现有 **UiaSniper.cs** 后，即可从“单程序插件”升级为以 Root 为起点的系统级 UIA 执行器，并与 Node 层已有的 **findWindowByName + 句柄缓存 + bringWindowToFront** 语义对齐；无需在本阶段编译或生成 exe。
