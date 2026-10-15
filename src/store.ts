import { create } from 'zustand';
import { api, streamChat, type ImportResult } from './api';
import { EMPTY_FILTERS } from './types';
import type { AppConfig, ChatMessage, ChatStats, Facets, FilterGroup, Filters, Item, MetaStep, Tag } from './types';

export type QueueItem = {
  name: string;
  status: 'pending' | 'uploading' | 'parsing' | 'done' | 'duplicate' | 'error';
  pct: number;
  message?: string;
  steps?: MetaStep[];
  itemId?: number;
};

export type RightTab = 'outline' | 'annotations' | 'notes' | 'ai';

interface AppState {
  items: Item[];
  tags: Tag[];
  collections: { id: number; name: string; count: number }[];
  stats: Record<string, number>;
  config: AppConfig | null;
  query: string;
  filter: string;
  collectionId: number | null;
  filters: Filters;
  facets: Facets | null;
  selectedId: number | null;
  /** 详情页是盖在阅读器上的覆盖层：阅读器保持挂载，切来切去不重渲染、不丢阅读位置 */
  detailOpen: boolean;
  rightTab: RightTab;
  queue: QueueItem[] | null;
  toast: { kind: 'info' | 'error' | 'ok'; text: string } | null;
  settingsOpen: boolean;
  selectedIds: number[];
  citeIds: number[] | null;
  removing: number[] | null;

  load: () => Promise<void>;
  loadMeta: () => Promise<void>;
  refreshConfig: () => Promise<void>;
  select: (id: number | null) => void;
  setDetailOpen: (open: boolean) => void;
  setQuery: (q: string) => void;
  setFilter: (f: string) => void;
  setCollection: (id: number | null) => void;
  toggleFilter: (group: FilterGroup, value: string) => void;
  clearFilters: () => void;
  setRightTab: (t: RightTab) => void;
  setSettings: (open: boolean) => void;
  toggleSelect: (id: number) => void;
  clearSelection: () => void;
  selectAllVisible: () => void;
  openCite: (ids?: number[]) => void;
  closeCite: () => void;
  setRemoving: (ids: number[] | null) => void;
  confirmRemove: () => Promise<void>;
  pushToast: (kind: 'info' | 'error' | 'ok', text: string) => void;
  clearToast: () => void;
  importFiles: (files: File[]) => Promise<void>;
  dismissQueue: () => void;
  createCollection: (name: string) => Promise<void>;
  reextract: (id: number) => Promise<{ steps: MetaStep[]; source: string; confidence: string }>;
  patchItem: (id: number, patch: Record<string, unknown>) => Promise<void>;
}

