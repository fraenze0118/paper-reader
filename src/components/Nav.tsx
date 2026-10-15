import { useRef } from 'react';
import { useApp } from '../store';

const FILTERS = [
  { key: 'all', label: '全部文献' },
  { key: 'recent', label: '最近 7 天' },
  { key: 'review', label: '待确认' },
  { key: 'annotated', label: '有标注' },
  { key: 'notes', label: '有笔记' },
];

export default function Nav() {
  const stats = useApp((s) => s.stats);
  const filter = useApp((s) => s.filter);
  const collectionId = useApp((s) => s.collectionId);
  const filters = useApp((s) => s.filters);
  const facets = useApp((s) => s.facets);
  const collections = useApp((s) => s.collections);
  const setFilter = useApp((s) => s.setFilter);
  const setCollection = useApp((s) => s.setCollection);
  const toggleFilter = useApp((s) => s.toggleFilter);
  const importFiles = useApp((s) => s.importFiles);
  const createCollection = useApp((s) => s.createCollection);
  const loadMeta = useApp((s) => s.loadMeta);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  const facetCount = Object.values(filters).reduce((n, v) => n + v.length, 0);

  const collectFromDir = async (list: FileList) => {
    const files = [...list].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (files.length) await importFiles(files);
  };

  return (
    <nav className="nav">
      <button className="btn primary import-btn" onClick={() => fileRef.current?.click()}>
        + 导入 PDF
      </button>
      <button className="btn import-btn" onClick={() => dirRef.current?.click()}>
        导入整个文件夹
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length) void importFiles(files);
          e.target.value = '';
        }}
      />
      <input
        ref={dirRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        // @ts-expect-error 非标准属性，但 Chromium 支持目录选择
        webkitdirectory="true"
        onChange={(e) => {
          void collectFromDir(e.target.files ?? new DataTransfer().files);
          e.target.value = '';
        }}
      />

      <h5>文献库</h5>
      {FILTERS.map((f) => (
        <div
          key={f.key}
          className={`nav-item ${filter === f.key && !collectionId ? 'active' : ''}`}
          onClick={() => setFilter(f.key)}
        >
          {f.label}
          <span className="count">
            {f.key === 'all'
              ? facets?.total ?? stats.items ?? 0
              : f.key === 'review'
                ? facets?.flags?.needsReview ?? stats.needs_review ?? 0
                : f.key === 'annotated'
                  ? facets?.flags?.hasAnno ?? ''
                  : f.key === 'notes'
                    ? facets?.flags?.hasNote ?? ''
                    : ''}
          </span>
        </div>
      ))}

      <h5>集合</h5>
      {collections.length === 0 ? (
        <div className="nav-item" style={{ color: '#b9bec6' }}>暂无集合</div>
      ) : null}
      {collections.map((c) => (
        <div
          key={c.id}
          className={`nav-item ${collectionId === c.id ? 'active' : ''}`}
          onClick={() => setCollection(collectionId === c.id ? null : c.id)}
        >
          {c.name}
          <span className="count">{c.count}</span>
        </div>
      ))}
      <div
        className="nav-item"
        style={{ color: 'var(--accent)', cursor: 'pointer' }}
        onClick={async () => {
          const name = window.prompt('新建集合名称');
          if (name?.trim()) {
            await createCollection(name.trim());
            await loadMeta();
          }
        }}
      >
        + 新建集合
      </div>

      <h5>元数据筛选</h5>
      <div className="nav-hint">
        年份 / 类型 / 期刊 / 作者 / 标签 / 状态
        <br />
        在文献列表上方选择
      </div>
      {facetCount ? (
        <div className="nav-item" onClick={() => setFilter('all')}>
          已启用 {facetCount} 个筛选条件
        </div>
      ) : null}
      {filters.flags.includes('needsReview') || filter === 'review' ? (
        <div className="nav-item" onClick={() => toggleFilter('flags', 'needsReview')}>
          只看「待确认」
        </div>
      ) : null}

      <div className="nav-footer">
        <div>
          共 {facets?.total ?? stats.items ?? 0} 篇 · {stats.annotations ?? 0} 条标注 · {stats.notes ?? 0} 条笔记
        </div>
        <div>数据保存在本机 data/ 目录</div>
      </div>
    </nav>
  );
}
