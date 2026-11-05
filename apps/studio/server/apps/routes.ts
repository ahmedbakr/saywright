/**
 * HTTP routes for linked apps: the list, linking from a folder, a URL or a
 * GitHub repository, opening (and starting) one, its addresses, and its dev
 * server.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppEnv, AppProbe, Connection } from '../../shared/apps.ts';
import { HttpError, type Router } from '../http.ts';
import { listFolders, probeFolder, probeUrl } from './detect.ts';
import { cloneRepo } from './github.ts';
import type { AppManager, OpenDecision } from './manager.ts';
import { envFor } from './registry.ts';

interface AppRouteDeps {
  apps: AppManager;
  emit: (event: string, data: unknown) => void;
  /** The sample shop that ships with the studio (see StudioLayout). */
  sample: { source: string; root: string };
}

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
}

async function wrapAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
}

export function appRoutes(router: Router, deps: AppRouteDeps): void {
  const { apps } = deps;

  router.get('/apps', () => apps.state());

  router.get('/apps/folders', (req) => wrap(() => listFolders(req.query.get('path') ?? undefined)));

  /** What is in a folder or at a URL, before linking it. */
  router.post('/apps/probe', async (req) => {
    const body = (req.body ?? {}) as { folder?: unknown; url?: unknown };
    const folder = str(body.folder, 1000);
    const url = str(body.url, 1000);
    if (folder) return { probe: wrap(() => probeFolder(folder)) };
    if (url) return { probe: await wrapAsync(() => probeUrl(url)) };
    throw new HttpError(400, 'Give a folder or a URL');
  });

  /** Link an app (from a probe the user confirmed, with any edits), and open it unless told not to. */
  router.post('/apps', async (req) => {
    const body = (req.body ?? {}) as { probe?: AppProbe; name?: unknown; start?: unknown; url?: unknown; label?: unknown; open?: boolean };
    const p = body.probe;
    if (!p || typeof p !== 'object' || typeof p.name !== 'string') throw new HttpError(400, 'Expected { probe }');
    const probe: AppProbe = p.root ? wrap(() => probeFolder(p.root!)) : { ...p, root: null, notes: [], connection: 'proxy' as Connection };
    if (!p.root) {
      // A URL-only app: what answers there, checked again here.
      const checked = await wrapAsync(() => probeUrl(str(body.url) ?? p.url ?? ''));
      Object.assign(probe, { icon: checked.icon, title: checked.title, url: checked.url, connection: checked.connection });
    }
    const start = body.start === null ? null : str(body.start, 300);
    const app = wrap(() => apps.link(probe, { name: str(body.name, 80), start, url: str(body.url, 1000) ?? p.url, label: str(body.label, 30) }));
    if (body.open === false) return { app, state: apps.state() };
    await apps.open(app.id);
    return { app, state: apps.state() };
  });

  /** An app linked by its address gets its code folder: the same app, its addresses kept (“Link its folder…”). */
  router.post('/apps/:id/folder', async (req) => {
    const root = str((req.body as { root?: unknown } | undefined)?.root, 1000);
    if (!root) throw new HttpError(400, 'Give the app’s folder');
    const probe = wrap(() => probeFolder(root));
    const app = await apps.attachFolder(req.params.id, probe);
    return { app, state: apps.state() };
  });

  router.put('/apps/:id', (req) => {
    const body = (req.body ?? {}) as { name?: unknown; start?: unknown };
    const patch: { name?: string; start?: string | null } = {};
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
    if (body.start === null || typeof body.start === 'string') patch.start = body.start === null || !body.start.trim() ? null : body.start.trim().slice(0, 300);
    const app = wrap(() => apps.registry.update(req.params.id, patch));
    return { app, state: apps.state() };
  });

  router.delete('/apps/:id', async (req) => {
    await apps.unlink(req.params.id);
    return apps.state();
  });

  /** Another address for an app (staging, production…). */
  router.post('/apps/:id/envs', async (req) => {
    const body = (req.body ?? {}) as { url?: unknown; label?: unknown };
    const url = str(body.url, 1000);
    if (!url) throw new HttpError(400, 'Give the address');
    const probe = await wrapAsync(() => probeUrl(url));
    const env: AppEnv = envFor(probe.url ?? url, probe.connection, str(body.label, 30));
    const app = wrap(() => apps.registry.setEnv(req.params.id, env));
    return { app, env, state: apps.state() };
  });

  router.delete('/apps/:id/envs/:env', (req) => {
    const app = wrap(() => apps.registry.removeEnv(req.params.id, req.params.env));
    return { app, state: apps.state() };
  });

  /** Open an app (starting it when needed: this answers once it is up, or why it isn't). */
  router.post('/apps/:id/open', async (req) => {
    const body = (req.body ?? {}) as { env?: unknown; decide?: unknown };
    const decide = body.decide === 'keep' || body.decide === 'undo' ? (body.decide as OpenDecision) : undefined;
    await apps.open(req.params.id, str(body.env, 40), decide);
    return apps.state();
  });

  router.post('/apps/:id/install', async (req) => {
    const app = apps.registry.get(req.params.id);
    if (!app) throw new HttpError(404, 'No such app');
    const ok = await apps.runner.install(app);
    if (!ok) throw new HttpError(500, `Installing failed. ${apps.runner.get(app.id).log.slice(-4).join(' ')}`);
    return apps.state();
  });

  router.post('/apps/:id/stop', async (req) => {
    await apps.runner.stop(req.params.id);
    return apps.state();
  });

  router.get('/apps/:id/run', (req) => apps.runner.get(req.params.id));

  /** Clone a GitHub repository, then say what is in it (linking is the next step, once confirmed). */
  router.post('/apps/clone', async (req) => {
    const body = (req.body ?? {}) as { repo?: unknown; dir?: unknown };
    const repo = str(body.repo, 300);
    if (!repo) throw new HttpError(400, 'Give the repository');
    const parent = path.resolve(str(body.dir, 1000) || apps.cloneDir);
    const { dir, existing } = await wrapAsync(() => cloneRepo(repo, parent, (line) => deps.emit('apps', { kind: 'clone', line })));
    const probe = wrap(() => probeFolder(dir));
    if (existing) probe.notes.unshift('Cloned before: using that copy.');
    return { probe };
  });

  /** The sample shop: linked the first time, then opened (and started). */
  router.post('/apps/sample', async () => {
    const { source, root } = deps.sample;
    let app = apps.registry.list().find((a) => a.sample) ?? apps.registry.find(root);
    if (!app) {
      // Installed from npm, the sample is copied out of the package the first time: it is yours to change.
      if (!fs.existsSync(root) && fs.existsSync(source)) fs.cpSync(source, root, { recursive: true });
      if (!fs.existsSync(root)) throw new HttpError(404, 'The sample app isn’t here.');
      const probe = probeFolder(root);
      app = apps.link({ ...probe, name: 'Tidewell (sample shop)', connection: 'plugin' }, { url: 'http://localhost:5174', start: 'npm run dev', sample: true });
    }
    await apps.open(app.id);
    return apps.state();
  });

  router.put('/apps/launcher', (req) => {
    apps.registry.launcher = (req.body as { on?: unknown } | undefined)?.on !== false;
    apps.launcher = apps.registry.launcher;
    return apps.state();
  });

  router.put('/apps/clone-dir', (req) => {
    const dir = str((req.body as { dir?: unknown } | undefined)?.dir, 1000);
    apps.registry.cloneDir = dir ? path.resolve(dir) : undefined;
    return apps.state();
  });
}

