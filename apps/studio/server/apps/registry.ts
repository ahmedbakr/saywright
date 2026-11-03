/**
 * The apps linked to the studio, kept in <studio data>/apps.json. Each app's
 * own data (sessions, changes, metrics, settings) lives in its folder's
 * .saywright/ (git-ignored), or in <studio data>/apps/<id>/ for an app linked
 * by URL alone.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppEnv, AppProbe, LinkedApp } from '../../shared/apps.ts';
import { isLocalHost } from './detect.ts';

interface RegistryFile {
  version: 1;
  apps: LinkedApp[];
  last: string | null;
  /** Show the app list when the studio opens. */
  launcher?: boolean;
  cloneDir?: string;
}

/** The address of an app the studio serves itself (a folder of HTML): known once it is served. */
export const ASSIGNED_URL = 'http://localhost:0';

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'app';

/** The app's own data folder (created, and git-ignored when it is inside the app's code). */
export function appStateDir(dataDir: string, app: Pick<LinkedApp, 'id' | 'root'>): string {
  const dir = app.root ? path.join(app.root, '.saywright') : path.join(dataDir, 'apps', app.id);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (app.root && !fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  return dir;
}

export function envFor(url: string, connection: AppEnv['connection'], label?: string): AppEnv {
  const u = new URL(url);
  const local = isLocalHost(u.hostname);
  return {
    id: slug(label ?? (local ? 'local' : /staging|stage|preview|dev\./.test(u.hostname) ? 'staging' : 'production')),
    label: label ?? (local ? 'Local' : /staging|stage|preview|dev\./.test(u.hostname) ? 'Staging' : 'Production'),
    url: u.href.replace(/\/$/, u.pathname === '/' ? '' : '/'),
    kind: local ? 'local' : 'remote',
    connection: local ? connection : 'proxy',
  };
}

export class AppRegistry {
  private data: RegistryFile = { version: 1, apps: [], last: null };
  private readonly file: string;

  constructor(readonly dataDir: string) {
    this.file = path.join(dataDir, 'apps.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<RegistryFile>;
      if (Array.isArray(raw.apps)) this.data = { version: 1, apps: raw.apps.filter((a) => a && typeof a.id === 'string' && Array.isArray(a.envs) && a.envs.length), last: raw.last ?? null, launcher: raw.launcher, cloneDir: raw.cloneDir };
    } catch {
      /* first run */
    }
  }

  private save(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list(): LinkedApp[] {
    return [...this.data.apps].sort((a, b) => b.openedAt - a.openedAt);
  }

  get(id: string): LinkedApp | null {
    return this.data.apps.find((a) => a.id === id) ?? null;
  }

  get last(): string | null {
    return this.data.last && this.get(this.data.last) ? this.data.last : null;
  }

  get launcher(): boolean {
    return this.data.launcher !== false;
  }

  set launcher(on: boolean) {
    this.data.launcher = on;
    this.save();
  }

  get cloneDir(): string | undefined {
    return this.data.cloneDir;
  }

  set cloneDir(dir: string | undefined) {
    this.data.cloneDir = dir;
    this.save();
  }

  private newId(name: string): string {
    let id: string;
    do id = `${slug(name)}-${randomBytes(2).toString('hex')}`;
    while (this.get(id));
    return id;
  }

  /** Link an app from what was found in its folder or at its URL. */
  add(probe: AppProbe, extra: { name?: string; start?: string | null; url?: string; label?: string; sample?: boolean } = {}): LinkedApp {
    const url = extra.url || probe.url || (probe.framework === 'static' && probe.root ? ASSIGNED_URL : undefined);
    if (!url) throw new Error('Give the address the app runs at.');
    const env = envFor(url, probe.connection, extra.label);
    const now = Date.now();
    const app: LinkedApp = {
      id: this.newId(extra.name ?? probe.name),
      name: (extra.name ?? probe.name).slice(0, 80),
      root: probe.root,
      repo: probe.repo,
      framework: probe.framework,
      packageManager: probe.packageManager,
      start: extra.start !== undefined ? extra.start : (probe.start ?? null),
      envs: [env],
      env: env.id,
      createdAt: now,
      openedAt: now,
      icon: probe.icon,
      ...(extra.sample ? { sample: true } : {}),
    };
    this.data.apps.push(app);
    this.save();
    return app;
  }

  update(id: string, patch: Partial<Omit<LinkedApp, 'id' | 'createdAt'>>): LinkedApp {
    const app = this.get(id);
    if (!app) throw new Error('No such app');
    Object.assign(app, patch);
    if (!app.envs.some((e) => e.id === app.env)) app.env = app.envs[0].id;
    this.save();
    return app;
  }

  /** Add or replace one of an app's addresses. */
  setEnv(id: string, env: AppEnv): LinkedApp {
    const app = this.get(id);
    if (!app) throw new Error('No such app');
    const i = app.envs.findIndex((e) => e.id === env.id);
    if (i >= 0) app.envs[i] = env;
    else app.envs.push(env);
    this.save();
    return app;
  }

  removeEnv(id: string, envId: string): LinkedApp {
    const app = this.get(id);
    if (!app) throw new Error('No such app');
    if (app.envs.length <= 1) throw new Error('An app needs at least one address.');
    app.envs = app.envs.filter((e) => e.id !== envId);
    if (app.env === envId) app.env = app.envs[0].id;
    this.save();
    return app;
  }

  /** Forget an app (its data stays where it is). */
  remove(id: string): void {
    this.data.apps = this.data.apps.filter((a) => a.id !== id);
    if (this.data.last === id) this.data.last = null;
    this.save();
  }

  /** It was just opened. */
  touch(id: string, env?: string): LinkedApp {
    const app = this.get(id);
    if (!app) throw new Error('No such app');
    app.openedAt = Date.now();
    if (env && app.envs.some((e) => e.id === env)) app.env = env;
    this.data.last = id;
    this.save();
    return app;
  }

  /** The app at this folder (or URL, for one without a folder). */
  find(root: string | null, url?: string): LinkedApp | null {
    if (root) {
      const abs = path.resolve(root);
      return this.data.apps.find((a) => a.root && path.resolve(a.root) === abs) ?? null;
    }
    if (!url) return null;
    const origin = new URL(url).origin;
    return this.data.apps.find((a) => !a.root && a.envs.some((e) => new URL(e.url).origin === origin)) ?? null;
  }
}
