/* ============================================================
 * OpenCode 用量桌面小窗口 — preload 脚本
 * 职责：在 contextIsolation 开启时，通过 contextBridge 把最小化
 *       的 IPC 面暴露给渲染进程（window.widget）。
 * 约束：sandbox preload 只支持 CommonJS，且 package.json
 *       "type": "module"，因此必须使用 .cjs 扩展名。
 * ============================================================ */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("widget", {
  // One-way push from main (poll results). Returns an unsubscribe fn.
  onUpdate(callback) {
    const handler = (_event, summary) => callback(summary);
    ipcRenderer.on("usage:update", handler);
    return () => ipcRenderer.removeListener("usage:update", handler);
  },

  // Request/response
  getInitial: () => ipcRenderer.invoke("usage:initial"),
  refresh: () => ipcRenderer.invoke("usage:refresh"),

  // Fire-and-forget commands
  close: () => ipcRenderer.send("widget:close"),
  ready: (summary) => ipcRenderer.send("widget:ready", summary),

  // Go usage — quota push & initial fetch
  onQuotaUpdate(callback) {
    const handler = (_event, quota) => callback(quota);
    ipcRenderer.on("quota:update", handler);
    return () => ipcRenderer.removeListener("quota:update", handler);
  },

  getQuotaInitial: () => ipcRenderer.invoke("quota:initial"),

  // Go local usage — push (piggybacked on the 5min quota poll / manual
  // refresh) & lazy initial fetch (invoked when the Go tab is first opened)
  onGoLocalUpdate(callback) {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("go-local:update", handler);
    return () => ipcRenderer.removeListener("go-local:update", handler);
  },

  getGoLocalInitial: () => ipcRenderer.invoke("go:local:initial"),
});
