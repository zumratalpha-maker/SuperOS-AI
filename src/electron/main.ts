/**
 * SuperOS Electron 主进程
 * 系统托盘常驻 + Alt+Space 全局唤醒 + Spotlight 风格输入框
 */

import { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, screen } from "electron";
import { join } from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

const IS_DEV = !app.isPackaged;
const RENDERER_DIR = join(__dirname, "renderer");

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let dashboardProcess: ChildProcess | null = null;

function createMainWindow(): BrowserWindow {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width: 560,
    height: 420,
    x: Math.round((screenW - 560) / 2),
    y: Math.round(screenH * 0.2),
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(join(RENDERER_DIR, "spotlight.html"));

  win.on("blur", () => {
    if (win && !win.isDestroyed()) win.hide();
  });

  return win;
}

function toggleSpotlight(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  }

  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    mainWindow.setPosition(Math.round((screenW - 560) / 2), Math.round(screenH * 0.2));
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("focus-input");
  }
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAdRJREFUWEftlk1Kw0AYhp+ZQm0X7qwewa0nEPEEupO6deEBvIV7l65FPIBeBDeiq4o/GHFR8AVJmGYyM0mm/RbJZL55v+f7ZhKhwU9oML//BShWgPcGP0rqtFJhKZaSylLSqBk5Mgt8B07T4xn/eQVIU8EXKz+t0V++pHV2oi1AMQJqA0Bx38JEI8CiKLpXQvwEjqbPGX7Pwii8UdBCHANLtbEzcQB8A3clFN5hEPAZgk2aGIMAHvGWAOMCfAAWEqB64AW4CzwQz3g28BJ4D3d5n3gdYJ7k9gIwJlkKDBTqRjfAuPaALu5I2vAi5RGXAHOwTCW+k82Rh/AS8CQ/5+Z3V1mAY5dABuBh/SPh+AXuByauAd4CBv5RJUBtwGXP8G0zIr5F8EhwFwE3m1WuCX85NJqCfhHuFv6+ek05AFLEVi/4EvwDL2qiGb4FcDByPAdNyhQ3LHXAAY3gMOa5O0a0AdeA8Zch5iagLuAB3Q1f6d+p/OQKPAM9KQVyaqqwj+OYp9lXV5VHwFLfJVbAI3AZeOyKX1MCzOmL8oWBDsCKzxb7fwfIL2ACeJR+jMqGwST9GA0/dZ6Dxh2g5Q/nCr0P8ARR/z5UWTLd8AAAAASUVORK5CYII="
  );

  tray = new Tray(icon);
  tray.setToolTip("SuperOS 智能体");

  const contextMenu = Menu.buildFromTemplate([
    { label: "打开指令栏 (Alt+Space)", click: toggleSpotlight },
    { label: "控制面板", click: openDashboard },
    { type: "separator" },
    { label: "退出", click: () => { cleanup(); app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("click", toggleSpotlight);
}

function openDashboard(): void {
  const dashWin = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "SuperOS 控制面板",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  dashWin.loadURL("http://localhost:3200");
}

function startDashboardServer(): void {
  try {
    const serverPath = join(__dirname, "..", "dashboard", "api.js");
    dashboardProcess = fork(serverPath, [], { stdio: "pipe" });
    dashboardProcess.on("error", (e) => console.error("[electron] Dashboard 启动失败:", e.message));
  } catch (e) {
    console.warn("[electron] Dashboard 进程启动异常:", (e as Error).message);
  }
}

function cleanup(): void {
  globalShortcut.unregisterAll();
  if (dashboardProcess) dashboardProcess.kill();
}

// ─── Jarvis 后端进程 ───

let jarvisProcess: ChildProcess | null = null;
let jarvisResolvers: Map<string, (v: unknown) => void> = new Map();

function startJarvisBackend(): void {
  const backendPath = join(__dirname, "..", "electron", "jarvis-backend.js");
  const tsxPath = join(__dirname, "..", "..", "src", "electron", "jarvis-backend.ts");

  if (existsSync(backendPath)) {
    jarvisProcess = fork(backendPath, [], { stdio: "pipe" });
  } else {
    jarvisProcess = fork(tsxPath, [], { stdio: "pipe", execArgv: ["--import", "tsx"] });
  }

  jarvisProcess.on("message", (msg: unknown) => {
    const m = msg as { id?: string; result?: unknown };
    if (m.id && jarvisResolvers.has(m.id)) {
      jarvisResolvers.get(m.id)!(m.result);
      jarvisResolvers.delete(m.id);
    }
  });

  jarvisProcess.on("error", (e) => console.error("[electron] Jarvis backend error:", e.message));
  jarvisProcess.on("exit", (code) => console.warn("[electron] Jarvis backend exited:", code));
}

function sendToJarvis(command: string): Promise<unknown> {
  return new Promise((resolve) => {
    const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    jarvisResolvers.set(id, resolve);
    if (jarvisProcess?.connected) {
      jarvisProcess.send({ id, command });
    } else {
      resolve({ ok: false, error: "Jarvis 后端未连接" });
      jarvisResolvers.delete(id);
    }
    setTimeout(() => {
      if (jarvisResolvers.has(id)) {
        resolve({ ok: false, error: "超时" });
        jarvisResolvers.delete(id);
      }
    }, 30000);
  });
}

// ─── IPC 处理 ───

ipcMain.handle("dispatch-command", async (_event, command: string) => {
  return sendToJarvis(command);
});

ipcMain.handle("open-dashboard", () => {
  openDashboard();
});

ipcMain.handle("resize-window", (_event, height: number) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const [w] = mainWindow.getSize();
    mainWindow.setSize(w, Math.max(200, Math.min(height, 580)));
  }
});

// ─── 应用生命周期 ───

app.whenReady().then(() => {
  createTray();
  mainWindow = createMainWindow();
  startDashboardServer();
  startJarvisBackend();

  globalShortcut.register("Alt+Space", toggleSpotlight);

  console.log("[SuperOS] Electron 已启动，Alt+Space 唤醒指令栏");
});

app.on("will-quit", cleanup);
app.on("window-all-closed", () => { /* 不退出，保持托盘运行 */ });
