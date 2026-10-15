// 用 Chrome DevTools Protocol 截图 + 抓控制台错误，用于验证真实渲染结果。
// 用法: node scripts/shot.mjs <url> <out.png> [waitMs] [width] [height]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME =
  process.env.CHROME ||
  ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(
    (p) => fs.existsSync(p),
  );

const url = process.argv[2];
const out = process.argv[3];
const waitMs = Number(process.argv[4] ?? 7000);
const width = Number(process.argv[5] ?? 1680);
const height = Number(process.argv[6] ?? 1000);
const port = 9333 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForEndpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

let ws;
let msgId = 0;
const pending = new Map();
const logs = [];

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

try {
  await waitForEndpoint();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      logs.push(`[console.${msg.params.type}] ${text}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push(`[exception] ${d.exception?.description ?? d.text}`);
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error' || e.level === 'warning') logs.push(`[log.${e.level}] ${e.text} ${e.url ?? ''}`);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(waitMs);

  // 可选：截图前先执行一段 JS（例如点开某个 tab 或采集测量值），再等一会儿
  if (process.env.SHOT_EVAL) {
    const evaled = await send('Runtime.evaluate', {
      expression: process.env.SHOT_EVAL,
      awaitPromise: true,
      returnByValue: true,
    });
    const v = evaled?.result?.value;
    if (v !== undefined && v !== null) console.log('SHOT_EVAL 结果:', typeof v === 'string' ? v : JSON.stringify(v));
    if (evaled?.exceptionDetails) console.log('SHOT_EVAL 异常:', evaled.exceptionDetails.exception?.description ?? evaled.exceptionDetails.text);
    await sleep(Number(process.env.SHOT_EVAL_WAIT ?? 2500));
  }

  // 顺带取一些 DOM 事实，便于断言
  const probe = await send('Runtime.evaluate', {
    expression: `JSON.stringify((() => {
      const sc = document.querySelector('.pdf-scroll');
      const wrap = document.querySelector('.page-wrap');
      const cv = wrap?.querySelector('canvas');
      const side = document.querySelector('.side');
      const list = document.querySelector('.list');
      const nav = document.querySelector('.nav');
      const r = (el) => el ? { off: el.offsetWidth, client: el.clientWidth, scroll: el.scrollWidth, rect: Math.round(el.getBoundingClientRect().width) } : null;
      return {
        viewport: { w: window.innerWidth, dpr: window.devicePixelRatio },
        nav: r(nav), list: r(list), side: r(side),
        pdfScroll: r(sc),
        pageWrap: r(wrap),
        pageWrapCss: wrap ? wrap.style.width : null,
        canvasAttr: cv ? { w: cv.width, h: cv.height } : null,
        canvasStyle: cv ? { w: cv.style.width, h: cv.style.height } : null,
        totalScaleFactor: wrap ? getComputedStyle(wrap).getPropertyValue('--total-scale-factor').trim() : null,
        canvasMaxWidth: cv ? getComputedStyle(cv).maxWidth : null,
        canvases: document.querySelectorAll('canvas').length,
        textLayerSpans: document.querySelectorAll('.textLayer span').length,
        pages: document.querySelectorAll('.page-wrap').length,
        annRects: document.querySelectorAll('.ann-rect').length,
        hasLoadingText: document.body.innerText.includes('正在加载 PDF'),
        chatMsgs: document.querySelectorAll('.msg').length,
        pageChips: document.querySelectorAll('.page-chip').length,
        costBar: document.querySelector('.cost-bar')?.innerText?.replace(/\\s+/g, ' ') ?? null,
      };
    })())`,
    returnByValue: true,
  });

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));

  console.log('DOM 探测:', probe.result.value);
  const notable = logs.filter((l) => !/favicon|DevTools|Download the React/i.test(l));
  console.log('控制台输出:', notable.length ? '\n  ' + notable.slice(0, 25).join('\n  ') : '（无错误）');
  console.log('截图已保存:', out);
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  await sleep(400);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
