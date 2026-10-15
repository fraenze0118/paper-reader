// 论文结构解析：分层降级
//   L1 PDF 自带书签（hyperref 生成的 PDF 通常有，最准）
//   L2 字号 + 编号 + 关键词启发式（无书签时的主力）
//   L3 DeepSeek 语义解析（按需触发，用来修正启发式的错漏）
//
// 产出统一的 sections: { id, title, level, page, yFrac, type, source }
// yFrac = 该标题在页面内自上而下的位置比例（0~1），用于精确跳转而不只是跳到页首。
import { MODELS, chatJson } from './deepseek.js';

const r1 = (n) => Math.round(n * 10) / 10;

const normKey = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/^(?:\d+(?:\.\d+)*|[ivxlc]+)[.)]?\s+/i, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');

export const SECTION_TYPES = [
  'abstract', 'introduction', 'related', 'method', 'results',
  'discussion', 'conclusion', 'references', 'acknowledgement', 'appendix', 'other',
];

const TYPE_LABEL = {
  abstract: '摘要',
  introduction: '引言',
  related: '相关工作',
  method: '方法',
  results: '实验与结果',
  discussion: '讨论',
  conclusion: '结论',
  references: '参考文献',
  acknowledgement: '致谢',
  appendix: '附录',
  other: '其他',
};
export const sectionTypeLabel = (t) => TYPE_LABEL[t] ?? '其他';

/** 按标题文本猜章节类型（仅用于 UI 上色/过滤，不影响跳转） */
export function classifySection(rawTitle) {
  const t = String(rawTitle ?? '')
    .toLowerCase()
    .replace(/^(?:\d+(?:\.\d+)*|[ivxlc]+)[.)]?\s+/i, '')
    .trim();
  if (/^(abstract|摘要)\b/.test(t)) return 'abstract';
  if (/^(introduction|引言|绪论|概述)\b/.test(t)) return 'introduction';
  if (/^(related|background|prior work|literature|相关工作|研究背景|背景)\b/.test(t)) return 'related';
  if (/^(method|approach|model|architecture|framework|preliminar|algorithm|implementation|方法|模型|算法|架构)\b/.test(t)) return 'method';
  if (/^(experiment|evaluation|result|analysis|ablation|benchmark|实验|结果|评测|分析)\b/.test(t)) return 'results';
  if (/^(discussion|讨论)\b/.test(t)) return 'discussion';
  if (/^(conclusion|concluding|summary|limitation|future work|结论|总结|局限|展望)\b/.test(t)) return 'conclusion';
  if (/^(reference|bibliograph|参考文献|引用)\b/.test(t)) return 'references';
  if (/^(acknowledg|致谢|鸣谢)\b/.test(t)) return 'acknowledgement';
  if (/^(appendix|supplement|附录|补充)\b/.test(t)) return 'appendix';
  return 'other';
}

/* ---------------- L1：PDF 书签 ---------------- */

function fromBookmarks(bookmarks) {
  if (!Array.isArray(bookmarks) || bookmarks.length < 3) return [];
  return bookmarks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.page && b.title && b.title.length <= 120)
    .map(({ b, i }) => ({
      title: b.title,
      level: Math.min(3, Math.max(1, b.level || 1)),
      page: b.page,
      yFrac: 0,
      seq: i,
      type: classifySection(b.title),
      source: 'bookmark',
    }));
}

/* ---------------- L2：启发式 ---------------- */

const NUM_RE = /^(\d+(?:\.\d+)*|[IVXLC]+)[.)]?\s+(\S.*)$/;

// 无编号也能一眼认出的标题（允许与正文同行，取标题片段）
const STRONG_HEAD = /^(abstract|references|bibliography|acknowledg\w*|appendix|supplement|摘要|参考文献|致谢|附录)/i;
// 常见章节名：后面必须跟空格/冒号/行尾，避免把 "model. The existence..." 当成标题
const GENERIC_HEAD =
  /^(introduction|related work|background|prior work|literature review|method|methods|methodology|approach|model|architecture|framework|preliminaries|implementation|experiments?|evaluation|results?|analysis|ablation|discussion|conclusions?|concluding remarks|summary|limitations|future work|引言|相关工作|研究背景|方法|模型|算法|实验|结果|分析|讨论|结论|总结|局限|展望)(?=[\s:：]|$)/i;
