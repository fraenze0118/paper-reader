import { create } from 'zustand';
import { api } from './api';
import type { Outline } from './types';

interface OutlineState {
  itemId: number | null;
  data: Outline | null;
  loading: boolean;
  error: string | null;
  open: (itemId: number) => Promise<void>;
  reparse: (useAi: boolean) => Promise<void>;
}

export const useOutline = create<OutlineState>((set, get) => ({
  itemId: null,
  data: null,
  loading: false,
  error: null,

  open: async (itemId) => {
    if (get().itemId === itemId) return;
    set({ itemId, data: null, error: null, loading: true });
    try {
      const data = await api.outline(itemId);
      if (get().itemId === itemId) set({ data, loading: false });
    } catch (e) {
      if (get().itemId === itemId) set({ error: (e as Error).message, loading: false });
    }
  },

  reparse: async (useAi) => {
    const itemId = get().itemId;
    if (!itemId) return;
    set({ loading: true, error: null });
    try {
      const data = await api.reparseOutline(itemId, useAi);
      if (get().itemId === itemId) set({ data, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },
}));
