/**
 * Monorepos: an app's components often live in sibling packages (apps/web next to packages/ui). The plugin annotates
 * those files too, with paths from the app's folder, and never a library's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import saywright, { type SaywrightOptions } from '../src/index';
import { workspacePackages, workspaceRoot } from '../src/workspace';

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-ws-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const BUTTON = 'export const Button = () => <button>Save</button>;\n';

function annotate(root: string, file: string, options?: SaywrightOptions): string | null {
  const plugin = saywright(options);
  (plugin.configResolved as (c: { root: string }) => void)({ root });
  const out = (plugin.transform as (code: string, id: string) => { code: string } | null)(BUTTON, file);
  return out ? (/data-ds-src="([^"]+)"/.exec(out.code)?.[1] ?? null) : null;
}

describe('the workspace an app is part of', () => {
  it('is found by package.json workspaces, pnpm-workspace.yaml, Lerna, Nx or Turborepo', () => {
    const npm = tree({ 'package.json': JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }), 'apps/web/package.json': '{}' });
    expect(workspaceRoot(path.join(npm, 'apps/web'))).toBe(npm);
    const yarn = tree({ 'package.json': JSON.stringify({ workspaces: { packages: ['excalidraw-app', 'packages/*'] } }), 'excalidraw-app/package.json': '{}' });
    expect(workspaceRoot(path.join(yarn, 'excalidraw-app'))).toBe(yarn);
    const pnpm = tree({ 'pnpm-workspace.yaml': "packages:\n  - 'apps/**'\n  - \"!apps/legacy\"\n", 'apps/site/web/package.json': '{}' });
    expect(workspaceRoot(path.join(pnpm, 'apps/site/web'))).toBe(pnpm);
    const turbo = tree({ 'turbo.json': '{}', 'apps/web/package.json': '{}' });
    expect(workspaceRoot(path.join(turbo, 'apps/web'))).toBe(turbo);
    const lerna = tree({ 'lerna.json': '{}', 'packages/app/package.json': '{}' });
    expect(workspaceRoot(path.join(lerna, 'packages/app'))).toBe(lerna);
  });

  it('a folder the workspace doesn’t list is in none (a copy, a test fixture)', () => {
    const ws = tree({ 'package.json': JSON.stringify({ workspaces: ['apps/*'] }), 'apps/studio/tests/.e2e-shop/package.json': '{}' });
    expect(workspaceRoot(path.join(ws, 'apps/studio/tests/.e2e-shop'))).toBeNull();
    const pnpm = tree({ 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - '!apps/legacy'\n", 'apps/legacy/package.json': '{}' });
    expect(workspaceRoot(path.join(pnpm, 'apps/legacy'))).toBeNull();
    expect(workspaceRoot(tree({ 'package.json': '{}' }))).toBeNull();
  });

  it('lists its packages', () => {
    const ws = tree({ 'package.json': JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }), 'apps/web/package.json': '{}', 'packages/ui/package.json': '{}', 'packages/notes.md': '' });
    expect(workspacePackages(ws).map((d) => path.relative(ws, d).split(path.sep).join('/')).sort()).toEqual(['apps/web', 'packages/ui']);
  });
});

describe('what the plugin annotates', () => {
  const ws = tree({
    'package.json': JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }),
    'apps/web/package.json': '{}',
    'packages/ui/package.json': '{}',
  });
  const web = path.join(ws, 'apps/web');

  it('the app’s files, and a sibling package’s with a path from the app’s folder', () => {
    expect(annotate(web, path.join(web, 'src/App.tsx'))).toBe('src/App.tsx:1:29');
    expect(annotate(web, path.join(ws, 'packages/ui/src/Button.tsx'))).toBe('../../packages/ui/src/Button.tsx:1:29');
  });

  it('never node_modules, nor what `exclude` names', () => {
    expect(annotate(web, path.join(ws, 'node_modules/ui/Button.tsx'))).toBeNull();
    expect(annotate(web, path.join(ws, 'node_modules/ui/Button.tsx'), { include: /\.tsx$/, exclude: /\.stories\.tsx$/ })).toBeNull();
    expect(annotate(web, path.join(web, 'src/Button.stories.tsx'), { exclude: /\.stories\.tsx$/ })).toBeNull();
  });

  it('nothing outside the workspace, whatever `include` names (the studio couldn’t open it)', () => {
    const elsewhere = tree({ 'Shared.tsx': '' });
    expect(annotate(web, path.join(elsewhere, 'Shared.tsx'))).toBeNull();
    expect(annotate(web, path.join(elsewhere, 'Shared.tsx'), { include: /Shared\.tsx$/ })).toBeNull();
    expect(annotate(web, path.join(ws, 'packages/ui/src/Button.tsx'), { include: /\.mdx$/ })).toBeNull();
  });

  it('an app in no workspace: its own folder only, as before', () => {
    const solo = tree({ 'package.json': '{}' });
    expect(annotate(solo, path.join(solo, 'src/App.tsx'))).toBe('src/App.tsx:1:29');
    expect(annotate(solo, path.join(path.dirname(solo), 'other/App.tsx'))).toBeNull();
  });
});
