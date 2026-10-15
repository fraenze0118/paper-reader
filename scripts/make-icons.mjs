// 从 public/favicon.svg 生成各尺寸 PNG 图标。
// 用 Chrome 无头渲染，保证 PNG 与浏览器实际显示的 SVG 完全一致（不引入额外的图形依赖）。
//
// 用法: node scripts/make-icons.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public', 'favicon.svg');
const OUT = path.join(ROOT, 'public');
const PREVIEW_DIR = path.join(ROOT, 'docs', 'images');
const CHROME =
  process.env.CHROME ||
  [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('没找到 Chrome/Edge，可用 CHROME 环境变量指定可执行文件路径');
  process.exit(1);
}

const svg = fs.readFileSync(SRC, 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icons-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把一段 SVG 放到无边框页面上，用无头浏览器截成 size×size 的 PNG */
async function render(svgText, size, outFile, { transparent }) {
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:${transparent ? 'transparent' : '#2f5fd0'}}
svg{display:block;width:${size}px;height:${size}px}</style>${svgText}`;
  const page = path.join(tmp, `icon-${size}-${transparent ? 'a' : 'o'}.html`);
  fs.writeFileSync(page, html);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--screenshot=${outFile}`,
    `--window-size=${size},${size}`,
    '--force-device-scale-factor=1',
    `--user-data-dir=${path.join(tmp, `profile-${size}-${transparent ? 'a' : 'o'}`)}`,
    `file:///${page.replace(/\\/g, '/')}`,
  ];
  if (transparent) args.splice(args.length - 2, 0, '--default-background-color=00000000');
  const proc = spawn(CHROME, args, { stdio: 'ignore' });
  await new Promise((resolve) => proc.on('exit', resolve));
  await sleep(150);
  if (!fs.existsSync(outFile)) throw new Error(`渲染失败: ${outFile}`);
  return `${path.basename(outFile)} ${size}×${size} ${(fs.statSync(outFile).size / 1024).toFixed(1)} KB`;
}

try {
  const results = [];
  // 标签页图标：32px，保留透明圆角
  results.push(await render(svg, 32, path.join(OUT, 'favicon-32.png'), { transparent: true }));
  // iOS 主屏图标：180px，iOS 自己会加圆角，所以要满幅不透明
  results.push(
    await render(svg.replace('rx="15"', 'rx="0"'), 180, path.join(OUT, 'apple-touch-icon.png'), {
      transparent: false,
    }),
  );
  // 预览图（大尺寸，放在文档里方便看细节，不进 public）
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  results.push(await render(svg, 256, path.join(PREVIEW_DIR, 'icon-preview.png'), { transparent: true }));
  console.log('生成完成：');
  for (const r of results) console.log('  ' + r);
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
