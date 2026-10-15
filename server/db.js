// 本地存储层：node:sqlite（Node 22 内置，零原生依赖 —— 免去 better-sqlite3 跨平台重编译的麻烦）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeType, typeLabel } from './csl-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PDF_DIR = path.join(DATA_DIR, 'pdfs');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

fs.mkdirSync(PDF_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'paper-reader.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_key TEXT UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  abstract TEXT NOT NULL DEFAULT '',
  year INTEGER,
  venue TEXT NOT NULL DEFAULT '',
  doi TEXT NOT NULL DEFAULT '',
  arxiv_id TEXT NOT NULL DEFAULT '',
  csl_type TEXT NOT NULL DEFAULT 'article',
  url TEXT NOT NULL DEFAULT '',
  authors_json TEXT NOT NULL DEFAULT '[]',
  csl_json TEXT NOT NULL DEFAULT '{}',
  meta_source TEXT NOT NULL DEFAULT '',
  meta_confidence TEXT NOT NULL DEFAULT 'low',
  needs_review INTEGER NOT NULL DEFAULT 0,
  date_added TEXT NOT NULL DEFAULT (datetime('now')),
  date_modified TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS item_collections (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, collection_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  color TEXT NOT NULL DEFAULT '#64748b'
);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  page_count INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pages (
  attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (attachment_id, page)
);

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'highlight',
  color TEXT NOT NULL DEFAULT 'yellow',
  rects_json TEXT NOT NULL DEFAULT '[]',
  text TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  image_data TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL DEFAULT (datetime('now')),
  updated TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  md TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
  model TEXT NOT NULL DEFAULT 'deepseek-flash',
  created TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}',
  created TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outlines (
  attachment_id INTEGER PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ann_item ON annotations(item_id);
CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id);
`);

const now = () => new Date().toISOString();
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

/* ---------- 轻量迁移 ---------- */

// v1 之前没有 csl_type 列：补列并把旧的 csl_json.type 归一化后回填
{
  const cols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  if (!cols.includes('csl_type')) {
    db.exec("ALTER TABLE items ADD COLUMN csl_type TEXT NOT NULL DEFAULT 'article'");
    const rows = db.prepare('SELECT id, csl_json FROM items').all();
    const upd = db.prepare('UPDATE items SET csl_type = ? WHERE id = ?');
    for (const r of rows) {
      let t = 'article';
      try {
        t = normalizeType(JSON.parse(r.csl_json || '{}').type);
      } catch {
        /* 脏数据忽略 */
      }
      upd.run(t, r.id);
    }
  }
}

/* ---------- 配置 ---------- */

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

/* ---------- 文献 ---------- */

export function rowToItem(row) {
  if (!row) return null;
  const attachments = db
    .prepare('SELECT id, filename, byte_size, page_count, created FROM attachments WHERE item_id = ? ORDER BY id')
    .all(row.id);
  const tags = db
    .prepare('SELECT t.id, t.name, t.color FROM tags t JOIN item_tags it ON it.tag_id = t.id WHERE it.item_id = ?')
    .all(row.id);
  const collections = db
    .prepare(
      'SELECT c.id, c.name FROM collections c JOIN item_collections ic ON ic.collection_id = c.id WHERE ic.item_id = ?',
    )
    .all(row.id);
  return {
    ...row,
    authors: JSON.parse(row.authors_json || '[]'),
    csl: JSON.parse(row.csl_json || '{}'),
    needs_review: !!row.needs_review,
    attachments,
    tags,
    collections,
    annotation_count: num(
      db.prepare('SELECT COUNT(*) AS c FROM annotations WHERE item_id = ?').get(row.id)?.c ?? 0,
    ),
    note_count: num(db.prepare('SELECT COUNT(*) AS n FROM notes WHERE item_id = ?').get(row.id)?.n ?? 0),
  };
}

/* ---------- 筛选 ---------- */

const LIKE_ESC = (s) => String(s).replace(/[%_\\]/g, (m) => `\\${m}`);

/**
 * 把筛选条件编译成 SQL。
 * scope='items' 时应用全部条件；scope='facets' 时只应用搜索词/预设/集合，
 * 这样勾选某个分面不会让其它分面的选项消失（标准 faceted search 行为）。
 */
function buildWhere(opts, scope) {
  const {
    q = '',
    filter = 'all',
    collectionId = null,
    years = [],
    venues = [],
    authors = [],
    types = [],
    tags = [],
    confidence = [],
    flags = [],
  } = opts;
  const where = [];
  const params = [];

  if (q.trim()) {
    where.push('(title LIKE ? ESCAPE \'\\\' OR authors_json LIKE ? ESCAPE \'\\\' OR venue LIKE ? ESCAPE \'\\\' OR doi LIKE ? ESCAPE \'\\\' OR abstract LIKE ? ESCAPE \'\\\')');
    const like = `%${LIKE_ESC(q.trim())}%`;
    params.push(like, like, like, like, like);
  }
  if (filter === 'recent') where.push("date_added >= datetime('now','-7 days')");
  if (filter === 'notes') where.push('EXISTS (SELECT 1 FROM notes n WHERE n.item_id = items.id)');
  if (filter === 'annotated') where.push('EXISTS (SELECT 1 FROM annotations a WHERE a.item_id = items.id)');
  if (collectionId) {
    where.push('EXISTS (SELECT 1 FROM item_collections ic WHERE ic.item_id = items.id AND ic.collection_id = ?)');
    params.push(collectionId);
  }

  if (scope === 'facets') return { where, params };

  if (filter === 'review' || flags.includes('needsReview')) where.push('needs_review = 1');
  if (flags.includes('clean')) where.push('needs_review = 0');
  if (flags.includes('hasPdf')) where.push('EXISTS (SELECT 1 FROM attachments a WHERE a.item_id = items.id)');
  if (flags.includes('noPdf')) where.push('NOT EXISTS (SELECT 1 FROM attachments a WHERE a.item_id = items.id)');
  if (flags.includes('hasDoi')) where.push("doi <> ''");
  if (flags.includes('noDoi')) where.push("doi = ''");
  if (flags.includes('hasAnno')) where.push('EXISTS (SELECT 1 FROM annotations a WHERE a.item_id = items.id)');
  if (flags.includes('hasNote')) where.push('EXISTS (SELECT 1 FROM notes n WHERE n.item_id = items.id)');

  const inClause = (col, list) => {
    where.push(`${col} IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  };
  if (years.length) inClause('year', years.map(Number).filter(Number.isFinite));
  if (venues.length) inClause('venue', venues);
  if (types.length) inClause('csl_type', types);
  if (confidence.length) inClause('meta_confidence', confidence);
  if (tags.length) {
    where.push(
      `EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id
               WHERE it.item_id = items.id AND t.name IN (${tags.map(() => '?').join(',')}))`,
    );
    params.push(...tags);
  }
  for (const a of authors) {
    where.push("authors_json LIKE ? ESCAPE '\\'");
    params.push(`%"family":"${LIKE_ESC(a)}"%`);
  }

  return { where, params };
}

