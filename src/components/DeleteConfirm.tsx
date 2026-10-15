import { useApp } from '../store';

export default function DeleteConfirm() {
  const removing = useApp((s) => s.removing);
  const items = useApp((s) => s.items);
  const setRemoving = useApp((s) => s.setRemoving);
  const confirmRemove = useApp((s) => s.confirmRemove);
  if (!removing?.length) return null;

  const chosen = removing.map((id) => items.find((i) => i.id === id)).filter(Boolean);
  const missing = removing.length - chosen.length;
  const annotations = chosen.reduce((n, i) => n + (i!.annotation_count ?? 0), 0);
  const notes = chosen.reduce((n, i) => n + (i!.note_count ?? 0), 0);
  const withPdf = chosen.filter((i) => i!.attachments.length > 0).length;

  return (
    <div className="modal-back" onClick={() => setRemoving(null)}>
      <div className="modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <header>删除文献</header>
        <div className="content">
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            将删除 <b>{removing.length}</b> 篇文献
            {missing ? <span style={{ color: 'var(--muted)' }}>（其中 {missing} 篇已不在当前列表，仍会一并删除）</span> : null}
            ，以及：
            <ul style={{ margin: '8px 0 0', paddingLeft: 20, color: 'var(--muted)', fontSize: 12.4 }}>
              <li>{withPdf} 个 PDF 文件（磁盘上一起删除）</li>
              <li>{annotations} 条标注</li>
              <li>{notes} 条笔记</li>
              <li>对应的 AI 对话记录</li>
            </ul>
          </div>

          {chosen.length ? (
            <div style={{ marginTop: 12, maxHeight: 150, overflow: 'auto', border: '1px solid var(--line-soft)', borderRadius: 8, padding: '8px 10px' }}>
              {chosen.slice(0, 12).map((i) => (
                <div key={i!.id} style={{ fontSize: 12.2, padding: '2px 0', color: '#3a4149' }}>
                  · {i!.title.slice(0, 52) || '(无标题)'}
                  {i!.title.length > 52 ? '…' : ''}
                </div>
              ))}
              {chosen.length > 12 ? (
                <div style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 4 }}>…等 {chosen.length} 篇</div>
              ) : null}
            </div>
          ) : null}

          <div style={{ marginTop: 12, fontSize: 11.8, color: 'var(--danger)' }}>此操作不可撤销。</div>
        </div>
        <footer>
          <button className="btn" onClick={() => setRemoving(null)}>
            取消
          </button>
          <button className="btn danger" onClick={() => void confirmRemove()}>
            确认删除
          </button>
        </footer>
      </div>
    </div>
  );
}
