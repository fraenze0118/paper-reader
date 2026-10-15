// 元数据识别流水线：四级降级，逐级兜底
//   L0 内嵌元数据(pdf.js) → L1 DOI→CrossRef → L2 启发式+DeepSeek JSON→CrossRef 反查
//   → L3 arXiv → L4 仅启发式（标记待确认）
import { MODELS, chatJson } from './deepseek.js';
import { normalizeType } from './csl-types.js';

const UA = 'paper-reader/0.1 (demo; mailto:paper-reader@example.com)';
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>()[\]{},;]+)/;
const ARXIV_RE = /\barXiv[:\s]*(\d{4}\.\d{4,5})(v\d+)?/i;

const strip = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/* ---------------- L0：启发式（字号 + 位置） ---------------- */

export function guessHeuristic(ex) {
  const p1 = ex.pages?.[0];
  if (!p1) return { title: '', authors: [] };
  const top = p1.lines.slice(0, 30);
  const maxSize = Math.max(...top.map((l) => l.size), 0);
  if (!maxSize) return { title: '', authors: [] };

  const titleParts = [];
  let started = false;
  let lastY = null;
  for (const line of top) {
    const big = line.size >= maxSize * 0.92;
    if (!started) {
      if (!big) continue;
      started = true;
    } else if (!big || (lastY !== null && lastY - line.y > maxSize * 3.2)) {
      break;
    }
    titleParts.push(line.text);
    lastY = line.y;
  }

  const title = strip(titleParts.join(' '));

  // 作者：紧随标题、字号居中、且不像单位/邮箱的行
  const authors = [];
  let seen = false;
  for (const line of top) {
    if (!seen) {
      if (strip(titleParts.join(' ')).startsWith(line.text.slice(0, 12))) seen = true;
      if (seen && titleParts.includes(line.text)) continue;
      if (!seen) continue;
    }
    if (titleParts.includes(line.text)) continue;
    if (line.size > maxSize * 0.9) continue;
    if (line.size < maxSize * 0.55) break;
    if (/universit|institut|department|laborator|academy|collaboration|@|school|college/i.test(line.text)) break;
    authors.push(line.text);
    if (authors.length >= 2) break;
  }

  return { title, authors };
}

/* ---------------- DOI / arXiv 识别 ---------------- */

export function findDoi(text) {
  const m = DOI_RE.exec(text || '');
  if (!m) return '';
  return m[1].replace(/[.,;:]+$/, '');
}

export function findArxiv(text) {
  const m = ARXIV_RE.exec(text || '');
  return m ? m[1] + (m[2] ?? '') : '';
}

/* ---------------- 外部元数据源 ---------------- */

function fromCrossref(msg) {
  const issued = msg.issued?.['date-parts']?.[0]?.[0] ?? msg.published?.['date-parts']?.[0]?.[0] ?? null;
  return {
    title: strip(msg.title?.[0] ?? ''),
    authors: (msg.author ?? []).map((a) => ({
      family: strip(a.family ?? a.name ?? ''),
      given: strip(a.given ?? ''),
    })),
    year: issued ?? null,
    venue: strip(msg['container-title']?.[0] ?? msg.publisher ?? ''),
    doi: msg.DOI ?? '',
    url: msg.URL ?? '',
    abstract: strip(String(msg.abstract ?? '').replace(/<[^>]+>/g, ' ')),
    volume: msg.volume ?? '',
    issue: msg.issue ?? '',
    page: msg.page ?? '',
    type: normalizeType(msg.type),
  };
}

export async function crossrefByDoi(doi) {
  const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`CrossRef ${res.status}`);
  const json = await res.json();
  return fromCrossref(json.message);
}

export async function crossrefByTitle(title, year) {
  const q = encodeURIComponent(title.slice(0, 220));
  const res = await fetch(
    `https://api.crossref.org/works?query.bibliographic=${q}&rows=3&select=DOI,title,author,issued,container-title,volume,issue,page,abstract,type,URL`,
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) },
  );
  if (!res.ok) throw new Error(`CrossRef ${res.status}`);
  const json = await res.json();
  const items = (json.message?.items ?? []).map(fromCrossref);
  let best = null;
  let bestScore = 0;
  for (const it of items) {
    let score = similarity(it.title, title);
    if (year && it.year && Math.abs(it.year - year) <= 1) score += 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return bestScore >= 0.82 ? { item: best, score: bestScore } : { item: null, score: bestScore };
}

