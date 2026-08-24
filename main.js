/**
 * pi-desktop-app — 主进程
 *
 * 职责：
 *  1. 创建现代化桌面窗口（Electron）
 *  2. spawn `pi --mode rpc` 子进程，桥接 JSONL 协议
 *  3. 命令关联（id → Promise）、事件广播、扩展 UI 请求分发
 *  4. 会话目录扫描 / 桌面通知 / 冒烟测试模式
 */

const { app, BrowserWindow, ipcMain, Menu, Notification, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");
const SMOKE = process.env.PI_DESKTOP_SMOKE === "1";

let win = null;
let pi = null;
let buf = "";
let restartTimer = null;
const pending = new Map(); // cmd id -> {resolve, reject}
const pendingUi = new Map(); // ui request id -> timeout handle

// ---------------------------------------------------------------------------
// pi RPC 子进程
// ---------------------------------------------------------------------------

function writePi(obj) {
  if (!pi || pi.exitCode !== null || pi.killed) return false;
  pi.stdin.write(JSON.stringify(obj) + "\n");
  return true;
}

function sendToRenderer(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function spawnPi() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  buf = "";
  pi = spawn("pi", ["--mode", "rpc"], {
    cwd: os.homedir(),
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  pi.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        handleMessage(JSON.parse(line));
      } catch (e) {
        console.error("[pi-desktop] bad JSON line:", e.message);
      }
    }
  });

  pi.stderr.on("data", (d) => {
    const s = d.toString();
    sendToRenderer("rpc:log", s);
    if (SMOKE) console.log("SMOKE stderr:", s.trim());
  });
  pi.on("spawn", () => {
    if (SMOKE) console.log("SMOKE: pi spawned pid=" + pi.pid);
  });
  pi.on("error", (err) => {
    console.error("[pi-desktop] spawn error:", err.message);
    if (SMOKE) {
      console.log("SMOKE: spawn FAIL — " + err.message);
      app.exit(3);
    }
  });
  pi.stdin.on("error", () => {});

  pi.on("exit", (code, signal) => {
    for (const [, r] of pending) r.reject(new Error("pi 进程已退出"));
    pending.clear();
    sendToRenderer("rpc:status", { online: false, code, signal });
    if (SMOKE) {
      console.log("SMOKE: pi exited code=", code, "signal=", signal);
      app.exit(0);
      return;
    }
    // 自动重启（窗口仍打开时）
    if (win && !win.isDestroyed()) {
      restartTimer = setTimeout(() => {
        sendToRenderer("rpc:status", { online: false, restarting: true });
        spawnPi();
      }, 1200);
    }
  });

  sendToRenderer("rpc:status", { online: true });
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "response") {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.success ? p.resolve(msg) : p.reject(new Error(msg.error || "RPC 命令失败"));
    }
    return;
  }

  if (msg.type === "extension_ui_request") {
    handleUiRequest(msg);
    return;
  }

  // 其它全部是事件，原样转发
  sendToRenderer("rpc:event", msg);
}

// ---------------------------------------------------------------------------
// 扩展 UI 请求（RPC 模式下扩展的 ctx.ui.* 会变成这些请求）
// ---------------------------------------------------------------------------

const DIALOG_METHODS = ["select", "confirm", "input", "editor"];

function handleUiRequest(req) {
  if (DIALOG_METHODS.includes(req.method) && req.timeout) {
    const t = setTimeout(() => {
      if (pendingUi.has(req.id)) {
        pendingUi.delete(req.id);
        writePi({ type: "extension_ui_response", id: req.id, cancelled: true });
      }
    }, req.timeout);
    pendingUi.set(req.id, t);
  }

  if (req.method === "notify" && Notification.isSupported()) {
    try {
      new Notification({
        title: "pi",
        body: req.message || "",
        silent: req.notifyType === "info",
      }).show();
    } catch {
      /* ignore */
    }
  }

  sendToRenderer("rpc:ui-request", req);
}

function respondUi(id, payload) {
  const t = pendingUi.get(id);
  if (t) {
    clearTimeout(t);
    pendingUi.delete(id);
  }
  writePi({ type: "extension_ui_response", id, ...payload });
}

