// 引用生成：CSL 样式走 citeproc-js（与 Zotero 同款引擎），交换格式自行序列化。
//
// 样式与 locale 文件按需从官方仓库下载并缓存到 data/csl/，首次使用需要联网，之后离线可用。
// 注意：CSL 样式来自 citation-style-language/styles，授权为 CC-BY-SA 3.0；再分发时需保留署名。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR } from './db.js';
import { normalizeType } from './csl-types.js';

const require = createRequire(import.meta.url);
// citeproc 是较大的 CJS 库，延迟到真正渲染引用时再加载
let _CSL = null;
const getCSL = () => (_CSL ??= require('citeproc'));

export const CSL_DIR = path.join(DATA_DIR, 'csl');
const STYLE_DIR = path.join(CSL_DIR, 'styles');
const LOCALE_DIR = path.join(CSL_DIR, 'locales');
fs.mkdirSync(STYLE_DIR, { recursive: true });
fs.mkdirSync(LOCALE_DIR, { recursive: true });

const STYLE_BASE = 'https://raw.githubusercontent.com/citation-style-language/styles/master';
const LOCALE_BASE = 'https://raw.githubusercontent.com/citation-style-language/locales/master';

/* ---------------- 格式目录 ---------------- */

export const CSL_STYLES = [
  { id: 'apa', label: 'APA 7th', note: '心理学 / 社科最常用（著者-出版年）' },
  { id: 'modern-language-association', label: 'MLA 9th', note: '文学 / 人文' },
  { id: 'chicago-author-date', label: 'Chicago 著者-出版年', note: '历史 / 部分社科' },
  { id: 'ieee', label: 'IEEE', note: '工程 / 计算机（顺序编码）' },
  { id: 'china-national-standard-gb-t-7714-2015-numeric', label: 'GB/T 7714-2015 顺序编码', note: '中文期刊常用' },
  { id: 'china-national-standard-gb-t-7714-2015-author-date', label: 'GB/T 7714-2015 著者-出版年', note: '中文社科' },
  { id: 'harvard-cite-them-right', label: 'Harvard (Cite Them Right)', note: '英国高校常用' },
  { id: 'american-medical-association', label: 'AMA / Vancouver 系', note: '医学 / 生物（顺序编码）' },
  { id: 'nature', label: 'Nature', note: '自然科学研究论文' },
];

export const EXCHANGE_FORMATS = [
  { id: 'bibtex', label: 'BibTeX', ext: 'bib', mime: 'application/x-bibtex', note: 'LaTeX / Overleaf' },
  { id: 'ris', label: 'RIS', ext: 'ris', mime: 'application/x-research-info-systems', note: 'EndNote / NoteExpress / Mendeley' },
  { id: 'endnote-xml', label: 'EndNote XML', ext: 'xml', mime: 'application/xml', note: 'EndNote 直接导入' },
  { id: 'csl-json', label: 'CSL-JSON', ext: 'json', mime: 'application/json', note: 'Zotero / Pandoc / Quarto' },
  { id: 'markdown', label: 'Markdown 列表', ext: 'md', mime: 'text/markdown', note: '笔记 / Obsidian' },
  { id: 'latex', label: 'LaTeX thebibliography', ext: 'tex', mime: 'text/x-tex', note: '直接粘进 .tex' },
  { id: 'plain', label: '纯文本引用串', ext: 'txt', mime: 'text/plain', note: '通用著者-年份格式' },
];

export const FORMATS = () => ({
  styles: CSL_STYLES,
  exchange: EXCHANGE_FORMATS,
  locales: [
    { id: 'zh-CN', label: '中文' },
    { id: 'en-US', label: 'English' },
  ],
});

/* ---------------- 资产缓存 ---------------- */

const assetCache = new Map();