export function listItems(opts = {}) {
  const { where, params } = buildWhere(opts, 'items');
  const sql = `SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date_added DESC, id DESC`;
  return db.prepare(sql).all(...params).map(rowToItem);
}

/** 分面计数：只受搜索词 / 预设 / 集合影响 */
export function getFacets(opts = {}) {
  const { where, params } = buildWhere(opts, 'facets');
  const base = `SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const rows = db.prepare(base).all(...params);

  const counter = () => new Map();
  const bump = (map, key) => key && map.set(key, (map.get(key) ?? 0) + 1);
  const toList = (map, labeler = (x) => x) =>
    [...map.entries()]
      .map(([value, count]) => ({ value, label: labeler(value), count }))
      .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));

  const years = counter();
  const venues = counter();
  const authors = counter();
  const types = counter();
  const tags = counter();
  const confidence = counter();
  const flags = { needsReview: 0, clean: 0, hasPdf: 0, noPdf: 0, hasDoi: 0, noDoi: 0, hasAnno: 0, hasNote: 0 };

  for (const r of rows) {
    if (r.year) bump(years, String(r.year));
    bump(venues, r.venue);
    try {
      for (const a of JSON.parse(r.authors_json || '[]')) {
        if (a.family) bump(authors, a.family);
        else if (a.given) bump(authors, a.given);
      }
    } catch {
      /* 忽略脏数据 */
    }
    bump(types, r.csl_type || 'article');
    for (const t of db.prepare('SELECT t.name FROM tags t JOIN item_tags it ON it.tag_id = t.id WHERE it.item_id = ?').all(r.id)) {
      bump(tags, t.name);
    }
    bump(confidence, r.meta_confidence || 'low');
    if (r.needs_review) flags.needsReview++;
    else flags.clean++;
    const hasPdf = !!db.prepare('SELECT 1 FROM attachments WHERE item_id = ? LIMIT 1').get(r.id);
    flags[hasPdf ? 'hasPdf' : 'noPdf']++;
    if (r.doi) flags.hasDoi++;
    else flags.noDoi++;
    if (db.prepare('SELECT 1 FROM annotations WHERE item_id = ? LIMIT 1').get(r.id)) flags.hasAnno++;
    if (db.prepare('SELECT 1 FROM notes WHERE item_id = ? LIMIT 1').get(r.id)) flags.hasNote++;
  }

  const cap = (arr, n) => ({ list: arr.slice(0, n), total: arr.length });
  const authorsFull = toList(authors);
  const venuesFull = toList(venues);

  return {
    years: toList(years).sort((a, b) => Number(b.value) - Number(a.value)),
    venues: cap(venuesFull, 300).list,
    venuesTotal: venuesFull.length,
    authors: cap(authorsFull, 400).list,
    authorsTotal: authorsFull.length,
    types: toList(types, typeLabel),
    tags: toList(tags),
    confidence: toList(confidence),
    flags,
    total: rows.length,
  };
}

export function getItem(id) {
  return rowToItem(db.prepare('SELECT * FROM items WHERE id = ?').get(id));
}

export function getItemByDoi(doi) {
  if (!doi) return null;
  return rowToItem(db.prepare('SELECT * FROM items WHERE lower(doi) = lower(?)').get(doi));
}

export function normTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

export function findDuplicate(title, doi) {
  if (doi) {
    const hit = getItemByDoi(doi);
    if (hit) return hit;
  }
  const key = normTitle(title);
  if (key.length < 12) return null;
  for (const row of db.prepare('SELECT id, title FROM items').all()) {
    if (normTitle(row.title) === key) return getItem(row.id);
  }
  return null;
}

export function makeItemKey() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

export function insertItem(data) {
  const info = db
    .prepare(
      `INSERT INTO items (item_key, title, abstract, year, venue, doi, arxiv_id, csl_type, url,
        authors_json, csl_json, meta_source, meta_confidence, needs_review, date_modified)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      data.item_key ?? makeItemKey(),
      data.title ?? '',
      data.abstract ?? '',
      data.year ?? null,
      data.venue ?? '',
      data.doi ?? '',
      data.arxiv_id ?? '',
      normalizeType(data.csl?.type),
      data.url ?? '',
      JSON.stringify(data.authors ?? []),
      JSON.stringify(data.csl ?? {}),
      data.meta_source ?? '',
      data.meta_confidence ?? 'low',
      data.needs_review ? 1 : 0,
      now(),
    );
  return getItem(num(info.lastInsertRowid));
}