export const useApp = create<AppState>((set, get) => ({
  items: [],
  tags: [],
  collections: [],
  stats: {},
  config: null,
  query: '',
  filter: 'all',
  collectionId: null,
  filters: EMPTY_FILTERS,
  facets: null,
  selectedId: null,
  detailOpen: false,
  rightTab: 'outline',
  queue: null,
  toast: null,
  settingsOpen: false,
  selectedIds: [],
  citeIds: null,
  removing: null,

  load: async () => {
    const { query, filter, collectionId, filters } = get();
    const [items, stats, tags, collections, facets] = await Promise.all([
      api.items({ q: query, filter, collection: collectionId, filters }),
      api.stats(),
      api.tags(),
      api.collections(),
      api.facets({ q: query, filter, collection: collectionId }),
    ]);
    set({ items, stats, tags, collections, facets });
  },

  loadMeta: async () => {
    const [tags, collections, stats] = await Promise.all([api.tags(), api.collections(), api.stats()]);
    set({ tags, collections, stats });
  },

  refreshConfig: async () => set({ config: await api.config() }),

  select: (id) => {
    // 换文献时阅读器始终是底层视图，详情覆盖层关掉
    set({ selectedId: id, detailOpen: false });
    // 深链：?item=3，刷新后仍停在同一篇
    try {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set('item', String(id));
      else url.searchParams.delete('item');
      url.searchParams.delete('view');
      window.history.replaceState(null, '', url.toString());
    } catch {
      /* 隐私模式下可能不可用，忽略 */
    }
  },

  setDetailOpen: (detailOpen) => {
    set({ detailOpen });
    try {
      const url = new URL(window.location.href);
      if (get().selectedId && detailOpen) url.searchParams.set('view', 'detail');
      else url.searchParams.delete('view');
      window.history.replaceState(null, '', url.toString());
    } catch {
      /* 忽略 */
    }
  },

  setQuery: (query) => {
    set({ query });
    void get().load();
  },
  setFilter: (filter) => {
    set({ filter });
    void get().load();
  },
  setCollection: (collectionId) => {
    set({ collectionId, filter: 'all' });
    void get().load();
  },
  toggleFilter: (group, value) => {
    const cur = get().filters[group];
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    set({ filters: { ...get().filters, [group]: next } });
    void get().load();
  },
  clearFilters: () => {
    set({ filters: EMPTY_FILTERS });
    void get().load();
  },
  setRightTab: (rightTab) => set({ rightTab }),
  setSettings: (settingsOpen) => set({ settingsOpen }),

  toggleSelect: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id) ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id],
    })),
  clearSelection: () => set({ selectedIds: [] }),
  selectAllVisible: () => set((s) => ({ selectedIds: s.items.map((i) => i.id) })),
  openCite: (ids) => {
    const chosen = ids?.length
      ? ids
      : get().selectedIds.length
        ? get().selectedIds
        : get().selectedId
          ? [get().selectedId as number]
          : [];
    if (chosen.length) set({ citeIds: chosen });
  },
  closeCite: () => set({ citeIds: null }),
  setRemoving: (removing) => set({ removing }),

  confirmRemove: async () => {
    const ids = get().removing ?? [];
    if (!ids.length) return;
    const r = await api.bulkDelete(ids);
    set((s) => ({
      removing: null,
      selectedIds: s.selectedIds.filter((id) => !ids.includes(id)),
      selectedId: s.selectedId && ids.includes(s.selectedId) ? null : s.selectedId,
      citeIds: s.citeIds?.filter((id) => !ids.includes(id)) ?? null,
    }));
    await get().load();
    await get().loadMeta();
    get().pushToast('ok', `已删除 ${r.deleted} 篇文献${r.files ? `，同时清理 ${r.files} 个 PDF 文件` : ''}`);
  },

  pushToast: (kind, text) => {
    set({ toast: { kind, text } });
    setTimeout(() => set({ toast: null }), 5000);
  },
  clearToast: () => set({ toast: null }),
  dismissQueue: () => set({ queue: null }),

  createCollection: async (name) => {
    await api.createCollection(name);
    await get().loadMeta();
  },

  importFiles: async (files) => {
    if (!files.length) return;
    const queue: QueueItem[] = files.map((f) => ({ name: f.name, status: 'pending', pct: 0 }));
    set({ queue });
    for (let i = 0; i < files.length; i++) {
      const upd = (patch: Partial<QueueItem>) =>
        set((s) => ({ queue: (s.queue ?? []).map((q, idx) => (idx === i ? { ...q, ...patch } : q)) }));
      upd({ status: 'uploading' });
      try {
        const res: ImportResult = await api.importPdf(files[i], (pct) => upd({ pct }));
        if (res.duplicate) {
          upd({ status: 'duplicate', message: `已存在：${res.item.title.slice(0, 40)}`, itemId: res.item.id, pct: 100 });
        } else {
          upd({
            status: 'done',
            pct: 100,
            itemId: res.item.id,
            steps: res.steps,
            message: `${res.confidence === 'high' ? '高置信' : res.confidence === 'medium' ? '中置信' : '待确认'} · ${res.source}${
              res.outline ? ` · 结构 ${res.outline.sections} 节` : ''
            }`,
          });
        }
        await get().load();
        await get().loadMeta();
        const first = get().queue?.[i];
        if (i === 0 && first?.itemId) set({ selectedId: first.itemId, detailOpen: false });
      } catch (e) {
        upd({ status: 'error', message: (e as Error).message });
      }
    }
  },

  reextract: async (id) => {
    const r = await api.reextract(id);
    await get().load();
    await get().loadMeta();
    set({
      queue: [
        {
          name: r.item.title.slice(0, 50),
          status: 'done',
          pct: 100,
          steps: r.steps,
          message: `重新识别：${r.confidence} · ${r.source}`,
          itemId: id,
        },
      ],
    });
    return { steps: r.steps, source: r.source, confidence: r.confidence };
  },

  patchItem: async (id, patch) => {
    await api.updateItem(id, patch);
    await get().load();
    await get().loadMeta();
  },
}));

/* ---------------- AI 会话 ---------------- */

