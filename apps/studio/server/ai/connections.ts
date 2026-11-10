/**
 * The AI connections a person has, found or added:
 * - API keys: Anthropic, OpenAI, Gemini, and OpenAI-compatible providers
 *   (OpenRouter, Groq, DeepSeek, Mistral, xAI or any other address). Keys
 *   live in the studio's .env.local, readable by this user only.
 * - Subscriptions they already pay for, through the official apps on this
 *   computer: Claude Code (a Claude plan), Codex (a ChatGPT plan) and Gemini
 *   CLI (a Google account). The studio asks each app whether it is signed in;
 *   it never reads their sign-in files or tokens.
 * - Models on this computer: Ollama and LM Studio, when they are running.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AiEffort, AiTask, ConnectionStatus, ConnectionView, ModelInfo, ProviderKind, Route } from '../../shared/ai.ts';
import { CATALOG, PRESETS, modelInfo } from '../../shared/models.ts';
import { credentialSource, keyHint, saveSecret } from '../env.ts';
import { readJson, writeJson } from '../fsx.ts';
import { runQuiet } from '../program.ts';
import { AnthropicModel } from './llm/anthropic.ts';
import { CompatibleModel } from './llm/compatible.ts';
import { GeminiModel } from './llm/gemini.ts';
import { OpenAIModel } from './llm/openai.ts';
import type { ChatModel } from './llm/types.ts';

/** An OpenAI-compatible provider the person added. */
interface CustomConnection {
  id: string;
  preset: string;
  label: string;
  baseUrl: string;
  /** The variable in .env.local that holds its key (none for local servers). */
  keyVar?: string;
  /** Models the person picked or typed, kept when the provider doesn't list them. */
  models?: string[];
}

interface AiConfig {
  custom: CustomConnection[];
  routes: Partial<Record<AiTask, Route>>;
  effort: AiEffort;
  /** Connections turned off: kept, never used. */
  off: string[];
}

const DEFAULT_CONFIG: AiConfig = { custom: [], routes: {}, effort: 'medium', off: [] };

/** Keys by provider, in the order they are looked up. */
const KEY_VARS: Record<'anthropic' | 'openai' | 'gemini', string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

const PRESET_KEY_VAR: Record<string, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xai: 'XAI_API_KEY',
};

/** Which presets can be asked for JSON matching a schema (DeepSeek only does plain JSON). */
const NO_JSON_SCHEMA = new Set(['deepseek']);

export const keyOf = (kind: 'anthropic' | 'openai' | 'gemini') => KEY_VARS[kind].map((v) => process.env[v]).find(Boolean);


/** Where a program is on PATH (no shell involved), or null. */
export function which(bin: string): string | null {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext.toLowerCase());
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

async function getJson(url: string, headers: Record<string, string> = {}, timeoutMs = 900): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** A CLI's own model choice: whatever its plan and settings pick. */
const PLAN_DEFAULT: ModelInfo = { id: 'default', label: 'Your plan’s default', tools: true, vision: true, note: 'Whatever the app picks for your plan' };

interface Detected {
  status: ConnectionStatus;
  detail?: string;
  models?: ModelInfo[];
  /** The program to run (CLIs). */
  bin?: string;
}

export class Connections {
  config: AiConfig;
  private detected = new Map<string, Detected>();
  private detectedAt = 0;
  private detecting: Promise<void> | null = null;

  constructor(
    private file: string,
    private envDir: string,
  ) {
    this.config = this.load();
  }

