/**
 * The app the studio is working on, and switching between linked apps
 * without restarting. Each app gets its own workspace (its code, previews,
 * sessions, metrics) that stays open once used, so a report being written
 * for one app carries on while you work in another.
 */
import fs from 'node:fs';
import type { AppEnv, AppProbe, AppsResponse, LinkedApp } from '../../shared/apps.ts';
import type { ChangeStore } from '../changes.ts';
import { HttpError } from '../http.ts';
import type { Metrics } from '../metrics.ts';
import { Project } from '../project.ts';
import type { Sessions } from '../sessions/index.ts';
import type { SourceMapper } from '../sessions/sourcemap.ts';
import { dependenciesInstalled, hasPlugin, probeFolder } from './detect.ts';
import { AppProxy } from './proxy.ts';
import { AppRegistry, appStateDir, envFor } from './registry.ts';
import { AppRunner } from './runner.ts';

export interface Workspace {
  app: LinkedApp;
  env: AppEnv;
  project: Project;
  /** What the studio's frame loads: the app itself, or the proxy in front of it. */
  frameUrl: string;
  changes: ChangeStore;
  metrics: Metrics;
  sessions: Sessions;
  mapper: SourceMapper;
}

interface ManagerDeps {
  dataDir: string;
  emit: (event: string, data: unknown) => void;
  /** The studio's own address (for the bridge script and the plugin). */
  studio: () => string;
  build: (project: Project) => Pick<Workspace, 'changes' | 'metrics' | 'sessions' | 'mapper'>;
  proxyPort?: number;
  /** How long a dev server has to answer after it is started (90 seconds). */
  startMs?: number;
}

export type OpenDecision = 'keep' | 'undo';

const answers = (url: string, ms = 2500) =>
  fetch(url, { signal: AbortSignal.timeout(ms) })
    .then((r) => r.status < 500)
    .catch(() => false);

// A dev server that just started can be slow to answer anything (pre-bundling its dependencies, type-checking on a
// busy computer): an app whose config loads the plugin gets longer.
const pluginAnswers = (url: string, ms = 5000) =>
  fetch(new URL('/__saywright/info', url), { signal: AbortSignal.timeout(ms) })
    .then((r) => r.ok && /json/.test(r.headers.get('content-type') ?? ''))
    .catch(() => false);

export class AppManager {
  readonly registry: AppRegistry;
  readonly runner: AppRunner;
  readonly proxy: AppProxy;
  private spaces = new Map<string, Workspace>();
  private activeId: string | null = null;
  /** Shown before an app opens (false once the studio was started for a given app). */
  launcher = true;
  opening: { id: string; env: string } | null = null;

  constructor(private deps: ManagerDeps) {
    this.registry = new AppRegistry(deps.dataDir);
    this.runner = new AppRunner((run) => deps.emit('apps', { kind: 'run', run }));
    this.proxy = new AppProxy({ studio: deps.studio, port: deps.proxyPort, stateFile: `${deps.dataDir}/proxy-ports.json` });
    this.launcher = this.registry.launcher;
  }

  active(): Workspace | null {
    return this.activeId ? (this.spaces.get(this.activeId) ?? null) : null;
  }

  /** The open app, or a 409 that tells the studio to show the app list. */
  require(): Workspace {
    const ws = this.active();
    if (!ws) throw new HttpError(409, 'Open an app first.', 'no-app');
    return ws;
  }

  /** The workspace a session belongs to (it may be another app's, still writing its report). */
  forSession(id: string): Workspace {
    const active = this.active();
    if (active?.sessions.store.has(id)) return active;
    for (const ws of this.spaces.values()) if (ws.sessions.store.has(id)) return ws;
    return this.require();
  }

  all(): Workspace[] {
    return [...this.spaces.values()];
  }

  state(): AppsResponse {
    return {
      apps: this.registry.list(),
      active: this.activeId,
      runs: this.runner.all(),
      cloneDir: this.cloneDir,
      launcher: this.launcher,
    };
  }

  get cloneDir(): string {
    return this.registry.cloneDir ?? `${process.env.HOME ?? process.env.USERPROFILE ?? '.'}/saywright-apps`;
  }

  link(probe: AppProbe, extra: Parameters<AppRegistry['add']>[1] = {}): LinkedApp {
    if (probe.root) {
      const existing = this.registry.find(probe.root);
      if (existing) return existing;
    }
    const app = this.registry.add(probe, extra);
    this.deps.emit('apps', { kind: 'linked', app });
    return app;
  }

  async unlink(id: string): Promise<void> {
    if (this.activeId === id) {
      const ws = this.active();
      if (ws?.sessions.active()) throw new HttpError(409, 'Stop the recording first.');
      this.activeId = null;
    }
    const ws = this.spaces.get(id);
    ws?.sessions.close();
    this.spaces.delete(id);
    await this.runner.stop(id);
    this.proxy.release(id);
    this.registry.remove(id);
    this.deps.emit('apps', { kind: 'unlinked', id });
  }

