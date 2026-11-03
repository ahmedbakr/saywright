import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './fsx.ts';

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]] = value;
  }
  return out;
}

/** Keys the studio saves in .env.local: those win over the environment, so a key changed in Settings takes effect. */
const SAVED_KEY = /^(ANTHROPIC|OPENAI|GEMINI|OPENROUTER|GROQ|DEEPSEEK|MISTRAL|XAI|TOGETHER|PAGESPEED|GOOGLE)_API_KEY$|^SAYWRIGHT_KEY_\w+$/;

/**
 * What .env then .env.local in `dir` add to the environment. Values already in it win, except keys saved from Settings
 * (an empty one never blanks a key set in the shell).
 */
export function readEnvFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['.env', '.env.local']) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const vars = parseEnv(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(vars)) {
      if ((out[k] ?? process.env[k]) === undefined || (name === '.env.local' && SAVED_KEY.test(k) && v)) out[k] = v;
    }
  }
  return out;
}

/** Load .env then .env.local from `dir` into the environment (see readEnvFiles). */
export function loadEnvFiles(dir: string): void {
  Object.assign(process.env, readEnvFiles(dir));
}

/** Write or replace one secret in `.env.local` (created with owner-only permissions), or remove it (null). */
export function saveSecret(dir: string, name: string, value: string | null): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`Not a variable name: ${name}`);
  const file = path.join(dir, '.env.local');
  if (value !== null && /[\r\n]/.test(value)) throw new Error('A key is a single line.');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  // Every line that sets it goes: in a file that sets it twice (edited by hand), the last one wins when it is read.
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=.*$\\n?`, 'gm');
  const at = text.search(re);
  text = text.replace(re, '');
  if (value === null) {
    delete process.env[name];
  } else {
    // In the first one's place, or at the end.
    const line = `${name}=${value}\n`;
    text = at >= 0 ? text.slice(0, at) + line + text.slice(at) : (text && !text.endsWith('\n') ? `${text}\n` : text) + line;
    process.env[name] = value;
  }
  writeFileAtomic(file, text, { mode: 0o600 });
  return file;
}

/** "sk-…4f2a": enough to recognise a key, never enough to use it. */
export function keyHint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 12) return '…';
  const prefix = Math.min(6, value.indexOf('-', 3) + 1 || 3);
  return `${value.slice(0, prefix)}…${value.slice(-4)}`;
}

type CredentialSource = 'env' | 'file' | 'profile' | null;

/** Where the Anthropic SDK will find credentials, without making a request. */
export function credentialSource(envFileDir: string): CredentialSource {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    const local = path.join(envFileDir, '.env.local');
    const fromFile = fs.existsSync(local) && /ANTHROPIC_API_KEY\s*=\s*\S/.test(fs.readFileSync(local, 'utf8'));
    return fromFile ? 'file' : 'env';
  }
  // `ant auth login` stores a profile the SDK reads automatically.
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const profileDir = path.join(configHome, 'anthropic');
  try {
    if (fs.existsSync(profileDir) && fs.readdirSync(profileDir).length > 0) return 'profile';
  } catch {
    /* unreadable profile dir: treat as missing */
  }
  return null;
}
