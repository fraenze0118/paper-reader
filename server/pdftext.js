// PDF 文本抽取：pdf.js 在 Node 侧复用与前端相同的解析器，保证阅读器与 AI 看到的文本一致。
import fs from 'node:fs';

let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** 中英混排的智能拼接：CJK 之间不插空格，拉丁文之间按间距插空格 */
function joinLine(items) {
  let out = '';
  let prev = null;
  for (const it of items) {
    const t = it.str;
    if (!t) continue;
    if (prev) {
      const needSpace =
        !(CJK.test(prev.str.slice(-1)) || CJK.test(t.slice(0, 1))) &&
        it.x - (prev.x + prev.width) > prev.size * 0.18;
      if (needSpace && !/\s$/.test(out)) out += ' ';
    }
    out += t;
    prev = it;
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

/**
 * 抽取 PDF：页文本 + 带字号的行（用于启发式判断标题/作者）+ 内嵌元数据。
 * 返回结构刻意保持稳定，AI 侧的前缀文本由它确定性生成（缓存命中依赖字节稳定）。
 */
export async function extractPdf(filePath) {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;

  let info = {};
  let xmp = null;
  try {
    const meta = await doc.getMetadata();
    info = meta?.info ?? {};
    xmp = meta?.metadata?.getAll?.() ?? null;
  } catch {
    /* 元数据缺失是常态，忽略 */
  }

  let bookmarks = [];
  try {
    bookmarks = await readBookmarks(doc, await doc.getOutline());
  } catch {
    /* 书签解析失败不影响正文抽取 */
  }

  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const buckets = new Map();
    for (const it of content.items) {
      if (typeof it.str !== 'string' || !it.str.trim()) continue;
      const size = Math.abs(it.transform?.[3] ?? 10);
      const y = Math.round((it.transform?.[5] ?? 0) * 2) / 2;
      const key = `${y}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ str: it.str, x: it.transform?.[4] ?? 0, width: it.width ?? 0, size });
    }

    const lines = [];
    for (const [y, items] of buckets) {
      items.sort((a, b) => a.x - b.x);
      // 按横向大间隙切分：双栏排版里左右两栏在同一 y 上，不切开会拼成一行乱码
      // （栏间距通常 ≥ 1.4 倍字号，词间距远小于此）
      const segs = [];
      let cur = [];
      for (const it of items) {
        if (cur.length) {
          const prev = cur[cur.length - 1];
          const gap = it.x - (prev.x + prev.width);
          if (gap > Math.max(9, prev.size * 1.45)) {
            segs.push(cur);
            cur = [];
          }
        }
        cur.push(it);
      }
      if (cur.length) segs.push(cur);

      for (const seg of segs) {
        const text = joinLine(seg);
        if (!text) continue;
        const last = seg[seg.length - 1];
        lines.push({
          y: Number(y),
          x: seg[0].x,
          w: last.x + last.width - seg[0].x,
          size: Math.max(...seg.map((i) => i.size)),
          text,
        });
      }
    }

    // 阅读顺序：双栏页面必须“左栏自上而下、再右栏自上而下”，
    // 否则两栏文字会按 y 交错，正文和 AI 上下文都会变成乱序。
    const pageWidth = page.view?.[2] - page.view?.[0] || 612;
    const mid = pageWidth / 2;
    const leftN = lines.filter((l) => l.x < mid * 0.75).length;
    const rightN = lines.length - leftN;
    const twoColumn = leftN > 4 && rightN > 4 && rightN / lines.length > 0.2;

    lines.sort((a, b) => {
      if (twoColumn) {
        const ca = a.x >= mid * 0.75 ? 1 : 0;
        const cb = b.x >= mid * 0.75 ? 1 : 0;
        if (ca !== cb) return ca - cb;
      }
      return b.y - a.y || a.x - b.x;
    });

    pages.push({
      page: n,
      text: lines.map((l) => l.text).join('\n'),
      lines,
      width: page.view?.[2] - page.view?.[0],
      height: page.view?.[3] - page.view?.[1],
    });
  }

  await task.destroy();

  return {
    numPages: pages.length,
    pages,
    bookmarks: bookmarks ?? [],
    info: {
      title: clean(info.Title),
      author: clean(info.Author),
      subject: clean(info.Subject),
      creator: clean(info.Creator),
      producer: clean(info.Producer),
    },
    xmpTitle: clean(xmp?.dc$title ?? null),
  };
}

/** 读取 PDF 自带的书签/目录（hyperref 生成的 PDF 通常有），拍平成 {title, level, page} */
async function readBookmarks(doc, outline) {
  if (!Array.isArray(outline) || !outline.length) return [];
  const flat = [];
  const walk = async (items, level) => {
    for (const it of items) {
      let page = null;
      if (!it.url && it.dest != null) {
        try {
          const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest;
          const ref = Array.isArray(dest) ? dest[0] : null;
          if (ref != null) page = (await doc.getPageIndex(ref)) + 1;
        } catch {
          /* 目标无法解析就跳过页码 */
        }
      }
      const title = String(it.title ?? '').replace(/\s+/g, ' ').trim();
      if (title) flat.push({ title, level, page });
      if (it.items?.length) await walk(it.items, level + 1);
    }
  };
  await walk(outline, 1);
  return flat;
}

function clean(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (!s || /^(untitled|unknown|microsoft word|latex.*|pdftex.*)$/i.test(s)) return '';
  return s;
}

/** 直接给 AI 用的前缀文本：只依赖页文本，字节稳定 */
export function buildPageBlocks(pages) {
  return pages.map((p) => `<page ${p.page}>\n${p.text}\n</page>`).join('\n\n');
}
