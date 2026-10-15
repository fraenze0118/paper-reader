import { useApp } from '../store';
import type { QueueItem } from '../store';

const STATUS_LABEL: Record<QueueItem['status'], string> = {
  pending: '排队中',
  uploading: '上传中',
  parsing: '识别中',
  done: '完成',
  duplicate: '重复',
  error: '失败',
};

export default function QueuePanel() {
  const queue = useApp((s) => s.queue) ?? [];
  const dismiss = useApp((s) => s.dismissQueue);
  const select = useApp((s) => s.select);

  const running = queue.some((q) => q.status === 'uploading' || q.status === 'parsing' || q.status === 'pending');
  const okCount = queue.filter((q) => q.status === 'done').length;
  const dupCount = queue.filter((q) => q.status === 'duplicate').length;
  const errCount = queue.filter((q) => q.status === 'error').length;

  return (
    <div className="queue">
      <div className="qhead">
        <span>导入 {queue.length} 个文件</span>
        <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 11.5 }}>
          {running ? '处理中…' : `成功 ${okCount} · 重复 ${dupCount} · 失败 ${errCount}`}
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn small" onClick={dismiss}>
          {running ? '后台运行' : '关闭'}
        </button>
      </div>
      <div className="qbody">
        {queue.map((q, i) => (
          <div key={i} className="qitem">
            <div className="name">
              <span className="txt" title={q.name}>
                {q.name}
              </span>
              <span
                className={`badge ${q.status === 'done' ? 'high' : q.status === 'error' ? 'low' : q.status === 'duplicate' ? 'medium' : ''}`}
              >
                {STATUS_LABEL[q.status]}
              </span>
              {q.itemId ? (
                <button className="btn small" onClick={() => select(q.itemId!, 'reader')}>
                  打开
                </button>
              ) : null}
            </div>
            {q.status === 'uploading' ? (
              <div className="progress">
                <i style={{ width: `${q.pct}%` }} />
              </div>
            ) : null}
            {q.message ? <div className="note">{q.message}</div> : null}
            {q.steps && q.steps.length ? (
              <ul className="steps">
                {q.steps.map((s, j) => (
                  <li key={j} className={s.ok ? 'ok' : 'no'}>
                    <span className="lvl">{s.level}</span>
                    <span className="note">{s.note}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
