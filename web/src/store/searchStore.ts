/**
 * 检索状态：当前 query、关键字、各集合结果、延迟、错误、集合提示
 */
import { create } from 'zustand';
import type { SearchResult } from '../types';

interface SearchState {
  query: string;
  keyword: string;
  isSearching: boolean;
  textResults: SearchResult | null;
  imageResults: SearchResult | null;
  error: string | null;
  /** 集合选择提示（如当前集合失效、已回退到约定集合），以警示条展示 */
  collectionNotice: string | null;
  setQuery: (q: string) => void;
  setKeyword: (k: string) => void;
  setSearching: (s: boolean) => void;
  setTextResults: (r: SearchResult | null) => void;
  setImageResults: (r: SearchResult | null) => void;
  setError: (e: string | null) => void;
  setCollectionNotice: (notice: string | null) => void;
  reset: () => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  query: '',
  keyword: '',
  isSearching: false,
  textResults: null,
  imageResults: null,
  error: null,
  collectionNotice: null,
  setQuery: (q) => set({ query: q }),
  setKeyword: (k) => set({ keyword: k }),
  setSearching: (s) => set({ isSearching: s }),
  setTextResults: (r) => set({ textResults: r }),
  setImageResults: (r) => set({ imageResults: r }),
  setError: (error) => set({ error }),
  setCollectionNotice: (collectionNotice) => set({ collectionNotice }),
  reset: () =>
    set({
      textResults: null,
      imageResults: null,
      isSearching: false,
      error: null,
      collectionNotice: null,
    }),
}));
