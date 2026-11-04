/**
 * The values of the secrets an app's tests type (PASSWORD, CARD_NUMBER…), saved when you choose to, so the studio
 * can run its tests and replay its sessions. Kept with the studio's data, outside every app's code (no AI tool and
 * no commit reaches them), in a file only you can read. A test never holds one: it reads SAYWRIGHT_SECRET_PASSWORD,
 * which the studio sets from here when it runs it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { secretEnvName, SECRET_ENV_PREFIX } from '@saywright/vite/protocol';
import { readJson, writeFileAtomic } from '../fsx.ts';

/** A secret's name as tests use it: PASSWORD, CARD_NUMBER. */
export const secretKey = (name: string): string => secretEnvName(name).slice(SECRET_ENV_PREFIX.length);

export class TestSecrets {
  constructor(private readonly file: string) {}

  private read(): Record<string, string> {
    const saved = readJson<Record<string, unknown>>(this.file);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(saved ?? {})) if (typeof v === 'string' && v) out[secretKey(k)] = v;
    return out;
  }

  /** The values, by name (only the studio's server ever reads them all). */
  all(): Record<string, string> {
    return this.read();
  }

  /** Which secrets have a value, saved here or in the environment the studio was started in. */
  names(): { saved: string[]; environment: string[] } {
    const environment = Object.keys(process.env)
      .filter((k) => k.startsWith(SECRET_ENV_PREFIX) && process.env[k])
      .map((k) => k.slice(SECRET_ENV_PREFIX.length));
    return { saved: Object.keys(this.read()).sort(), environment: environment.sort() };
  }

  /** Save a value (an empty one forgets it). */
  set(name: string, value: string): void {
    const all = this.read();
    const key = secretKey(name);
    if (value) all[key] = value;
    else delete all[key];
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(all, null, 2), { mode: 0o600 });
  }

  /** The value a replay types for this name: saved here, else from the environment. */
  get(name: string): string | undefined {
    const key = secretKey(name);
    return this.read()[key] || process.env[SECRET_ENV_PREFIX + key] || undefined;
  }
}
