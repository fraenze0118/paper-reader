// 端到端交互验证：划词高亮 + 框选标注（通过 CDP 在真实浏览器里操作 DOM）
// 用法: node scripts/e2e.mjs [baseUrl]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5273';

// 选一篇有 PDF 附件的文献（可用 E2E_ITEM 指定 id），避免写死 id
const items = await (await fetch(`${BASE}/api/items`)).json();
const target = process.env.E2E_ITEM
  ? items.find((i) => String(i.id) === String(process.env.E2E_ITEM))
  : items.find((i) => i.attachments?.length);
if (!target) {
  console.error('没有可测试的文献（需要有 PDF 附件）');
  process.exit(1);
}
const ITEM_ID = target.id;
console.log(`测试对象: #${ITEM_ID} ${target.title.slice(0, 50)}`);
const before = await (await fetch(`${BASE}/api/items/${ITEM_ID}/annotations`)).json();
const maxBefore = before.reduce((n, a) => Math.max(n, a.id), 0);

const CHROME =
  process.env.CHROME ||
  ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(
    (p) => fs.existsSync(p),
  );
const port = 9700 + Math.floor(Math.random() * 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1680,1000', 'about:blank'],
  { stdio: 'ignore' },
);

let ws;
let msgId = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const SCRIPT = `(async () => {
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(250); }
    return false;
  };

  await waitFor(() => document.querySelectorAll('.page-wrap').length > 0);
  await waitFor(() => document.querySelectorAll('.textLayer span').length > 10);
  log.push('pages=' + document.querySelectorAll('.page-wrap').length);
  log.push('spans=' + document.querySelectorAll('.textLayer span').length);

  // --- 1) 划词高亮 ---
  const spans = [...document.querySelectorAll('.page-wrap .textLayer span')].filter((s) => s.textContent.trim().length > 3);
  log.push('usableSpans=' + spans.length);
  const before = document.querySelectorAll('.ann-rect').length;
  const range = document.createRange();
  range.setStart(spans[4].firstChild, 0);
  range.setEnd(spans[7].firstChild, spans[7].textContent.length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.querySelector('.page-wrap').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  await sleep(500);
  const menu = document.querySelector('.sel-menu');
  log.push('selMenu=' + !!menu);
  if (menu) {
    log.push('menuTextLen=' + window.getSelection().toString().trim().length);
    menu.querySelector('.color-swatch').click();
    await sleep(1200);
  }
  log.push('annRects ' + before + '->' + document.querySelectorAll('.ann-rect').length);

  // --- 2) 框选标注 ---
  const areaBtn = [...document.querySelectorAll('.tool-group .btn')].find((b) => b.textContent.includes('框选'));
  areaBtn?.click();
  await sleep(400);
  const cap = document.querySelector('.area-capture');
  log.push('areaCapture=' + !!cap);
  if (cap) {
    const r = cap.getBoundingClientRect();
    const fire = (t, x, y) => cap.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x, clientY: y }));
    fire('mousedown', r.left + 120, r.top + 180);
    fire('mousemove', r.left + 430, r.top + 320);
    fire('mouseup', r.left + 430, r.top + 320);
    await sleep(1500);
  }
  log.push('annAreaRects=' + document.querySelectorAll('.ann-rect.area').length);

  // --- 3) 标注侧栏 ---
  await sleep(600);
  log.push('sideCards=' + document.querySelectorAll('.ann-card').length);
  log.push('areaImages=' + [...document.querySelectorAll('.ann-card img')].length);
  return log.join(' | ');
})()`;

try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch {
      /* wait */
    }
    await sleep(250);
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
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
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1680,
    height: 1000,
    deviceScaleFactor: Number(process.env.SHOT_DPR ?? 1),
    mobile: false,
  });
  await send('Page.navigate', { url: `${BASE}/?item=${ITEM_ID}` });
  await sleep(3000);

  const res = await send('Runtime.evaluate', { expression: SCRIPT, awaitPromise: true, returnByValue: true });
  console.log('浏览器内结果:', res.result.value ?? JSON.stringify(res.result));

  const anns = await (await fetch(`${BASE}/api/items/${ITEM_ID}/annotations`)).json();
  console.log('\n本次新增的标注:');
  const created = anns.filter((a) => a.id > maxBefore);
  for (const a of created) {
    console.log(
      `  #${a.id} page=${a.page} kind=${a.kind} color=${a.color} rects=${a.rects.length} ` +
        `text="${String(a.text).slice(0, 48)}" image=${a.image_data ? a.image_data.length + 'B' : '无'}`,
    );
  }

  // 清理：测试产生的标注全部删掉，保持文献库干净
  for (const a of created) await fetch(`${BASE}/api/annotations/${a.id}`, { method: 'DELETE' });
  if (created.length) console.log(`\n已清理 ${created.length} 条测试标注`);
  if (!created.length) {
    console.error('⚠ 没有产生任何标注，测试可能失败');
    process.exitCode = 1;
  }
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