// 单独一个词就毫无歧义的标题（"method" / "model" 这种多半是表格表头）
const UNAMBIGUOUS_SINGLE =
  /^(introduction|references|bibliography|abstract|conclusions?|discussion|acknowledg\w*|appendix|supplement|summary|related work|引言|绪论|参考文献|摘要|结论|讨论|致谢|附录|总结)$/i;
// 标题后面不该直接接这些小写的功能词
const SENTENCE_START = /^(the|a|an|in|we|this|these|those|it|is|are|was|were|and|or|for|to|of|on|at|as|by|with|has|have|can|will)\b/i;

/** 目录页：大量 "......" 引导点，识别出的“章节”其实是目录条目 */
function isTocPage(page) {
  return (page.lines ?? []).filter((l) => /\.{4,}/.test(l.text)).length >= 4;
}

function buildHeuristic(ex) {
  const pages = ex.pages ?? [];
  if (!pages.length) return [];

  // 正文字号 = 全篇出现最多的字号
  const hist = new Map();
  for (const p of pages) {
    for (const l of p.lines) {
      const s = r1(l.size);
      hist.set(s, (hist.get(s) ?? 0) + 1);
    }
  }
  const bodySize = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;

  // 跨页重复的页眉/页脚
  const seen = new Map();
  for (const p of pages) {
    const h = p.height || 792;
    for (const l of p.lines) {
      const rel = (h - l.y) / h;
      if (rel < 0.12 || rel > 0.92) {
        const k = normKey(l.text);
        if (k.length >= 3) {
          if (!seen.has(k)) seen.set(k, new Set());
          seen.get(k).add(p.page);
        }
      }
    }
  }
  const runningHeads = new Set([...seen.entries()].filter(([, ps]) => ps.size >= 3).map(([k]) => k));

  // 首页题名区：Abstract 之前的题目/作者/单位都不是章节
  const p1 = pages[0];
  const firstAbstract = (p1?.lines ?? []).find((l) => /^abstract\b/i.test(l.text.trim()));
  const titleZoneY = firstAbstract ? firstAbstract.y : -Infinity;

  const out = [];
  let seq = 0;
  for (const p of pages) {
    if (isTocPage(p)) continue;
    const h = p.height || 792;
    for (let i = 0; i < (p.lines ?? []).length; i++) {
      const line = p.lines[i];
      const text = String(line.text ?? '').trim();
      if (!text || text.length > 120) continue;
      const key = normKey(text);
      if (key.length < 3 || runningHeads.has(key)) continue;
      // 首页 Abstract 以上 = 题名区
      if (p.page === 1 && line.y > titleZoneY) continue;
      if (/^\[\d+\]/.test(text)) continue; // 参考文献条目
      if (/^(figure|table|fig\.|tab\.|图|表)\s*\d/i.test(text)) continue; // 图表标题
      if (/^[\d\s.·]+$/.test(text)) continue;

      const rel = Math.min(1, Math.max(0, (h - line.y) / h));
      const big = line.size >= bodySize * 1.13;

      const push = (title, level, source) =>
        out.push({
          title,
          level,
          page: p.page,
          yFrac: rel,
          size: line.size,
          lineIndex: i,
          seq: seq++,
          type: classifySection(title),
          source,
        });

      // 1) 强标题：Abstract / References / 致谢 / 附录（可能与正文同行，截断即可）
      const strong = STRONG_HEAD.exec(text);
      if (strong) {
        push(strong[0].trim(), 1, 'pattern');
        continue;
      }

      // 2) 编号标题：2.1 / IV. 等
      const numM = NUM_RE.exec(text);
      if (numM) {
        const rest = numM[2];
        const letters = (rest.match(/[A-Za-z\u4e00-\u9fff]/g) ?? []).length;
        const looksLikeHeading =
          rest.length <= 80 &&
          letters >= 3 &&
          /^[A-Z\u4e00-\u9fff“"\[]/.test(rest) &&
          !SENTENCE_START.test(rest) &&
          !/[.,;:]$/.test(rest);
        if (looksLikeHeading) {
          const num = numM[1];
          push(text, num.includes('.') ? Math.min(3, num.split('.').length) : 1, 'number');
          continue;
        }
      }

      // 3) 命中常见章节名，且整行就是标题
      const gen = GENERIC_HEAD.exec(text);
      if (gen && text.length <= 70 && !/\.\s/.test(text) && !/[.,;:]$/.test(text)) {
        const rest = text.slice(gen[0].length).trim();
        // 单独一个词时，只有含义明确的词才算（"method" / "model" 多半是表头）
        if (rest === '' && !big && !UNAMBIGUOUS_SINGLE.test(text)) continue;
        // 后面若还有内容，必须是新词的开始（大写/中文/数字），不能是小写延续
        if (rest !== '' && !/^[A-Z\u4e00-\u9fff\d“"\[]/.test(rest)) continue;
        push(text, 1, 'pattern');
        continue;
      }

      // 4) 字号明显大于正文 + 短 + 不以标点结尾
      if (big && text.length <= 70 && !/[.,;:]$/.test(text)) {
        push(text, 1, 'font');
      }
    }
  }

  // 合并被断行的标题：下一行以小写字母开头、同字号、紧邻、且自身不像标题
  const merged = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    const isContinuation =
      prev &&
      prev.page === s.page &&
      Math.abs(prev.size - s.size) < 0.2 &&
      s.lineIndex === prev.lineIndex + 1 &&
      /^[a-z(\u4e00-\u9fff]/.test(s.title) &&
      !NUM_RE.test(s.title) &&
      prev.source === s.source;
    if (isContinuation) {
      prev.title = `${prev.title} ${s.title}`.replace(/\s+/g, ' ').trim();
      prev.lineIndex = s.lineIndex;
      prev.type = classifySection(prev.title);
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

/* ---------------- L3：DeepSeek 语义解析 ---------------- */

const LLM_SYSTEM = `你是学术论文结构解析器。用户会给你一篇论文的逐页正文，请识别它的章节结构，输出 json。

字段：sections —— 对象数组，按论文中出现的先后顺序排列，每项含：
- title：章节标题，保留论文原本的编号与措辞（例如 "3.1 Residual Learning"、"II. DETECTORS"）
- level：1 表示一级标题，2 表示二级，3 表示三级
- page：该章节**起始**页码（整数，与给出的 [第 N 页] 对应）
- type：从 abstract / introduction / related / method / results / discussion / conclusion / references / acknowledgement / appendix / other 中选一个

样例输出：
{"sections":[{"title":"Abstract","level":1,"page":1,"type":"abstract"},{"title":"1 Introduction","level":1,"page":1,"type":"introduction"},{"title":"3.1 Residual Learning","level":2,"page":2,"type":"method"}]}

要求：只列真实章节标题；不要把正文句子、图表标题、页眉页脚、参考文献条目当成章节；顺序必须与论文一致。`;

async function fromLlm(ex, apiKey) {
  if (!apiKey) return { sections: [], note: '未配置 API Key' };
  const text = (ex.pages ?? [])
    .map((p) => `[第 ${p.page} 页]\n${p.text}`)
    .join('\n\n')
    .slice(0, 80000);
  const { data, usage } = await chatJson({
    apiKey,
    model: MODELS.flash,
    system: LLM_SYSTEM,
    user: `论文全文如下：\n\n${text}`,
    maxTokens: 4096,
  });
  const sections = (Array.isArray(data.sections) ? data.sections : [])
    .map((s, i) => ({
      title: String(s.title ?? '').replace(/\s+/g, ' ').trim(),
      level: Math.min(3, Math.max(1, Number(s.level) || 1)),
      page: Math.min(ex.pages.length, Math.max(1, Number(s.page) || 1)),
      yFrac: 0,
      seq: i,
      type: SECTION_TYPES.includes(s.type) ? s.type : classifySection(s.title),
      source: 'llm',
    }))
    .filter((s) => s.title && s.title.length <= 120);
  return { sections, usage };
}

/* ---------------- 合并：语义来自 A，几何（精确 y）来自 B ---------------- */

function snapGeometry(sections, geometric) {
  return sections.map((s) => {
    const key = normKey(s.title);
    if (!key) return s;
    // 同页优先；标题前缀互相包含即可认为对应同一节
    const samePage = geometric.filter((g) => g.page === s.page);
    const pool = samePage.length ? samePage : geometric;
    let best = null;
    let bestScore = 0;
    for (const g of pool) {
      const gk = normKey(g.title);
      if (!gk) continue;
      let score = 0;
      if (gk === key) score = 3;
      else if (gk.startsWith(key) || key.startsWith(gk)) score = 2;
      if (score > bestScore) {
        bestScore = score;
        best = g;
      }
    }
    return best ? { ...s, yFrac: best.yFrac } : s;
  });
}

/* ---------------- 主入口 ---------------- */

export async function buildOutline(ex, { bookmarks = [], apiKey = '', useAi = false } = {}) {
  const geometric = buildHeuristic(ex);
  const notes = [];

  let primary = [];
  let source = 'heuristic';

  const bm = fromBookmarks(bookmarks);
  if (bm.length >= 3) {
    primary = bm;
    source = 'bookmark';
    notes.push(`使用 PDF 自带书签（${bm.length} 条）`);
  } else {
    primary = geometric.map(({ title, level, page, yFrac, type, seq }) => ({ title, level, page, yFrac, type, seq, source: 'font' }));
    notes.push(
      geometric.length
        ? `PDF 无书签，用字号+编号启发式识别出 ${geometric.length} 个标题`
        : '未能从版面识别出章节',
    );
  }

  if (useAi) {
    try {
      const { sections: llm, usage } = await fromLlm(ex, apiKey);
      if (llm.length >= 3) {
        primary = snapGeometry(llm, geometric);
        source = 'llm';
        notes.push(`DeepSeek 解析出 ${llm.length} 个章节，并用版面信息对齐了跳转位置`);
        if (usage) notes.push(`tokens: ${usage.prompt_tokens ?? '?'} in / ${usage.completion_tokens ?? '?'} out`);
      } else {
        notes.push('DeepSeek 返回的章节过少，保留原有结果');
      }
    } catch (e) {
      notes.push(`DeepSeek 解析失败：${e.message}`);
    }
  } else if (source === 'bookmark') {
    primary = snapGeometry(primary, geometric);
  }

  // 排序 + 去重 + 编号。
  // 用 seq（阅读顺序）而不是 yFrac 排序 —— 双栏页面里左栏靠下的章节在阅读顺序上先于右栏靠上的章节。
  const sections = primary
    .filter((s) => s.title && s.page)
    .sort((a, b) => a.page - b.page || (a.seq ?? 0) - (b.seq ?? 0))
    .filter((s, i, arr) => {
      const prev = arr[i - 1];
      return !prev || normKey(prev.title) !== normKey(s.title) || prev.page !== s.page;
    })
    .map((s, i) => ({ ...s, id: `sec-${i + 1}` }));

  // 少数 PDF 的书签里子节点排在父节点前面（例如 DeepSeek-V4 的 "Muon Optimizer" 在
  // "General Infrastructures" 之前），同页且版面位置明显矛盾时按位置纠正一次。
  for (let i = 0; i + 1 < sections.length; i++) {
    const a = sections[i];
    const b = sections[i + 1];
    if (a.page === b.page && a.level > b.level && b.yFrac < a.yFrac - 0.03) {
      sections[i] = b;
      sections[i + 1] = a;
    }
  }

  return {
    sections,
    source,
    notes,
    counts: {
      total: sections.length,
      byType: sections.reduce((acc, s) => ((acc[s.type] = (acc[s.type] ?? 0) + 1), acc), {}),
    },
  };
}