  /**
   * Open an app (and one of its addresses). A local app the studio can start is started and waited for.
   * Refuses while the open app is recording, and while it has a change waiting for keep or undo, unless
   * told which.
   */
  async open(id: string, envId?: string, decide?: OpenDecision): Promise<Workspace> {
    const app = this.registry.get(id);
    if (!app) throw new HttpError(404, 'No such app');
    const env = app.envs.find((e) => e.id === (envId ?? app.env)) ?? app.envs[0];
    const current = this.active();
    if (current && (current.app.id !== id || current.env.id !== env.id)) {
      if (current.sessions.active()) throw new HttpError(409, `${current.app.name} is recording a test session. Stop it first.`, 'recording');
      const waiting = current.changes.previews();
      if (waiting.length && current.app.id !== id) {
        if (!decide) throw new HttpError(409, `${current.app.name} has ${waiting.length === 1 ? 'a change' : `${waiting.length} changes`} waiting for keep or undo.`, 'previews');
        if (decide === 'keep') current.changes.keep();
        else await current.changes.undo(undefined, { force: true });
      }
    }
    this.opening = { id, env: env.id };
    this.deps.emit('apps', { kind: 'opening', id, env: env.id, step: env.kind === 'local' && app.root && app.start ? 'Starting' : 'Connecting' });
    try {
      const url = await this.reach(app, env);
      const ws = await this.workspace(app, env, url);
      this.activeId = id;
      this.registry.touch(id, env.id);
      this.launcher = this.registry.launcher;
      this.deps.emit('apps', { kind: 'active', id, env: env.id });
      void this.announce(ws);
      return ws;
    } catch (err) {
      this.deps.emit('apps', { kind: 'failed', id, error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      this.opening = null;
    }
  }

  /** Where the app answers now: started if it is a local app that isn't running (its port may have moved). */
  private async reach(app: LinkedApp, env: AppEnv): Promise<string> {
    if (env.kind === 'remote') {
      if (!(await answers(env.url, 10_000))) throw new HttpError(502, `${env.url} isn’t answering.`);
      return env.url;
    }
    // A folder the studio serves gets its address when it is served.
    const assigned = new URL(env.url).port === '0';
    if (!assigned && (await answers(env.url))) return env.url;
    if (!app.root || (!app.start && app.framework !== 'static')) throw new HttpError(502, `${env.url} isn’t running. Start it, then open it again.`, 'not-running');
    if (app.framework !== 'static' && fs.existsSync(`${app.root}/package.json`) && !dependenciesInstalled(app.root)) {
      throw new HttpError(409, `${app.name}’s dependencies aren’t installed yet.`, 'needs-install');
    }
    await this.runner.start(app);
    const url = await this.runner.ready(app.id, assigned ? null : env.url, this.deps.startMs ?? 90_000);
    if (!url) {
      const why = await this.whyNotStarted(app, env);
      const log = this.runner.get(app.id).log.slice(-6).join('\n');
      throw new HttpError(502, `${app.name} didn’t start: ${why}${log ? `\n${log}` : ''}`, 'start-failed');
    }
    // It runs elsewhere than last time (its port was taken): remember where.
    const actual = new URL(url);
    const usual = new URL(env.url);
    const path = usual.pathname === '/' ? '' : usual.pathname;
    if (actual.origin !== usual.origin) this.registry.setEnv(app.id, { ...env, url: actual.origin + path });
    return actual.origin + path + usual.search;
  }

  /** Why a dev server didn't come up, and what to do. One that is still running but never answered is stopped. */
  private async whyNotStarted(app: LinkedApp, env: AppEnv): Promise<string> {
    const run = this.runner.get(app.id);
    if (this.runner.running(app.id)) {
      await this.runner.stop(app.id);
      const secs = Math.round((this.deps.startMs ?? 90_000) / 1000);
      return run.url
        ? `it said it was at ${run.url}, but nothing answered there within ${secs} seconds, so the studio stopped it.`
        : `nothing answered at ${env.url} within ${secs} seconds and it didn’t say where else it listens, so the studio stopped it. Check its dev command (Your apps → ⋯ → Dev command).`;
    }
    // A shell says a program isn't there with exit code 127 (Windows: “'x' is not recognized”).
    const log = run.log.join('\n');
    const missing = run.exitCode === 127 || process.platform === 'win32' ? /(?:^|\s)([\w.@/-]+): (?:command )?not found|command not found: ([\w.@/-]+)|'([\w.@/-]+)' is not recognized/m.exec(log) : null;
    const program = missing && (missing[1] ?? missing[2] ?? missing[3]);
    if (program && /^(npm|npx|pnpm|yarn|bun)$/.test(program)) return `“${program}” isn’t installed on this computer. Install it, or change its dev command (Your apps → ⋯ → Dev command).`;
    if (program) return `“${program}” isn’t installed. Install its dependencies (Your apps → ⋯ → Install dependencies), or change its dev command.`;
    // A port given outright (next dev -p 3000, vite --strictPort) isn't moved when it is taken.
    const taken = /EADDRINUSE[^\n]*?:(\d{2,5})\b|\bport:? (\d{2,5}) is (?:already )?in use(?!, trying)|already running on port (\d{2,5})/i.exec(log);
    if (taken || /EADDRINUSE/.test(log)) {
      const port = taken?.[1] ?? taken?.[2] ?? taken?.[3];
      return `${port ? `port ${port}` : 'its port'} is taken by another program. Close it, or give the app another port in its dev command (Your apps → ⋯ → Dev command).`;
    }
    if (run.exitCode === 0) return 'its dev command finished without starting a server. Check its dev command (Your apps → ⋯ → Dev command).';
    return `its dev command stopped${run.exitCode === null ? '' : ` with exit code ${run.exitCode}`}. Its output says why.`;
  }

  private async workspace(app: LinkedApp, env: AppEnv, url: string): Promise<Workspace> {
    // The plugin answers on the app's own server; without it, the proxy adds the studio to its pages. The address as
    // it is now: reach() may have just moved it (its port was taken).
    const latest = this.registry.get(app.id)?.envs.find((e) => e.id === env.id) ?? env;
    let connection = latest.connection;
    if (env.kind === 'local') {
      const plugin = await pluginAnswers(url, app.root && hasPlugin(app.root) ? 20_000 : 5000);
      if (plugin) connection = 'plugin';
      else if (connection === 'plugin') connection = 'proxy';
      if (connection !== latest.connection) this.registry.setEnv(app.id, { ...latest, connection });
    }
    // One proxy per app address: when the app's port moves, it keeps its proxy, and with it its cookies and storage.
    const frameUrl = connection === 'proxy' ? await this.proxy.open(url, `${app.id}/${env.id}`) : url;
    const fresh = this.registry.get(app.id) ?? app;
    const current = { ...env, connection, url: fresh.envs.find((e) => e.id === env.id)?.url ?? env.url };
    let ws = this.spaces.get(app.id);
    if (ws) {
      ws.project.url = url;
      ws.frameUrl = frameUrl;
      ws.env = current;
      ws.app = fresh;
      return ws;
    }
    const dataDir = appStateDir(this.deps.dataDir, app);
    const project = new Project(app.root ?? dataDir, url, dataDir, !!app.root);
    ws = { app: fresh, env: current, project, frameUrl, ...this.deps.build(project) };
    this.spaces.set(app.id, ws);
    return ws;
  }

  /** Tell the open app's plugin where the studio is (once the studio knows its own address). */
  announceActive(): void {
    const ws = this.active();
    if (ws) void this.announce(ws);
  }

  /** Close the open app (back to the app list). */
  deactivate(): void {
    const ws = this.active();
    if (ws?.sessions.active()) throw new HttpError(409, 'Stop the recording first.');
    this.activeId = null;
    this.deps.emit('apps', { kind: 'active', id: null });
  }

  /** Tell the plugin where the studio is, so sessions started in the app's own tab reach it. */
  private async announce(ws: Workspace): Promise<void> {
    if (ws.env.connection !== 'plugin') return;
    try {
      await fetch(new URL('/__saywright/studio', ws.project.url), { method: 'POST', body: JSON.stringify({ url: this.deps.studio() }), signal: AbortSignal.timeout(2000) });
    } catch {
      /* the app's tab finds the studio by its default address */
    }
  }

  /**
   * The app the studio was started for (npm run dev --target, the tests): linked if new, and opened.
   * It is already running; the studio doesn't start or stop it.
   */
  async openTarget(url: string, root: string | null): Promise<Workspace> {
    let app = this.registry.find(root, url);
    if (!app) {
      const probe: AppProbe = root ? probeFolder(root) : { name: new URL(url).hostname, root: null, connection: 'proxy', notes: [] };
      probe.connection = root && hasPlugin(root) ? 'plugin' : (await pluginAnswers(url)) ? 'plugin' : 'proxy';
      app = this.registry.add(probe, { url, start: null });
    } else {
      const env = app.envs.find((e) => new URL(e.url).origin === new URL(url).origin);
      if (!env) app = this.registry.setEnv(app.id, envFor(url, 'plugin'));
      app = this.registry.update(app.id, { env: (env ?? app.envs[app.envs.length - 1]).id, start: null });
    }
    this.launcher = false;
    return this.open(app.id);
  }

  close(): void {
    for (const ws of this.spaces.values()) ws.sessions.close();
    this.runner.stopAll();
    this.proxy.close();
  }
}
