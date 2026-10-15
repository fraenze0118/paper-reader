import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import type { Note } from '../types';

export default function NotesTab({ itemId }: { itemId: number }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const loadMeta = useApp((s) => s.loadMeta);

  const reload = async () => setNotes(await api.notes(itemId));

  useEffect(() => {
    void reload();
  }, [itemId]);

  return (
    <div className="panel-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="写一条笔记…（也可以用标注里的「成笔记」，或让 AI 整理）"
        style={{ width: '100%', minHeight: 78, border: '1px solid var(--line)', borderRadius: 9, padding: 9, fontSize: 12.4, lineHeight: 1.65, resize: 'vertical' }}
      />
      <div>
        <button
          className="btn primary small"
          disabled={!draft.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.createNote(itemId, draft.trim());
              setDraft('');
              await reload();
              await loadMeta();
            } finally {
              setBusy(false);
            }
          }}
        >
          保存笔记
        </button>
      </div>

      {notes.length === 0 ? (
        <div style={{ color: '#9aa1ac', fontSize: 12.4, lineHeight: 1.8 }}>还没有笔记。</div>
      ) : null}

      {notes.map((n) => (
        <div key={n.id} className="ann-card" style={{ borderLeftColor: 'var(--accent)' }}>
          <div className="head">
            <span className="badge">{n.source === 'ai' ? 'AI 整理' : '手写'}</span>
            <span>{new Date(n.created).toLocaleString('zh-CN')}</span>
            <div style={{ flex: 1 }} />
            <button
              className="btn small danger"
              style={{ border: 0, padding: '0 4px' }}
              onClick={async () => {
                await api.deleteNote(n.id);
                await reload();
                await loadMeta();
              }}
            >
              删除
            </button>
          </div>
          <div style={{ fontSize: 12.4, lineHeight: 1.7, whiteSpace: 'pre-wrap', color: '#333a45' }}>{n.md}</div>
        </div>
      ))}
    </div>
  );
}
