import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import type { CiteFormats, CiteResult } from '../types';

const FORMAT_HINT: Record<string, string> = {
  'author-date': '著者-出版年制',
  numeric: '顺序编码制',
  note: '脚注 / 尾注制',
  label: '标签制',
};

export default function CiteDialog() {
  const ids = useApp((s) => s.citeIds);
  const items = useApp((s) => s.items);
  const closeCite = useApp((s) => s.closeCite);
  const pushToast = useApp((s) => s.pushToast);

  const [catalog, setCatalog] = useState<CiteFormats | null>(null);
  const [format, setFormat] = useState('apa');
  const [locale, setLocale] = useState('en-US');
  const [result, setResult] = useState<CiteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showInline, setShowInline] = useState(true);

  useEffect(() => {
    api.citeFormats().then(setCatalog, (e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    if (!ids?.length) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .cite(ids, format, locale)
      .then(
        (r) => !cancelled && setResult(r),
        (e) => !cancelled && setError((e as Error).message),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ids, format, locale]);

  const chosen = useMemo(() => (ids ?? []).map((id) => items.find((i) => i.id === id)).filter(Boolean), [ids, items]);
  const isCsl = catalog?.styles.some((s) => s.id === format) ?? result?.kind === 'csl';
  const currentInfo = catalog ? [...catalog.styles, ...catalog.exchange].find((f) => f.id === format) : null;

  const copy = async (text: string, what: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      pushToast('ok', `已复制${what}`);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        pushToast('ok', `已复制${what}`);
      } catch {
        pushToast('error', '复制失败，请手动选择文本');
      }
      ta.remove();
    }
  };

  if (!ids?.length) return null;

  return (
    <div className="modal-back" onClick={closeCite}>
      <div className="modal cite-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          生成引用
          <span className="chip" style={{ marginLeft: 10, fontWeight: 400 }}>
            已选 {ids.length} 篇
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn small" onClick={closeCite}>
            关闭
          </button>
        </header>

        <div className="cite-body">
          <aside className="cite-formats">
            <h5>CSL 样式</h5>
            {(catalog?.styles ?? []).map((s) => (
              <button
                key={s.id}
                className={`cite-fmt ${format === s.id ? 'active' : ''}`}
                onClick={() => setFormat(s.id)}
                title={s.note}
              >
                <span>{s.label}</span>
                <small>{s.note}</small>
              </button>
            ))}
            <h5>交换格式</h5>
            {(catalog?.exchange ?? []).map((s) => (
              <button
                key={s.id}
                className={`cite-fmt ${format === s.id ? 'active' : ''}`}
                onClick={() => setFormat(s.id)}
                title={s.note}
              >
                <span>{s.label}</span>
                <small>{s.note}</small>
              </button>
            ))}
            {!catalog ? <div style={{ padding: 10, color: '#9aa1ac', fontSize: 12 }}>加载格式列表…</div> : null}
          </aside>

          <section className="cite-result">
            <div className="cite-toolbar">
              <b style={{ fontSize: 12.5 }}>{currentInfo?.label ?? format}</b>
              {isCsl ? (
                <>
                  <span className="chip">
                    {FORMAT_HINT[result?.styleMeta?.citationFormat ?? ''] ?? 'CSL 样式'}
                  </span>
                  <div className="tool-group">
                    {catalog?.locales.map((l) => (
                      <button
                        key={l.id}
                        className={`btn small ${locale === l.id ? 'active' : ''}`}
                        onClick={() => setLocale(l.id)}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--muted)' }}>
                    <input type="checkbox" checked={showInline} onChange={(e) => setShowInline(e.target.checked)} />
                    含文中引用
                  </label>
                </>
              ) : null}
              <div style={{ flex: 1 }} />
              {loading ? <span className="chip">生成中…</span> : null}
              <button className="btn small primary" onClick={() => copy(result?.text ?? '', '引用文本')} disabled={!result}>
                复制
              </button>
              {isCsl ? (
                <button
                  className="btn small"
                  onClick={() => copy(result?.bibliography.join('\n') ?? '', '参考文献列表')}
                  disabled={!result}
                >
                  只复制文献表
                </button>
              ) : null}
              <a className="btn small" href={api.citeExportUrl(ids, format, locale)} download>
                下载文件
              </a>
            </div>

            {error ? <div className="cite-error">{error}</div> : null}

            <div className="cite-scroll">
              {result && isCsl && showInline && result.inlineHtml ? (
                <div className="cite-block">
                  <div className="cite-block-title">文中引用</div>
                  <div className="csl-render" dangerouslySetInnerHTML={{ __html: result.inlineHtml }} />
                  <button className="btn small" style={{ marginTop: 6 }} onClick={() => copy(result.inline, '文中引用')}>
                    复制文中引用
                  </button>
                </div>
              ) : null}

              {result ? (
                <div className="cite-block">
                  <div className="cite-block-title">{isCsl ? '参考文献' : '内容'}</div>
                  {isCsl ? (
                    <div
                      className="csl-render csl-bib"
                      dangerouslySetInnerHTML={{ __html: result.bibliographyHtml.join('') }}
                    />
                  ) : (
                    <pre className="cite-pre">{result.text}</pre>
                  )}
                </div>
              ) : null}

              {result && result.count < ids.length ? (
                <div className="cite-note">注意：请求 {ids.length} 篇，实际生成 {result.count} 篇。</div>
              ) : null}
            </div>

            <div className="cite-foot">
              {chosen
                .slice(0, 4)
                .map((it) => (
                  <span key={it!.id} className="chip" title={it!.title}>
                    {it!.title.slice(0, 26)}
                    {it!.title.length > 26 ? '…' : ''}
                  </span>
                ))}
              {chosen.length > 4 ? <span className="chip">等 {chosen.length} 篇</span> : null}
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: 'var(--faint)' }}>
                {isCsl ? 'citeproc-js + 官方 CSL 样式（首次使用需联网下载，之后离线可用）' : '直接序列化，不依赖样式引擎'}
              </span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
