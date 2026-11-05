/**
 * Linked apps, as the studio's screens see them: the list, the one open, the
 * dev servers the studio started, and opening (and starting) one. The server
 * keeps each app's data apart; switching here switches everything the studio
 * shows (the frame, previews, sessions).
 */
import { create } from 'zustand';
import type { AppProbe, AppRun, AppsResponse, FolderListing, LinkedApp } from '@shared/apps';
import { ApiError, api } from '@/lib/api';

export interface Opening {
  id: string;
  env: string;
  step: string;
  /** Why it didn't open, and what can be done. */
  error?: string;
  code?: string;
}

/** The ways of linking an app: a folder on this computer, an address, a GitHub repository. */
export type LinkTab = 'folder' | 'url' | 'github';

/** The open app has changes waiting for keep or undo: switching asks first. */
export interface PendingSwitch {
  id: string;
  env?: string;
  message: string;
}

interface AppsState {
  apps: LinkedApp[];
  active: string | null;
  runs: Record<string, AppRun>;
  cloneDir: string;
  /** Show the app list when the studio opens. */
  launcherPref: boolean;
  /** The app list is showing. */
  launcher: boolean;
  /** Linking an app, on this tab of the Link dialog. */
  linking: LinkTab | null;
  /** “Link its folder…” on an app linked by its address alone: the folder picked becomes that app's. */
  attachTo: string | null;
  opening: Opening | null;
  pending: PendingSwitch | null;
  cloneLog: string[];
  loaded: boolean;
}

export const useApps = create<AppsState>()(() => ({
  apps: [],
  active: null,
  runs: {},
  cloneDir: '',
  launcherPref: true,
  launcher: false,
  linking: null,
  attachTo: null,
  opening: null,
  pending: null,
  cloneLog: [],
  loaded: false,
}));

const setA = useApps.setState;
const getA = useApps.getState;

function apply(r: AppsResponse): void {
  setA({ apps: r.apps, active: r.active, runs: Object.fromEntries(r.runs.map((x) => [x.app, x])), cloneDir: r.cloneDir, launcherPref: r.launcher, loaded: true });
}

/** Called when the open app changed (the controller resets what it showed, unless it is the app it showed). */
let onSwitched: (changed: boolean) => void = () => undefined;
/** The app this page shows: a studio that restarted opens it again, and the page keeps what it had of it. */
let shown: string | null = null;
const switched = (id: string | null) => {
  const changed = id !== shown;
  shown = id;
  onSwitched(changed);
};

