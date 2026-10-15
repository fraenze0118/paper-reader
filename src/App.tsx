import { useEffect, useRef, useState } from 'react';
import { useApp } from './store';
import Nav from './components/Nav';
import LibraryList from './components/LibraryList';
import ItemDetail from './components/ItemDetail';
import Reader from './components/Reader';
import QueuePanel from './components/QueuePanel';
import Settings from './components/Settings';
import CiteDialog from './components/CiteDialog';
import DeleteConfirm from './components/DeleteConfirm';

export default function App() {
  const items = useApp((s) => s.items);
  const stats = useApp((s) => s.stats);
  const selectedId = useApp((s) => s.selectedId);
  const detailOpen = useApp((s) => s.detailOpen);
  const setDetailOpen = useApp((s) => s.setDetailOpen);
  const config = useApp((s) => s.config);
  const queue = useApp((s) => s.queue);
  const toast = useApp((s) => s.toast);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const load = useApp((s) => s.load);
  const refreshConfig = useApp((s) => s.refreshConfig);
  const importFiles = useApp((s) => s.importFiles);
  const setSettings = useApp((s) => s.setSettings);
  const select = useApp((s) => s.select);

  const [dragging, setDragging] = useState(false);
  const [focus, setFocus] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    void refreshConfig();
    void load();
  }, [load, refreshConfig]);

  // 支持深链 ?item=<id>（刷新/分享后停在原处，也方便自动化截图）
  const deepLinkApplied = useRef(false);
  useEffect(() => {
    if (deepLinkApplied.current || !items.length) return;
    deepLinkApplied.current = true;
    const params = new URLSearchParams(window.location.search);
    const id = Number(params.get('item'));
    if (id && items.some((i) => i.id === id)) {
      select(id);
      if (params.get('view') === 'detail') setDetailOpen(true);
    }
  }, [items, select, setDetailOpen]);

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      dragDepth.current += 1;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const onDragLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) =>
        /\.pdf$/i.test(f.name) || f.type === 'application/pdf',
      );
      if (files.length) void importFiles(files);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [importFiles]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSettings(false);
        setFocus(false);
        // 详情覆盖层优先关闭
        if (useApp.getState().detailOpen) setDetailOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSettings, setDetailOpen]);

  const selected = items.find((i) => i.id === selectedId) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <BrandLogo />
          paper-reader <small>本地文献阅读工具 · demo</small>
        </div>
        <div className="spacer" />
        <span className="chip">
          文献 <b>{stats.items ?? 0}</b>
        </span>
        <span className="chip">
          标注 <b>{stats.annotations ?? 0}</b>
        </span>
        {stats.needs_review ? <span className="chip warn">待确认 {stats.needs_review}</span> : null}
        {config ? (
          config.hasKey ? (
            <span className="chip ok dot">DeepSeek 已连接 · {config.defaultModel}</span>
          ) : (
            <span className="chip mock dot">演示模式（未配置 API Key）</span>
          )
        ) : null}
        <span className="chip">{config?.peak ? '高峰时段计价' : '空闲时段计价（半价）'}</span>
        <button className="btn" onClick={() => setSettings(true)}>
          设置
        </button>
      </header>

      <div className="body" style={focus ? { gridTemplateColumns: '0 0 1fr' } : undefined}>
        <div style={focus ? { overflow: 'hidden' } : undefined}>
          <Nav />
        </div>
        <div style={focus ? { overflow: 'hidden' } : undefined}>
          <LibraryList />
        </div>
        <main className="main-area">
          {selected ? (
            <>
              {/* 阅读器始终保持挂载：详情页是盖在它上面的覆盖层。
                  这样来回切换不会销毁 PDF、不重建几十页 canvas、也不丢阅读位置。 */}
              <div className="main-reader" aria-hidden={detailOpen || undefined}>
                <Reader item={selected} focus={focus} onToggleFocus={() => setFocus((f) => !f)} />
              </div>
              {detailOpen ? (
                <div className="main-overlay">
                  <div className="overlay-bar">
                    <button className="btn small" onClick={() => setDetailOpen(false)}>
                      ← 返回阅读
                    </button>
                    <span className="overlay-title" title={selected.title}>
                      {selected.title}
                    </span>
                  </div>
                  <ItemDetail item={selected} />
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState />
          )}
        </main>
      </div>

      {dragging ? (
        <div className="dropzone">
          <div className="box">
            <b>松开以导入 PDF</b>
            支持一次拖入多个文件或整个文件夹 · 自动识别作者 / 年份 / DOI / 期刊
          </div>
        </div>
      ) : null}

      {queue ? <QueuePanel /> : null}
      {settingsOpen ? <Settings /> : null}
      <CiteDialog />
      <DeleteConfirm />
      {toast ? <div className={`toast ${toast.kind}`}>{toast.text}</div> : null}
    </div>
  );
}

function EmptyState() {
  const importFiles = useApp((s) => s.importFiles);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="empty">
      <div>
        <div className="big">从左侧选一篇文献开始</div>
        <div className="hint">
          点列表里的任意一篇会打开阅读器，可以划词高亮、批注，并让 AI 陪你读。
          <br />
          <br />
          还没有文献？把 PDF 拖到窗口任意位置，或直接
          <button className="btn primary" style={{ marginLeft: 6 }} onClick={() => ref.current?.click()}>
            选择 PDF 文件
          </button>
          <input
            ref={ref}
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
        </div>
      </div>
    </div>
  );
}

/** 品牌标：与 public/favicon.svg 同一份矢量图形，保证标签页图标和界面 logo 一致 */
function BrandLogo() {
  return (
    <svg className="logo" viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="brand-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#2f5fd0" />
          <stop offset="100%" stopColor="#6b8ff0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#brand-logo-bg)" />
      <path
        fill="#fff"
        fillRule="evenodd"
        d="M18 16 H34 A12 12 0 0 1 34 40 H26 V48 H18 Z M26 24 H34 A4 4 0 0 1 34 32 H26 Z"
      />
    </svg>
  );
}