export async function arxivById(id) {
  const res = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`arXiv ${res.status}`);
  const xml = await res.text();
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
  if (!entry) return null;
  const pick = (tag) => strip(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry)?.[1] ?? '').replace(/\s+/g, ' ');
  const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((m) => {
    const name = strip(m[1]);
    const parts = name.split(' ');
    return { family: parts.length > 1 ? parts.at(-1) : name, given: parts.slice(0, -1).join(' ') };
  });
  return {
    title: pick('title'),
    authors,
    year: Number(pick('published').slice(0, 4)) || null,
    venue: 'arXiv preprint',
    doi: pick('arxiv:doi'),
    arxiv_id: id,
    url: pick('id'),
    abstract: pick('summary'),
    type: 'article',
  };
}

/* ---------------- 标题相似度（Dice 二元组） ---------------- */

export function similarity(a, b) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter++;
  return (2 * inter) / (gx.size + gy.size);
}

/* ---------------- L2：DeepSeek JSON 抽取 ---------------- */

const LLM_SYSTEM = `你是学术文献元数据抽取器。从用户给出的论文首页文本中抽取元数据，输出 json。
字段：title(字符串)、authors(对象数组，每项含 given 和 family)、year(整数或 null)、venue(期刊或会议名，字符串)、doi(字符串，没有则为空)、arxiv_id(字符串，没有则为空)、abstract(字符串，没有则为空)。
样例输出：{"title":"Observation of Gravitational Waves","authors":[{"given":"B. P.","family":"Abbott"}],"year":2016,"venue":"Physical Review Letters","doi":"10.1103/PhysRevLett.116.061102","arxiv_id":"","abstract":"On September 14, 2015 ..."}
不要编造：文本中没有的信息一律留空或 null。`;

async function llmExtract(ex, apiKey) {
  const head = ex.pages.slice(0, 2).map((p) => p.text).join('\n').slice(0, 12000);
  const { data, usage } = await chatJson({
    apiKey,
    model: MODELS.flash,
    system: LLM_SYSTEM,
    user: `论文首页文本如下：\n\n${head}`,
  });
  return {
    meta: {
      title: strip(data.title ?? ''),
      authors: Array.isArray(data.authors)
        ? data.authors.map((a) => ({ family: strip(a.family ?? a.last ?? ''), given: strip(a.given ?? a.first ?? '') }))
        : [],
      year: Number.isFinite(data.year) ? data.year : Number(data.year) || null,
      venue: strip(data.venue ?? ''),
      doi: strip(data.doi ?? ''),
      arxiv_id: strip(data.arxiv_id ?? ''),
      abstract: strip(data.abstract ?? ''),
      type: 'article-journal',
    },
    usage,
  };
}

/* ---------------- 合并 ---------------- */

function toCsl(meta, itemKey) {
  const csl = {
    id: itemKey,
    type: meta.type || 'article-journal',
    title: meta.title || '',
    author: (meta.authors ?? []).filter((a) => a.family || a.given),
  };
  if (meta.year) csl.issued = { 'date-parts': [[meta.year]] };
  if (meta.venue) csl['container-title'] = meta.venue;
  if (meta.doi) csl.DOI = meta.doi;
  if (meta.url) csl.URL = meta.url;
  if (meta.volume) csl.volume = meta.volume;
  if (meta.issue) csl.issue = meta.issue;
  if (meta.page) csl.page = meta.page;
  if (meta.abstract) csl.abstract = meta.abstract;
  return csl;
}

/**
 * 主入口。ex 为 extractPdf 的结果。
 * 返回 { meta, source, confidence, needs_review, steps[] }
 * steps 会在 UI 上展示，让「AI 是怎么认出来的」可见。
 */