export const apps = {
  /** Resolves once the app list (and which app is open) is known. */
  async init(onSwitch: (changed: boolean) => void): Promise<void> {
    onSwitched = onSwitch;
    await this.refresh();
    shown = getA().active;
  },

  async refresh(): Promise<void> {
    try {
      apply(await api.get<AppsResponse>('/apps'));
    } catch {
      /* the status poll reports a server that is down */
    }
  },

  /**
   * Back in touch with a studio server that restarted: the app this page had open is opened again (a restarted
   * server has none open), so the page carries on where it was, a recording in it included.
   */
  async reconnected(): Promise<void> {
    const had = getA().active;
    await this.refresh();
    const now = getA();
    if (had && !now.active && !now.opening && now.apps.some((a) => a.id === had)) await this.open(had);
  },

  /** The app list; with `link`, the Link dialog over it, on that tab (`attachTo`: for that app's own folder). */
  show(link?: LinkTab, attachTo?: string): void {
    void this.refresh();
    setA(link ? { launcher: true, linking: link, attachTo: attachTo ?? null } : { launcher: true });
  },

  setLinking(link: LinkTab | null): void {
    setA(link ? { linking: link } : { linking: null, attachTo: null });
  },

  /** An app linked by its address gets its code folder: the same app, now with code to change. */
  async attachFolder(id: string, probe: AppProbe): Promise<LinkedApp> {
    const r = await api.post<{ app: LinkedApp; state: AppsResponse }>(`/apps/${encodeURIComponent(id)}/folder`, { root: probe.root });
    apply(r.state);
    return r.app;
  },

  hide(): void {
    if (getA().active) setA({ launcher: false });
  },

  /** Events from the studio server. */
  serverEvent(data: unknown): void {
    const m = data as { kind: string; id?: string | null; env?: string; step?: string; error?: string; run?: AppRun; line?: string };
    if (m.kind === 'run' && m.run) setA({ runs: { ...getA().runs, [m.run.app]: m.run } });
    else if (m.kind === 'opening' && m.id) setA({ opening: { id: m.id, env: m.env ?? '', step: m.step ?? 'Opening' } });
    else if (m.kind === 'clone' && m.line) setA({ cloneLog: [...getA().cloneLog, m.line].slice(-80) });
    else if (m.kind === 'active') {
      setA({ active: m.id ?? null, opening: null, launcher: !m.id });
      switched(m.id ?? null);
      void this.refresh();
    } else if (m.kind === 'linked' || m.kind === 'unlinked') void this.refresh();
  },

  /** Open (and start) an app. Resolves with whether it opened; errors are kept in `opening` for the screen. */
  async open(id: string, env?: string, decide?: 'keep' | 'undo'): Promise<boolean> {
    setA({ opening: { id, env: env ?? '', step: 'Opening' }, pending: null });
    try {
      apply(await api.post<AppsResponse>(`/apps/${id}/open`, { env, decide }));
      setA({ opening: null, launcher: false });
      switched(id);
      return true;
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      if (e?.code === 'previews') {
        setA({ opening: null, pending: { id, env, message: e.message } });
        return false;
      }
      setA({ opening: { id, env: env ?? '', step: 'Failed', error: err instanceof Error ? err.message : String(err), code: e?.code } });
      return false;
    }
  },

  dismissOpening(): void {
    setA({ opening: null, pending: null });
  },

  async probeFolder(folder: string): Promise<AppProbe> {
    return (await api.post<{ probe: AppProbe }>('/apps/probe', { folder })).probe;
  },

  async probeUrl(url: string): Promise<AppProbe> {
    return (await api.post<{ probe: AppProbe }>('/apps/probe', { url })).probe;
  },

  async folders(path?: string): Promise<FolderListing> {
    return api.get<FolderListing>(`/apps/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`);
  },

  async clone(repo: string, dir?: string): Promise<AppProbe> {
    setA({ cloneLog: [] });
    return (await api.post<{ probe: AppProbe }>('/apps/clone', { repo, dir })).probe;
  },

  /** Link an app, then open it. */
  async link(probe: AppProbe, extra: { name?: string; start?: string | null; url?: string; label?: string }): Promise<LinkedApp> {
    const r = await api.post<{ app: LinkedApp; state: AppsResponse }>('/apps', { probe, ...extra, open: false });
    apply(r.state);
    void this.open(r.app.id);
    return r.app;
  },

  async sample(): Promise<void> {
    setA({ opening: { id: 'sample', env: '', step: 'Starting the sample shop' } });
    try {
      apply(await api.post<AppsResponse>('/apps/sample', {}));
      setA({ opening: null, launcher: false });
      switched(getA().active);
    } catch (err) {
      setA({ opening: { id: 'sample', env: '', step: 'Failed', error: err instanceof Error ? err.message : String(err), code: err instanceof ApiError ? err.code : undefined } });
    }
  },

  async install(id: string): Promise<boolean> {
    setA({ opening: { id, env: '', step: 'Installing dependencies' } });
    try {
      apply(await api.post<AppsResponse>(`/apps/${id}/install`, {}));
      setA({ opening: null });
      return true;
    } catch (err) {
      setA({ opening: { id, env: '', step: 'Failed', error: err instanceof Error ? err.message : String(err) } });
      return false;
    }
  },

  async stop(id: string): Promise<void> {
    apply(await api.post<AppsResponse>(`/apps/${id}/stop`, {}));
  },

  async remove(id: string): Promise<void> {
    apply(await api.delete<AppsResponse>(`/apps/${id}`));
  },

  async update(id: string, patch: { name?: string; start?: string | null }): Promise<void> {
    apply((await api.put<{ state: AppsResponse }>(`/apps/${id}`, patch)).state);
  },

  async addEnv(id: string, url: string, label?: string): Promise<void> {
    apply((await api.post<{ state: AppsResponse }>(`/apps/${id}/envs`, { url, label })).state);
  },

  async removeEnv(id: string, env: string): Promise<void> {
    apply((await api.delete<{ state: AppsResponse }>(`/apps/${id}/envs/${env}`)).state);
  },

  async setLauncherPref(on: boolean): Promise<void> {
    apply(await api.put<AppsResponse>('/apps/launcher', { on }));
  },

  async setCloneDir(dir: string): Promise<void> {
    apply(await api.put<AppsResponse>('/apps/clone-dir', { dir }));
  },

  /** Back to the app list, with no app open. */
  async close(): Promise<void> {
    apply(await api.post<AppsResponse>('/apps/close', {}));
    setA({ launcher: true });
    switched(null);
  },
};