export function updateItem(id, patch) {
  const allowed = [
    'title',
    'abstract',
    'year',
    'venue',
    'doi',
    'arxiv_id',
    'url',
    'item_key',
    'meta_source',
    'meta_confidence',
  ];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      params.push(patch[k]);
    }
  }
  if (patch.authors !== undefined) {
    sets.push('authors_json = ?');
    params.push(JSON.stringify(patch.authors));
  }
  if (patch.csl !== undefined) {
    sets.push('csl_json = ?');
    params.push(JSON.stringify(patch.csl));
    sets.push('csl_type = ?');
    params.push(normalizeType(patch.csl?.type));
  }
  if (patch.needs_review !== undefined) {
    sets.push('needs_review = ?');
    params.push(patch.needs_review ? 1 : 0);
  }
  if (sets.length) {
    sets.push('date_modified = ?');
    params.push(now(), id);
    db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
  if (patch.tagNames) setItemTags(id, patch.tagNames);
  if (patch.collectionIds) setItemCollections(id, patch.collectionIds);
  return getItem(id);
}

export function deleteItem(id) {
  return deleteItems([id]);
}

/** 批量删除：连同 PDF 文件一起清掉（标注/笔记/会话由外键 CASCADE 处理） */
export function deleteItems(ids) {
  const list = [...new Set(ids.map(Number).filter(Number.isFinite))];
  if (!list.length) return { deleted: 0, files: 0 };
  const placeholders = list.map(() => '?').join(',');
  const paths = db
    .prepare(`SELECT a.stored_path FROM attachments a JOIN items i ON i.id = a.item_id WHERE i.id IN (${placeholders})`)
    .all(...list)
    .map((r) => r.stored_path);
  const info = db.prepare(`DELETE FROM items WHERE id IN (${placeholders})`).run(...list);
  let files = 0;
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
      files++;
    } catch {
      /* 文件可能已被手工删除 */
    }
  }
  return { deleted: num(info.changes), files };
}

