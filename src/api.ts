import type {
  Annotation,
  AppConfig,
  Item,
  MetaStep,
  Note,
  ChatMessage,
  ChatStats,
  CiteFormats,
  CiteResult,
  Facets,
  Filters,
  Outline,
} from './types';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? `HTTP ${res.status}`);
  return data as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  config: () => req<AppConfig>('/api/config'),
  saveConfig: (patch: { apiKey?: string; defaultModel?: string }) => req<AppConfig>('/api/config', json(patch)),
  testConfig: () => req<{ ok: boolean; message: string }>('/api/config/test', { method: 'POST' }),

  stats: () => req<Record<string, number>>('/api/stats'),
  collections: () => req<{ id: number; name: string; count: number }[]>('/api/collections'),
  createCollection: (name: string) => req<{ id: number }>('/api/collections', json({ name })),
  tags: () => req<{ id: number; name: string; color: string; count: number }[]>('/api/tags'),

  items: (params: {
    q?: string;
    filter?: string;
    collection?: number | null;
    filters?: Filters;
  }) => {
    const sp = new URLSearchParams();
    if (params.q) sp.set('q', params.q);
    if (params.filter) sp.set('filter', params.filter);
    if (params.collection) sp.set('collection', String(params.collection));
    const f = params.filters;
    if (f) {
      for (const [key, values] of Object.entries(f)) {
        if (values?.length) sp.set(key, values.join(','));
      }
    }
    return req<Item[]>(`/api/items?${sp}`);
  },
  facets: (params: { q?: string; filter?: string; collection?: number | null }) => {
    const sp = new URLSearchParams();
    if (params.q) sp.set('q', params.q);
    if (params.filter) sp.set('filter', params.filter);
    if (params.collection) sp.set('collection', String(params.collection));
    return req<Facets>(`/api/facets?${sp}`);
  },
  bulkDelete: (ids: number[]) =>
    req<{ ok: true; deleted: number; files: number }>('/api/items/bulk-delete', json({ ids })),
  item: (id: number) => req<Item>(`/api/items/${id}`),
  updateItem: (id: number, patch: Record<string, unknown>) =>
    req<Item>(`/api/items/${id}`, { ...json(patch), method: 'PATCH' }),
  deleteItem: (id: number) => req<{ ok: true }>(`/api/items/${id}`, { method: 'DELETE' }),
  reextract: (id: number) =>
    req<{ item: Item; steps: MetaStep[]; source: string; confidence: string }>(`/api/items/${id}/reextract`, {
      method: 'POST',
    }),

  text: (id: number) => req<{ pages: { page: number; text: string }[]; pageCount: number }>(`/api/items/${id}/text`),

  outline: (id: number) => req<Outline>(`/api/items/${id}/outline`),
  reparseOutline: (id: number, useAi: boolean) =>
    req<Outline>(`/api/items/${id}/outline`, json({ useAi })),

  annotations: (itemId: number) => req<Annotation[]>(`/api/items/${itemId}/annotations`),
  createAnnotation: (a: Partial<Annotation>) => req<Annotation>('/api/annotations', json(a)),
  updateAnnotation: (id: number, patch: Partial<Annotation>) =>
    req<Annotation>(`/api/annotations/${id}`, { ...json(patch), method: 'PATCH' }),
  deleteAnnotation: (id: number) => req<{ ok: true }>(`/api/annotations/${id}`, { method: 'DELETE' }),

  notes: (itemId: number) => req<Note[]>(`/api/items/${itemId}/notes`),
  createNote: (itemId: number, md: string, source = 'manual') =>
    req<Note>(`/api/items/${itemId}/notes`, json({ md, source })),
  deleteNote: (id: number) => req<{ ok: true }>(`/api/notes/${id}`, { method: 'DELETE' }),

  chatHistory: (itemId: number) => req<{ messages: ChatMessage[] }>(`/api/items/${itemId}/chat`),
  clearChat: (itemId: number) => req<{ ok: true }>(`/api/items/${itemId}/chat`, { method: 'DELETE' }),

  citeFormats: () => req<CiteFormats>('/api/cite/formats'),
  cite: (itemIds: number[], format: string, locale: string) =>
    req<CiteResult>('/api/cite', json({ itemIds, format, locale })),
  citeExportUrl: (itemIds: number[], format: string, locale: string) =>
    `/api/cite/export?ids=${itemIds.join(',')}&format=${encodeURIComponent(format)}&locale=${encodeURIComponent(locale)}`,

  importPdf: async (file: File, onProgress?: (pct: number) => void): Promise<ImportResult> => {
    // 直接上传裸字节，避免 multipart 解析；文件名走 header
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/import');
      xhr.setRequestHeader('Content-Type', 'application/pdf');
      xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 400) reject(new Error(data.error ?? `HTTP ${xhr.status}`));
          else resolve(data);
        } catch {
          reject(new Error(`上传响应异常：${xhr.responseText.slice(0, 200)}`));
        }
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(file);
    });
  },
};

export interface ImportResult {
  duplicate: boolean;
  item: Item;
  steps: MetaStep[];
  confidence: 'high' | 'medium' | 'low';
  source: string;
  pageCount?: number;
  hasText?: boolean;
  outline?: { sections: number; source: string } | null;
}

export type ChatEvent =
  | { type: 'meta'; mode: 'live' | 'mock'; model: string; thinking: boolean; prefixTokens: number }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'done'; stats: ChatStats; reasoning: string }
  | { type: 'error'; message: string };

/** SSE 流式提问 */
export async function streamChat(
  itemId: number,
  body: { question: string; mode?: string; selection?: string; page?: number; model?: string; thinking?: boolean },
  onEvent: (ev: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/items/${itemId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((data as { error?: string }).error ?? '请求失败');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as ChatEvent);
      } catch {
        /* 忽略无法解析的片段 */
      }
    }
  }
}
