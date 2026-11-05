/**
 * `npm run connect` hands the app to the studio through target.json in the
 * studio's data folder: on start the studio links it (or brings the linked
 * one up to date) and opens it first, then removes the file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createStudioApi } from '../../server/index';
import { repoLayout } from '../../server/layout';
import { tempShop, tree } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const STUDIO = path.resolve(here, '../..');
const saved = { home: process.env.SAYWRIGHT_HOME, ai: process.env.SAYWRIGHT_AI };
let close: (() => void) | null = null;

afterEach(() => {
  close?.();
  close = null;
  process.env.SAYWRIGHT_HOME = saved.home;
  process.env.SAYWRIGHT_AI = saved.ai;
  if (saved.home === undefined) delete process.env.SAYWRIGHT_HOME;
  if (saved.ai === undefined) delete process.env.SAYWRIGHT_AI;
});

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-home-'));
  const data = path.join(home, '.saywright');
  fs.mkdirSync(data);
  process.env.SAYWRIGHT_HOME = data;
  process.env.SAYWRIGHT_AI = 'fake';
  return { home, data, app: tempShop().root };
}

async function start(home: string) {
  const api = await createStudioApi({ ...repoLayout(path.resolve(STUDIO, '../..')), envDir: home });
  close = () => api.close();
  return api;
}

describe('an app connected with npm run connect', () => {
  it('is linked and opened first, and the hand-off file goes', async () => {
    const { home, data, app } = setup();
    fs.writeFileSync(path.join(data, 'target.json'), JSON.stringify({ url: 'http://localhost:5999', root: app, framework: 'vite', start: 'npm run dev' }));
    const api = await start(home);
    const linked = api.apps.registry.list().find((a) => a.root === app);
    expect(linked).toBeTruthy();
    expect(linked!.start).toBe('npm run dev');
    expect(linked!.envs.map((e) => e.url)).toEqual(['http://localhost:5999']);
    expect(api.apps.registry.last).toBe(linked!.id);
    expect(fs.existsSync(path.join(data, 'target.json'))).toBe(false);
  });

  it('brings an app already in the list up to date instead of linking it twice', async () => {
    const { home, data, app } = setup();
    fs.writeFileSync(path.join(data, 'target.json'), JSON.stringify({ url: 'http://localhost:5999', root: app, start: 'npm run dev' }));
    close = (await start(home)).close;
    close();
    close = null;
    // Connected again, now on another port and started differently.
    fs.writeFileSync(path.join(data, 'target.json'), JSON.stringify({ url: 'http://localhost:6001', root: app, start: 'pnpm dev' }));
    const api = await start(home);
    const all = api.apps.registry.list().filter((a) => a.root === app);
    expect(all).toHaveLength(1);
    expect(all[0].start).toBe('pnpm dev');
    // Its local address moved: the one address on this computer is updated, not kept twice.
    expect(all[0].envs.map((e) => e.url)).toEqual(['http://localhost:6001']);
    expect(all[0].envs.find((e) => e.id === all[0].env)?.url).toBe('http://localhost:6001');
  });

  it('several connected before the studio starts are each linked; the last connected opens first', async () => {
    const { home, data, app } = setup();
    const site = tree({ 'index.html': '<!doctype html><title>Notes</title>' });
    fs.writeFileSync(path.join(data, 'target.json'), JSON.stringify({ targets: [{ url: 'http://localhost:5999', root: app, start: 'npm run dev' }, { url: 'http://localhost:0', root: site, framework: 'static', start: null }] }));
    const api = await start(home);
    const roots = api.apps.registry.list().map((a) => a.root);
    expect(roots).toEqual(expect.arrayContaining([app, site]));
    expect(api.apps.registry.last).toBe(api.apps.registry.list().find((a) => a.root === site)!.id);
    expect(fs.existsSync(path.join(data, 'target.json'))).toBe(false);
  });

  it('opens a folder of HTML connected without a port at the address it gets when served', async () => {
    const { home, data } = setup();
    const site = tree({ 'package.json': { name: 'brochure' }, 'index.html': '<!doctype html><html><head><title>Brochure</title></head><body></body></html>' });
    fs.writeFileSync(path.join(data, 'target.json'), JSON.stringify({ url: 'http://localhost:0', root: site, framework: 'static', start: null }));
    const api = await start(home);
    expect(api.apps.registry.list().find((a) => a.root === site)?.envs.map((e) => e.url)).toEqual(['http://localhost:0']);
    for (let i = 0; i < 100 && !api.apps.active(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(api.apps.active()?.project.url).toMatch(/^http:\/\/localhost:[1-9]\d*$/);
  });
});