  private load(): AiConfig {
    const raw = readJson<Partial<AiConfig>>(this.file);
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG, custom: [], routes: {}, off: [] };
    return { ...DEFAULT_CONFIG, ...raw, custom: raw.custom ?? [], routes: raw.routes ?? {}, off: raw.off ?? [] };
  }

  save(): void {
    writeJson(this.file, this.config);
  }

  /** Look again (programs installed or signed in since, local servers started). At most every 20 s unless forced. */
  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.detectedAt < 20_000) return;
    if (this.detecting) return this.detecting;
    this.detecting = (async () => {
      const found = new Map<string, Detected>();
      await Promise.all([
        this.detectClaudeCode().then((d) => found.set('claude-code', d)),
        this.detectCodex().then((d) => found.set('codex', d)),
        this.detectGeminiCli().then((d) => found.set('gemini-cli', d)),
        this.detectLocal('ollama').then((d) => found.set('ollama', d)),
        this.detectLocal('lmstudio').then((d) => found.set('lmstudio', d)),
        ...this.config.custom.map((c) => this.detectCustom(c).then((d) => found.set(c.id, d))),
      ]);
      this.detected = found;
      this.detectedAt = Date.now();
    })().finally(() => (this.detecting = null));
    return this.detecting;
  }

  private async detectClaudeCode(): Promise<Detected> {
    const bin = which('claude');
    if (!bin) return { status: 'missing', detail: 'Install Claude Code and sign in with your Claude account to use your plan here.' };
    const r = await runQuiet(bin, ['auth', 'status', '--json'], 8000);
    try {
      const s = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
      if (!s.loggedIn) return { bin, status: 'needs-login', detail: 'Claude Code is installed but not signed in. Run “claude” once in a terminal and sign in.' };
      const via = s.apiProvider && s.apiProvider !== 'firstParty' ? ` through ${s.apiProvider}` : '';
      const how = /api_?key/i.test(s.authMethod ?? '') ? 'an API key (billed per use)' : 'your Claude account';
      return { bin, status: 'ready', detail: `Signed in with ${how}${via}.` };
    } catch {
      return { bin, status: r.code === 0 ? 'ready' : 'needs-login', detail: r.code === 0 ? 'Installed.' : 'Run “claude” once in a terminal and sign in.' };
    }
  }

  private async detectCodex(): Promise<Detected> {
    const bin = which('codex');
    if (!bin) return { status: 'missing', detail: 'Install Codex and sign in with ChatGPT to use your plan here.' };
    const r = await runQuiet(bin, ['login', 'status'], 8000);
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.code !== 0 || /not logged in/i.test(out)) return { bin, status: 'needs-login', detail: 'Codex is installed but not signed in. Run “codex login” in a terminal.' };
    return { bin, status: 'ready', detail: /api key/i.test(out) ? 'Signed in with an API key (billed per use).' : 'Signed in with ChatGPT.' };
  }

  private async detectGeminiCli(): Promise<Detected> {
    const bin = which('gemini');
    if (!bin) return { status: 'missing', detail: 'Install Gemini CLI and sign in with Google to use your account here.' };
    return { bin, status: 'ready', detail: 'Uses the Google account Gemini CLI signs in with.' };
  }

  private async detectLocal(id: 'ollama' | 'lmstudio'): Promise<Detected> {
    try {
      if (id === 'ollama') {
        const tags = (await getJson('http://127.0.0.1:11434/api/tags')) as { models?: { name: string; details?: { parameter_size?: string } }[] };
        const models = (tags.models ?? []).map((m) => ({ id: m.name, label: m.name, tools: true, price: { input: 0, output: 0 }, note: m.details?.parameter_size }));
        return { status: models.length ? 'ready' : 'error', detail: models.length ? `${models.length} model${models.length === 1 ? '' : 's'} on this computer.` : 'Running, with no models yet. Pull one with “ollama pull”.', models };
      }
      const list = (await getJson('http://127.0.0.1:1234/v1/models')) as { data?: { id: string }[] };
      const models = (list.data ?? []).filter((m) => !/embed/i.test(m.id)).map((m) => ({ id: m.id, label: m.id, tools: true, price: { input: 0, output: 0 } }));
      return { status: models.length ? 'ready' : 'error', detail: models.length ? `${models.length} model${models.length === 1 ? '' : 's'} loaded.` : 'Running, with no model loaded.', models };
    } catch {
      return { status: 'offline', detail: id === 'ollama' ? 'Not running. Start Ollama to use models on this computer.' : 'Not running. Start LM Studio’s local server.' };
    }
  }

  private async detectCustom(c: CustomConnection): Promise<Detected> {
    const key = c.keyVar ? process.env[c.keyVar] : undefined;
    const preset = PRESETS.find((p) => p.id === c.preset);
    if (c.keyVar && !key) return { status: 'needs-key', detail: 'Add its API key.' };
    const remembered = (c.models ?? []).map((id) => ({ ...(modelInfo('compatible', id) ?? { id, label: id }), tools: true }));
    try {
      const list = (await getJson(`${c.baseUrl.replace(/\/+$/, '')}/models`, key ? { Authorization: `Bearer ${key}` } : {}, 4000)) as {
        data?: { id: string; name?: string; pricing?: { prompt?: string; completion?: string; input_cache_read?: string }; architecture?: { input_modalities?: string[] }; supported_parameters?: string[] }[];
      };
      const listed = (list.data ?? [])
        .filter((m) => !/embed|whisper|tts|moderation|dall-e|image|audio|guard/i.test(m.id))
        .filter((m) => !m.supported_parameters || m.supported_parameters.includes('tools'))
        .map((m): ModelInfo => {
          const known = modelInfo('compatible', m.id);
          // A price per token, as text; a negative one ("-1", OpenRouter's "varies") or one that isn't a number is no price.
          const per = (v?: string) => (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) * 1_000_000 : undefined);
          const input = per(m.pricing?.prompt);
          const output = per(m.pricing?.completion);
          const price = m.pricing?.prompt != null ? (input !== undefined && output !== undefined ? { input, output, cacheRead: per(m.pricing.input_cache_read) } : undefined) : known?.price;
          return { id: m.id, label: m.name ?? known?.label ?? m.id, tools: true, vision: m.architecture?.input_modalities?.includes('image') ?? known?.vision, price, tier: known?.tier };
        });
      const models = [...remembered.filter((r) => !listed.some((l) => l.id === r.id)), ...listed];
      return { status: 'ready', detail: `${listed.length} models available.`, models: models.length ? models : (preset?.models ?? []) };
    } catch {
      const models = remembered.length ? remembered : (preset?.models ?? []);
      return { status: models.length ? 'ready' : 'error', detail: models.length ? 'Couldn’t list its models just now; using the ones you picked.' : 'Couldn’t reach it. Check the address and key.', models };
    }
  }

  /** Every connection, as the studio shows it. Call refresh() first for fresh detection. */
  list(): ConnectionView[] {
    const off = new Set(this.config.off);
    const out: ConnectionView[] = [];
    const d = (id: string) => this.detected.get(id);

    // Subscriptions through the official apps.
    for (const [id, label] of [
      ['claude-code', 'Claude (your plan, via Claude Code)'],
      ['codex', 'ChatGPT (your plan, via Codex)'],
      ['gemini-cli', 'Gemini (your Google account, via Gemini CLI)'],
    ] as const) {
      const det = d(id) ?? { status: 'missing' as const };
      out.push({ id, kind: id, label, auth: 'subscription', status: det.status, detail: det.detail, models: [PLAN_DEFAULT, ...(CATALOG[id] ?? [])], detected: det.status !== 'missing' });
    }

    // API keys.
    const anthropicSource = credentialSource(this.envDir);
    const anthropicKey = keyOf('anthropic');
    out.push({
      id: 'anthropic',
      kind: 'anthropic',
      label: 'Anthropic API',
      auth: 'key',
      status: anthropicSource ? 'ready' : 'needs-key',
      detail: anthropicKey ? `Key ${keyHint(anthropicKey)}${anthropicSource === 'env' ? ' (from the environment)' : ''}` : anthropicSource === 'profile' ? 'Signed in with the Anthropic CLI profile.' : undefined,
      models: CATALOG.anthropic ?? [],
      detected: !!anthropicSource,
    });
    const saved = this.savedKeys();
    for (const kind of ['openai', 'gemini'] as const) {
      const key = keyOf(kind);
      const fromEnv = key && !KEY_VARS[kind].some((v) => saved.has(v) && process.env[v] === key);
      out.push({
        id: kind,
        kind,
        label: kind === 'openai' ? 'OpenAI API' : 'Gemini API',
        auth: 'key',
        status: key ? 'ready' : 'needs-key',
        detail: key ? `Key ${keyHint(key)}${fromEnv ? ' (from the environment)' : ''}` : undefined,
        models: CATALOG[kind] ?? [],
        detected: !!key,
      });
    }

    // On this computer.
    for (const id of ['ollama', 'lmstudio'] as const) {
      const det = d(id) ?? { status: 'offline' as const };
      const preset = PRESETS.find((p) => p.id === id)!;
      out.push({ id, kind: 'compatible', label: preset.label, auth: 'local', status: det.status, detail: det.detail, models: det.models ?? [], baseUrl: preset.baseUrl, preset: id, detected: det.status === 'ready' });
    }

    // Added by the person.
    for (const c of this.config.custom) {
      const det = d(c.id) ?? { status: c.keyVar && !process.env[c.keyVar] ? ('needs-key' as const) : ('ready' as const) };
      const key = c.keyVar ? process.env[c.keyVar] : undefined;
      out.push({
        id: c.id,
        kind: 'compatible',
        label: c.label,
        auth: c.keyVar ? 'key' : 'local',
        status: det.status,
        detail: [key ? `Key ${keyHint(key)}` : null, det.detail].filter(Boolean).join(' · ') || undefined,
        models: det.models ?? (c.models ?? []).map((id) => modelInfo('compatible', id) ?? { id, label: id }),
        baseUrl: c.baseUrl,
        preset: c.preset,
      });
    }
    for (const c of out) if (off.has(c.id)) c.disabled = true;
    return out;
  }

  /** The variables .env.local holds (names only). */
  private savedKeys(): Set<string> {
    try {
      const text = fs.readFileSync(path.join(this.envDir, '.env.local'), 'utf8');
      return new Set([...text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]));
    } catch {
      return new Set();
    }
  }

  get(id: string): ConnectionView | undefined {
    return this.list().find((c) => c.id === id);
  }

  usable(c: ConnectionView | undefined): c is ConnectionView {
    return !!c && c.status === 'ready' && !c.disabled;
  }

  /** The program a subscription connection runs. */
  binary(id: string): string | null {
    return this.detected.get(id)?.bin ?? null;
  }

  /** What does a task: the person's choice when it can run, otherwise the best connection available. */
  route(task: AiTask): { connection: ConnectionView; model: string } | null {
    const all = this.list();
    const chosen = this.config.routes[task];
    if (chosen) {
      const c = all.find((x) => x.id === chosen.connection);
      if (this.usable(c)) return { connection: c, model: chosen.model };
    }
    // Plans first (they cost nothing extra), then keys, then this computer and other providers.
    const order: string[] = ['claude-code', 'codex', 'gemini-cli', 'anthropic', 'openai', 'gemini', ...this.config.custom.map((c) => c.id), 'ollama', 'lmstudio'];
    for (const id of order) {
      const c = all.find((x) => x.id === id);
      if (!this.usable(c) || !c.models.length) continue;
      if (task === 'report' && !c.models.some((m) => m.vision !== false) && c.auth !== 'subscription') continue;
      return { connection: c, model: defaultModel(c, task) };
    }
    return null;
  }

  /** A model to talk to through an API connection (subscriptions run their own app instead). */
  chatModel(connectionId: string, model: string): ChatModel | null {
    switch (connectionId) {
      case 'anthropic':
        return new AnthropicModel(model);
      case 'openai':
        return new OpenAIModel(model, () => keyOf('openai'));
      case 'gemini':
        return new GeminiModel(model, () => keyOf('gemini'));
      case 'ollama':
      case 'lmstudio': {
        const p = PRESETS.find((x) => x.id === connectionId)!;
        return new CompatibleModel(model, { label: p.label, baseUrl: p.baseUrl, vision: /vl|vision|llava|gemma3|qwen2\.5vl|mistral-small3/i.test(model) });
      }
    }
    const c = this.config.custom.find((x) => x.id === connectionId);
    if (!c) return null;
    const info = this.get(c.id)?.models.find((m) => m.id === model) ?? modelInfo('compatible', model);
    return new CompatibleModel(model, {
      label: c.label,
      baseUrl: c.baseUrl,
      key: c.keyVar ? () => process.env[c.keyVar!] : undefined,
      vision: info?.vision ?? false,
      jsonSchema: !NO_JSON_SCHEMA.has(c.preset),
      openrouter: c.preset === 'openrouter',
    });
  }

  /** Save a key for a built-in provider, or for an added one. */
  setKey(connectionId: string, key: string | null): void {
    const custom = this.config.custom.find((c) => c.id === connectionId);
    const name = connectionId === 'anthropic' ? 'ANTHROPIC_API_KEY' : connectionId === 'openai' ? 'OPENAI_API_KEY' : connectionId === 'gemini' ? 'GEMINI_API_KEY' : custom?.keyVar;
    if (!name) throw new Error('This connection has no key.');
    saveSecret(this.envDir, name, key);
    this.detectedAt = 0;
  }

  /** Add an OpenAI-compatible provider (from a preset or any address). */
  addCustom(input: { preset: string; label?: string; baseUrl?: string; key?: string; models?: string[] }): CustomConnection {
    const preset = PRESETS.find((p) => p.id === input.preset) ?? PRESETS.find((p) => p.id === 'custom')!;
    const baseUrl = (input.baseUrl || preset.baseUrl).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error('Give the provider’s address, like https://api.example.com/v1');
    if (/^http:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(baseUrl)) throw new Error('Use https for a provider that isn’t on this computer: keys must not travel unencrypted.');
    const n = this.config.custom.filter((c) => c.preset === preset.id).length;
    const id = `${preset.id}${n ? `-${n + 1}` : ''}`;
    const keyVar = input.key ? (n === 0 && PRESET_KEY_VAR[preset.id] ? PRESET_KEY_VAR[preset.id] : `SAYWRIGHT_KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`) : undefined;
    if (input.key && keyVar) saveSecret(this.envDir, keyVar, input.key.trim());
    const c: CustomConnection = { id, preset: preset.id, label: input.label?.trim() || preset.label, baseUrl, keyVar, models: input.models?.filter(Boolean).slice(0, 20) };
    this.config.custom.push(c);
    this.save();
    this.detectedAt = 0;
    return c;
  }

  removeCustom(id: string): void {
    const c = this.config.custom.find((x) => x.id === id);
    if (!c) return;
    if (c.keyVar && !this.config.custom.some((x) => x !== c && x.keyVar === c.keyVar)) saveSecret(this.envDir, c.keyVar, null);
    this.config.custom = this.config.custom.filter((x) => x !== c);
    for (const [task, r] of Object.entries(this.config.routes)) if (r?.connection === id) delete this.config.routes[task as AiTask];
    this.save();
  }

  setOff(id: string, off: boolean): void {
    this.config.off = off ? [...new Set([...this.config.off, id])] : this.config.off.filter((x) => x !== id);
    this.save();
  }

  setRoute(task: AiTask, route: Route | null): void {
    if (route) this.config.routes[task] = route;
    else delete this.config.routes[task];
    this.save();
  }

  setEffort(effort: AiEffort): void {
    this.config.effort = effort;
    this.save();
  }

  addModel(id: string, model: string): void {
    const c = this.config.custom.find((x) => x.id === id);
    if (!c) return;
    c.models = [...new Set([model, ...(c.models ?? [])])].slice(0, 20);
    this.save();
  }
}

/** The model a task gets on a connection by default: the most capable for code, a balanced one for reports, the lightest for small jobs. */
function defaultModel(c: ConnectionView, task: AiTask): string {
  if (c.auth === 'subscription') {
    if (c.kind === 'claude-code') return task === 'light' ? 'haiku' : task === 'report' ? 'sonnet' : 'default';
    return 'default';
  }
  const want: ModelInfo['tier'][] = task === 'code' ? ['top', 'balanced'] : task === 'report' ? ['balanced', 'top'] : ['fast', 'balanced'];
  for (const tier of want) {
    const m = c.models.find((x) => x.tier === tier && (task !== 'report' || x.vision !== false));
    if (m) return m.id;
  }
  return c.models[0]?.id ?? '';
}

export function kindLabel(kind: ProviderKind): string {
  return { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini', compatible: 'the model', 'claude-code': 'Claude', codex: 'Codex', 'gemini-cli': 'Gemini' }[kind];
}
