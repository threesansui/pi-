# pi-desktop-app — pi 现代化桌面端

一个真正的桌面 GUI 客户端，把 [pi](https://github.com/earendil-dev/pi) 编码代理搬进原生窗口：
暗色渐变主题、毛玻璃顶栏、流式消息、工具调用卡片、上下文用量仪表、会话管理、模型/思考级别切换、桌面通知。

## 架构

```
┌─────────────────────────────────────────────┐
│  Electron 渲染进程 (renderer/)               │
│  现代化 UI · 流式渲染 · 会话/模型/用量仪表   │
└──────────────┬──────────────────────────────┘
               │ IPC (contextBridge)
┌──────────────┴──────────────────────────────┐
│  Electron 主进程 (main.js)                  │
│  窗口 · pi 子进程管理 · JSONL 桥 · UI 请求   │
└──────────────┬──────────────────────────────┘
               │ stdin/stdout (RPC 协议)
┌──────────────┴──────────────────────────────┐
│  pi --mode rpc                              │
│  模型 · 工具 · 扩展 · 会话 · MCP            │
└─────────────────────────────────────────────┘
```

- **通信**：pi 的原生 RPC 模式（JSONL over stdio），主进程做 id 关联与事件广播。
- **扩展联动**：RPC 模式下扩展的 `ctx.ui` 请求（notify / select / confirm / input / editor / setWidget）会以 `extension_ui_request` 到达桌面端 —— 例如 `pi-desktop` 扩展的状态条会显示在输入框上方，`desktop_notify` 会弹出 macOS 系统通知，扩展对话框直接渲染为桌面模态。

## 功能

| 区域 | 功能 |
|---|---|
| 顶栏 | 状态灯（空闲/工作/压缩中）· 模型切换 · 思考级别切换 · 上下文用量仪表（超阈值变色）· 压缩 · 导出 HTML · 中止 |
| 侧边栏 | 新建会话 · 最近会话列表（切换恢复）· pi 引擎状态 · 重启 · 打开会话目录 |
| 主区 | 流式消息（markdown 轻渲染）· 思考块折叠 · 工具调用卡片（参数/输出/状态）· 费用显示 |
| 输入区 | 多行输入（Enter 发送 / Shift+Enter 换行）· 队列提示 |
| 其他 | macOS 桌面通知 · 扩展对话框模态 · pi 崩溃自动重启 |

## 使用

```bash
npm install        # 安装依赖（Electron 二进制若未下载，用镜像：
                   #   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install electron）
npm start          # 启动桌面端
```

启动后无需任何配置：直接使用 `~/.pi/agent` 里现有的模型、会话与扩展。

> 已配置 DeepSeek（deepseek-v4-flash / pro）与本地 Ollama（Qwen2.5VL）等模型。

## 开发

```bash
npm run smoke      # 冒烟测试：不起窗口，验证 pi RPC 链路
node scripts/drive.js "你好" 45   # CDP 驱动：发消息并观察响应（需先启动 --remote-debugging-port）
```

## 文件

```
pi-desktop-app/
├── main.js            # 主进程：窗口 + RPC 桥 + UI 请求 + 会话扫描
├── preload.js         # contextBridge 安全桥
├── renderer/
│   ├── index.html     # 布局骨架
│   ├── styles.css     # 暗色主题
│   └── app.js         # 前端逻辑（状态机/流式渲染/对话框）
├── scripts/drive.js   # CDP 端到端测试驱动
└── docs/              # 截图
```
