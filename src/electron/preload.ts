/**
 * Electron preload — 向渲染进程暴露安全的 IPC 接口
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("superos", {
  dispatch: (command: string) => ipcRenderer.invoke("dispatch-command", command),
  resizeWindow: (height: number) => ipcRenderer.invoke("resize-window", height),
  onFocusInput: (cb: () => void) => {
    ipcRenderer.on("focus-input", () => cb());
  },
  onProgress: (cb: (step: string, pct: number) => void) => {
    ipcRenderer.on("progress-update", (_e, step: string, pct: number) => cb(step, pct));
  },
  openDashboard: () => ipcRenderer.invoke("open-dashboard"),
});