export function setItemTags(itemId, names) {
  db.prepare('DELETE FROM item_tags WHERE item_id = ?').run(itemId);
  for (const raw of names) {
    const name = String(raw).trim();
    if (!name) continue;
    let row = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
    if (!row) {
      const info = db.prepare('INSERT INTO tags (name) VALUES (?)').run(name);
      row = { id: num(info.lastInsertRowid) };
    }
    db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?,?)').run(itemId, row.id);
  }
}

export function setItemCollections(itemId, ids) {
  db.prepare('DELETE FROM item_collections WHERE item_id = ?').run(itemId);
  for (const cid of ids) {
    db.prepare('INSERT OR IGNORE INTO item_collections (item_id, collection_id) VALUES (?,?)').run(itemId, cid);
  }
}

export function listCollections() {
  return db
    .prepare(
      `SELECT c.id, c.name, COUNT(ic.item_id) AS count
       FROM collections c LEFT JOIN item_collections ic ON ic.collection_id = c.id
       GROUP BY c.id ORDER BY c.name`,
    )
    .all();
}

export function createCollection(name) {
  const info = db.prepare('INSERT OR IGNORE INTO collections (name) VALUES (?)').run(name);
  return num(info.lastInsertRowid);
}

export function listTags() {
  return db
    .prepare(
      `SELECT t.id, t.name, t.color, COUNT(it.item_id) AS count
       FROM tags t LEFT JOIN item_tags it ON it.tag_id = t.id
       GROUP BY t.id ORDER BY count DESC, t.name`,
    )
    .all();
}

/* ---------- 附件 / 页文本 ---------- */

export function addAttachment(itemId, filename, storedPath, byteSize, sha256, pageCount) {
  const info = db
    .prepare(
      'INSERT INTO attachments (item_id, filename, stored_path, byte_size, sha256, page_count) VALUES (?,?,?,?,?,?)',
    )
    .run(itemId, filename, storedPath, byteSize, sha256, pageCount);
  return num(info.lastInsertRowid);
}

export function savePages(attachmentId, pages) {
  const stmt = db.prepare('INSERT OR REPLACE INTO pages (attachment_id, page, text) VALUES (?,?,?)');
  for (const p of pages) stmt.run(attachmentId, p.page, p.text);
}

export function getPages(attachmentId) {
  return db.prepare('SELECT page, text FROM pages WHERE attachment_id = ? ORDER BY page').all(attachmentId);
}

export function getAttachment(id) {
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
}

export function findAttachmentBySha(sha256) {
  return db.prepare('SELECT * FROM attachments WHERE sha256 = ? LIMIT 1').get(sha256);
}

export function getPrimaryAttachment(itemId) {
  return db.prepare('SELECT * FROM attachments WHERE item_id = ? ORDER BY id LIMIT 1').get(itemId);
}

/* ---------- 结构解析 ---------- */

export function saveOutline(attachmentId, outline) {
  db.prepare(
    `INSERT INTO outlines (attachment_id, json, source, created) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(attachment_id) DO UPDATE SET json = excluded.json, source = excluded.source, created = excluded.created`,
  ).run(attachmentId, JSON.stringify(outline), outline?.source ?? '');
  return outline;
}

