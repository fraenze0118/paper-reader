// CSL 条目类型：合法类型集合、数据源类型别名、中文显示名。
// 独立成模块是为了避免 db.js ↔ cite.js 的循环依赖（两边都要用）。

export const CSL_TYPES = new Set([
  'article', 'article-journal', 'article-magazine', 'article-newspaper', 'bill', 'book', 'broadcast',
  'chapter', 'classic', 'collection', 'dataset', 'document', 'entry', 'entry-dictionary',
  'entry-encyclopedia', 'event', 'figure', 'graphic', 'hearing', 'interview', 'legal_case', 'legislation',
  'manuscript', 'map', 'motion_picture', 'musical_score', 'pamphlet', 'paper-conference', 'patent',
  'performance', 'periodical', 'personal_communication', 'post', 'post-weblog', 'regulation', 'report',
  'review', 'review-book', 'software', 'song', 'speech', 'standard', 'thesis', 'treaty', 'webpage',
]);

const TYPE_ALIAS = {
  'journal-article': 'article-journal',
  'journal-issue': 'article-journal',
  'journal-volume': 'article-journal',
  journal: 'article-journal',
  'proceedings-article': 'paper-conference',
  'conference-paper': 'paper-conference',
  proceedings: 'book',
  'proceedings-series': 'book',
  'book-chapter': 'chapter',
  'book-part': 'chapter',
  'book-section': 'chapter',
  'book-series': 'book',
  'edited-book': 'book',
  'reference-book': 'book',
  'reference-entry': 'entry-encyclopedia',
  monograph: 'book',
  'posted-content': 'article',
  preprint: 'article',
  dissertation: 'thesis',
  'report-series': 'report',
  component: 'article',
  'peer-review': 'article',
  database: 'dataset',
  grant: 'report',
  other: 'article',
};

export const TYPE_LABELS = {
  'article-journal': '期刊论文',
  'article-magazine': '杂志文章',
  'article-newspaper': '报纸文章',
  article: '预印本 / 综述',
  'paper-conference': '会议论文',
  book: '图书',
  chapter: '图书章节',
  'entry-encyclopedia': '百科条目',
  thesis: '学位论文',
  report: '报告',
  manuscript: '手稿',
  webpage: '网页',
  dataset: '数据集',
  software: '软件',
  patent: '专利',
  speech: '演讲',
  standard: '标准',
};

export const typeLabel = (t) => TYPE_LABELS[t] ?? t ?? '其他';

export function normalizeType(type) {
  const t = String(type || '').trim();
  if (CSL_TYPES.has(t)) return t;
  return TYPE_ALIAS[t] ?? 'article';
}
