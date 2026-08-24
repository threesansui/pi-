/**
 * CDP 驱动脚本 — 通过 Chrome DevTools Protocol 操作桌面窗口
 * 用法: node scripts/drive.js "<消息文本>" [等待秒数]
 */
const CDP = "http://127.0.0.1:9222/json";

async function getPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(CDP);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("未找到可调试页面");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const message = process.argv[2] ?? "你好，请回复 OK";
  const waitSecs = Number(process.argv[3] ?? 15);

  const page = await getPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");
  await sleep(1000);

  // 1. 等待 UI 就绪（状态 pill 出现文字）
  for (let i = 0; i < 30; i++) {
    const r = await send("Runtime.evaluate", {
      expression: `document.querySelector('#status-text')?.textContent || ''`,
      returnByValue: true,
    });
    if (r.result?.result?.value) break;
    await sleep(1000);
  }

  // 2. 检查顶栏信息
  const snap = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      status: document.querySelector('#status-text')?.textContent,
      model: [...document.querySelector('#model-select').options].map(o=>o.textContent).slice(0,3),
      thinking: [...document.querySelector('#thinking-select').options].map(o=>o.textContent),
      gauge: document.querySelector('#gauge-label')?.textContent,
      sessions: document.querySelectorAll('.session-item').length,
      extWidget: document.querySelector('#ext-widget')?.textContent?.slice(0,120) ?? null,
    })`,
    returnByValue: true,
  });
  console.log("UI 快照:", snap.result?.result?.value);

  // 3. 输入消息并发送
  await send("Runtime.evaluate", {
    expression: `(() => {
      const ta = document.querySelector('#input');
      ta.value = ${JSON.stringify(message)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btn-send').click();
      return true;
    })()`,
  });
  console.log(`已发送消息: "${message}"，等待 ${waitSecs}s 响应…`);

  // 4. 轮询等待完成
  const t0 = Date.now();
  let lastLen = 0;
  while (Date.now() - t0 < waitSecs * 1000) {
    await sleep(2500);
    const r = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        n: document.querySelectorAll('.msg').length,
        status: document.querySelector('#status-text')?.textContent,
        lastText: (() => { const els = document.querySelectorAll('.assistant-text'); return els.length ? els[els.length-1].textContent.slice(0, 300) : ''; })(),
        tools: document.querySelectorAll('.tool-card').length,
      })`,
      returnByValue: true,
    });
    const v = JSON.parse(r.result?.result?.value ?? "{}");
    if (v.lastText && v.lastText.length !== lastLen) {
      lastLen = v.lastText.length;
      console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] 消息数=${v.n} 状态=${v.status} 工具=${v.tools} 回复前300字: ${v.lastText.slice(0, 120)}`);
    }
    if (v.status === "空闲" && v.lastText && lastLen > 0 && v.n >= 2) {
      console.log("完成 ✓");
      break;
    }
  }

  // 5. 最终快照
  const fin = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      messages: document.querySelectorAll('.msg').length,
      status: document.querySelector('#status-text')?.textContent,
      gauge: document.querySelector('#gauge-label')?.textContent,
    })`,
    returnByValue: true,
  });
  console.log("最终:", fin.result?.result?.value);

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("驱动失败:", e.message);
  process.exit(1);
});