export function getOutline(attachmentId) {
  const row = db.prepare('SELECT * FROM outlines WHERE attachment_id = ?').get(attachmentId);
  if (!row) return null;
  try {
    return { ...JSON.parse(row.json), created: row.created };
  } catch {
    return null;
  }
}

/* ---------- 标注 ---------- */

export function listAnnotations(itemId) {
  return db.prepare('SELECT * FROM annotations WHERE item_id = ? ORDER BY page, id').all(itemId).map(toAnnotation);
}

function toAnnotation(r) {
  return { ...r, rects: JSON.parse(r.rects_json || '[]') };
}

export function createAnnotation(a) {
  const info = db
    .prepare(
      `INSERT INTO annotations (item_id, attachment_id, page, kind, color, rects_json, text, comment, image_data)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      a.item_id,
      a.attachment_id,
      a.page,
      a.kind ?? 'highlight',
      a.color ?? 'yellow',
      JSON.stringify(a.rects ?? []),
      a.text ?? '',
      a.comment ?? '',
      a.image_data ?? '',
    );
  const row = db.prepare('SELECT * FROM annotations WHERE id = ?').get(num(info.lastInsertRowid));
  return toAnnotation(row);
}

export function updateAnnotation(id, patch) {
  const sets = [];
  const params = [];
  if (patch.color !== undefined) (sets.push('color = ?'), params.push(patch.color));
  if (patch.comment !== undefined) (sets.push('comment = ?'), params.push(patch.comment));
  if (patch.rects !== undefined) (sets.push('rects_json = ?'), params.push(JSON.stringify(patch.rects)));
  if (sets.length) {
    sets.push("updated = datetime('now')");
    params.push(id);
    db.prepare(`UPDATE annotations SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
  return toAnnotation(db.prepare('SELECT * FROM annotations WHERE id = ?').get(id));
}

export function deleteAnnotation(id) {
  db.prepare('DELETE FROM annotations WHERE id = ?').run(id);
  return { ok: true };
}

/* ---------- 笔记 ---------- */

export function listNotes(itemId) {
  return db.prepare('SELECT * FROM notes WHERE item_id = ? ORDER BY id DESC').all(itemId);
}

export function createNote(itemId, md, source = 'manual') {
  const info = db.prepare('INSERT INTO notes (item_id, md, source) VALUES (?,?,?)').run(itemId, md, source);
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(num(info.lastInsertRowid));
}

export function deleteNote(id) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  return { ok: true };
}

/* ---------- 会话 ---------- */

export function getOrCreateSession(itemId, model = 'deepseek-flash') {
  let row = db.prepare('SELECT * FROM chat_sessions WHERE item_id = ?').get(itemId);
  if (!row) {
    db.prepare('INSERT INTO chat_sessions (item_id, model) VALUES (?,?)').run(itemId, model);
    row = db.prepare('SELECT * FROM chat_sessions WHERE item_id = ?').get(itemId);
  }
  return row;
}

export function listMessages(sessionId) {
  return db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id')
    .all(sessionId)
    .map((m) => ({ ...m, meta: JSON.parse(m.meta_json || '{}') }));
}

export function addMessage(sessionId, role, content, meta = {}) {
  const info = db
    .prepare('INSERT INTO messages (session_id, role, content, meta_json) VALUES (?,?,?,?)')
    .run(sessionId, role, content, JSON.stringify(meta));
  return num(info.lastInsertRowid);
}

export function setSessionModel(sessionId, model) {
  db.prepare('UPDATE chat_sessions SET model = ? WHERE id = ?').run(model, sessionId);
}

export function clearSession(itemId) {
  const s = db.prepare('SELECT id FROM chat_sessions WHERE item_id = ?').get(itemId);
  if (s) db.prepare('DELETE FROM messages WHERE session_id = ?').run(s.id);
  return { ok: true };
}

export function stats() {
  const one = (sql) => num(db.prepare(sql).get()?.c ?? 0);
  return {
    items: one('SELECT COUNT(*) AS c FROM items'),
    needs_review: one('SELECT COUNT(*) AS c FROM items WHERE needs_review = 1'),
    annotations: one('SELECT COUNT(*) AS c FROM annotations'),
    notes: one('SELECT COUNT(*) AS c FROM notes'),
    pages: one('SELECT COUNT(*) AS c FROM pages'),
  };
}
