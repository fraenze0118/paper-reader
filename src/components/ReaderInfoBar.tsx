import { useApp } from '../store';
import type { Item } from '../types';

const CONFIDENCE_LABEL: Record<string, string> = {
  high: '高置信',
  medium: '中置信',
  low: '低置信',
};

function authorText(item: Item) {
  const a = item.authors ?? [];
  if (!a.length) return '';
  const name = (x: (typeof a)[number]) => [x.given, x.family].filter(Boolean).join(' ');
  if (a.length <= 3) return a.map(name).join('、');
  return `${name(a[0])} 等 ${a.length} 人`;
}

/**
 * 阅读页顶部信息条：把阅读时真正高频、只读的元数据（作者/年份/期刊/DOI/置信度/标签）
 * 直接摊在眼前，省掉「切到详情页看一眼再切回来」——那一次往返要重建全部页面
 * 并丢失阅读位置（58 页实测 1.7s）。
 * 低频的写操作（编辑元数据、CSL、识别过程、删除）仍留在详情页。
 */
export default function ReaderInfoBar({ item, onOpenDetail }: { item: Item; onOpenDetail: () => void }) {
  const toggleFilter = useApp((s) => s.toggleFilter);
  const pushToast = useApp((s) => s.pushToast);
  const authors = authorText(item);
  const conf = item.meta_confidence;

  return (
    <div className="info-bar">
      <div className="info-main">
        <span className="info-authors" title={(item.authors ?? []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).join(', ')}>
          {authors || <span className="info-missing">作者未知</span>}
        </span>
        <span className="info-sep">·</span>
        <span className={item.year ? '' : 'info-missing'}>{item.year ?? '年份未知'}</span>
        <span className="info-sep">·</span>
        <span className={item.venue ? 'info-venue' : 'info-missing'} title={item.venue || undefined}>
          {item.venue || '期刊未知'}
        </span>
        {item.doi ? (
          <>
            <span className="info-sep">·</span>
            <a
              className="info-doi"
              href={`https://doi.org/${item.doi}`}
              target="_blank"
              rel="noreferrer"
              title={item.doi}
            >
              DOI ↗
            </a>
          </>
        ) : null}
      </div>

      <div className="info-side">
        {item.needs_review ? (
          <button
            className="badge low info-btn"
            title="元数据识别置信度低，点击去详情页核对"
            onClick={onOpenDetail}
          >
            待确认 · 去核对
          </button>
        ) : (
          <span className={`badge ${conf}`} title="元数据识别来源与置信度">
            {CONFIDENCE_LABEL[conf] ?? conf}
          </span>
        )}
        {item.tags.map((t) => (
          <button
            key={t.id}
            className="badge tag info-btn"
            title={`在文献列表里按标签「${t.name}」筛选`}
            onClick={() => {
              toggleFilter('tags', t.name);
              pushToast('ok', `已按标签筛选：${t.name}`);
            }}
          >
            {t.name}
          </button>
        ))}
      </div>
    </div>
  );
}
