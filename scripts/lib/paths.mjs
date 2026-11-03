import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const STUDIO_DIR = path.join(ROOT, 'apps/studio');
export const SHOP_DIR = path.join(ROOT, 'apps/shop');
export const PLUGIN_DIR = path.join(ROOT, 'packages/vite');

/** The studio's own data (settings, linked apps, speech models): .saywright/, or SAYWRIGHT_HOME. */
export const DATA_DIR = process.env.SAYWRIGHT_HOME ? path.resolve(process.env.SAYWRIGHT_HOME) : path.join(ROOT, '.saywright');

/**
 * The models the studio's page runs itself live in the data folder; earlier versions kept them in apps/studio/public.
 * Moved there when the studio starts (npm run dev) or sets up (npm run setup), never by merely loading this file.
 */
export function moveOldModels() {
  const old = path.join(STUDIO_DIR, 'public/models');
  if (!fs.existsSync(old) || fs.existsSync(path.join(DATA_DIR, 'models'))) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.renameSync(old, path.join(DATA_DIR, 'models'));
}
