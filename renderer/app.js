/**
 * pi-desktop-app — 渲染进程逻辑
 *
 * 与主进程通过 window.piDesktop 桥通信：
 *  - cmd()         发送 RPC 命令（get_state / prompt / abort / ...）
 *  - onEvent()     订阅 pi 事件流（流式消息 / 工具执行 / 状态变化）
 *  - onUiRequest() 处理扩展 UI 对话框（select / confirm / input / editor / notify）
 */

"use strict";

const api = window.piDesktop;

// ---------------------------------------------------------------- 状态

const state = {
  messages: [],        // { role, content, timestamp, usage, streaming, toolCalls: Map }
  streamingMsg: null,  // 正在流式组装中的 assistant 消息
  streamingBuffer: [], // contentIndex -> { text, thinking, toolCallArgs }
  tools: new Map(),    // toolCallId -> { name, args, output, isError, state }
  model: null,
  thinking: null,
  isStreaming: false,
  isCompacting: false,
  contextUsage: null,
  sessions: [],
  currentSessionFile: null,
  commands: [],
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 工具图标

const TOOL_ICONS = {
  bash: "🖥", read: "📄", edit: "✏️", write: "🗒", mcp: "🔌",
  desktop_open: "🖥", desktop_notify: "🔔", web_search: "🌐", source_check: "🔎",
  fetch_content: "📥", get_search_content: "🧲", describe_image: "🖼",
  subagent: "🧩", subagent_wait: "⏳", subagent_supervisor: "🎛",
};
const toolIcon = (name) => TOOL_ICONS[name] || "⚙️";

// ---------------------------------------------------------------- 基础

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function fmtTokens(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------- 轻量 markdown

function renderMarkdown(src) {
  if (!src) return "";
  let html = escapeHtml(src);

  // 代码块（先保护）
  const codeBlocks = [];
  html = html.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${code}</code></pre>`);
    return `\u0000CB${idx}\u0000`;
  });

  // 行内代码
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // 行处理
  const lines = html.split("\n");
  const out = [];
  let listType = null;
  let inTable = false;

  const flushList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === "") { flushList(); inTable = false; out.push(""); continue; }

    const cb = line.match(/^\u0000CB(\d+)\u0000$/);
    if (cb) { flushList(); out.push(codeBlocks[Number(cb[1])]); continue; }

    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushList();
      const h = m[1].length;
      out.push(`<h${h}>${m[2]}</h${h}>`);
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      if (listType !== "ul") { flushList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${m[1]}</li>`);
    } else if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      if (listType !== "ol") { flushList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${m[1]}</li>`);
    } else if ((m = line.match(/^&gt;\s?(.*)$/))) {
      flushList();
      out.push(`<blockquote>${m[1]}</blockquote>`);
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      flushList();
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (/^:?-{2,}:?$/.test(cells[0])) continue; // 分隔行
      out.push(`<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`);
      if (!inTable) { out.splice(out.length - 1, 0, "<table><thead></thead><tbody>"); inTable = true; }
    } else {
      flushList();
      if (inTable) { out.push("</tbody></table>"); inTable = false; }
      // 行内样式
      let l = line
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/^---+$/, "<hr/>");
      out.push(`<p>${l}</p>`);
    }
  }
  flushList();
  return out.join("\n");
}

// ---------------------------------------------------------------- 消息渲染

function renderMessages() {
  const el = $("messages");
  const stick = isStuckToBottom();
  el.innerHTML = "";

  $("empty-state").hidden = state.messages.length > 0;

  for (const msg of state.messages) {
    el.appendChild(renderMessage(msg));
  }

  // 流式光标
  if (state.streamingMsg) {
    const els = el.querySelectorAll(".assistant-text");
    const last = els[els.length - 1];
    if (last) last.classList.add("stream-cursor");
  }

  if (stick) scrollToBottom();
}

function isStuckToBottom() {
  const m = $("messages");
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
}

function scrollToBottom() {
  const m = $("messages");
  m.scrollTop = m.scrollHeight;
}

function renderMessage(msg) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${msg.role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (msg.role === "user") {
    const text = Array.isArray(msg.content)
      ? msg.content.map((c) => (c.type === "text" ? c.text : c.type === "image" ? "🖼 [图片]" : "")).join("\n")
      : String(msg.content);
    bubble.textContent = text;
    wrap.appendChild(bubble);
  } else if (msg.role === "assistant") {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content) }];
    let textBuffer = "";
    const toolCalls = [];

    for (const block of content) {
      if (block.type === "text" || block.type === "output_text") {
        textBuffer += block.text ?? "";
      } else if (block.type === "thinking") {
        const tb = document.createElement("details");
        tb.className = "thinking-block";
        const body = document.createElement("div");
        body.className = "thinking-body";
        body.textContent = block.thinking ?? block.text ?? "";
        tb.appendChild(body);
        bubble.appendChild(tb);
      } else if (block.type === "toolCall" || block.type === "tool_call") {
        toolCalls.push({ id: block.id, name: block.name, args: block.arguments ?? {} });
      }
    }

    if (textBuffer) {
      const div = document.createElement("div");
      div.className = "assistant-text";
      div.innerHTML = renderMarkdown(textBuffer);
      bubble.appendChild(div);
    }

    // 工具调用 + 执行状态
    for (const tc of toolCalls) {
      bubble.appendChild(renderToolCard(tc.id, tc.name, tc.args));
    }
    wrap.appendChild(bubble);

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    if (msg.model) meta.innerHTML = `<span>${escapeHtml(String(msg.model))}</span>`;
    if (msg.timestamp) meta.insertAdjacentHTML("beforeend", `<span>${fmtTime(msg.timestamp)}</span>`);
    if (msg.usage?.cost) {
      meta.insertAdjacentHTML("beforeend", `<span>$${Number(msg.usage.cost.total ?? 0).toFixed(4)}</span>`);
    }
    if (meta.childNodes.length) wrap.appendChild(meta);
  } else if (msg.role === "toolResult" || msg.role === "tool_result" || msg.role === "bashExecution") {
    const text = Array.isArray(msg.content)
      ? msg.content.map((c) => (c.text ?? "")).join("")
      : String(msg.output ?? msg.content ?? "");
    bubble.textContent = msg.role === "bashExecution"
      ? `$ ${msg.command}\n${text}${msg.exitCode === 0 ? "" : `\n[退出码 ${msg.exitCode}]`}`
      : text;
    wrap.appendChild(bubble);
  } else {
    bubble.textContent = JSON.stringify(msg).slice(0, 2000);
    wrap.appendChild(bubble);
  }

  return wrap;
}

function renderToolCard(toolCallId, name, args) {
  const info = state.tools.get(toolCallId);
  const card = document.createElement("div");
  card.className = "tool-card";
  card.dataset.toolId = toolCallId;

  const head = document.createElement("div");
  head.className = "tc-head";
  const icon = document.createElement("span");
  icon.className = "tc-icon";
  icon.textContent = toolIcon(name);
  const nm = document.createElement("span");
  nm.className = "tc-name";
  nm.textContent = name;
  const st = document.createElement("span");
  st.className = "tc-state";
  st.id = `tool-state-${toolCallId}`;

  if (!info) {
    st.innerHTML = `<span>等待执行</span>`;
  } else if (info.state === "running") {
    st.innerHTML = `<span class="running">● 执行中</span>`;
  } else if (info.isError) {
    st.innerHTML = `<span class="err">✕ 出错</span>`;
  } else {
    st.innerHTML = `<span class="ok">✓ 完成</span>`;
  }

  head.append(icon, nm, st);
  head.addEventListener("click", () => {
    const bodyEl = card.querySelector(".tc-collapse");
    if (bodyEl) bodyEl.hidden = !bodyEl.hidden;
  });
  card.appendChild(head);

  const collapse = document.createElement("div");
  collapse.className = "tc-collapse";
  const argsText = typeof args === "string" ? args : JSON.stringify(args, null, 2);
  if (argsText && argsText !== "{}") {
    const a = document.createElement("div");
    a.className = "tc-args";
    a.textContent = argsText;
    collapse.appendChild(a);
  }
  if (info && info.output) {
    const o = document.createElement("div");
    o.className = "tc-output";
    o.textContent = info.output;
    collapse.appendChild(o);
  }
  card.appendChild(collapse);
  return card;
}

function updateToolCard(toolCallId) {
  const info = state.tools.get(toolCallId);
  const stEl = document.getElementById(`tool-state-${toolCallId}`);
  if (stEl && info) {
    if (info.state === "running") stEl.innerHTML = `<span class="running">● 执行中</span>`;
    else if (info.isError) stEl.innerHTML = `<span class="err">✕ 出错</span>`;
    else stEl.innerHTML = `<span class="ok">✓ 完成</span>`;
  }
}

// ---------------------------------------------------------------- RPC

async function cmd(obj) {
  const res = await api.cmd(obj);
  return res;
}

// ---------------------------------------------------------------- 事件流

function handleEvent(ev) {
  switch (ev.type) {
    case "agent_start":
      setBusy(true);
      break;
    case "agent_end":
      setBusy(false);
      refreshStats();
      break;
    case "agent_settled":
      setBusy(false);
      refreshStats();
      break;
    case "turn_start":
      break;
    case "turn_end":
      // 权威消息
      if (ev.message) upsertMessage(ev.message);
      if (ev.toolResults) for (const tr of ev.toolResults) upsertMessage(tr);
      finalizeStreaming();
      refreshStats();
      break;
    case "message_start":
      if (ev.message?.role === "assistant") beginStreaming(ev.message);
      else if (ev.message) upsertMessage(ev.message);
      break;
    case "message_update":
      applyDelta(ev.assistantMessageEvent);
      if (ev.usage) updateStreamingUsage(ev.usage);
      break;
    case "message_end":
      if (ev.message) upsertMessage(ev.message);
      finalizeStreaming();
      break;
    case "tool_execution_start":
      state.tools.set(ev.toolCallId, {
        name: ev.toolName, args: ev.args, output: "", state: "running", isError: false,
      });
      renderMessages();
      break;
    case "tool_execution_update": {
      const t = state.tools.get(ev.toolCallId);
      if (t) {
        const text = (ev.partialResult?.content ?? []).map((c) => c.text ?? "").join("");
        t.output = text;
        renderMessages();
      }
      break;
    }
    case "tool_execution_end": {
      const t = state.tools.get(ev.toolCallId);
      if (t) {
        t.state = "done";
        t.isError = !!ev.isError;
        t.output = (ev.result?.content ?? []).map((c) => c.text ?? "").join("");
      }
      renderMessages();
      refreshStats();
      break;
    }
    case "queue_update":
      updateQueueHint(ev.pending ?? 0);
      break;
    case "compaction_start":
      state.isCompacting = true;
      setBusy(true, "compacting");
      break;
    case "compaction_end":
      state.isCompacting = false;
      setBusy(state.isStreaming);
      refreshStats();
      refreshAll();
      break;
    case "auto_retry_start":
      toast("自动重试中…", "warning");
      break;
    case "extension_error":
      toast(`扩展错误: ${ev.message ?? "未知"}`, "error");
      break;
  }
}

// ---- 流式组装 ----

function beginStreaming(msg) {
  state.streamingMsg = { ...msg, content: [], streaming: true };
  state.streamingBuffer = [];
  // 若已有内容（如 thinking_start 先到），保留
  const existing = state.messages[state.messages.length - 1];
  if (existing?.role === "assistant" && existing.streaming) {
    state.streamingMsg = existing;
    state.streamingBuffer = existing._buffer || [];
  } else {
    state.messages.push(state.streamingMsg);
    state.streamingMsg._buffer = state.streamingBuffer;
  }
  renderMessages();
}

function ensureBlock(idx) {
  while (state.streamingBuffer.length <= idx) {
    state.streamingBuffer.push({ type: "text", text: "", thinking: "", toolArgs: "" });
  }
  return state.streamingBuffer[idx];
}

function applyDelta(delta) {
  if (!delta || !state.streamingMsg) return;
  const block = ensureBlock(delta.contentIndex ?? 0);

  switch (delta.type) {
    case "text_start": block.type = "text"; break;
    case "text_delta": block.text += delta.delta ?? ""; break;
    case "text_end": block.text = delta.content ?? block.text; break;
    case "thinking_start": block.type = "thinking"; break;
    case "thinking_delta": block.thinking += delta.delta ?? ""; break;
    case "thinking_end": block.thinking = delta.content ?? block.thinking; break;
    case "toolcall_start": block.type = "toolCall"; break;
    case "toolcall_delta": block.toolArgs += delta.delta ?? ""; break;
    case "toolcall_end":
      block.type = "toolCall";
      if (delta.toolCall) {
        block.id = delta.toolCall.id;
        block.name = delta.toolCall.name;
        block.args = delta.toolCall.arguments ?? {};
        // 预注册工具状态
        state.tools.set(delta.toolCall.id, {
          name: delta.toolCall.name,
          args: delta.toolCall.arguments ?? {},
          output: "",
          state: "pending",
          isError: false,
        });
      }
      break;
  }
  syncStreamingContent();
  renderMessages();
}

function syncStreamingContent() {
  if (!state.streamingMsg) return;
  state.streamingMsg.content = state.streamingBuffer.map((b) => {
    if (b.type === "thinking") return { type: "thinking", thinking: b.thinking };
    if (b.type === "toolCall") {
      const parsed = tryParseArgs(b.toolArgs);
      return {
        type: "toolCall", id: b.id ?? "", name: b.name ?? "tool",
        arguments: b.args ?? parsed,
      };
    }
    return { type: "text", text: b.text };
  });
}

function tryParseArgs(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function updateStreamingUsage(usage) {
  if (state.streamingMsg) state.streamingMsg.usage = usage;
}

function finalizeStreaming() {
  if (!state.streamingMsg) return;
  state.streamingMsg.streaming = false;
  state.streamingMsg._buffer = undefined;
  state.streamingMsg = null;
  state.streamingBuffer = [];
}

function upsertMessage(msg) {
  // 用 timestamp+role 近似去重；流式结束后直接追加
  const last = state.messages[state.messages.length - 1];
  if (state.streamingMsg && last === state.streamingMsg) {
    state.streamingMsg = null;
    state.streamingBuffer = [];
    last.streaming = false;
    last.content = msg.content ?? last.content;
    last.usage = msg.usage ?? last.usage;
    last.model = msg.model ?? last.model;
  } else if (last && last.role === msg.role && !last.streaming &&
             Math.abs((last.timestamp ?? 0) - (msg.timestamp ?? 0)) < 2000) {
    // 同角色且时间相近 → 合并（避免重复渲染）
    last.content = msg.content ?? last.content;
    last.usage = msg.usage ?? last.usage;
    last.model = msg.model ?? last.model;
  } else {
    state.messages.push({ ...msg, streaming: false });
  }
  renderMessages();
}

// ---------------------------------------------------------------- 顶栏状态

function setBusy(busy, kind) {
  state.isStreaming = busy;
  const dot = $("status-dot");
  const text = $("status-text");
  const abortBtn = $("btn-abort");

  if (state.isCompacting) {
    dot.className = "status-dot compacting";
    text.textContent = "压缩上下文中";
  } else if (busy) {
    dot.className = "status-dot working";
    text.textContent = kind === "compacting" ? "压缩中" : "工作中";
  } else {
    dot.className = "status-dot idle";
    text.textContent = "空闲";
  }
  abortBtn.hidden = !busy && !state.isCompacting;
  $("btn-send").disabled = busy && !state.isCompacting;
}

function updateQueueHint(pending) {
  const h = $("queue-hint");
  h.hidden = pending <= 0;
  h.textContent = `⏳ 队列中 ${pending} 条`;
}

function renderGauge() {
  const g = $("gauge-fill");
  const label = $("gauge-label");
  const u = state.contextUsage;
  if (!u || u.tokens == null || !u.contextWindow) {
    g.style.width = "0%";
    g.className = "gauge-fill";
    label.textContent = "—";
    return;
  }
  const pct = Math.min(100, Math.round(u.percent ?? (u.tokens / u.contextWindow) * 100));
  g.style.width = `${pct}%`;
  g.className = `gauge-fill${pct > 90 ? " danger" : pct > 70 ? " warn" : ""}`;
  label.textContent = `${fmtTokens(u.tokens)} / ${fmtTokens(u.contextWindow)}`;
}

// ---------------------------------------------------------------- 模型 / 思考级别

async function refreshModels() {
  try {
    const res = await cmd({ type: "get_available_models" });
    const models = res.data?.models ?? [];
    const sel = $("model-select");
    sel.innerHTML = "";
    const seen = new Set();
    for (const m of models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const opt = document.createElement("option");
      opt.value = JSON.stringify({ provider: m.provider, modelId: m.id });
      opt.textContent = `${m.name ?? m.id}${m.provider ? ` · ${m.provider}` : ""}`;
      if (state.model && m.id === state.model.id && m.provider === state.model.provider) {
        opt.selected = true;
      }
      sel.appendChild(opt);
    }
  } catch (e) {
    console.warn("refreshModels:", e.message);
  }
}

async function refreshThinking() {
  try {
    const res = await cmd({ type: "get_available_thinking_levels" });
    const levels = res.data?.levels ?? [];
    const sel = $("thinking-select");
    sel.innerHTML = "";
    for (const l of levels) {
      const opt = document.createElement("option");
      opt.value = l;
      opt.textContent = `思考: ${l}`;
      opt.selected = l === state.thinking;
      sel.appendChild(opt);
    }
  } catch {
    /* 忽略 */
  }
}

async function refreshStats() {
  try {
    const res = await cmd({ type: "get_session_stats" });
    const d = res.data;
    if (!d) return;
    state.contextUsage = d.contextUsage ?? null;
    renderGauge();
    $("session-name").textContent = d.sessionName || "untitled";
    state.currentSessionFile = d.sessionFile ?? null;
  } catch {
    /* 忽略 */
  }
  // 标记当前会话
  markActiveSession();
}

async function refreshAll() {
  try {
    const [st, msgs] = await Promise.all([
      cmd({ type: "get_state" }),
      cmd({ type: "get_messages" }),
    ]);
    if (st.data) {
      state.model = st.data.model ?? null;
      state.thinking = st.data.thinkingLevel ?? null;
      setBusy(!!st.data.isStreaming || !!st.data.isCompacting);
      $("session-name").textContent = st.data.sessionName || "untitled";
      state.currentSessionFile = st.data.sessionFile ?? null;
      $("queue-hint").hidden = !(st.data.pendingMessageCount > 0);
      if (st.data.pendingMessageCount > 0) updateQueueHint(st.data.pendingMessageCount);
    }
    state.messages = msgs.data?.messages ?? [];
    state.streamingMsg = null;
    state.streamingBuffer = [];
    state.tools.clear();
    renderMessages();
    refreshModels();
    refreshThinking();
    refreshStats();
    refreshSessions();
  } catch (e) {
    console.error("refreshAll:", e);
    toast(`加载失败: ${e.message}`, "error");
  }
}

// ---------------------------------------------------------------- 会话列表

async function refreshSessions() {
  try {
    state.sessions = await api.listSessions();
  } catch {
    state.sessions = [];
  }
  const list = $("session-list");
  list.innerHTML = "";

  if (!state.sessions.length) {
    const div = document.createElement("div");
    div.className = "session-empty";
    div.textContent = "暂无历史会话";
    list.appendChild(div);
    return;
  }

  for (const s of state.sessions) {
    const item = document.createElement("div");
    item.className = "session-item";
    const nm = document.createElement("div");
    nm.className = "si-name";
    nm.textContent = s.name || s.file.split("/").pop().replace(/\.jsonl$/, "");
    const sub = document.createElement("div");
    sub.className = "si-sub";
    const p = document.createElement("span");
    p.className = "si-path";
    p.textContent = s.label;
    const t = document.createElement("span");
    t.className = "si-time";
    t.textContent = fmtAgo(s.mtime);
    sub.append(p, t);
    item.append(nm, sub);
    item.addEventListener("click", () => switchSession(s.file));
    list.appendChild(item);
  }
  markActiveSession();
}

function markActiveSession() {
  const items = document.querySelectorAll(".session-item");
  items.forEach((el, i) => {
    const s = state.sessions[i];
    el.classList.toggle("active", !!s && s.file === state.currentSessionFile);
  });
}

async function switchSession(path) {
  try {
    const res = await cmd({ type: "switch_session", sessionPath: path });
    if (res.data?.cancelled) return;
    toast("已切换会话", "info");
    await refreshAll();
  } catch (e) {
    toast(`切换失败: ${e.message}`, "error");
  }
}

// ---------------------------------------------------------------- 操作

async function sendMessage() {
  const input = $("input");
  const text = input.value.trim();
  if (!text) return;

  if (state.isStreaming) {
    toast("正在处理中，无法发送（可先中止）", "warning");
    return;
  }

  input.value = "";
  autoResize();

  // 立即渲染用户消息
  state.messages.push({ role: "user", content: text, timestamp: Date.now(), streaming: false });
  renderMessages();

  try {
    const res = await cmd({ type: "prompt", message: text });
    if (!res.success) toast(`发送失败: ${res.error ?? "未知错误"}`, "error");
  } catch (e) {
    toast(`发送失败: ${e.message}`, "error");
  }
}

async function abortTurn() {
  try {
    await cmd({ type: "abort" });
    toast("已发送中止请求", "info");
  } catch (e) {
    toast(`中止失败: ${e.message}`, "error");
  }
}

async function compactContext() {
  try {
    toast("正在压缩上下文…", "info");
    await cmd({ type: "compact" });
  } catch (e) {
    toast(`压缩失败: ${e.message}`, "error");
  }
}

async function exportHtml() {
  try {
    const res = await cmd({ type: "export_html" });
    toast(`已导出: ${res.data?.path ?? "?"}`, "info");
  } catch (e) {
    toast(`导出失败: ${e.message}`, "error");
  }
}

// ---------------------------------------------------------------- 扩展 UI 对话框

const activeDialog = { id: null, timeout: null };

function showDialog(req) {
  const overlay = $("modal-overlay");
  const title = $("modal-title");
  const body = $("modal-body");
  const actions = $("modal-actions");
  activeDialog.id = req.id;

  title.textContent = req.title ?? req.method;
  body.innerHTML = "";
  actions.innerHTML = "";

  const cancelBtn = () => {
    const b = document.createElement("button");
    b.className = "btn ghost";
    b.textContent = "取消";
    b.addEventListener("click", () => closeDialog({ cancelled: true }));
    return b;
  };

  if (req.method === "select") {
    for (const opt of req.options ?? []) {
      const b = document.createElement("button");
      b.className = "modal-option";
      b.textContent = opt;
      b.addEventListener("click", () => closeDialog({ value: opt }));
      body.appendChild(b);
    }
    actions.appendChild(cancelBtn());
  } else if (req.method === "confirm") {
    const p = document.createElement("p");
    p.textContent = req.message ?? "";
    body.appendChild(p);
    const ok = document.createElement("button");
    ok.className = "btn primary";
    ok.textContent = "确认";
    ok.addEventListener("click", () => closeDialog({ confirmed: true }));
    const no = document.createElement("button");
    no.className = "btn ghost";
    no.textContent = "拒绝";
    no.addEventListener("click", () => closeDialog({ confirmed: false }));
    actions.append(no, ok);
  } else if (req.method === "input" || req.method === "editor") {
    if (req.message) {
      const p = document.createElement("p");
      p.textContent = req.message;
      body.appendChild(p);
    }
    const ta = document.createElement("textarea");
    if (req.method === "input") ta.style.minHeight = "52px";
    ta.placeholder = req.placeholder ?? "";
    ta.value = req.prefill ?? "";
    body.appendChild(ta);
    const ok = document.createElement("button");
    ok.className = "btn primary";
    ok.textContent = "确定";
    ok.addEventListener("click", () => closeDialog({ value: ta.value }));
    actions.append(cancelBtn(), ok);
    setTimeout(() => ta.focus(), 30);
  }

  overlay.hidden = false;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDialog({ cancelled: true });
  });
}

function closeDialog(payload) {
  $("modal-overlay").hidden = true;
  if (activeDialog.id) {
    api.uiResponse(activeDialog.id, payload);
    activeDialog.id = null;
  }
}

function handleUiRequest(req) {
  if (["select", "confirm", "input", "editor"].includes(req.method)) {
    showDialog(req);
    return;
  }
  switch (req.method) {
    case "notify":
      toast(req.message ?? "", req.notifyType ?? "info");
      break;
    case "setStatus":
      break; // 无状态栏可设置，忽略
    case "setWidget": {
      // 显示扩展的状态条 widget（如 pi-desktop 扩展的 desktop-strip）
      const lines = (req.widgetLines ?? []).map(stripAnsi).filter((l) => l.trim());
      const el = $("ext-widget");
      if (lines.length) {
        el.textContent = lines.join(" · ");
        el.hidden = false;
      } else {
        el.hidden = true;
      }
      break;
    }
    case "set_editor_text":
      $("input").value = req.text ?? "";
      autoResize();
      break;
    case "setTitle":
      document.title = `${req.title ?? "pi"} · pi desktop`;
      break;
  }
}

// ---------------------------------------------------------------- toast

function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, "");
}

function toast(message, type = "info", ms = 4200) {
  const box = $("toasts");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .3s";
    setTimeout(() => el.remove(), 320);
  }, ms);
}

// ---------------------------------------------------------------- 输入框

function autoResize() {
  const ta = $("input");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
}

function initComposer() {
  const ta = $("input");
  ta.addEventListener("input", autoResize);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  $("btn-send").addEventListener("click", sendMessage);
  $("btn-abort").addEventListener("click", abortTurn);
  $("btn-compact").addEventListener("click", compactContext);
  $("btn-export").addEventListener("click", exportHtml);
  $("btn-new").addEventListener("click", async () => {
    try {
      const res = await cmd({ type: "new_session" });
      if (!res.data?.cancelled) {
        toast("已新建会话", "info");
        await refreshAll();
      }
    } catch (e) {
      toast(`新建失败: ${e.message}`, "error");
    }
  });
  $("btn-refresh-sessions").addEventListener("click", refreshSessions);
  $("btn-restart").addEventListener("click", () => api.restartPi());
  $("btn-open-folder").addEventListener("click", () => api.openSessionsFolder());

  $("model-select").addEventListener("change", async (e) => {
    if (!e.target.value) return;
    const { provider, modelId } = JSON.parse(e.target.value);
    try {
      await cmd({ type: "set_model", provider, modelId });
      toast(`已切换模型: ${modelId}`, "info");
      refreshStats();
    } catch (err) {
      toast(`切换失败: ${err.message}`, "error");
    }
  });

  $("thinking-select").addEventListener("change", async (e) => {
    if (!e.target.value) return;
    try {
      await cmd({ type: "set_thinking_level", level: e.target.value });
      toast(`思考级别: ${e.target.value}`, "info");
    } catch (err) {
      toast(`设置失败: ${err.message}`, "error");
    }
  });
}

// ---------------------------------------------------------------- 启动

function init() {
  initComposer();

  api.onEvent(handleEvent);
  api.onUiRequest(handleUiRequest);
  api.onStatus((s) => {
    const dot = $("rpc-dot");
    const text = $("rpc-text");
    if (s.online) {
      dot.className = "status-dot small idle";
      text.textContent = "pi 引擎在线";
    } else {
      dot.className = "status-dot small error";
      text.textContent = s.restarting ? "pi 重启中…" : "pi 已断开";
    }
  });
  api.onLog((line) => console.log("[pi]", line));

  refreshAll();

  // 每 15s 静默刷新统计
  setInterval(() => {
    if (!state.isStreaming) refreshStats();
  }, 15000);
}

document.addEventListener("DOMContentLoaded", init);