export async function resolveMetadata(ex, { apiKey } = {}) {
  const steps = [];
  const p1text = ex.pages?.[0]?.text ?? '';
  const headText = ex.pages.slice(0, 2).map((p) => p.text).join('\n');
  const heuristic = guessHeuristic(ex);
  let meta = {
    title: ex.info.title || heuristic.title || '',
    authors: [],
    year: null,
    venue: '',
    doi: '',
    arxiv_id: '',
    url: '',
    abstract: '',
    type: 'article-journal',
  };
  let source = 'embedded+heuristic';
  let confidence = 'low';

  if (ex.info.title) steps.push({ level: 'L0', ok: true, note: `PDF 内嵌标题：${ex.info.title.slice(0, 80)}` });
  else if (heuristic.title) steps.push({ level: 'L0', ok: true, note: `字号启发式标题：${heuristic.title.slice(0, 80)}` });
  else steps.push({ level: 'L0', ok: false, note: '未识别出标题' });

  // L1: DOI → CrossRef（最权威）
  const doi = findDoi(headText) || findDoi(ex.info.subject) || '';
  if (doi) {
    steps.push({ level: 'L1', ok: true, note: `首页识别到 DOI：${doi}` });
    try {
      const cr = await crossrefByDoi(doi);
      if (cr) {
        meta = { ...meta, ...cr };
        source = 'crossref:doi';
        confidence = 'high';
        steps.push({ level: 'L1', ok: true, note: `CrossRef 命中：${cr.title.slice(0, 60)}（${cr.authors.length} 位作者）` });
      } else {
        meta.doi = doi;
        steps.push({ level: 'L1', ok: false, note: 'DOI 未在 CrossRef 检索到' });
      }
    } catch (e) {
      meta.doi = doi;
      steps.push({ level: 'L1', ok: false, note: `CrossRef 请求失败：${e.message}` });
    }
  } else {
    steps.push({ level: 'L1', ok: false, note: '首页未找到 DOI' });
  }

  // L2: DeepSeek 结构化抽取 + CrossRef 反查校验
  if (confidence !== 'high' && apiKey) {
    try {
      const { meta: llm } = await llmExtract(ex, apiKey);
      steps.push({
        level: 'L2',
        ok: true,
        note: `DeepSeek 抽取：${llm.title.slice(0, 60) || '(空)'} / ${llm.authors.length} 位作者 / ${llm.year ?? '年份未知'}`,
      });
      const fill = (k, v) => {
        if ((meta[k] === '' || meta[k] == null) && v !== '' && v != null) meta[k] = v;
      };
      if (llm.title) {
        fill('title', llm.title);
        if (similarity(meta.title, llm.title) > 0.6) meta.title = llm.title;
      }
      if (llm.authors.length) fill('authors', llm.authors);
      fill('year', llm.year);
      fill('venue', llm.venue);
      fill('doi', llm.doi);
      fill('arxiv_id', llm.arxiv_id);
      fill('abstract', llm.abstract);
      source = 'deepseek:json';
      confidence = 'medium';

      if (!meta.doi && llm.title) {
        const cr = await crossrefByTitle(llm.title, llm.year);
        if (cr.item) {
          meta = { ...meta, ...cr.item, abstract: meta.abstract || cr.item.abstract };
          source = 'deepseek+crossref:title';
          confidence = 'high';
          steps.push({ level: 'L2', ok: true, note: `标题反查 CrossRef 命中（相似度 ${cr.score.toFixed(2)}）` });
        } else {
          steps.push({ level: 'L2', ok: false, note: `标题反查相似度不足（${cr.score.toFixed(2)}），保留模型结果` });
        }
      }
    } catch (e) {
      steps.push({ level: 'L2', ok: false, note: `DeepSeek 抽取失败：${e.message}` });
    }
  } else if (confidence !== 'high') {
    steps.push({ level: 'L2', ok: false, note: '未配置 API Key，跳过 AI 抽取' });
  }

  // L3: arXiv
  if (confidence !== 'high') {
    const ax = findArxiv(headText);
    if (ax) {
      try {
        const a = await arxivById(ax);
        if (a) {
          meta = { ...meta, ...a };
          source = 'arxiv';
          confidence = 'high';
          steps.push({ level: 'L3', ok: true, note: `arXiv 命中：${a.title.slice(0, 60)}` });
        }
      } catch (e) {
        steps.push({ level: 'L3', ok: false, note: `arXiv 请求失败：${e.message}` });
      }
    } else {
      steps.push({ level: 'L3', ok: false, note: '未发现 arXiv 编号' });
    }
  }

  // L4: 兜底
  if (!meta.title && heuristic.title) meta.title = heuristic.title;
  if (!meta.authors.length && heuristic.authors.length) {
    meta.authors = heuristic.authors[0]
      .split(/[,;]|\band\b/)
      .map((s) => strip(s).replace(/[*†‡§¶#]|\d+$/g, '').trim())
      .filter(Boolean)
      .map((name) => {
        const parts = name.split(' ');
        return { family: parts.length > 1 ? parts.at(-1) : name, given: parts.slice(0, -1).join(' ') };
      });
    if (confidence === 'low') source = 'heuristic';
  }
  if (confidence === 'low') {
    steps.push({ level: 'L4', ok: false, note: '仅启发式结果，已标记为「待确认」' });
  }

  meta.title = strip(meta.title);
  meta.doi = strip(meta.doi).replace(/^https?:\/\/doi\.org\//i, '');

  return {
    meta: { ...meta, csl: toCsl(meta, '') },
    source,
    confidence,
    needs_review: confidence === 'low' || !meta.title,
    steps,
    heuristic,
  };
}