interface AiState {
  itemId: number | null;
  messages: ChatMessage[];
  streaming: boolean;
  reasoning: string;
  lastStats: ChatStats | null;
  totals: { cost: number; hit: number; miss: number; out: number; calls: number };
  error: string | null;
  abort: AbortController | null;

  openItem: (itemId: number) => Promise<void>;
  ask: (q: { question: string; mode?: string; selection?: string; page?: number }) => Promise<void>;
  stop: () => void;
  clear: () => Promise<void>;
}

const EMPTY_TOTALS = { cost: 0, hit: 0, miss: 0, out: 0, calls: 0 };

export const useAi = create<AiState>((set, get) => ({
  itemId: null,
  messages: [],
  streaming: false,
  reasoning: '',
  lastStats: null,
  totals: EMPTY_TOTALS,
  error: null,
  abort: null,

  openItem: async (itemId) => {
    if (get().itemId === itemId) return;
    set({ itemId, messages: [], lastStats: null, reasoning: '', totals: EMPTY_TOTALS, error: null });
    try {
      const { messages } = await api.chatHistory(itemId);
      const restored: ChatMessage[] = messages.map((m) => ({ id: m.id, role: m.role, content: m.content, meta: m.meta }));
      // 从历史消息里恢复会话累计花费/缓存统计，避免显示为 0
      const totals = restored.reduce(
        (acc, m) => {
          if (m.role !== 'assistant' || !m.meta || m.meta.error) return acc;
          return {
            cost: acc.cost + (m.meta.cost ?? 0),
            hit: acc.hit + (m.meta.cache_hit_tokens ?? 0),
            miss: acc.miss + (m.meta.cache_miss_tokens ?? 0),
            out: acc.out + (m.meta.completion_tokens ?? 0),
            calls: acc.calls + 1,
          };
        },
        { ...EMPTY_TOTALS },
      );
      set({ messages: restored, totals });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  ask: async ({ question, mode = 'chat', selection, page }) => {
    const itemId = get().itemId;
    if (!itemId || get().streaming) return;
    const cfg = useApp.getState().config;
    const model = cfg?.defaultModel ?? 'deepseek-flash';
    const thinking = model === 'deepseek-v4-pro';
    const abort = new AbortController();
    set((s) => ({
      streaming: true,
      error: null,
      reasoning: '',
      abort,
      messages: [...s.messages, { role: 'user', content: question, meta: { askMode: mode, page } }],
    }));
    let answer = '';
    try {
      await streamChat(
        itemId,
        { question, mode, selection, page, model, thinking },
        (ev) => {
          if (ev.type === 'delta') {
            answer += ev.text;
            set((s) => {
              const msgs = [...s.messages];
              const last = msgs[msgs.length - 1];
              if (last?.role === 'assistant' && last.meta?.streaming) last.content = answer;
              else msgs.push({ role: 'assistant', content: answer, meta: { streaming: true } });
              return { messages: msgs };
            });
          } else if (ev.type === 'reasoning') {
            set((s) => ({ reasoning: s.reasoning + ev.text }));
          } else if (ev.type === 'done') {
            set((s) => {
              const msgs = [...s.messages];
              const last = msgs[msgs.length - 1];
              if (last?.role === 'assistant') {
                last.meta = { ...ev.stats };
                last.content = answer;
              }
              const t = s.totals;
              return {
                messages: msgs,
                lastStats: ev.stats,
                streaming: false,
                reasoning: '',
                abort: null,
                totals: {
                  cost: t.cost + (ev.stats.cost ?? 0),
                  hit: t.hit + (ev.stats.cache_hit_tokens ?? 0),
                  miss: t.miss + (ev.stats.cache_miss_tokens ?? 0),
                  out: t.out + (ev.stats.completion_tokens ?? 0),
                  calls: t.calls + 1,
                },
              };
            });
          } else if (ev.type === 'error') {
            set({ error: ev.message, streaming: false, abort: null });
          }
        },
        abort.signal,
      );
    } catch (e) {
      set({ error: (e as Error).message, streaming: false, abort: null });
    }
  },

  stop: () => {
    get().abort?.abort();
    set({ streaming: false, abort: null });
  },

  clear: async () => {
    const itemId = get().itemId;
    if (!itemId) return;
    await api.clearChat(itemId);
    set({ messages: [], lastStats: null, totals: EMPTY_TOTALS });
  },
}));