async function fetchCached(url, file, label) {
  if (assetCache.has(file)) return assetCache.get(file);
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    assetCache.set(file, text);
    return text;
  }
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new Error(`${label} 未缓存且下载失败（需要联网一次）：${e.message}`);
  }
  if (!res.ok) throw new Error(`${label} 下载失败：HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('<style') && !text.includes('<locale')) throw new Error(`${label} 内容异常，可能被网关拦截`);
  fs.writeFileSync(file, text);
  assetCache.set(file, text);
  return text;
}

export const ensureStyle = (id) =>
  fetchCached(`${STYLE_BASE}/${id}.csl`, path.join(STYLE_DIR, `${id}.csl`), `CSL 样式 ${id}`);

export const ensureLocale = (lang) =>
  fetchCached(`${LOCALE_BASE}/locales-${lang}.xml`, path.join(LOCALE_DIR, `locales-${lang}.xml`), `CSL locale ${lang}`);

/** 预热：把目录里所有样式与 locale 拉下来（离线也能用） */
export async function warmAssets() {
  const done = [];
  for (const s of CSL_STYLES) {
    try {
      await ensureStyle(s.id);
      done.push(s.id);
    } catch (e) {
      done.push(`✗ ${s.id}: ${e.message}`);
    }
  }
  for (const l of ['zh-CN', 'en-US']) {
    try {
      await ensureLocale(l);
      done.push(l);
    } catch (e) {
      done.push(`✗ ${l}: ${e.message}`);
    }
  }
  return done;
}

/* ---------------- 条目 → CSL item ---------------- */

export function toCslItem(row) {
  const extra = row.csl && typeof row.csl === 'object' ? row.csl : {};
  const csl = {
    id: `item-${row.id}`,
    type: normalizeType(extra.type),
    title: row.title || '',
    author: (row.authors ?? [])
      .filter((a) => a && (a.family || a.given))
      .map((a) => ({ family: a.family || '', given: a.given || '' })),
  };
  if (row.year) csl.issued = { 'date-parts': [[row.year]] };
  if (row.venue) csl['container-title'] = row.venue;
  if (row.doi) csl.DOI = row.doi;
  if (row.url) csl.URL = row.url;
  if (row.abstract) csl.abstract = row.abstract;
  for (const k of [
    'volume', 'issue', 'page', 'publisher', 'publisher-place', 'edition', 'number',
    'number-of-pages', 'genre', 'collection-title', 'event', 'event-place', 'ISBN', 'ISSN', 'language',
  ]) {
    if (extra[k]) csl[k] = extra[k];
  }
  return csl;
}

/* ---------------- CSL 渲染 ---------------- */

function makeEngine(styleXml, localeXml, lang) {
  const CSL = getCSL();
  return new CSL.Engine(
    {
      retrieveLocale: () => localeXml,
      retrieveItem: (id) => makeEngine.items[id],
    },
    styleXml,
    lang,
  );
}

/**
 * 用 CSL 样式渲染。
 * 返回 { inline, bibliography: string[], html: { inline, bibliography } }
 */
export function renderCsl(items, styleXml, localeXml, lang = 'en-US') {
  const map = {};
  const ids = [];
  for (const it of items) {
    const csl = toCslItem(it);
    map[csl.id] = csl;
    ids.push(csl.id);
  }
  makeEngine.items = map;

  const run = (format) => {
    const engine = makeEngine(styleXml, localeXml, lang);
    engine.setOutputFormat(format);
    engine.updateItems(ids);
    const inline = engine.makeCitationCluster(ids.map((id) => ({ id })));
    const bib = engine.makeBibliography();
    const entries = (bib?.[1] ?? []).map((s) => String(s).trim());
    return { inline: String(inline).trim(), entries, opt: engine.opt ?? {} };
  };

  const text = run('text');
  const html = run('html');
  return {
    inline: text.inline,
    inlineHtml: html.inline,
    bibliography: text.entries,
    bibliographyHtml: html.entries,
    styleMeta: {
      title: text.opt.styleName ?? '',
      styleId: text.opt.styleID ?? '',
      // citation-format 在 CSL 1.0.2 里是 <info><category citation-format="..."/>，
      // 老样式可能直接写在 <style> 上，两种都认。
      citationFormat:
        /<category[^>]*\bcitation-format="([^"]+)"/.exec(styleXml)?.[1] ??
        /<style[^>]*\bcitation-format="([^"]+)"/.exec(styleXml)?.[1] ??
        '',
    },
  };
}

/* ---------------- 通用著者-年份格式 ---------------- */

const initials = (given) =>
  String(given || '')
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((p) => `${p[0].toUpperCase()}.`)
    .join(' ');

function apaAuthor(a) {
  if (!a.family && !a.given) return '';
  if (!a.family) return a.given;
  return a.given ? `${a.family}, ${initials(a.given)}` : a.family;
}

function authorYearList(authors = []) {
  const list = authors.map(apaAuthor).filter(Boolean);
  if (!list.length) return { text: '', first: '', short: '' };
  const first = list[0].split(',')[0];
  if (list.length === 1) return { text: list[0], first, short: first };
  if (list.length <= 6) {
    const head = list.slice(0, -1).join(', ');
    return { text: `${head}, & ${list.at(-1)}`, first, short: `${first} et al.` };
  }
  return { text: `${list.slice(0, 3).join(', ')}, et al.`, first, short: `${first} et al.` };
}

export function formatPlainItem(row) {
  const a = authorYearList(row.authors ?? []);
  const year = row.year ? `(${row.year}).` : '(n.d.).';
  const parts = [a.text ? `${a.text} ${year}` : year];
  if (row.title) parts.push(/[.!?]$/.test(row.title) ? row.title : `${row.title}.`);
  const tail = [];
  if (row.venue) tail.push(row.venue);
  const extra = row.csl && typeof row.csl === 'object' ? row.csl : {};
  const volIss = [extra.volume, extra.issue ? `(${extra.issue})` : '', extra.page ? `, ${extra.page}` : '']
    .filter(Boolean)
    .join('');
  if (volIss) tail.push(volIss.replace(/^,/, '').trim());
  if (tail.length) parts.push(`${tail.join(', ')}.`);
  if (row.doi) parts.push(`https://doi.org/${row.doi}`);
  else if (row.url) parts.push(row.url);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function formatPlainInline(row) {
  const a = authorYearList(row.authors ?? []);
  return `${a.short || '佚名'}, ${row.year ?? 'n.d.'}`;
}

function markdownRef(row) {
  const text = formatPlainItem(row);
  return row.url || row.doi ? `- [${row.title || text}](${row.doi ? `https://doi.org/${row.doi}` : row.url}) — ${text}` : `- ${text}`;
}

/* ---------------- LaTeX ---------------- */

const LATEX_ESCAPE = [
  [/\\/g, '\\textbackslash{}'],
  [/[&%$#_{}]/g, (m) => `\\${m}`],
  [/~/g, '\\textasciitilde{}'],
  [/\^/g, '\\textasciicircum{}'],
];
const tex = (s) =>
  LATEX_ESCAPE.reduce((acc, [re, to]) => acc.replace(re, to), String(s ?? ''));

function bibKey(row, used) {
  const fam = (row.authors?.[0]?.family || 'anon').toLowerCase().replace(/[^a-z]/g, '');
  const year = row.year ?? 'nd';
  const word = (row.title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .find((w) => w.length > 3) ?? 'paper';
  let key = `${fam}${year}${word}`;
  let n = 97;
  while (used.has(key)) key = `${fam}${year}${word}${String.fromCharCode(n++)}`;
  used.add(key);
  return key;
}

/* ---------------- 交换格式 ---------------- */

const BIBTEX_TYPE = {
  'article-journal': 'article',
  'article-magazine': 'article',
  'article-newspaper': 'article',
  article: 'article',
  'paper-conference': 'inproceedings',
  chapter: 'incollection',
  'entry-encyclopedia': 'incollection',
  book: 'book',
  thesis: 'phdthesis',
  report: 'techreport',
  manuscript: 'unpublished',
  webpage: 'misc',
  'posted-content': 'misc',
  dataset: 'misc',
  software: 'misc',
  patent: 'misc',
  speech: 'inproceedings',
};

const RIS_TYPE = {
  'article-journal': 'JOUR',
  'article-magazine': 'MGZN',
  'article-newspaper': 'NEWS',
  article: 'JOUR',
  'paper-conference': 'CPAPER',
  chapter: 'CHAP',
  book: 'BOOK',
  thesis: 'THES',
  report: 'RPRT',
  webpage: 'ELEC',
  'posted-content': 'UNPB',
  dataset: 'DATA',
  patent: 'PAT',
};

const ENDNOTE_TYPE = {
  'article-journal': ['Journal Article', 17],
  'article-magazine': ['Magazine Article', 19],
  'article-newspaper': ['Newspaper Article', 23],
  article: ['Journal Article', 17],
  'paper-conference': ['Conference Paper', 10],
  chapter: ['Book Section', 5],
  book: ['Book', 6],
  thesis: ['Thesis', 32],
  report: ['Report', 27],
  webpage: ['Web Page', 12],
  dataset: ['Dataset', 59],
  patent: ['Patent', 21],
};

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function bibField(name, value) {
  if (value === undefined || value === null || value === '') return '';
  const v = String(value).replace(/[&%$#_]/g, (m) => `\\${m}`).replace(/[{}]/g, (m) => `\\${m}`);
  return `  ${name.padEnd(9)} = {${v}},\n`;
}

export function toBibtex(items) {
  const used = new Set();
  const out = items
    .map((row) => {
      const extra = row.csl && typeof row.csl === 'object' ? row.csl : {};
      const cslType = normalizeType(extra.type);
      // 没有 DOI 的 arXiv 预印本按 @misc + eprint 输出，比硬塞 @article 规范
      const preprint = !!row.arxiv_id && !row.doi;
      const type = preprint ? 'misc' : BIBTEX_TYPE[cslType] ?? 'misc';
      const authors = (row.authors ?? [])
        .filter((a) => a.family || a.given)
        .map((a) => (a.family ? `${a.family}, ${a.given || ''}`.trim().replace(/,$/, '') : a.given))
        .join(' and ');
      let body = '';
      body += bibField('author', authors);
      body += bibField('title', row.title);
      if (!preprint) {
        body += bibField('journal', row.venue);
        body += bibField('booktitle', type === 'inproceedings' ? row.venue : undefined);
      }
      body += bibField('year', row.year);
      if (preprint) {
        body += bibField('eprint', String(row.arxiv_id).replace(/v\d+$/, ''));
        body += bibField('archivePrefix', 'arXiv');
      }
      body += bibField('volume', extra.volume);
      body += bibField('number', extra.issue);
      body += bibField('pages', extra.page ? String(extra.page).replace(/\s*[-–]\s*/, '--') : undefined);
      body += bibField('publisher', extra.publisher);
      body += bibField('doi', row.doi);
      body += bibField('url', row.url || (row.doi ? `https://doi.org/${row.doi}` : undefined));
      return `@${type}{${bibKey(row, used)},\n${body}}`;
    })
    .join('\n\n');
  return `${out}\n`;
}

export function toRis(items) {
  return items
    .map((row) => {
      const extra = row.csl && typeof row.csl === 'object' ? row.csl : {};
      const lines = [`TY  - ${RIS_TYPE[normalizeType(extra.type)] ?? 'GEN'}`];
      for (const a of row.authors ?? []) {
        if (a.family || a.given) lines.push(`AU  - ${a.family || ''}${a.given ? `, ${a.given}` : ''}`.trimEnd());
      }
      if (row.title) lines.push(`TI  - ${row.title}`);
      if (row.venue) lines.push(`JO  - ${row.venue}`);
      if (extra.volume) lines.push(`VL  - ${extra.volume}`);
      if (extra.issue) lines.push(`IS  - ${extra.issue}`);
      if (extra.page) {
        const [sp, ep] = String(extra.page).split(/\s*[-–]\s*/);
        lines.push(`SP  - ${sp}`);
        if (ep) lines.push(`EP  - ${ep}`);
      }
      if (row.year) lines.push(`PY  - ${row.year}`);
      if (extra.publisher) lines.push(`PB  - ${extra.publisher}`);
      if (row.doi) lines.push(`DO  - ${row.doi}`);
      if (row.url) lines.push(`UR  - ${row.url}`);
      if (row.abstract) lines.push(`AB  - ${row.abstract.replace(/\s+/g, ' ').slice(0, 1200)}`);
      lines.push('ER  - ', '');
      return lines.join('\n');
    })
    .join('\n');
}

export function toEndNoteXml(items) {
  const records = items
    .map((row, i) => {
      const extra = row.csl && typeof row.csl === 'object' ? row.csl : {};
      const [typeName, typeId] = ENDNOTE_TYPE[normalizeType(extra.type)] ?? ['Generic', 13];
      const authors = (row.authors ?? [])
        .filter((a) => a.family || a.given)
        .map((a) => `        <author>${esc(a.family ? `${a.family}, ${a.given || ''}`.trim().replace(/,$/, '') : a.given)}</author>`)
        .join('\n');
      const doi = row.doi ? `https://doi.org/${row.doi}` : row.url;
      return `    <record>
      <rec-number>${i + 1}</rec-number>
      <ref-type name="${esc(typeName)}">${typeId}</ref-type>
      <contributors>
        <authors>
${authors}
        </authors>
      </contributors>
      <titles>
        <title>${esc(row.title)}</title>
${row.venue ? `        <secondary-title>${esc(row.venue)}</secondary-title>` : ''}
      </titles>
${row.venue ? `      <periodical>\n        <full-title>${esc(row.venue)}</full-title>\n      </periodical>` : ''}
${row.year ? `      <dates>\n        <year>${row.year}</year>\n      </dates>` : ''}
${extra.volume ? `      <volume>${esc(extra.volume)}</volume>` : ''}
${extra.issue ? `      <number>${esc(extra.issue)}</number>` : ''}
${extra.page ? `      <pages>${esc(extra.page)}</pages>` : ''}
${extra.publisher ? `      <publisher>\n        <publisher>${esc(extra.publisher)}</publisher>\n      </publisher>` : ''}
${row.abstract ? `      <abstract>${esc(row.abstract.replace(/\s+/g, ' ').slice(0, 2000))}</abstract>` : ''}
${doi ? `      <urls>\n        <related-urls>\n          <url>${esc(doi)}</url>\n        </related-urls>\n      </urls>` : ''}
${row.doi ? `      <electronic-resource-num>${esc(row.doi)}</electronic-resource-num>` : ''}
    </record>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xml>\n  <records>\n${records}\n  </records>\n</xml>\n`;
}

export function toCslJson(items) {
  return `${JSON.stringify(items.map(toCslItem), null, 2)}\n`;
}

export function toMarkdown(items) {
  return `# 参考文献\n\n${items.map(markdownRef).join('\n')}\n`;
}

export function toLatex(items) {
  const used = new Set();
  const keys = items.map((row) => bibKey(row, used));
  const body = items
    .map((row, i) => {
      const a = authorYearList(row.authors ?? []);
      const extra = row.csl && typeof row.csl === 'object' ? row.csl : {};
      const parts = [];
      const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
      if (a.text) parts.push(sentence(tex(a.text)));
      if (row.title) parts.push(sentence(tex(row.title)));
      let venue = '';
      if (row.venue) venue += `\\textit{${tex(row.venue)}}`;
      if (extra.volume) venue += `${venue ? ', ' : ''}${tex(extra.volume)}`;
      if (extra.issue) venue += `(${tex(extra.issue)})`;
      if (extra.page) venue += `:${tex(extra.page)}`;
      if (venue) parts.push(`${venue}.`);
      if (row.year) parts.push(`${row.year}.`);
      if (row.doi) parts.push(`\\url{https://doi.org/${tex(row.doi)}}`);
      return `\\bibitem{${keys[i]}}\n${parts.join(' ').replace(/\s+/g, ' ').trim()}`;
    })
    .join('\n\n');
  return `% 正文里用 \\cite{${keys.join(', ')}} 引用\n\\begin{thebibliography}{${items.length}}\n\n${body}\n\n\\end{thebibliography}\n`;
}

export const EXCHANGE_IMPL = {
  bibtex: toBibtex,
  ris: toRis,
  'endnote-xml': toEndNoteXml,
  'csl-json': toCslJson,
  markdown: toMarkdown,
  latex: toLatex,
  plain: (items) => `${items.map(formatPlainItem).join('\n\n')}\n`,
};

export const KNOWN_FORMATS = new Set([
  ...CSL_STYLES.map((s) => s.id),
  ...EXCHANGE_FORMATS.map((f) => f.id),
]);

/* ---------------- 统一入口 ---------------- */

export async function generateCitation(items, format, { locale = 'en-US', includeInline = true } = {}) {
  const style = CSL_STYLES.find((s) => s.id === format);
  if (style) {
    const [styleXml, localeXml] = await Promise.all([ensureStyle(format), ensureLocale(locale)]);
    const r = renderCsl(items, styleXml, localeXml, locale);
    return {
      kind: 'csl',
      format,
      label: style.label,
      styleMeta: r.styleMeta,
      inline: includeInline ? r.inline : '',
      inlineHtml: includeInline ? cleanCslHtml(r.inlineHtml) : '',
      bibliography: r.bibliography,
      bibliographyHtml: r.bibliographyHtml.map(cleanCslHtml),
      text: [includeInline && r.inline ? `文中引用：${r.inline}` : '', ...r.bibliography].filter(Boolean).join('\n'),
      html: [includeInline && r.inlineHtml ? `<div class="csl-inline">${cleanCslHtml(r.inlineHtml)}</div>` : '', ...r.bibliographyHtml.map(cleanCslHtml)]
        .filter(Boolean)
        .join(''),
    };
  }
  const impl = EXCHANGE_IMPL[format];
  if (!impl) throw new Error(`未知格式：${format}`);
  const spec = EXCHANGE_FORMATS.find((f) => f.id === format);
  const text = impl(items);
  return {
    kind: 'exchange',
    format,
    label: spec?.label ?? format,
    ext: spec?.ext ?? 'txt',
    mime: spec?.mime ?? 'text/plain',
    inline: format === 'plain' || format === 'markdown' ? items.map(formatPlainInline).join('; ') : '',
    bibliography: format === 'plain' ? items.map(formatPlainItem) : [],
    text,
    html: '',
  };
}

/** citeproc 的 HTML 只保留少量安全标签，防止元数据里的尖括号跑出来 */
export function cleanCslHtml(html) {
  return String(html ?? '')
    .replace(/<(?!\/?(?:i|b|sup|sub|span|div|br)\b)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/\sstyle\s*=\s*"(?![^"]*(?:font-variant|font-style|vertical-align)[^"]*)[^"]*"/gi, '');
}
