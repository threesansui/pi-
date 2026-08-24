/**
 * 启动器 — 在拉起 Electron 前做自检：
 *
 * 历史 bug：node_modules/electron/path.txt 末尾多了一个换行符，
 * 导致 Electron CLI 误判二进制缺失 → 尝试从 GitHub 重新下载 → 网络阻塞，应用永远打不开。
 * 此脚本会先修复 path.txt，再直接校验并启动 Electron 二进制，绝不触发下载。
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const electronDir = path.join(root, "node_modules", "electron");

// 1) 自愈 path.txt：去掉尾部换行/空白（root cause fix，防止复发）
const pathFile = path.join(electronDir, "path.txt");
if (fs.existsSync(pathFile)) {
  const raw = fs.readFileSync(pathFile, "utf8");
  const fixed = raw.replace(/[\r\n\s]+$/, "");
  if (raw !== fixed) {
    fs.writeFileSync(pathFile, fixed);
    console.log("[launch] 已修复 electron/path.txt 的尾部换行");
  }
}

// 2) 定位 Electron 可执行文件（macOS 按 path.txt 内容；其它平台回退 require）
function electronBinary() {
  if (process.platform === "darwin" && fs.existsSync(pathFile)) {
    const rel = fs.readFileSync(pathFile, "utf8").trim();
    const bin = path.join(electronDir, "dist", rel);
    if (fs.existsSync(bin)) return bin;
  }
  try {
    return require("electron"); // 仅当上面失败时回退
  } catch (e) {
    console.error("[launch] 无法解析 Electron 二进制:", e.message);
    return null;
  }
}

const bin = electronBinary();
if (!bin) {
  console.error("");
  console.error("[launch] Electron 未正确安装。请手动执行：");
  console.error("  cd ~/pi-desktop-app");
  console.error("  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install");
  console.error("");
  process.exit(1);
}

// 3) 启动 Electron（透传额外参数，如 --remote-debugging-port=9222）
const child = spawn(bin, [root, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env },
});

child.on("error", (err) => {
  console.error("[launch] Electron 启动失败:", err.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
