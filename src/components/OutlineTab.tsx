import { useMemo, useState } from 'react';
import { useOutline } from '../outlineStore';
import { useApp } from '../store';
import { OUTLINE_SOURCE_LABEL, SECTION_TYPE_COLOR, SECTION_TYPE_LABEL, type OutlineSection } from '../types';

export default function OutlineTab({
  activeId,
  onJump,
}: {
  activeId: string | null;
  onJump: (s: OutlineSection) => void;
}) {
  const data = useOutline((s) => s.data);
  const loading = useOutline((s) => s.loading);
  const error = useOutline((s) => s.error);
  const reparse = useOutline((s) => s.reparse);
  const config = useApp((s) => s.config);
  const pushToast = useApp((s) => s.pushToast);
  const [showNotes, setShowNotes] = useState(false);
  const [onlyTop, setOnlyTop] = useState(false);

  const sections = useMemo(() => {
    const all = data?.sections ?? [];
    return onlyTop ? all.filter((s) => s.level === 1) : all;
  }, [data, onlyTop]);

  if (loading && !data) return <div className="panel-scroll" style={{ color: '#9aa1ac', fontSize: 12.4 }}>正在解析论文结构…</div>;

  return (
    <div className="panel-scroll outline-panel">
      <div className="outline-head">
        <span className={`badge ${data?.source === 'bookmark' ? 'high' : data?.source === 'llm' ? 'medium' : ''}`}>
          {OUTLINE_SOURCE_LABEL[data?.source ?? ''] ?? data?.source ?? '未知'}
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>{data?.sections.length ?? 0} 节</span>
        <div style={{ flex: 1 }} />
        <label className="outline-toggle" title="只看一级标题">
          <input type="checkbox" checked={onlyTop} onChange={(e) => setOnlyTop(e.target.checked)} />
          一级
        </label>
      </div>

      <div className="outline-actions">
        <button className="btn small" disabled={loading} onClick={() => void reparse(false)}>
          {loading ? '解析中…' : '重新解析'}
        </button>
        <button
          className="btn small"
          disabled={loading}
          title={config?.hasKey ? '用 DeepSeek 语义解析，覆盖版面识别的错漏' : '需要先配置 DeepSeek API Key'}
          onClick={async () => {
            if (!config?.hasKey) {
              pushToast('error', '未配置 DeepSeek API Key，无法使用 AI 解析');
              return;
            }
            await reparse(true);
            pushToast('ok', 'AI 结构解析完成');
          }}
        >
          AI 重新解析
        </button>
        {(data?.notes?.length ?? 0) > 0 ? (
          <button className="btn small" style={{ border: 0 }} onClick={() => setShowNotes((v) => !v)}>
            {showNotes ? '收起说明' : '解析说明'}
          </button>
        ) : null}
      </div>

      {showNotes ? (
        <div className="outline-notes">
          {data?.notes?.map((n, i) => (
            <div key={i}>· {n}</div>
          ))}
        </div>
      ) : null}
      {error ? <div className="cite-error" style={{ margin: '8px 0' }}>{error}</div> : null}

      {!sections.length && !loading ? (
        <div style={{ color: '#9aa1ac', fontSize: 12.4, lineHeight: 1.8 }}>
          没能从版面上识别出章节结构。可以点「AI 重新解析」，用 DeepSeek 读全文再识别一次。
        </div>
      ) : null}

      <div className="outline-list">
        {sections.map((s) => (
          <button
            key={s.id}
            className={`outline-item lv${s.level} ${activeId === s.id ? 'active' : ''}`}
            onClick={() => onJump(s)}
            title={`${s.title}（第 ${s.page} 页）`}
          >
            <span className="outline-dot" style={{ background: SECTION_TYPE_COLOR[s.type] ?? '#9aa1ac' }} />
            <span className="outline-title">{s.title}</span>
            <span className="outline-page">{s.page}</span>
          </button>
        ))}
      </div>

      {sections.length ? (
        <div className="outline-legend">
          {[...new Set(sections.map((s) => s.type))]
            .filter((t) => t !== 'other')
            .map((t) => (
              <span key={t} className="outline-legend-item">
                <i style={{ background: SECTION_TYPE_COLOR[t] }} />
                {SECTION_TYPE_LABEL[t]}
              </span>
            ))}
        </div>
      ) : null}
    </div>
  );
}
