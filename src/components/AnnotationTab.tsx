import { useMemo, useState } from 'react';
import { colorHex, colorLabel, HIGHLIGHT_COLORS, type Annotation } from '../types';

export default function AnnotationTab({
  annotations,
  onJump,
  onDelete,
  onColor,
  onExplain,
  onNote,
}: {
  itemId: number;
  annotations: Annotation[];
  onJump: (page: number, annId?: number) => void;
  onDelete: (id: number) => void;
  onColor: (id: number, c: string) => void;
  onExplain: (text: string, page: number) => void;
  onNote: (text: string, page: number) => void;
  onReload: () => Promise<void>;
}) {
  const [filterColor, setFilterColor] = useState<string | null>(null);
  const list = useMemo(
    () => (filterColor ? annotations.filter((a) => a.color === filterColor) : annotations),
    [annotations, filterColor],
  );

  return (
    <div className="panel-scroll">
      <div style={{ display: 'flex', gap: 5, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className={`btn small ${filterColor === null ? 'active' : ''}`} onClick={() => setFilterColor(null)}>
          全部 {annotations.length}
        </button>
        {HIGHLIGHT_COLORS.map((c) => {
          const n = annotations.filter((a) => a.color === c.name).length;
          return (
            <button
              key={c.name}
              className={`btn small ${filterColor === c.name ? 'active' : ''}`}
              onClick={() => setFilterColor(filterColor === c.name ? null : c.name)}
              title={c.label}
              style={{ borderLeft: `4px solid ${c.hex}` }}
            >
              {c.label} {n || ''}
            </button>
          );
        })}
      </div>

      {list.length === 0 ? (
        <div style={{ color: '#9aa1ac', fontSize: 12.4, lineHeight: 1.8, paddingTop: 8 }}>
          还没有标注。
          <br />
          在 PDF 里<b>划词</b>即可高亮，选中颜色代表语义（重点 / 方法 / 结论 / 疑问）。
          <br />
          切到「▣ 框选」可以圈住图表或公式。
        </div>
      ) : null}

      {list.map((a) => (
        <div key={a.id} className="ann-card" style={{ borderLeftColor: colorHex(a.color) }}>
          <div className="head">
            <span
              style={{ width: 8, height: 8, borderRadius: '50%', background: colorHex(a.color), display: 'inline-block' }}
            />
            第 {a.page} 页 · {a.kind === 'area' ? '框选' : colorLabel(a.color)}
            <div style={{ flex: 1 }} />
            <button className="btn small" style={{ border: 0, padding: '0 4px' }} onClick={() => onJump(a.page, a.id)}>
              定位
            </button>
          </div>
          {a.image_data ? (
            <img src={a.image_data} alt="区域" style={{ width: '100%', borderRadius: 6, border: '1px solid var(--line-soft)', marginBottom: 6 }} />
          ) : null}
          {a.text ? <div className="quote">{a.text}</div> : null}
          {a.comment ? <div className="comment">✎ {a.comment}</div> : null}
          <div className="actions">
            <button className="btn small" disabled={!a.text} onClick={() => onExplain(a.text, a.page)}>
              AI 解释
            </button>
            <button className="btn small" disabled={!a.text} onClick={() => onNote(a.text, a.page)}>
              成笔记
            </button>
            <button className="btn small danger" onClick={() => onDelete(a.id)}>
              删除
            </button>
            <div style={{ flex: 1 }} />
            {HIGHLIGHT_COLORS.filter((c) => c.name !== a.color).map((c) => (
              <button
                key={c.name}
                title={`改为${c.label}`}
                onClick={() => onColor(a.id, c.name)}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: c.hex,
                  border: '1px solid rgba(0,0,0,.12)',
                  cursor: 'pointer',
                  padding: 0,
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
