import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { api } from '../api';
import { useAi, useApp } from '../store';
import { HIGHLIGHT_COLORS, colorHex, colorLabel, type Annotation, type Item, type Rect } from '../types';
import AnnotationTab from './AnnotationTab';
import NotesTab from './NotesTab';
import AiPanel from './AiPanel';
import OutlineTab from './OutlineTab';
import { useOutline } from '../outlineStore';
import type { OutlineSection } from '../types';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

type SelMenu = { x: number; y: number; text: string; rects: Rect[]; page: number };
type Popover = { ann: Annotation; x: number; y: number };

export default function Reader({
  item,
  focus,
  onToggleFocus,
}: {
  item: Item;
  focus: boolean;
  onToggleFocus: () => void;
}) {
  const setView = useApp((s) => s.setView);
  const rightTab = useApp((s) => s.rightTab);
  const setRightTab = useApp((s) => s.setRightTab);
  const openCite = useApp((s) => s.openCite);
  const openItem = useAi((s) => s.openItem);

  const attachment = item.attachments[0] ?? null;
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tool, setTool] = useState<'select' | 'area'>('select');
  const [color, setColor] = useState<string>('yellow');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selMenu, setSelMenu] = useState<SelMenu | null>(null);
  const [popover, setPopover] = useState<Popover | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [rendered, setRendered] = useState(0);

  // ---- 缩放：默认适应宽度，随容器尺寸自动重算 ----
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoomMode, setZoomMode] = useState<'fit' | 'page' | 'manual'>('fit');
  const [manualScale, setManualScale] = useState(1.3);
  const [container, setContainer] = useState({ w: 0, h: 0 });
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null);

  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // 容器尺寸（rAF + 140ms 防抖，避免拖窗口时反复重渲染全部页面）
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let timer = 0;
    const measure = () => setContainer({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, 140);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [attachment?.id]);

  // 第 1 页的原始尺寸，用来算「适应宽度」
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    doc.getPage(1).then(
      (p) => {
        if (cancelled) return;
        const v = p.getViewport({ scale: 1 });
        setBaseSize({ w: v.width, h: v.height });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [doc]);

  const PAD_X = 84;
  const PAD_Y = 44;
  const scale = useMemo(() => {
    if (zoomMode === 'manual' || !baseSize || !container.w) return manualScale;
    const availW = Math.max(140, container.w - PAD_X);
    const availH = Math.max(140, (container.h || 800) - PAD_Y);
    const fitW = availW / baseSize.w;
    const s = zoomMode === 'fit' ? fitW : Math.min(fitW, availH / baseSize.h);
    return Math.min(3, Math.max(0.3, s));
  }, [zoomMode, manualScale, baseSize, container]);

  const zoomBy = useCallback(
    (delta: number) => {
      setManualScale(Math.min(3, Math.max(0.3, +(scale + delta).toFixed(2))));
      setZoomMode('manual');
    },
    [scale],
  );

  const ready = !!doc && !!baseSize && container.w > 0;

  // 键盘快捷键：+/- 缩放，0 适应宽度（在输入框里打字时不触发）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          zoomBy(0.15);
        } else if (e.key === '-') {
          e.preventDefault();
          zoomBy(-0.15);
        } else if (e.key === '0') {
          e.preventDefault();
          setZoomMode('fit');
        }
        return;
      }
      if (e.key === '+' || e.key === '=') zoomBy(0.15);
      else if (e.key === '-') zoomBy(-0.15);
      else if (e.key === '0') setZoomMode('fit');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomBy]);

  /* 加载 PDF */
  useEffect(() => {
    if (!attachment) return;
    let cancelled = false;
    setDoc(null);
    setLoadError(null);
    setRendered(0);
    const task = pdfjsLib.getDocument({ url: `/api/attachments/${attachment.id}/file` });
    task.promise.then(
      (d) => {
        if (!cancelled) setDoc(d);
      },
      (e) => {
        if (!cancelled) setLoadError(String(e?.message ?? e));
      },
    );
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [attachment?.id]);

  /* 加载标注 + 会话 + 结构 */
  useEffect(() => {
    let cancelled = false;
    api.annotations(item.id).then(
      (a) => {
        if (!cancelled) setAnnotations(a);
      },
      () => undefined,
    );
    void openItem(item.id);
    void useOutline.getState().open(item.id);
    return () => {
      cancelled = true;
    };
  }, [item.id, openItem]);

  const outline = useOutline((s) => s.data);

  // 有目录时默认展示目录（用户手动切过 tab 就不再自动切）
  const userPickedTab = useRef(false);
  useEffect(() => {
    userPickedTab.current = false;
  }, [item.id]);
  useEffect(() => {
    if (!outline || userPickedTab.current) return;
    if ((outline.sections?.length ?? 0) >= 4) setRightTab('outline');
  }, [outline, setRightTab]);

  const byPage = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const a of annotations) {
      const list = map.get(a.page) ?? [];
      list.push(a);
      map.set(a.page, list);
    }
    return map;
  }, [annotations]);

  const jumpToPage = useCallback((page: number, annId?: number) => {
    const el = pageRefs.current[page];
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (annId !== undefined) {
      setActiveId(annId);
      window.setTimeout(() => setActiveId((cur) => (cur === annId ? null : cur)), 2600);
    }
  }, []);

  /** 跳到某页的指定纵向位置（yFrac = 页面内自上而下的比例），而不只是页首 */
  const jumpToSection = useCallback((s: OutlineSection) => {
    const el = pageRefs.current[s.page];
    const scroller = scrollRef.current;
    if (!el) return;
    if (scroller && s.yFrac > 0.001) {
      const scRect = scroller.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const target = scroller.scrollTop + (elRect.top - scRect.top) + s.yFrac * elRect.height - 16;
      scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    } else {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setActiveSection(s.id);
  }, []);

  /* 当前阅读到哪一节：滚动时把最后一个越过视口顶部的章节标为 active */
  const [activeSection, setActiveSection] = useState<string | null>(null);
  useEffect(() => {
    const sc = scrollRef.current;
    const secs = outline?.sections ?? [];
    if (!sc || !secs.length) return;
    let raf = 0;
    const compute = () => {
      const scTop = sc.getBoundingClientRect().top + 48;
      let current: string | null = null;
      for (const s of secs) {
        const el = pageRefs.current[s.page];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.top + s.yFrac * r.height <= scTop) current = s.id;
        else break;
      }
      setActiveSection(current);
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(compute);
    };
    sc.addEventListener('scroll', onScroll, { passive: true });
    compute();
    return () => {
      sc.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [outline, scale, rendered]);

  const reload = useCallback(async () => setAnnotations(await api.annotations(item.id)), [item.id]);

  const createHighlight = useCallback(
    async (rects: Rect[], text: string, page: number, kind: Annotation['kind'] = 'highlight', image = '') => {
      if (!attachment) return;
      const created = await api.createAnnotation({
        item_id: item.id,
        attachment_id: attachment.id,
        page,
        kind,
        color,
        rects,
        text,
        image_data: image,
      });
      setAnnotations((prev) => [...prev, created]);
      setActiveId(created.id);
      void useApp.getState().loadMeta();
    },
    [attachment, color, item.id],
  );

  const removeAnnotation = useCallback(
    async (id: number) => {
      await api.deleteAnnotation(id);
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      setPopover(null);
      void useApp.getState().loadMeta();
    },
    [],
  );

  const updateAnnotation = useCallback(async (id: number, patch: Partial<Annotation>) => {
    const updated = await api.updateAnnotation(id, patch);
    setAnnotations((prev) => prev.map((a) => (a.id === id ? updated : a)));
    return updated;
  }, []);

  const explain = useCallback(
    (text: string, page: number) => {
      setSelMenu(null);
      setPopover(null);
      setRightTab('ai');
      void useAi.getState().ask({ question: '', mode: 'explain', selection: text, page });
    },
    [setRightTab],
  );

  const toNote = useCallback(
    (text: string, page: number) => {
      setSelMenu(null);
      setPopover(null);
      setRightTab('ai');
      void useAi.getState().ask({ question: '', mode: 'note', selection: text, page });
    },
    [setRightTab],
  );

  if (!attachment) {
    return (
      <div className="empty">
        <div>
          <div className="big">这篇文献没有 PDF 附件</div>
          <div className="hint">
            在详情页删除后重新导入，或手动补充附件。
            <br />
            <br />
            <button className="btn" onClick={() => setView('detail')}>
              返回详情
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="reader">
      <div className="reader-toolbar">
        <button className="btn small" onClick={() => setView('detail')} title="返回详情">
          ← 详情
        </button>
        <button className="btn small" onClick={onToggleFocus}>
          {focus ? '显示侧栏' : '专注阅读'}
        </button>
        <span className="title" title={item.title}>
          {item.title}
        </span>
        <div className="spacer" />
        <button className="btn small" onClick={() => openCite([item.id])} title="生成引用">
          引用
        </button>
        <div className="tool-group">
          <button className={`btn small ${tool === 'select' ? 'active' : ''}`} onClick={() => setTool('select')} title="划词高亮">
            ✎ 划词
          </button>
          <button className={`btn small ${tool === 'area' ? 'active' : ''}`} onClick={() => setTool('area')} title="框选图表/公式">
            ▣ 框选
          </button>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c.name}
              title={c.label}
              onClick={() => setColor(c.name)}
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: c.hex,
                border: color === c.name ? '2px solid #2f5fd0' : '1px solid rgba(0,0,0,.12)',
                cursor: 'pointer',
                padding: 0,
              }}
            />
          ))}
        </div>
        <div className="tool-group" title="Ctrl +/- 缩放，Ctrl+0 适应宽度">
          <button
            className={`btn small ${zoomMode === 'fit' ? 'active' : ''}`}
            onClick={() => setZoomMode('fit')}
            title="适应宽度"
          >
            适宽
          </button>
          <button
            className={`btn small ${zoomMode === 'page' ? 'active' : ''}`}
            onClick={() => setZoomMode('page')}
            title="整页显示"
          >
            整页
          </button>
        </div>
        <div className="tool-group">
          <button className="btn small" onClick={() => zoomBy(-0.15)} title="缩小">
            −
          </button>
          <span style={{ padding: '0 6px', fontSize: 11.5, color: 'var(--muted)', minWidth: 42, textAlign: 'center' }}>
            {Math.round(scale * 100)}%
          </span>
          <button className="btn small" onClick={() => zoomBy(0.15)} title="放大">
            ＋
          </button>
        </div>
        <span className="chip">{attachment.page_count} 页</span>
        {doc && rendered < doc.numPages ? <span className="chip">渲染 {rendered}/{doc.numPages}</span> : null}
      </div>

      <div className="reader-body">
        <div className="pdf-scroll" ref={scrollRef} onClick={() => setSelMenu(null)}>
          {loadError ? (
            <div style={{ padding: 30, color: 'var(--danger)' }}>PDF 加载失败：{loadError}</div>
          ) : null}
          {/* 等基准页尺寸与容器宽度都量好再渲染，避免先按旧缩放画一遍再重画 */}
          {!ready && !loadError ? <div style={{ padding: 30, color: 'var(--muted)' }}>正在加载 PDF…</div> : null}
          {ready && doc ? (
            <div className="pdf-pages">
              {Array.from({ length: doc.numPages }, (_, i) => i + 1).map((n) => (
                <PdfPage
                  key={n}
                  doc={doc}
                  pageNumber={n}
                  scale={scale}
                  annotations={byPage.get(n) ?? []}
                  tool={tool}
                  activeId={activeId}
                  registerRef={(el) => {
                    pageRefs.current[n] = el;
                  }}
                  onRendered={() => setRendered((r) => r + 1)}
                  onSelect={(menu) => setSelMenu(menu)}
                  onArea={(rects, image) => {
                    setTool('select');
                    void createHighlight(rects, '', n, 'area', image);
                  }}
                  onAnnotationClick={(ann, x, y) => {
                    setActiveId(ann.id);
                    setPopover({ ann, x, y });
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>

        <aside className="side">
          <div className="tabs">
            <button
              className={`tab ${rightTab === 'outline' ? 'active' : ''}`}
              onClick={() => {
                userPickedTab.current = true;
                setRightTab('outline');
              }}
            >
              目录 {outline?.sections?.length ? `(${outline.sections.length})` : ''}
            </button>
            <button
              className={`tab ${rightTab === 'annotations' ? 'active' : ''}`}
              onClick={() => {
                userPickedTab.current = true;
                setRightTab('annotations');
              }}
            >
              标注 {annotations.length ? `(${annotations.length})` : ''}
            </button>
            <button
              className={`tab ${rightTab === 'notes' ? 'active' : ''}`}
              onClick={() => {
                userPickedTab.current = true;
                setRightTab('notes');
              }}
            >
              笔记
            </button>
            <button
              className={`tab ${rightTab === 'ai' ? 'active' : ''}`}
              onClick={() => {
                userPickedTab.current = true;
                setRightTab('ai');
              }}
            >
              AI 伴读
            </button>
          </div>
          {rightTab === 'outline' ? (
            <OutlineTab activeId={activeSection} onJump={jumpToSection} />
          ) : rightTab === 'annotations' ? (
            <AnnotationTab
              itemId={item.id}
              annotations={annotations}
              onJump={jumpToPage}
              onDelete={removeAnnotation}
              onColor={(id, c) => void updateAnnotation(id, { color: c })}
              onExplain={explain}
              onNote={toNote}
              onReload={reload}
            />
          ) : rightTab === 'notes' ? (
            <NotesTab itemId={item.id} />
          ) : (
            <AiPanel item={item} onJumpPage={(p) => jumpToPage(p)} />
          )}
        </aside>
      </div>

      {selMenu ? (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 55 }} onClick={() => setSelMenu(null)} />
          <div
            className="sel-menu"
            style={{
              left: Math.min(Math.max(selMenu.x - 130, 10), window.innerWidth - 300),
              top: Math.max(selMenu.y - 46, 60),
            }}
          >
            {HIGHLIGHT_COLORS.map((c) => (
              <button
                key={c.name}
                className="color-swatch"
                title={`高亮：${c.label}`}
                style={{ background: c.hex }}
                onClick={() => {
                  const m = selMenu;
                  setSelMenu(null);
                  window.getSelection()?.removeAllRanges();
                  void createHighlight(m.rects, m.text, m.page);
                }}
              />
            ))}
            <span className="sep" />
            <button onClick={() => explain(selMenu.text, selMenu.page)}>AI 解释</button>
            <button onClick={() => toNote(selMenu.text, selMenu.page)}>整理成笔记</button>
          </div>
        </>
      ) : null}

      {popover ? (
        <AnnotationPopover
          ann={popover.ann}
          x={popover.x}
          y={popover.y}
          onClose={() => setPopover(null)}
          onColor={(c) => void updateAnnotation(popover.ann.id, { color: c })}
          onComment={(text) => void updateAnnotation(popover.ann.id, { comment: text })}
          onDelete={() => void removeAnnotation(popover.ann.id)}
          onExplain={() =>
            explain(popover.ann.text || `第 ${popover.ann.page} 页的框选区域（图表 / 公式）`, popover.ann.page)
          }
          onNote={() => toNote(popover.ann.text, popover.ann.page)}
          onJump={() => jumpToPage(popover.ann.page)}
        />
      ) : null}
    </div>
  );
}

/* ---------------- 单页渲染 ---------------- */

function PdfPage({
  doc,
  pageNumber,
  scale,
  annotations,
  tool,
  activeId,
  registerRef,
  onRendered,
  onSelect,
  onArea,
  onAnnotationClick,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  annotations: Annotation[];
  tool: 'select' | 'area';
  activeId: number | null;
  registerRef: (el: HTMLDivElement | null) => void;
  onRendered: () => void;
  onSelect: (menu: SelMenu) => void;
  onArea: (rects: Rect[], image: string) => void;
  onAnnotationClick: (ann: Annotation, x: number, y: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // 拖拽过程用 ref 记录（同步、不受 React 批处理影响），state 只负责画选框
  const dragRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [dragBox, setDragBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let textLayer: { cancel?: () => void } | null = null;
    let renderTask: ReturnType<PDFPageProxy['render']> | null = null;
    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const textDiv = textLayerRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !textDiv || !wrap) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext('2d', { alpha: false })!;

      // v6 使用 --total-scale-factor 定位文本层
      wrap.style.setProperty('--total-scale-factor', String(scale));
      wrap.style.setProperty('--scale-factor', String(scale));
      setSize({ w: Math.floor(viewport.width), h: Math.floor(viewport.height) });

      // 关键：DPR 只能应用一次。
      // 之前这里还额外 ctx.setTransform(dpr,...)，而 pdf.js 又会把 transform 参数叠加上去，
      // 总缩放变成 dpr² —— 在 125% 缩放的屏幕上内容被放大 1.25 倍，页面右缘整片被裁掉
      // （dpr=1 时两次都是 1，所以只在高分屏/系统缩放下暴露）。
      // 现在统一交给 pdf.js 的 transform 参数，canvas 保持默认单位矩阵。
      renderTask = page.render({
        canvas: null,
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      await renderTask.promise;
      renderTask = null;
      if (cancelled) return;

      textDiv.replaceChildren();
      textDiv.style.width = `${Math.floor(viewport.width)}px`;
      textDiv.style.height = `${Math.floor(viewport.height)}px`;
      const tl = new pdfjsLib.TextLayer({
        textContentSource: await page.getTextContent(),
        container: textDiv,
        viewport,
      });
      textLayer = tl as unknown as { cancel?: () => void };
      await tl.render();
      if (!cancelled) onRendered();
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {
        /* 渲染已完成或被取消 */
      }
      try {
        textLayer?.cancel?.();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageNumber, scale]);

  const norm = (e: React.MouseEvent) => {
    const base = wrapRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max((e.clientX - base.left) / base.width, 0), 1),
      y: Math.min(Math.max((e.clientY - base.top) / base.height, 0), 1),
    };
  };

  const handleMouseUp = () => {
    if (tool !== 'select') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const wrap = wrapRef.current;
    if (!wrap || !wrap.contains(range.commonAncestorContainer)) return;
    const text = sel.toString().trim();
    if (text.length < 2) return;
    const base = wrap.getBoundingClientRect();
    const rects: Rect[] = [];
    const clientRects = range.getClientRects();
    let last: DOMRect | null = null;
    for (let i = 0; i < clientRects.length; i++) {
      const r = clientRects[i];
      if (r.width < 2 || r.height < 2) continue;
      last = r;
      rects.push({
        x: (r.left - base.left) / base.width,
        y: (r.top - base.top) / base.height,
        w: r.width / base.width,
        h: r.height / base.height,
      });
    }
    if (!rects.length || !last) return;
    onSelect({
      x: last.left + last.width / 2,
      y: last.top + window.scrollY,
      text,
      rects,
      page: pageNumber,
    });
  };

  const cropImage = (r: Rect) => {
    const canvas = canvasRef.current;
    if (!canvas) return '';
    const sx = Math.max(0, Math.round(r.x * canvas.width));
    const sy = Math.max(0, Math.round(r.y * canvas.height));
    const sw = Math.min(canvas.width - sx, Math.round(r.w * canvas.width));
    const sh = Math.min(canvas.height - sy, Math.round(r.h * canvas.height));
    if (sw < 4 || sh < 4) return '';
    const maxW = 900;
    const k = Math.min(1, maxW / sw);
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.round(sw * k));
    tmp.height = Math.max(1, Math.round(sh * k));
    const tctx = tmp.getContext('2d')!;
    tctx.fillStyle = '#fff';
    tctx.fillRect(0, 0, tmp.width, tmp.height);
    tctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, tmp.width, tmp.height);
    return tmp.toDataURL('image/png');
  };

  return (
    <div
      className="page-wrap"
      ref={(el) => {
        wrapRef.current = el;
        registerRef(el);
      }}
      style={{ width: size.w || undefined, height: size.h || undefined }}
      onMouseUp={handleMouseUp}
    >
      <span className="page-badge">{pageNumber}</span>
      <canvas ref={canvasRef} />
      <div className="textLayer" ref={textLayerRef} />
      <div className="annotation-overlay">
        {annotations.flatMap((a) =>
          a.rects.map((r, i) => (
            <div
              key={`${a.id}-${i}`}
              className={`ann-rect ${a.kind === 'area' ? 'area' : ''} ${activeId === a.id ? 'active flash' : ''}`}
              style={{
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`,
                background: a.kind === 'area' ? undefined : `${colorHex(a.color)}66`,
                borderBottom: a.kind === 'area' ? undefined : `2px solid ${colorHex(a.color)}`,
              }}
              title={a.comment || a.text.slice(0, 120)}
              onClick={(e) => {
                e.stopPropagation();
                const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                onAnnotationClick(a, box.left, box.bottom);
              }}
            />
          )),
        )}
      </div>
      {tool === 'area' ? (
        <div
          className="area-capture"
          onMouseDown={(e) => {
            e.preventDefault();
            const p = norm(e);
            dragRef.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
            setDragBox(dragRef.current);
          }}
          onMouseMove={(e) => {
            if (!dragRef.current) return;
            const p = norm(e);
            dragRef.current = { ...dragRef.current, x1: p.x, y1: p.y };
            setDragBox(dragRef.current);
          }}
          onMouseUp={() => {
            const d = dragRef.current;
            dragRef.current = null;
            setDragBox(null);
            if (!d) return;
            const r: Rect = {
              x: Math.min(d.x0, d.x1),
              y: Math.min(d.y0, d.y1),
              w: Math.abs(d.x1 - d.x0),
              h: Math.abs(d.y1 - d.y0),
            };
            if (r.w * (size.w || 600) < 12 || r.h * (size.h || 800) < 12) return;
            onArea([r], cropImage(r));
          }}
        />
      ) : null}
      {dragBox ? (
        <div
          className="area-box"
          style={{
            left: `${Math.min(dragBox.x0, dragBox.x1) * 100}%`,
            top: `${Math.min(dragBox.y0, dragBox.y1) * 100}%`,
            width: `${Math.abs(dragBox.x1 - dragBox.x0) * 100}%`,
            height: `${Math.abs(dragBox.y1 - dragBox.y0) * 100}%`,
          }}
        />
      ) : null}
    </div>
  );
}

/* ---------------- 标注浮层 ---------------- */

function AnnotationPopover({
  ann,
  x,
  y,
  onClose,
  onColor,
  onComment,
  onDelete,
  onExplain,
  onNote,
  onJump,
}: {
  ann: Annotation;
  x: number;
  y: number;
  onClose: () => void;
  onColor: (c: string) => void;
  onComment: (t: string) => void;
  onDelete: () => void;
  onExplain: () => void;
  onNote: () => void;
  onJump: () => void;
}) {
  const [comment, setComment] = useState(ann.comment);
  useEffect(() => setComment(ann.comment), [ann.id, ann.comment]);

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 58 }} onClick={onClose} />
      <div
        style={{
          position: 'fixed',
          left: Math.min(Math.max(x - 40, 12), window.innerWidth - 360),
          top: Math.min(y + 8, window.innerHeight - 300),
          width: 336,
          background: '#fff',
          border: '1px solid var(--line)',
          borderRadius: 12,
          boxShadow: '0 16px 40px rgba(16,24,40,.22)',
          zIndex: 59,
          padding: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span className="badge">第 {ann.page} 页</span>
          <span className="badge">{ann.kind === 'area' ? '框选区域' : colorLabel(ann.color)}</span>
          <div style={{ flex: 1 }} />
          <button className="btn small" onClick={onJump}>
            定位
          </button>
          <button className="btn small danger" onClick={onDelete}>
            删除
          </button>
        </div>

        {ann.image_data ? (
          <img src={ann.image_data} alt="框选区域" style={{ width: '100%', borderRadius: 8, border: '1px solid var(--line)', marginBottom: 8 }} />
        ) : null}
        {ann.text ? (
          <div style={{ fontSize: 12.3, lineHeight: 1.65, maxHeight: 120, overflow: 'auto', color: '#333a45', marginBottom: 8 }}>
            {ann.text}
          </div>
        ) : null}

        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onBlur={() => onComment(comment)}
          placeholder="写点批注…（失焦自动保存）"
          style={{ width: '100%', minHeight: 52, border: '1px solid var(--line)', borderRadius: 8, padding: 7, fontSize: 12.3, resize: 'vertical' }}
        />

        <div style={{ display: 'flex', gap: 5, margin: '9px 0' }}>
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c.name}
              title={c.label}
              onClick={() => onColor(c.name)}
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: c.hex,
                border: ann.color === c.name ? '2px solid #2f5fd0' : '1px solid rgba(0,0,0,.12)',
                cursor: 'pointer',
                padding: 0,
              }}
            />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn small primary" onClick={onExplain} disabled={!ann.text && ann.kind !== 'area'}>
            AI 解释这段
          </button>
          <button className="btn small" onClick={onNote} disabled={!ann.text}>
            整理成笔记
          </button>
        </div>
      </div>
    </>
  );
}
