// Timeline-local view state (zoom, scroll, expansion). Not part of the project document.
import { create } from 'zustand';

export interface TLState {
  pps: number; // pixels per second
  scrollX: number;
  scrollY: number;
  viewW: number;
  viewH: number;
  expanded: Record<string, boolean>;
  ripple: boolean;
  hideShy: boolean;
  search: string;
  trackH: number;
  leftW: number;
  renaming: string | null;
  set: (p: Partial<TLState>) => void;
}

export const useTL = create<TLState>((set) => ({
  pps: 80,
  scrollX: 0,
  scrollY: 0,
  viewW: 800,
  viewH: 300,
  expanded: {},
  ripple: false,
  hideShy: false,
  search: '',
  trackH: 34,
  leftW: 380,
  renaming: null,
  set: (p) => set(p),
}));

/** The scrollable track container, shared so actions/playhead can scroll it. */
export const tlRefs: { scroller: HTMLDivElement | null } = { scroller: null };

export const PROP_ROW_H = 20;
export const RULER_H = 34;
