/**
 * The studio's AI connections, models, usage and budget, as Settings shows
 * them. Every change goes to the studio server, which keeps keys in
 * .env.local and everything else in its data folder; the top bar's usage
 * follows live.
 */
import { create } from 'zustand';
import { api } from '@/lib/api';
import type { AiEffort, AiState, AiTask, Budget, Route, UsageSummary } from '@shared/ai';
import { controller } from './controller';

interface AiStore {
  state: AiState | null;
  loading: boolean;
  error: string | null;
  /** Per connection: a test or save in progress, and its result. */
  busy: Record<string, boolean>;
  results: Record<string, { ok: boolean; message: string } | undefined>;
}

export const useAi = create<AiStore>(() => ({ state: null, loading: false, error: null, busy: {}, results: {} }));

const setStore = useAi.setState;
const get = useAi.getState;

async function apply(p: Promise<AiState>): Promise<boolean> {
  try {
    setStore({ state: await p, error: null });
    void controller.refreshStatus();
    return true;
  } catch (err) {
    setStore({ error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function busy(id: string, on: boolean, result?: { ok: boolean; message: string }) {
  setStore({ busy: { ...get().busy, [id]: on }, ...(result !== undefined ? { results: { ...get().results, [id]: result } } : {}) });
}

export const ai = {
  async load(refresh = false): Promise<void> {
    setStore({ loading: true });
    await apply(api.get<AiState>(`/ai${refresh ? '?refresh=1' : ''}`));
    setStore({ loading: false });
  },

  async saveKey(connection: string, key: string | null): Promise<boolean> {
    busy(connection, true);
    const ok = await apply(api.put<AiState>('/ai/key', { connection, key }));
    if (ok && key) {
      const r = await ai.test(connection, false);
      busy(connection, false, r);
      return r.ok;
    }
    busy(connection, false, ok ? undefined : { ok: false, message: get().error ?? 'Couldn’t save the key.' });
    return ok;
  },

  async test(connection: string, track = true): Promise<{ ok: boolean; message: string }> {
    if (track) busy(connection, true);
    let r: { ok: boolean; message: string };
    try {
      r = await api.post<{ ok: boolean; message: string }>('/ai/test', { connection });
    } catch (err) {
      r = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    if (track) busy(connection, false, r);
    void ai.load();
    return r;
  },

  add(input: { preset: string; label?: string; baseUrl?: string; key?: string; models?: string[] }): Promise<boolean> {
    return apply(api.post<AiState>('/ai/connections', input));
  },

  remove(id: string): Promise<boolean> {
    return apply(api.delete<AiState>(`/ai/connections/${encodeURIComponent(id)}`));
  },

  setOff(id: string, off: boolean): Promise<boolean> {
    return apply(api.put<AiState>(`/ai/connections/${encodeURIComponent(id)}`, { off }));
  },

  addModel(id: string, model: string): Promise<boolean> {
    return apply(api.put<AiState>(`/ai/connections/${encodeURIComponent(id)}`, { model }));
  },

  setRoute(task: AiTask, route: Route | null): Promise<boolean> {
    return apply(api.put<AiState>('/ai/routes', { task, connection: route?.connection ?? null, model: route?.model ?? null }));
  },

  setEffort(effort: AiEffort): Promise<boolean> {
    return apply(api.put<AiState>('/ai/effort', { effort }));
  },

  async setBudget(patch: Partial<Budget>): Promise<void> {
    try {
      const usage = await api.put<UsageSummary>('/ai/budget', patch);
      const s = get().state;
      if (s) setStore({ state: { ...s, usage } });
    } catch (err) {
      setStore({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async reset(scope: 'today' | 'month' | 'all'): Promise<void> {
    try {
      const usage = await api.post<UsageSummary>('/ai/usage/reset', { scope });
      const s = get().state;
      if (s) setStore({ state: { ...s, usage } });
      void controller.refreshStatus();
    } catch (err) {
      setStore({ error: err instanceof Error ? err.message : String(err) });
    }
  },
};
