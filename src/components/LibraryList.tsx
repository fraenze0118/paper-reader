import { useApp } from '../store';
import type { Item } from '../types';
import FilterBar from './FilterBar';

function AuthorLine({ item }: { item: Item }) {
  const a = item.authors ?? [];
  if (!a.length) return <span style={{ color: '#b9bec6' }}>作者未知</span>;
  const first = [a[0]?.given, a[0]?.family].filter(Boolean).join(' ');
  const rest = a.length > 1 ? ` 等 ${a.length} 人` : '';
  return (
    <span>
      {first}
      <span style={{ color: '#b9bec6' }}>{rest}</span>
    </span>
  );
}

export default function LibraryList() {
  const items = useApp((s) => s.items);
  const selectedId = useApp((s) => s.selectedId);
  const query = useApp((s) => s.query);
  const setQuery = useApp((s) => s.setQuery);
  const select = useApp((s) => s.select);
  const selectedIds = useApp((s) => s.selectedIds);
  const toggleSelect = useApp((s) => s.toggleSelect);
  const clearSelection = useApp((s) => s.clearSelection);
  const selectAllVisible = useApp((s) => s.selectAllVisible);
  const openCite = useApp((s) => s.openCite);
  const setRemoving = useApp((s) => s.setRemoving);
  const facets = useApp((s) => s.facets);
  const clearFilters = useApp((s) => s.clearFilters);
  const filtersActive = useApp((s) => Object.values(s.filters).some((v) => v.length > 0));

  return (
    <section className="list">
      <div className="list-toolbar">
        <div className="search">
          <span style={{ color: '#9aa1ac' }}>⌕</span>
          <input
            placeholder="搜索标题 / 作者 / 期刊 / DOI / 摘要"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button className="btn small" style={{ border: 0, padding: '0 4px' }} onClick={() => setQuery('')}>
              ✕
            </button>
          ) : null}
        </div>
      </div>

      <FilterBar />

      <div className="list-scroll">
        <div className="list-count">
          共 {items.length} 篇
          {facets ? <span style={{ color: 'var(--faint)' }}> / 全库 {facets.total}</span> : null}
          {filtersActive || query ? (
            <button
              className="btn small"
              style={{ border: 0, marginLeft: 6, padding: '0 4px' }}
              onClick={() => {
                clearFilters();
                setQuery('');
              }}
            >
              重置
            </button>
          ) : null}
        </div>
        {items.length === 0 ? (
          <div style={{ padding: '4px 16px 20px', color: '#9aa1ac', fontSize: 12.5, lineHeight: 1.7 }}>
            {query || filtersActive ? '没有符合当前条件的文献。试试放宽筛选。' : '还没有文献。拖拽 PDF 到窗口，或用左侧「导入 PDF」。'}
          </div>
        ) : null}
        {items.map((it) => (
          <div
            key={it.id}
            className={`item-row ${selectedId === it.id ? 'active' : ''} ${selectedIds.includes(it.id) ? 'picked' : ''}`}
            onClick={() => select(it.id, 'reader')}
          >
            <input
              type="checkbox"
              className="row-check"
              checked={selectedIds.includes(it.id)}
              title="勾选后可批量生成引用 / 删除"
              onClick={(e) => e.stopPropagation()}
              onChange={() => toggleSelect(it.id)}
            />
            <div className="row-main">
              <h4>{it.title || '(无标题)'}</h4>
              <div className="sub">
                <AuthorLine item={it} />
                {it.year ? <span className="sep">·</span> : null}
                {it.year ?? null}
                {it.venue ? <span className="sep">·</span> : null}
                {it.venue ? <span style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.venue}</span> : null}
              </div>
              <div className="flags">
                {it.needs_review ? <span className="badge low">待确认</span> : null}
                {it.doi ? <span className="badge">DOI</span> : null}
                {it.attachments[0] ? <span className="badge">{it.attachments[0].page_count} 页</span> : null}
                {it.annotation_count ? <span className="badge">标注 {it.annotation_count}</span> : null}
                {it.note_count ? <span className="badge">笔记 {it.note_count}</span> : null}
                {it.tags.slice(0, 3).map((t) => (
                  <span key={t.id} className="badge tag">
                    {t.name}
                  </span>
                ))}
              </div>
            </div>
            <button
              className="row-del"
              title="删除这篇文献"
              onClick={(e) => {
                e.stopPropagation();
                setRemoving([it.id]);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {selectedIds.length ? (
        <div className="sel-bar">
          <span>
            已选 <b>{selectedIds.length}</b> 篇
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn small" onClick={selectAllVisible} title="选中当前列表全部">
            全选
          </button>
          <button className="btn small" onClick={clearSelection}>
            取消
          </button>
          <button className="btn small danger" onClick={() => setRemoving(selectedIds)}>
            删除
          </button>
          <button className="btn small primary" onClick={() => openCite()}>
            生成引用
          </button>
        </div>
      ) : null}
    </section>
  );
}
