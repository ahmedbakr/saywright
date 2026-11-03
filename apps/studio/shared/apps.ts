/**
 * Linked apps: every app the studio works on, with where its code is (if on
 * this computer), how to start it, and the addresses it runs at (local,
 * staging, production). Each app keeps its own sessions, changes and settings.
 */

export type Framework = 'vite' | 'next' | 'cra' | 'astro' | 'remix' | 'react-router' | 'sveltekit' | 'nuxt' | 'angular' | 'gatsby' | 'static' | 'other';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * How the studio's bridge gets into the app's pages:
 * - plugin: the Vite plugin (exact source lines for every element)
 * - script: a script tag the app loads from the studio (added by `npm run connect`)
 * - proxy:  the studio serves the app through a local proxy that adds it (any framework, any URL)
 */
export type Connection = 'plugin' | 'script' | 'proxy';

/** One address the app runs at. */
export interface AppEnv {
  id: string;
  /** "Local", "Staging", "Production"… */
  label: string;
  url: string;
  /** On this computer (started by the studio, editable) or a deployed site (looked at, tested, audited). */
  kind: 'local' | 'remote';
  connection: Connection;
}

export interface LinkedApp {
  id: string;
  name: string;
  /** The app's code on this computer: where changes are made. Null for an app linked by URL alone. */
  root: string | null;
  /** Where it was cloned from. */
  repo?: string;
  framework?: Framework;
  packageManager?: PackageManager;
  /** The command that starts its dev server (run in root), or null when you start it yourself. */
  start?: string | null;
  envs: AppEnv[];
  /** The env opened last. */
  env: string;
  createdAt: number;
  openedAt: number;
  /** A small data: URL of its favicon, for the app list. */
  icon?: string;
  /** The sample app that ships with the studio. */
  sample?: boolean;
}

/** What the studio found in a folder or at a URL, before linking it. */
export interface AppProbe {
  name: string;
  root: string | null;
  framework?: Framework;
  packageManager?: PackageManager;
  start?: string | null;
  /** Where its dev server usually runs. */
  url?: string;
  /** Dependencies aren't installed yet. */
  needsInstall?: boolean;
  /** The Vite plugin is in its config (exact source lines). */
  plugin?: boolean;
  /** It could have the plugin (a Vite app without it). */
  canAddPlugin?: boolean;
  connection: Connection;
  repo?: string;
  /** For a URL: what answered. */
  title?: string;
  icon?: string;
  /** Things to tell the user before linking (no package.json, blocks frames…). */
  notes: string[];
  /** A monorepo: the apps inside it, to pick one. */
  candidates?: { name: string; path: string; framework?: Framework }[];
}

export type RunStatus = 'stopped' | 'installing' | 'starting' | 'running' | 'crashed';

/** The dev server the studio started for an app. */
export interface AppRun {
  app: string;
  status: RunStatus;
  command: string | null;
  /** The address it said it is listening on. */
  url: string | null;
  startedAt: number | null;
  exitCode: number | null;
  /** Its last output lines. */
  log: string[];
}

export interface AppsResponse {
  apps: LinkedApp[];
  active: string | null;
  runs: AppRun[];
  /** Folder new GitHub clones go into. */
  cloneDir: string;
  /** Show the app list when the studio opens. */
  launcher: boolean;
}

/** A folder, for picking one on this computer. */
export interface FolderListing {
  path: string;
  parent: string | null;
  folders: { name: string; path: string; app: boolean }[];
  /** Shortcuts: home, desktop, recent projects. */
  places: { label: string; path: string }[];
}
