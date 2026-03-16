/*
 * 全域上帝视角 - 系统级 UIA 执行器
 * 搜索起点：AutomationElement.RootElement；句柄缓存 + PID 精准匹配；无 FocusedElement 附着。
 * 成功执行后 stdout 输出一行 HWND: XXXXX，供 Node.js 接收。
 *
 * 编译: build.bat 或 csc /reference:UIAutomationClient.dll /reference:UIAutomationTypes.dll /reference:WindowsBase.dll /reference:System.Windows.Forms.dll UiaSniper.cs
 * 用法: UiaSniper.exe click "微信|发送"
 *       UiaSniper.exe click "记事本|保存" /pid:12345
 *       UiaSniper.exe text "记事本|编辑" "内容"
 */

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Windows.Automation;
using System.Windows.Forms;

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
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private static readonly IntPtr HWND_TOP = new IntPtr(0);

        public static void BringToFront(IntPtr hwnd)
        {
            ShowWindow(hwnd, SW_RESTORE);
            SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            SetForegroundWindow(hwnd);
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public int type;
            public MOUSEKEYBDHARDWAREINPUT mi;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct MOUSEKEYBDHARDWAREINPUT
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public int mouseData;
            public int dwFlags;
            public int time;
            public IntPtr dwExtraInfo;
        }

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

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X, Y;
        }

        public static void MouseClickAbsolute(int x, int y)
        {
            int screenW = GetSystemMetrics(SM_CXSCREEN);
            int screenH = GetSystemMetrics(SM_CYSCREEN);
            int nx = (int)((x * 65535.0) / screenW);
            int ny = (int)((y * 65535.0) / screenH);
            var inputs = new INPUT[]
            {
                new INPUT { type = INPUT_MOUSE, mi = new MOUSEKEYBDHARDWAREINPUT { mi = new MOUSEINPUT { dx = nx, dy = ny, dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE } } },
                new INPUT { type = INPUT_MOUSE, mi = new MOUSEKEYBDHARDWAREINPUT { mi = new MOUSEINPUT { dx = 0, dy = 0, dwFlags = MOUSEEVENTF_LEFTDOWN } } },
                new INPUT { type = INPUT_MOUSE, mi = new MOUSEKEYBDHARDWAREINPUT { mi = new MOUSEINPUT { dx = 0, dy = 0, dwFlags = MOUSEEVENTF_LEFTUP } } }
            };
            SendInput(3, inputs, Marshal.SizeOf<INPUT>());
        }
    }

    internal sealed class CacheEntry
    {
        public int Hwnd { get; set; }
        public string Name { get; set; }
        public int ProcessId { get; set; }
    }

    internal static class HandleCache
    {
        private const int MaxSize = 64;
        private static readonly Dictionary<string, CacheEntry> _cache = new Dictionary<string, CacheEntry>();
        private static readonly List<string> _order = new List<string>();

        public static string MakeKey(string name, int? pid)
        {
            var n = (name ?? "").Trim().ToLowerInvariant();
            return (pid != null && pid.Value > 0) ? (n + "|" + pid.Value) : n;
        }

        public static CacheEntry Get(string key)
        {
            if (string.IsNullOrEmpty(key)) return null;
            lock (_cache)
            {
                CacheEntry entry;
                if (!_cache.TryGetValue(key, out entry)) return null;
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
        private const int MAX_TOP_LEVEL = 512;
        private const int MAX_DEPTH = 25;

        /// <summary>窗口名中/英文别名，便于 find "记事本" 在英文系统上匹配 "Notepad"。</summary>
        private static readonly string[][] WindowNameAliases = new[]
        {
            new[] { "记事本", "Notepad" },
            new[] { "计算器", "Calculator" },
            new[] { "画图", "Paint", "Mspaint" },
        };

        private static bool TryFindWindowByNames(string[] namesToTry, int? filterPid, out AutomationElement window, out int hwndVal, out int processIdOut)
        {
            window = null;
            hwndVal = 0;
            processIdOut = 0;
            foreach (var name in namesToTry)
            {
                int hwnd, pid;
                var el = FindWindowByNameWithCache(name, filterPid, out hwnd, out pid);
                if (el != null && hwnd != 0)
                {
                    window = el;
                    hwndVal = hwnd;
                    processIdOut = pid;
                    return true;
                }
            }
            return false;
        }

        /// <summary>从 Root 第一层子节点查找：Name 包含 namePart，可选 ProcessId 精准匹配。</summary>
        private static AutomationElement FindWindowByName(string namePart, int? filterPid)
        {
            var root = AutomationElement.RootElement;
            var cond = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window);
            var coll = root.FindAll(TreeScope.Children, cond);
            if (coll == null || coll.Count == 0) return null;
            var nameLower = (namePart ?? "").Trim().ToLowerInvariant();
            for (int i = 0; i < Math.Min(coll.Count, MAX_TOP_LEVEL); i++)
            {
                try
                {
                    var el = coll[i];
                    var pid = el.Current.ProcessId;
                    if (filterPid != null && filterPid.Value != 0 && pid != filterPid.Value) continue;
                    var name = el.Current.Name ?? "";
                    if (!string.IsNullOrEmpty(nameLower) && !name.ToLowerInvariant().Contains(nameLower)) continue;
                    return el;
                }
                catch { }
            }
            return null;
        }

        /// <summary>先查缓存（IsWindow 有效则用缓存），否则 FindWindowByName 并写回缓存。返回窗口元素与 hwnd（out）。</summary>
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

        private static AutomationElement FindElementInScope(AutomationElement scope, string elementName, int depth = 0)
        {
            if (scope == null || elementName == null || string.IsNullOrEmpty(elementName.Trim()) || depth >= MAX_DEPTH) return null;
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
                EnsureWindowFocused(new IntPtr(window.Current.NativeWindowHandle));
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

        /// <summary>读取控件的 AcceleratorKeyProperty 或 AccessKey，返回 UIA 格式如 "Ctrl+S"、"Alt+F"。</summary>
        private static string GetAcceleratorOrAccessKey(AutomationElement el)
        {
            if (el == null) return null;
            try
            {
                var acc = el.GetCurrentPropertyValue(AutomationElement.AcceleratorKeyProperty);
                var s = acc as string;
                if (!string.IsNullOrWhiteSpace(s)) return s.Trim();
                acc = el.GetCurrentPropertyValue(AutomationElement.AccessKeyProperty);
                s = acc as string;
                if (!string.IsNullOrWhiteSpace(s)) return s.Trim();
            }
            catch { }
            return null;
        }

        /// <summary>将 UIA 格式快捷键转为 SendKeys 格式：Ctrl+S -> ^s, Alt+F -> %f。</summary>
        private static string ConvertAcceleratorToSendKeys(string accelerator)
        {
            if (string.IsNullOrWhiteSpace(accelerator)) return null;
            var parts = Regex.Split(accelerator.Trim(), @"\s+");
            var mods = new List<char>();
            string key = null;
            foreach (var p in parts)
            {
                if (p.Equals("Ctrl", StringComparison.OrdinalIgnoreCase)) mods.Add('^');
                else if (p.Equals("Alt", StringComparison.OrdinalIgnoreCase)) mods.Add('%');
                else if (p.Equals("Shift", StringComparison.OrdinalIgnoreCase)) mods.Add('+');
                else if (p.Equals("Win", StringComparison.OrdinalIgnoreCase)) mods.Add('~');
                else if (!string.IsNullOrEmpty(p)) key = p;
            }
            if (string.IsNullOrEmpty(key)) return null;
            key = key.ToLowerInvariant();
            if (key.Length == 1) key = "{" + key + "}";
            else key = "{" + key + "}";
            return string.Concat(mods) + key;
        }

        private static void SendAcceleratorKeys(string sendKeysFormat)
        {
            if (string.IsNullOrWhiteSpace(sendKeysFormat)) return;
            try { SendKeys.SendWait(sendKeysFormat); } catch { }
        }

        private static void ClickElement(AutomationElement el)
        {
            if (TryInvoke(el)) return;
            var acc = GetAcceleratorOrAccessKey(el);
            if (!string.IsNullOrWhiteSpace(acc))
            {
                var sk = ConvertAcceleratorToSendKeys(acc);
                if (!string.IsNullOrWhiteSpace(sk)) { SendAcceleratorKeys(sk); return; }
            }
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

        /// <summary>解析 target 为 "窗口|元素"；从 args 解析可选 /pid:N。</summary>
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
            if (args != null)
            {
                for (int i = 0; i < args.Length; i++)
                {
                    if (args[i] != null && args[i].StartsWith("/pid:", StringComparison.OrdinalIgnoreCase))
                    {
                        int p;
                        if (int.TryParse(args[i].Substring(5).Trim(), out p)) pid = p;
                        break;
                    }
                }
            }
        }

        private static int Main(string[] args)
        {
            if (args == null || args.Length < 2)
            {
                Console.Error.WriteLine("Usage: UiaSniper.exe <action> <target> [extra] [/pid:N]");
                Console.Error.WriteLine("  action: find | click | text | scroll");
                Console.Error.WriteLine("  find:   directshell.exe find \"记事本\"  — 仅查窗并输出 HWND");
                Console.Error.WriteLine("  target: \"WindowTitle|ElementName\" (window required for HWND output)");
                Console.Error.WriteLine("  /pid:N  optional, pin to process ID");
                return 1;
            }
            var action = (args[0] ?? "").Trim().ToLowerInvariant();
            var target = args.Length > 1 ? args[1] : "";
            var extra = args.Length > 2 ? args[2] : "";
            string windowName, elementName;
            int? filterPid;
            ParseTarget(target, args, out windowName, out elementName, out filterPid);
            if (action == "find")
            {
                windowName = target.Trim();
                elementName = "";
            }

            AutomationElement window = null;
            int hwndVal = 0;
            int unusedPid;

            if (!string.IsNullOrEmpty(windowName))
            {
                var namesToTry = new List<string> { windowName };
                foreach (var group in WindowNameAliases)
                {
                    if (group != null && Array.IndexOf(group, windowName) >= 0)
                    {
                        foreach (var a in group) if (a != windowName) namesToTry.Add(a);
                        break;
                    }
                }
                if (!TryFindWindowByNames(namesToTry.ToArray(), filterPid, out window, out hwndVal, out unusedPid))
                {
                    Console.Error.WriteLine("Window not found: " + windowName);
                    return 2;
                }
            }
            else
            {
                IntPtr fg = Win32.GetForegroundWindow();
                if (fg == IntPtr.Zero)
                {
                    Console.Error.WriteLine("No foreground window");
                    return 2;
                }
                AutomationElement fgEl = null;
                try { fgEl = AutomationElement.FromHandle(fg); } catch { }
                if (fgEl == null)
                {
                    Console.Error.WriteLine("FromHandle failed for foreground window");
                    return 2;
                }
                string fgName = "";
                int fgPid = 0;
                try { fgName = fgEl.Current.Name ?? ""; fgPid = fgEl.Current.ProcessId; } catch { }
                window = FindWindowByNameWithCache(fgName, fgPid > 0 ? (int?)fgPid : null, out hwndVal, out unusedPid);
                if (window == null) window = fgEl;
                if (hwndVal == 0) hwndVal = (int)fg;
            }
            if (window != null)
            {
                try
                {
                    int pid = window.Current.ProcessId;
                    Console.Error.WriteLine("[UiaSniper] Found hwnd=" + hwndVal + " pid=" + pid + (filterPid != null ? " filterPid=" + filterPid : ""));
                }
                catch { }
            }
            EnsureWindowFocused(window);
            System.Threading.Thread.Sleep(200);

            if (string.IsNullOrEmpty(elementName))
            {
                if (action == "find" && window != null)
                {
                    Console.WriteLine("HWND: " + hwndVal);
                    Console.WriteLine("ok");
                    return 0;
                }
                if (action == "click" && window != null)
                {
                    EnsureWindowFocused(window);
                    Console.WriteLine("HWND: " + hwndVal);
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
                    System.Threading.Thread.Sleep(150);
                    ClickElement(element);
                    break;
                case "text":
                    EnsureWindowFocused(window);
                    System.Threading.Thread.Sleep(150);
                    SetFocusAndValue(element, extra);
                    break;
                case "scroll":
                    try
                    {
                        var sp = element.GetCurrentPattern(ScrollPattern.Pattern) as ScrollPattern;
                        if (sp != null)
                        {
                            var dir = (extra ?? "down").Trim().ToLowerInvariant();
                            ScrollAmount noScroll = (ScrollAmount)0;
                            if (dir == "down") sp.Scroll(noScroll, ScrollAmount.LargeIncrement);
                            else if (dir == "up") sp.Scroll(noScroll, ScrollAmount.LargeDecrement);
                            else if (dir == "right") sp.Scroll(ScrollAmount.LargeIncrement, noScroll);
                            else if (dir == "left") sp.Scroll(ScrollAmount.LargeDecrement, noScroll);
                        }
                    }
                    catch { }
                    break;
                default:
                    Console.Error.WriteLine("Unknown action: " + action);
                    return 5;
            }

            Console.WriteLine("HWND: " + hwndVal);
            Console.WriteLine("ok");
            return 0;
        }
    }
}
