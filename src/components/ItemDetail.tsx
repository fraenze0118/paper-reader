import { useEffect, useState } from 'react';
import { useApp } from '../store';
import type { Item, MetaStep } from '../types';

const formatSize = (b: number) =>
  b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(2)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

export default function ItemDetail({ item }: { item: Item }) {
  const setDetailOpen = useApp((s) => s.setDetailOpen);
  const reextract = useApp((s) => s.reextract);
  const patchItem = useApp((s) => s.patchItem);
  const pushToast = useApp((s) => s.pushToast);
  const openCite = useApp((s) => s.openCite);
  const setRemoving = useApp((s) => s.setRemoving);

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<MetaStep[] | null>(null);
  const [form, setForm] = useState({
    title: item.title,
    year: item.year ? String(item.year) : '',
    venue: item.venue,
    doi: item.doi,
    authors: (item.authors ?? []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).join('; '),
  });
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    setForm({
      title: item.title,
      year: item.year ? String(item.year) : '',
      venue: item.venue,
      doi: item.doi,
      authors: (item.authors ?? []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).join('; '),
    });
    setSteps(null);
    setEditing(false);
  }, [item.id, item.title, item.year, item.venue, item.doi, item.authors]);

  const save = async () => {
    const authors = form.authors
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => {
        const parts = name.split(' ');
        return { family: parts.length > 1 ? parts.at(-1)! : name, given: parts.slice(0, -1).join(' ') };
      });
    await patchItem(item.id, {
      title: form.title,
      year: form.year ? Number(form.year) : null,
      venue: form.venue,
      doi: form.doi,
      authors,
      needs_review: false,
    });
    setEditing(false);
    pushToast('ok', '已保存');
  };

  const conf = item.meta_confidence;
  const confLabel = conf === 'high' ? '高置信' : conf === 'medium' ? '中置信' : '低置信（建议核对）';

  return (
    <div className="detail">
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {editing ? (
              <input
                className="mono"
                style={{ width: '100%', fontSize: 16, fontWeight: 600, padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 8 }}
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            ) : (
              <h2>{item.title || '(无标题)'}</h2>
            )}
            <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>
              {(item.authors ?? []).length
                ? item.authors.map((a) => [a.given, a.family].filter(Boolean).join(' ')).join(', ')
                : '作者未知'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span className={`badge ${conf}`}>{confLabel}</span>
            <span className="badge">{item.meta_source || '未知来源'}</span>
          </div>
        </div>

        <hr style={{ border: 0, borderTop: '1px solid var(--line-soft)', margin: '14px 0' }} />

        <div className="kv">
          <dt>年份</dt>
          <dd>
            {editing ? (
              <input value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} style={{ width: 90, border: '1px solid var(--line)', borderRadius: 6, padding: '3px 6px' }} />
            ) : (
              item.year ?? <span style={{ color: '#b9bec6' }}>未知</span>
            )}
          </dd>
          <dt>期刊/会议</dt>
          <dd>
            {editing ? (
              <input value={form.venue} onChange={(e) => setForm({ ...form, venue: e.target.value })} style={{ width: '100%', maxWidth: 340, border: '1px solid var(--line)', borderRadius: 6, padding: '3px 6px' }} />
            ) : (
              item.venue || <span style={{ color: '#b9bec6' }}>未知</span>
            )}
          </dd>
          <dt>DOI</dt>
          <dd className="mono">
            {editing ? (
              <input value={form.doi} onChange={(e) => setForm({ ...form, doi: e.target.value })} style={{ width: '100%', maxWidth: 340, border: '1px solid var(--line)', borderRadius: 6, padding: '3px 6px' }} />
            ) : item.doi ? (
              <a href={`https://doi.org/${item.doi}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                {item.doi}
              </a>
            ) : (
              <span style={{ color: '#b9bec6' }}>无</span>
            )}
          </dd>
          {editing ? (
            <>
              <dt>作者</dt>
              <dd>
                <input
                  value={form.authors}
                  onChange={(e) => setForm({ ...form, authors: e.target.value })}
                  style={{ width: '100%', border: '1px solid var(--line)', borderRadius: 6, padding: '3px 6px' }}
                />
                <div style={{ color: 'var(--faint)', fontSize: 11, marginTop: 4 }}>多个作者用分号分隔</div>
              </dd>
            </>
          ) : null}
          <dt>附件</dt>
          <dd>
            {item.attachments.map((a) => (
              <div key={a.id}>
                {a.filename} · {formatSize(a.byte_size)} · {a.page_count} 页
              </div>
            ))}
          </dd>
          <dt>入库时间</dt>
          <dd>{new Date(item.date_added).toLocaleString('zh-CN')}</dd>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={() => setDetailOpen(false)}>
            回到阅读器
          </button>
          <button className="btn" onClick={() => openCite([item.id])}>
            生成引用
          </button>
          {editing ? (
            <>
              <button className="btn" onClick={save}>
                保存
              </button>
              <button className="btn" onClick={() => setEditing(false)}>
                取消
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setEditing(true)}>
              编辑元数据
            </button>
          )}
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await reextract(item.id);
                setSteps(r.steps);
                pushToast('ok', `重新识别完成：${r.source}`);
              } catch (e) {
                pushToast('error', (e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '识别中…' : '重新识别元数据'}
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn danger" onClick={() => setRemoving([item.id])}>
            删除
          </button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: '0 0 8px', fontSize: 13.5 }}>识别过程</h3>
        <div style={{ color: 'var(--muted)', fontSize: 12.3 }}>
          流水线按 L0→L3 逐级降级：内嵌元数据 → DOI/CrossRef → DeepSeek JSON 抽取 + 反查 → arXiv。
          {steps ? ' 下面是最近一次识别的每一步结果：' : ' 点「重新识别元数据」可以查看每一步的判定依据。'}
        </div>
        {steps ? (
          <ul className="steps">
            {steps.map((s, i) => (
              <li key={i} className={s.ok ? 'ok' : 'no'}>
                <span className="lvl">{s.level}</span>
                <span className="note">{s.note}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {item.abstract ? (
        <div className="card">
          <h3 style={{ margin: '0 0 8px', fontSize: 13.5 }}>摘要</h3>
          <div style={{ fontSize: 12.6, lineHeight: 1.75, color: '#333a45', maxHeight: 220, overflow: 'auto' }}>
            {item.abstract}
          </div>
        </div>
      ) : null}

      <div className="card">
        <h3 style={{ margin: '0 0 8px', fontSize: 13.5 }}>标签</h3>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {item.tags.length === 0 ? <span style={{ color: '#b9bec6', fontSize: 12.3 }}>暂无标签</span> : null}
          {item.tags.map((t) => (
            <span key={t.id} className="badge tag">
              {t.name}
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            placeholder="输入标签，回车添加（多个用逗号分隔）"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && tagInput.trim()) {
                const names = [...item.tags.map((t) => t.name), ...tagInput.split(/[,，]/).map((s) => s.trim()).filter(Boolean)];
                await patchItem(item.id, { tagNames: names });
                setTagInput('');
              }
            }}
            style={{ flex: 1, height: 32, border: '1px solid var(--line)', borderRadius: 8, padding: '0 10px' }}
          />
        </div>
      </div>

      <details className="card">
        <summary style={{ cursor: 'pointer', fontSize: 13.5, fontWeight: 600 }}>CSL-JSON（与 Zotero / EndNote 互操作）</summary>
        <pre className="mono" style={{ marginTop: 10, background: '#fbfbfc', padding: 12, borderRadius: 8, overflow: 'auto', maxHeight: 300 }}>
          {JSON.stringify(item.csl ?? {}, null, 2)}
        </pre>
      </details>
    </div>
  );
}
