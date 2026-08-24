/**
 * pi-desktop-app — preload
 * 通过 contextBridge 暴露安全的渲染进程 API。
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("piDesktop", {
  /** 发送 RPC 命令，返回 Promise<response> */
  cmd: (obj) => ipcRenderer.invoke("rpc:cmd", obj),

  /** pi 事件流（JSONL 消息） */
  onEvent: (cb) => ipcRenderer.on("rpc:event", (_e, data) => cb(data)),

  /** pi 进程在线状态 */
  onStatus: (cb) => ipcRenderer.on("rpc:status", (_e, data) => cb(data)),

  /** 扩展 UI 请求（select/confirm/input/editor/notify/...） */
  onUiRequest: (cb) => ipcRenderer.on("rpc:ui-request", (_e, data) => cb(data)),

  /** stderr 日志 */
  onLog: (cb) => ipcRenderer.on("rpc:log", (_e, data) => cb(data)),

  /** 回复扩展 UI 对话框请求 */
  uiResponse: (id, payload) => ipcRenderer.send("rpc:ui-response", { id, ...payload }),

  /** 会话列表 */
  listSessions: () => ipcRenderer.invoke("sessions:list"),

  /** 在 Finder 打开会话目录 */
  openSessionsFolder: () => ipcRenderer.send("sessions:open"),

  /** 重启 pi 子进程 */
  restartPi: () => ipcRenderer.invoke("rpc:restart"),
});
