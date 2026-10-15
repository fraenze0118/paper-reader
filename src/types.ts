export interface Author {
  given?: string;
  family?: string;
}

export interface Attachment {
  id: number;
  filename: string;
  byte_size: number;
  page_count: number;
  created: string;
}

export interface Tag {
  id: number;
  name: string;
  color: string;
  count?: number;
}

export interface Collection {
  id: number;
  name: string;
  count?: number;
}

export interface Item {
  id: number;
  item_key: string;
  title: string;
  abstract: string;
  year: number | null;
  venue: string;
  doi: string;
  arxiv_id: string;
  url: string;
  authors: Author[];
  csl: Record<string, unknown>;
  meta_source: string;
  meta_confidence: 'high' | 'medium' | 'low';
  needs_review: boolean;
  date_added: string;
  attachments: Attachment[];
  tags: Tag[];
  collections: Collection[];
  annotation_count: number;
  note_count: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Annotation {
  id: number;
  item_id: number;
  attachment_id: number;
  page: number;
  kind: 'highlight' | 'area' | 'note';
  color: string;
  rects: Rect[];
  rects_json: string;
  text: string;
  comment: string;
  image_data: string;
  created: string;
}

export interface Note {
  id: number;
  item_id: number;
  md: string;
  source: string;
  created: string;
}

export interface ChatStats {
  model: string;
  thinking: boolean;
  mode: 'live' | 'mock';
  elapsed_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_hit_tokens: number | null;
  cache_miss_tokens: number | null;
  cost: number;
  peak: boolean;
  simulated?: boolean;
}

export interface MessageMeta extends Partial<ChatStats> {
  error?: string;
  reasoning?: string;
  page?: number | null;
  askMode?: string;
  streaming?: boolean;
}

export interface ChatMessage {
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  meta?: MessageMeta;
}

export interface MetaStep {
  level: string;
  ok: boolean;
  note: string;
}

export interface AppConfig {
  hasKey: boolean;
  keyHint: string;
  defaultModel: string;
  baseUrl: string;
  peak: boolean;
}

export const HIGHLIGHT_COLORS = [
  { name: 'yellow', label: '重点', hex: '#f7d34e' },
  { name: 'green', label: '方法', hex: '#7ddc8f' },
  { name: 'blue', label: '结论', hex: '#7cc4f5' },
  { name: 'red', label: '疑问', hex: '#f79c9c' },
  { name: 'purple', label: '其他', hex: '#c3aaf0' },
] as const;

export const colorHex = (name: string) =>
  HIGHLIGHT_COLORS.find((c) => c.name === name)?.hex ?? '#f7d34e';
export const colorLabel = (name: string) =>
  HIGHLIGHT_COLORS.find((c) => c.name === name)?.label ?? name;

/* ---------------- 筛选 ---------------- */

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

export interface Facets {
  years: FacetOption[];
  venues: FacetOption[];
  venuesTotal: number;
  authors: FacetOption[];
  authorsTotal: number;
  types: FacetOption[];
  tags: FacetOption[];
  confidence: FacetOption[];
  flags: Record<string, number>;
  total: number;
}

export interface Filters {
  years: string[];
  venues: string[];
  authors: string[];
  types: string[];
  tags: string[];
  confidence: string[];
  flags: string[];
}

export const EMPTY_FILTERS: Filters = {
  years: [],
  venues: [],
  authors: [],
  types: [],
  tags: [],
  confidence: [],
  flags: [],
};

export type FilterGroup = keyof Filters;

export const FILTER_GROUP_LABEL: Record<FilterGroup, string> = {
  years: '年份',
  venues: '期刊',
  authors: '作者',
  types: '类型',
  tags: '标签',
  confidence: '置信度',
  flags: '状态',
};

export const CONFIDENCE_LABEL: Record<string, string> = {
  high: '高置信',
  medium: '中置信',
  low: '低置信',
};

export const FLAG_OPTIONS: { value: string; label: string }[] = [
  { value: 'needsReview', label: '待确认' },
  { value: 'clean', label: '已确认' },
  { value: 'hasPdf', label: '有 PDF' },
  { value: 'noPdf', label: '无 PDF' },
  { value: 'hasDoi', label: '有 DOI' },
  { value: 'noDoi', label: '无 DOI' },
  { value: 'hasAnno', label: '有标注' },
  { value: 'hasNote', label: '有笔记' },
];

/* ---------------- 论文结构 ---------------- */

export type SectionType =
  | 'abstract'
  | 'introduction'
  | 'related'
  | 'method'
  | 'results'
  | 'discussion'
  | 'conclusion'
  | 'references'
  | 'acknowledgement'
  | 'appendix'
  | 'other';

export interface OutlineSection {
  id: string;
  title: string;
  level: number;
  page: number;
  yFrac: number;
  type: SectionType;
  source?: string;
}

export interface Outline {
  sections: OutlineSection[];
  source: 'bookmark' | 'heuristic' | 'llm' | string;
  notes?: string[];
  counts?: { total: number; byType: Record<string, number> };
  created?: string;
}

export const SECTION_TYPE_LABEL: Record<string, string> = {
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

export const SECTION_TYPE_COLOR: Record<string, string> = {
  abstract: '#6b7280',
  introduction: '#2f5fd0',
  related: '#7c6bd0',
  method: '#1a7f4b',
  results: '#b26a00',
  discussion: '#0f8b8d',
  conclusion: '#b42318',
  references: '#9aa1ac',
  acknowledgement: '#9aa1ac',
  appendix: '#9aa1ac',
  other: '#9aa1ac',
};

export const OUTLINE_SOURCE_LABEL: Record<string, string> = {
  bookmark: 'PDF 书签',
  heuristic: '版面识别',
  llm: 'AI 解析',
};

/* ---------------- 引用 ---------------- */

export interface CiteFormatInfo {
  id: string;
  label: string;
  note: string;
}

export interface CiteFormats {
  styles: CiteFormatInfo[];
  exchange: CiteFormatInfo[];
  locales: { id: string; label: string }[];
}

export interface CiteResult {
  kind: 'csl' | 'exchange';
  format: string;
  label: string;
  inline: string;
  inlineHtml: string;
  bibliography: string[];
  bibliographyHtml: string[];
  text: string;
  html: string;
  ext?: string;
  mime?: string;
  styleMeta?: { title: string; citationFormat: string; updated: string };
  count: number;
  itemTitles: string[];
}
