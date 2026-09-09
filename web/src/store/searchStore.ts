/**
 * 检索状态：当前 query、各集合结果、延迟
 */
import { create } from 'zustand';
import type { SearchResult } from '../types';

interface SearchState {
  query: string;
  keyword: string;
  isSearching: boolean;
  textResults: SearchResult | null;
  imageResults: SearchResult | null;
  setQuery: (q: string) => void;
  setKeyword: (k: string) => void;
  setSearching: (s: boolean) => void;
  setTextResults: (r: SearchResult | null) => void;
  setImageResults: (r: SearchResult | null) => void;
  reset: () => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  query: '',
  keyword: '',
  isSearching: false,
  textResults: null,
  imageResults: null,
  setQuery: (q) => set({ query: q }),
  setKeyword: (k) => set({ keyword: k }),
  setSearching: (s) => set({ isSearching: s }),
  setTextResults: (r) => set({ textResults: r }),
  setImageResults: (r) => set({ imageResults: r }),
  reset: () =>
    set({
      textResults: null,
      imageResults: null,
      isSearching: false,
    }),
}));