// ---------------------------------------------------------------------------
// 会话目录扫描
// ---------------------------------------------------------------------------

function listSessions() {
  const out = [];
  if (!fs.existsSync(SESSIONS_DIR)) return out;
  for (const dir of fs.readdirSync(SESSIONS_DIR)) {
    const dpath = path.join(SESSIONS_DIR, dir);
    let st;
    try {
      st = fs.statSync(dpath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dpath)) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(dpath, f);
      let name = "";
      let created = 0;
      try {
        const first = fs.readFileSync(fp, "utf8").split("\n")[0];
        const h = JSON.parse(first);
        name = h.name || "";
        created = h.timestamp || 0;
      } catch {
        /* header 不完整也没关系 */
      }
      let mtime = 0;
      try {
        mtime = fs.statSync(fp).mtimeMs;
      } catch {
        continue;
      }
      out.push({
        file: fp,
        label: dir.replace(/^--/, "").replace(/--$/, "").replace(/--/g, "/"),
        name,
        mtime,
        created,
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 60);
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: "#0a0d14",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    console.log("[pi-desktop] window closed");
    win = null;
  });
  win.webContents.on("render-process-gone", (_e, d) => {
    console.log("[pi-desktop] renderer gone:", JSON.stringify(d));
  });
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    console.log("[pi-desktop] did-fail-load:", code, desc);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "窗口",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function setupIpc() {
  ipcMain.handle("rpc:cmd", (_e, obj) => {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pending.set(id, { resolve, reject });
      if (!writePi({ id, ...obj })) {
        pending.delete(id);
        reject(new Error("pi 进程未运行"));
      }
    });
  });

  ipcMain.on("rpc:ui-response", (_e, payload) => {
    respondUi(payload.id, payload);
  });

  ipcMain.handle("sessions:list", () => listSessions());
  ipcMain.on("sessions:open", () => {
    shell.openPath(SESSIONS_DIR);
  });

  ipcMain.handle("rpc:restart", () => {
    if (pi) pi.kill("SIGTERM");
    return true;
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

// 单实例锁：重复点击图标时聚焦已有窗口，而不是再开一个实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
  buildMenu();
  setupIpc();

  if (SMOKE) {
    // 冒烟测试：不起窗口，验证 pi RPC 链路
    console.log("SMOKE: starting pi RPC...");
    spawnPi();
    let sent = false;
    const check = setInterval(() => {
      if (sent || !pi || pi.exitCode !== null) return;
      sent = true;
      const fire = (id, obj) => {
        pending.set(id, {
          resolve: (msg) => {
            console.log(`SMOKE: ${id} → success=${msg.success}`, JSON.stringify(msg.data).slice(0, 200));
          },
          reject: (err) => console.log(`SMOKE: ${id} → FAIL: ${err.message}`),
        });
        writePi({ id, ...obj });
      };
      fire("smoke-1", { type: "get_state" });
      fire("smoke-2", { type: "get_session_stats" });
      fire("smoke-3", { type: "get_available_models" });
    }, 2000);

    const finish = setTimeout(() => {
      console.log("SMOKE: FAIL — 超时未收到响应");
      app.exit(2);
    }, 60000);

    ipcMain.on("rpc:event", () => {});
    // 三个响应都收到后完成
    let done = 0;
    const countDone = () => {
      done++;
      if (done >= 3) {
        clearTimeout(finish);
        console.log("SMOKE: OK");
        pi.kill("SIGTERM");
      }
    };
    const origSet2 = pending.set.bind(pending);
    pending.set = (id, r) => {
      origSet2(id, {
        resolve: (msg) => {
          console.log(`SMOKE: ${id} → success=${msg.success}`, JSON.stringify(msg.data).slice(0, 200));
          r.resolve(msg);
          countDone();
        },
        reject: (err) => {
          console.log(`SMOKE: ${id} → FAIL: ${err.message}`);
          r.reject(err);
          countDone();
        },
      });
      return this;
    };
    return;
  }

  createWindow();
  spawnPi();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (pi) pi.kill("SIGTERM");
  if (process.platform !== "darwin") app.quit();
});
