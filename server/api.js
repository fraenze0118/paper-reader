// HTTP API：由 vite 插件挂载，也可被独立 server.mjs 复用（路由与框架无关）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as db from './db.js';
import { extractPdf, buildPageBlocks } from './pdftext.js';
import { resolveMetadata } from './metadata.js';
import { MODELS, chatStream, estimateCost, approxTokens, isPeakNow, listModels } from './deepseek.js';
import { FORMATS, generateCitation, warmAssets, CSL_DIR, KNOWN_FORMATS } from './cite.js';
import { buildOutline } from './outline.js';

/* ---------------- 基础工具 ---------------- */

// 每次服务端代码（重新）加载的时间。用来确认 dev server 是否真的重启过 ——
// vite 配置加载失败时会静默沿用旧进程，接口看起来"改了没生效"。
const BOOTED_AT = new Date().toISOString();

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};
const fail = (res, code, message) => send(res, code, { error: message });

function readBody(req, limit = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('文件过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 32 * 1024 * 1024);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

/* ---------------- 提示词（前缀必须字节稳定：缓存命中的前提） ---------------- */

const SYSTEM_PROMPT = `你是一位严谨的学术论文精读助手，正在陪用户读一篇论文。

规则：
1. 只能依据【论文全文】中的内容回答。原文没有提到的，明确说「文中未提及」，不要用外部知识补充细节。
2. 引用或转述原文时，必须在句末标注页码，格式为 [[p.页码]]，例如 [[p.3]]，可标注多个。
3. 不要编造作者、年份、数据或结论，不要臆测论文没做过的实验。
4. 用中文回答，语言简洁，必要时用列表。
5. 用户问「这段是什么意思」时，先解释字面含义，再说明它在全文论证中的作用。`;

const FIRST_TURN_TAIL = '请先通读全文，然后等待我的问题。';
const FIXED_ACK =
  '好的，我已通读全文，包含其元数据与逐页正文。请提问，我会严格依据原文回答，并在引用处标注页码（如 [[p.3]]）。';

/** 论文上下文：只依赖标题/作者/页文本，不含时间戳与随机值 —— 这是缓存命中的前提 */
function buildPaperContext(item, pages) {
  const names = item.authors ?? [];
  const authorText = names.length
    ? names
        .slice(0, 8)
        .map((a) => [a.given, a.family].filter(Boolean).join(' '))
        .join(', ') + (names.length > 8 ? ` 等 ${names.length} 位作者` : '')
    : '未知';
  return `【论文元数据】
标题：${item.title || '未知'}
作者：${authorText}
年份：${item.year ?? '未知'}
发表处：${item.venue || '未知'}
DOI：${item.doi || '无'}

【论文全文】
${buildPageBlocks(pages)}

【全文结束】`;
}

function buildMessages(item, pages, history, question) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${buildPaperContext(item, pages)}\n\n${FIRST_TURN_TAIL}` },
    { role: 'assistant', content: FIXED_ACK },
  ];
  for (const h of history) {
    if (h.role === 'user' || h.role === 'assistant') messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: 'user', content: question });
  return messages;
}

/* ---------------- 演示模式（未配置 API Key 时的降级） ---------------- */

const warmState = new Map();

const STOP = new Set([
  'the', 'this', 'that', 'with', 'from', 'which', 'were', 'have', 'been', 'their', 'there', 'these', 'those',
  'into', 'than', 'then', 'they', 'will', 'would', 'could', 'should', 'about', 'what', 'does', 'paper',
]);

/** 从原文里挑出「最像正文」的句子：命中问题关键词、够长、有论证特征 */
function scoreSentences(pages, question) {
  const words = (String(question).toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w));
  const out = [];
  for (const p of pages) {
    const flat = String(p.text || '').split('\n').join(' ');
    for (const s of flat.split(/(?<=[.!?])\s+/)) {
      const t = s.replace(/\s+/g, ' ').trim();
      if (t.length < 50) continue;
      const lower = t.toLowerCase();
      const n = t.split(' ').length;
      let score = 0;
      for (const w of words) if (lower.includes(w)) score += 4;
      if (n >= 10) score += 2;
      for (const m of ['we ', 'our ', 'this paper', 'these results', 'we find', 'we show', 'however', 'therefore', 'results show', 'conclusion', 'abstract'])
        if (lower.includes(m)) score += 2;
      if (n < 9) score -= 3;
      out.push({ t, page: p.page, score });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.page - b.page);
}

function mockAnswer(question, pages, item) {
  const ranked = scoreSentences(pages, question);
  const keywordHit = ranked[0] && ranked[0].score > 0;

  // 问题关键词没命中（例如中文问英文论文）时，退回摘要，比随机页更像样
  let picks = ranked.slice(0, 3);
  let basis = `论文中相关的一段出现在第 ${picks[0]?.page ?? 1} 页`;
  if (!keywordHit) {
    const absSents = String(item.abstract || '')
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.trim().length > 50)
      .slice(0, 3);
    if (absSents.length) {
      const page = pages[0]?.page ?? 1;
      picks = absSents.map((t) => ({ t: t.trim(), page, score: 0 }));
      basis = `问题里的关键词没有直接命中原文（演示模式只做字面检索），先给出论文摘要（第 ${page} 页）`;
    }
  }
  if (!picks.length) {
    return `（演示模式）这篇论文没有可用的正文文本，可能是扫描件。\n\n配置 DeepSeek API Key 后，这里会给出真实的模型回答；扫描件也可以交给支持视觉的 deepseek-flash 处理。`;
  }

  const page = picks[0].page;
  const body = picks
    .slice(0, 2)
    .map((p) => `> ${p.t}\n\n（第 ${p.page} 页 [[p.${p.page}]]）`)
    .join('\n\n');

  return `（演示模式：未配置 DeepSeek API Key，以下是基于本地原文检索生成的模拟回答，不是模型输出）

针对「${String(question).slice(0, 70)}」，${basis}：

${body}

填入 API Key 后（右上角「设置」），同一个问题会由 deepseek-flash / deepseek-v4-pro 依据全文回答，并同样带 [[p.N]] 页码锚点，可点击跳回原文。`;
}

/* ---------------- 摘要兜底 ---------------- */

/** 没有元数据源给出摘要时，从首页文本里按 "Abstract" 标记截一段 */
function guessAbstract(pages) {
  const flat = pages.slice(0, 2).map((p) => p.text).join('\n');
  const idx = flat.search(/\babstract\b/i);
  if (idx >= 0) {
    let body = flat.slice(idx + 8).replace(/^[\s:.\-–]+/, '');
    const cut = body.search(/\n\s*(1\.?\s*introduction|I\.\s*INTRODUCTION|keywords|index terms|1\s+introduction)/i);
    if (cut > 60) body = body.slice(0, cut);
    const trimmed = body.trim();
    if (trimmed.length > 80) return trimmed.slice(0, 1500);
  }
  return flat.slice(0, 1200);
}

/* ---------------- 导入 ---------------- */

async function handleImport(req, res, url) {
  const filename = decodeURIComponent(req.headers['x-filename'] || 'untitled.pdf');
  const buf = await readBody(req);
  if (!buf.length) return fail(res, 400, '空文件');

  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

  // 同一个文件重复导入：直接返回已有文献，不落盘、更不删原文件
  const sameSha = db.findAttachmentBySha(sha256);
  if (sameSha) {
    const owner = db.getItem(sameSha.item_id);
    if (owner) return send(res, 200, { duplicate: true, item: owner, steps: [], confidence: owner.meta_confidence });
  }

  const safeName = filename.replace(/[^\w.\-()\u4e00-\u9fff ]+/g, '_').slice(-120) || 'paper.pdf';
  const storedPath = path.join(db.PDF_DIR, `${sha256.slice(0, 10)}_${crypto.randomBytes(3).toString('hex')}_${safeName}`);
  await fs.promises.writeFile(storedPath, buf);

  let ex;
  try {
    ex = await extractPdf(storedPath);
  } catch (e) {
    return fail(res, 422, `PDF 解析失败：${e.message}`);
  }
  const hasText = ex.pages.some((p) => (p.text || '').length > 40);

  const cfg = db.readConfig();
  let meta;
  try {
    meta = await resolveMetadata(ex, { apiKey: cfg.apiKey });
  } catch (e) {
    meta = {
      meta: { title: ex.info.title || safeName.replace(/\.pdf$/i, ''), authors: [], year: null, venue: '', doi: '', abstract: '', csl: {} },
      source: 'filename',
      confidence: 'low',
      needs_review: true,
      steps: [{ level: 'L4', ok: false, note: `元数据流水线异常：${e.message}` }],
    };
  }

  if (url.searchParams.get('preview') === '1') {
    return send(res, 200, {
      preview: true,
      filename,
      pageCount: ex.numPages,
      hasText,
      meta: meta.meta,
      source: meta.source,
      confidence: meta.confidence,
      needs_review: meta.needs_review,
      steps: meta.steps,
      firstPageLines: ex.pages[0]?.lines.slice(0, 8) ?? [],
    });
  }

  const dup = db.findDuplicate(meta.meta.title, meta.meta.doi);
  if (dup) {
    try {
      fs.unlinkSync(storedPath);
    } catch {
      /* ignore */
    }
    return send(res, 200, { duplicate: true, item: dup, steps: meta.steps, confidence: meta.confidence });
  }

  const item = db.insertItem({
    title: meta.meta.title || safeName.replace(/\.pdf$/i, ''),
    abstract: meta.meta.abstract || guessAbstract(ex.pages) || '',
    year: meta.meta.year,
    venue: meta.meta.venue,
    doi: meta.meta.doi,
    arxiv_id: meta.meta.arxiv_id,
    url: meta.meta.url,
    authors: meta.meta.authors,
    csl: { ...meta.meta.csl, id: undefined },
    meta_source: meta.source,
    meta_confidence: meta.confidence,
    needs_review: meta.needs_review,
  });

  const attId = db.addAttachment(item.id, filename, storedPath, buf.length, sha256, ex.numPages);
  db.savePages(attId, ex.pages);

  // 结构解析放到导入流程里一起做（启发式，不调 AI，秒级完成）
  let outlineInfo = null;
  try {
    outlineInfo = db.saveOutline(attId, await buildOutline(ex, { bookmarks: ex.bookmarks }));
  } catch (e) {
    console.warn('[import] 结构解析失败:', e.message);
  }

  send(res, 200, {
    duplicate: false,
    item: db.getItem(item.id),
    steps: meta.steps,
    confidence: meta.confidence,
    source: meta.source,
    pageCount: ex.numPages,
    hasText,
    outline: outlineInfo ? { sections: outlineInfo.sections.length, source: outlineInfo.source } : null,
  });
}

/* ---------------- 会话（SSE） ---------------- */

async function handleChat(req, res, itemId) {
  const body = await readJson(req);
  const item = db.getItem(itemId);
  if (!item) return fail(res, 404, '文献不存在');
  const att = db.getPrimaryAttachment(itemId);
  if (!att) return fail(res, 400, '该文献没有 PDF 附件');
  const pages = db.getPages(att.id);
  if (!pages.some((p) => (p.text || '').length > 40)) {
    return fail(res, 400, '这篇 PDF 没有可提取的文本层（可能是扫描件），AI 伴读暂不可用');
  }

  const cfg = db.readConfig();
  const apiKey = cfg.apiKey || '';
  const model = body.model || cfg.defaultModel || MODELS.flash;
  const thinking = body.thinking ?? model === MODELS.pro;
  const mode = body.mode || 'chat';

  let question = String(body.question || '').trim();
  if (mode === 'explain' && body.selection) {
    const sel = String(body.selection).slice(0, 4000);
    question = `【我在第 ${body.page ?? '?'} 页选中了以下内容】\n> ${sel.replace(/\n+/g, '\n> ')}\n\n请解释这段话：先解释字面含义，再说明它在全文论证中的作用。${question ? `\n\n补充要求：${question}` : ''}`;
  } else if (mode === 'note' && body.selection) {
    const sel = String(body.selection).slice(0, 6000);
    question = `请把下面这段被标注的原文整理成一条结构化阅读笔记，输出 4 个小节：核心主张 / 支撑证据 / 我的疑问 / 与全文的关系。每条都要标注页码 [[p.N]]。\n\n【标注原文（第 ${body.page ?? '?'} 页）】\n${sel}`;
  }
  if (!question) return fail(res, 400, '问题为空');

  const session = db.getOrCreateSession(itemId, model);
  db.setSessionModel(session.id, model);
  const history = db.listMessages(session.id).map((m) => ({ role: m.role, content: m.content }));
  const messages = buildMessages(item, pages, history, question);

  db.addMessage(session.id, 'user', mode === 'explain' || mode === 'note' ? question : body.question || question, {
    mode,
    page: body.page ?? null,
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const prefixTokens = approxTokens(messages.slice(0, 3).map((m) => m.content).join('\n'));
  const started = Date.now();
  let answer = '';
  let reasoning = '';
  let usage = null;

  try {
    if (apiKey) {
      sse({ type: 'meta', mode: apiKey ? 'live' : 'mock', model, thinking, prefixTokens });
      for await (const ev of chatStream({ apiKey, model, messages, thinking })) {
        if (ev.type === 'text') {
          answer += ev.text;
          sse({ type: 'delta', text: ev.text });
        } else if (ev.type === 'reasoning') {
          reasoning += ev.text;
          sse({ type: 'reasoning', text: ev.text });
        } else if (ev.type === 'usage') {
          usage = ev.usage;
        }
      }
    } else {
      sse({ type: 'meta', mode: 'mock', model, thinking, prefixTokens });
      const text = mockAnswer(body.question || question, pages, item);
      const chunks = text.match(/[\s\S]{1,12}/g) ?? [];
      for (const c of chunks) {
        answer += c;
        sse({ type: 'delta', text: c });
        await new Promise((r) => setTimeout(r, 14));
      }
      const n = warmState.get(itemId) ?? 0;
      warmState.set(itemId, n + 1);
      const hitRatio = n === 0 ? 0 : n === 1 ? 0.55 : 0.95;
      usage = {
        prompt_tokens: prefixTokens + approxTokens(question),
        completion_tokens: approxTokens(answer),
        prompt_cache_hit_tokens: Math.round(prefixTokens * hitRatio),
        prompt_cache_miss_tokens: Math.round(prefixTokens * (1 - hitRatio)) + approxTokens(question),
        simulated: true,
      };
    }

    const stats = {
      model,
      thinking,
      mode: apiKey ? 'live' : 'mock',
      elapsed_ms: Date.now() - started,
      prompt_tokens: usage?.prompt_tokens ?? approxTokens(messages.map((m) => m.content).join('\n')),
      completion_tokens: usage?.completion_tokens ?? approxTokens(answer),
      cache_hit_tokens: usage?.prompt_cache_hit_tokens ?? null,
      cache_miss_tokens: usage?.prompt_cache_miss_tokens ?? null,
      peak: isPeakNow(),
      simulated: !!usage?.simulated,
    };
    stats.cost = estimateCost(model, {
      hit: stats.cache_hit_tokens ?? 0,
      miss: stats.cache_miss_tokens ?? stats.prompt_tokens,
      out: stats.completion_tokens,
    });

    db.addMessage(session.id, 'assistant', answer, { ...stats, reasoning: reasoning.slice(0, 4000) });
    sse({ type: 'done', stats, reasoning });
  } catch (e) {
    sse({ type: 'error', message: e.message });
    db.addMessage(session.id, 'assistant', answer, { error: e.message, model });
  }
  res.end();
}

/* ---------------- 路由 ---------------- */

export async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname.replace(/^\/api/, '');
  const m = req.method.toUpperCase();

  try {
    if (route === '/health' && m === 'GET')
      return send(res, 200, { ok: true, started: BOOTED_AT, ...db.stats() });

    if (route === '/config') {
      if (m === 'GET') {
        const cfg = db.readConfig();
        return send(res, 200, {
          hasKey: !!cfg.apiKey,
          keyHint: cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}…${cfg.apiKey.slice(-4)}` : '',
          defaultModel: cfg.defaultModel || MODELS.flash,
          baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
          peak: isPeakNow(),
        });
      }
      if (m === 'POST') {
        const body = await readJson(req);
        const patch = {};
        if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey.trim();
        if (body.defaultModel) patch.defaultModel = body.defaultModel;
        const cfg = db.writeConfig(patch);
        return send(res, 200, { ok: true, hasKey: !!cfg.apiKey, defaultModel: cfg.defaultModel });
      }
    }

    if (route === '/config/test' && m === 'POST') {
      const cfg = db.readConfig();
      if (!cfg.apiKey) return fail(res, 400, '未配置 API Key');
      try {
        await listModels(cfg.apiKey);
        return send(res, 200, { ok: true, message: 'Key 有效，连接成功' });
      } catch (e) {
        return send(res, 200, { ok: false, message: e.message });
      }
    }

    if (route === '/import' && m === 'POST') return handleImport(req, res, url);

    if (route === '/stats' && m === 'GET') return send(res, 200, { ...db.stats(), peak: isPeakNow() });
    if (route === '/tags' && m === 'GET') return send(res, 200, db.listTags());
    if (route === '/collections') {
      if (m === 'GET') return send(res, 200, db.listCollections());
      if (m === 'POST') {
        const body = await readJson(req);
        if (!body.name?.trim()) return fail(res, 400, '名称不能为空');
        return send(res, 200, { id: db.createCollection(body.name.trim()) });
      }
    }

    if (route === '/items' && m === 'GET') {
      const list = (key) => {
        const raw = url.searchParams.get(key);
        return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
      };
      const opts = {
        q: url.searchParams.get('q') ?? '',
        filter: url.searchParams.get('filter') ?? 'all',
        collectionId: url.searchParams.get('collection') ? Number(url.searchParams.get('collection')) : null,
        years: list('years'),
        venues: list('venues'),
        authors: list('authors'),
        types: list('types'),
        tags: list('tags'),
        confidence: list('confidence'),
        flags: list('flags'),
      };
      return send(res, 200, db.listItems(opts));
    }

    if (route === '/facets' && m === 'GET') {
      return send(
        res,
        200,
        db.getFacets({
          q: url.searchParams.get('q') ?? '',
          filter: url.searchParams.get('filter') ?? 'all',
          collectionId: url.searchParams.get('collection') ? Number(url.searchParams.get('collection')) : null,
        }),
      );
    }

    if (route === '/items/bulk-delete' && m === 'POST') {
      const body = await readJson(req);
      const ids = (body.ids ?? []).map(Number).filter(Boolean);
      if (!ids.length) return fail(res, 400, '未选择要删除的文献');
      const r = db.deleteItems(ids);
      return send(res, 200, { ok: true, ...r });
    }

    let mm;
    if ((mm = route.match(/^\/items\/(\d+)$/))) {
      const id = Number(mm[1]);
      if (m === 'GET') {
        const item = db.getItem(id);
        return item ? send(res, 200, item) : fail(res, 404, '不存在');
      }
      if (m === 'PATCH') {
        const body = await readJson(req);
        return send(res, 200, db.updateItem(id, body));
      }
      if (m === 'DELETE') {
        db.deleteItem(id);
        return send(res, 200, { ok: true });
      }
    }

    if ((mm = route.match(/^\/items\/(\d+)\/text$/)) && m === 'GET') {
      const att = db.getPrimaryAttachment(Number(mm[1]));
      if (!att) return fail(res, 404, '无附件');
      return send(res, 200, { pages: db.getPages(att.id), pageCount: att.page_count });
    }

    if ((mm = route.match(/^\/items\/(\d+)\/reextract$/)) && m === 'POST') {
      const id = Number(mm[1]);
      const item = db.getItem(id);
      const att = db.getPrimaryAttachment(id);
      if (!item || !att) return fail(res, 404, '不存在');
      const ex = await extractPdf(att.stored_path);
      db.savePages(att.id, ex.pages);
      const cfg = db.readConfig();
      const r = await resolveMetadata(ex, { apiKey: cfg.apiKey });
      const updated = db.updateItem(id, {
        title: r.meta.title || item.title,
        year: r.meta.year,
        venue: r.meta.venue,
        doi: r.meta.doi,
        arxiv_id: r.meta.arxiv_id,
        url: r.meta.url,
        authors: r.meta.authors,
        csl: r.meta.csl,
        meta_source: r.source,
        meta_confidence: r.confidence,
        needs_review: r.needs_review,
      });
      return send(res, 200, { item: updated, steps: r.steps, source: r.source, confidence: r.confidence });
    }

    if ((mm = route.match(/^\/items\/(\d+)\/annotations$/)) && m === 'GET') {
      return send(res, 200, db.listAnnotations(Number(mm[1])));
    }

    if (route === '/annotations' && m === 'POST') {
      const body = await readJson(req);
      if (!body.item_id || !body.attachment_id) return fail(res, 400, '缺少 item_id / attachment_id');
      return send(res, 200, db.createAnnotation(body));
    }

    if ((mm = route.match(/^\/annotations\/(\d+)$/))) {
      const id = Number(mm[1]);
      if (m === 'PATCH') return send(res, 200, db.updateAnnotation(id, await readJson(req)));
      if (m === 'DELETE') return send(res, 200, db.deleteAnnotation(id));
    }

    if ((mm = route.match(/^\/attachments\/(\d+)\/file$/)) && m === 'GET') {
      const att = db.getAttachment(Number(mm[1]));
      if (!att || !fs.existsSync(att.stored_path)) return fail(res, 404, '文件不存在');
      const stat = fs.statSync(att.stored_path);
      const range = req.headers.range;
      const headers = {
        'Content-Type': 'application/pdf',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        'Content-Disposition': `inline; filename="${encodeURIComponent(att.filename)}"`,
      };
      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        const start = match?.[1] ? Number(match[1]) : 0;
        const end = match?.[2] ? Number(match[2]) : stat.size - 1;
        res.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(att.stored_path, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': stat.size });
      fs.createReadStream(att.stored_path).pipe(res);
      return;
    }

    if ((mm = route.match(/^\/items\/(\d+)\/notes$/))) {
      const id = Number(mm[1]);
      if (m === 'GET') return send(res, 200, db.listNotes(id));
      if (m === 'POST') {
        const body = await readJson(req);
        return send(res, 200, db.createNote(id, String(body.md ?? ''), body.source ?? 'manual'));
      }
    }
    if ((mm = route.match(/^\/notes\/(\d+)$/)) && m === 'DELETE') {
      return send(res, 200, db.deleteNote(Number(mm[1])));
    }

    if ((mm = route.match(/^\/items\/(\d+)\/chat$/))) {
      const id = Number(mm[1]);
      if (m === 'GET') {
        const s = db.getOrCreateSession(id);
        const messages = db.listMessages(s.id);
        return send(res, 200, { session: s, messages });
      }
      if (m === 'POST') return handleChat(req, res, id);
      if (m === 'DELETE') return send(res, 200, db.clearSession(id));
    }

    /* ---------------- 引用生成 ---------------- */

    if (route === '/cite/formats' && m === 'GET') return send(res, 200, FORMATS());

    if (route === '/cite' && m === 'POST') {
      const body = await readJson(req);
      const ids = (body.itemIds ?? []).map(Number).filter(Boolean);
      if (!ids.length) return fail(res, 400, '未选择文献');
      const items = ids.map((id) => db.getItem(id)).filter(Boolean);
      if (!items.length) return fail(res, 404, '文献不存在');
      const format = body.format ?? 'apa';
      if (!KNOWN_FORMATS.has(format)) return fail(res, 400, `未知格式：${format}`);
      const out = await generateCitation(items, format, {
        locale: body.locale ?? 'en-US',
        includeInline: body.includeInline !== false,
      });
      return send(res, 200, { ...out, count: items.length, itemTitles: items.map((i) => i.title) });
    }

    if (route === '/cite/export' && m === 'GET') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number).filter(Boolean);
      const format = url.searchParams.get('format') ?? 'bibtex';
      const locale = url.searchParams.get('locale') ?? 'en-US';
      const items = ids.map((id) => db.getItem(id)).filter(Boolean);
      if (!items.length) return fail(res, 404, '没有可导出的文献');
      const out = await generateCitation(items, format, { locale, includeInline: false });
      const ext = out.ext ?? 'txt';
      const filename = `paper-reader-${items.length}refs-${format}.${ext}`;
      res.writeHead(200, {
        'Content-Type': `${out.mime ?? 'text/plain'}; charset=utf-8`,
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      res.end(out.text);
      return;
    }

    if (route === '/cite/warm' && m === 'POST') {
      const result = await warmAssets();
      return send(res, 200, { ok: true, dir: CSL_DIR, result });
    }

    if (route === '/cite/status' && m === 'GET') {
      const list = (dir) => {
        try {
          return fs.readdirSync(dir);
        } catch {
          return [];
        }
      };
      return send(res, 200, {
        dir: CSL_DIR,
        styles: list(path.join(CSL_DIR, 'styles')),
        locales: list(path.join(CSL_DIR, 'locales')),
      });
    }

    /* ---------------- 论文结构 ---------------- */

    if ((mm = route.match(/^\/items\/(\d+)\/outline$/))) {
      const id = Number(mm[1]);
      const item = db.getItem(id);
      const att = db.getPrimaryAttachment(id);
      if (!item || !att) return fail(res, 404, '文献不存在');

      if (m === 'GET') {
        const cached = db.getOutline(att.id);
        if (cached) return send(res, 200, cached);
        // 旧数据没有缓存：就地解析一次（只读 PDF 抽文本，不调 AI）
        const ex = await extractPdf(att.stored_path);
        db.savePages(att.id, ex.pages);
        const outline = db.saveOutline(att.id, await buildOutline(ex, { bookmarks: ex.bookmarks }));
        return send(res, 200, outline);
      }

      if (m === 'POST') {
        const body = await readJson(req);
        const ex = await extractPdf(att.stored_path);
        db.savePages(att.id, ex.pages);
        const cfg = db.readConfig();
        const outline = db.saveOutline(
          att.id,
          await buildOutline(ex, { bookmarks: ex.bookmarks, apiKey: cfg.apiKey, useAi: !!body.useAi }),
        );
        return send(res, 200, outline);
      }
    }

    return fail(res, 404, `未知接口 ${m} ${route}`);
  } catch (e) {
    console.error('[api]', route, e);
    return fail(res, 500, e.message);
  }
}
