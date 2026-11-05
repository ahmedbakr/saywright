/**
 * The models Saywright knows by name, with list prices (USD per million
 * tokens, as published in October 2026), and the presets for OpenAI-compatible
 * providers. Models a provider lists that aren't here still work; their cost
 * is unknown unless the provider reports it (OpenRouter does).
 */
import type { CompatiblePreset, ModelInfo, Price, ProviderKind, Usage } from './ai.ts';

export const CATALOG: Partial<Record<ProviderKind, ModelInfo[]>> = {
  anthropic: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', tier: 'top', vision: true, tools: true, price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, note: 'Best results' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', tier: 'balanced', vision: true, tools: true, price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, note: 'Fast and capable' },
    {
      id: 'claude-haiku-5-5',
      label: 'Claude Haiku 5.5',
      tier: 'fast',
      vision: true,
      tools: true,
      price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, longAbove: 100_000, long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
      note: 'Fastest, lightest',
    },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', tier: 'top', vision: true, tools: true, price: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }, note: 'Most capable, priciest' },
  ],
  openai: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', tier: 'top', vision: true, tools: true, price: { input: 2, output: 10, cacheRead: 0.1 }, note: 'Best value at the top' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', tier: 'top', vision: true, tools: true, price: { input: 10, output: 50, cacheRead: 1 }, note: 'Most capable, priciest' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', tier: 'balanced', vision: true, tools: true, price: { input: 0.75, output: 4.5, cacheRead: 0.075 } },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', tier: 'fast', vision: true, tools: true, price: { input: 0.1, output: 0.5, cacheRead: 0.01 }, note: 'Fastest, lightest' },
  ],
  gemini: [
    { id: 'gemini-4-argon', label: 'Gemini 4 Argon', tier: 'top', vision: true, tools: true, price: { input: 2, output: 10, cacheRead: 0.1 }, note: 'Best results' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', tier: 'balanced', vision: true, tools: true, price: { input: 0.75, output: 3.75, cacheRead: 0.075 } },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', tier: 'fast', vision: true, tools: true, price: { input: 0.3, output: 2.5, cacheRead: 0.03 } },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', tier: 'fast', vision: true, tools: true, price: { input: 0.25, output: 1.5, cacheRead: 0.025 }, note: 'Cheapest' },
  ],
  // Subscriptions: the plan pays; prices are the API equivalent, shown for comparison.
  'claude-code': [
    { id: 'opus', label: 'Opus (latest)', tier: 'top', vision: true, tools: true, price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
    { id: 'sonnet', label: 'Sonnet (latest)', tier: 'balanced', vision: true, tools: true, price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
    { id: 'haiku', label: 'Haiku (latest)', tier: 'fast', vision: true, tools: true, price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
  ],
  codex: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', tier: 'top', vision: true, tools: true, price: { input: 2, output: 10, cacheRead: 0.1 } },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', tier: 'balanced', vision: true, tools: true, price: { input: 0.75, output: 4.5, cacheRead: 0.075 } },
  ],
  'gemini-cli': [
    { id: 'gemini-4-argon', label: 'Gemini 4 Argon', tier: 'top', vision: true, tools: true, price: { input: 2, output: 10, cacheRead: 0.1 } },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', tier: 'balanced', vision: true, tools: true, price: { input: 0.75, output: 3.75, cacheRead: 0.075 } },
  ],
};

/** Prices of models people reach through OpenAI-compatible providers, by the model's own id. */
const COMPATIBLE_PRICES: Record<string, Price> = {
  'deepseek-chat': { input: 0.28, output: 0.42, cacheRead: 0.028 },
  'deepseek-v4-flash': { input: 0.3, output: 1.2, cacheRead: 0.006 },
  'deepseek-v4-pro': { input: 1.32, output: 3.96, cacheRead: 0.044 },
  'openai/gpt-oss-120b': { input: 0.15, output: 0.6, cacheRead: 0.075 },
  'qwen/qwen3.8-27b': { input: 0.8, output: 4 },
  'mistral-medium-latest': { input: 1.5, output: 7.5, cacheRead: 0.15 },
  'mistral-large-latest': { input: 0.5, output: 1.5, cacheRead: 0.05 },
  'devstral-latest': { input: 0.4, output: 2, cacheRead: 0.04 },
  'codestral-latest': { input: 0.3, output: 0.9, cacheRead: 0.03 },
  'grok-code-fast-1': { input: 1, output: 2, cacheRead: 0.2 },
};

export const PRESETS: CompatiblePreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    note: 'One key for hundreds of models from every major lab. Reports the exact cost of each call.',
  },
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', keyUrl: null, local: true, note: 'Models running on this computer. Free and private; changes need a model that can call tools.' },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', keyUrl: null, local: true, note: 'Models running on this computer through LM Studio’s local server.' },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    models: [{ id: 'openai/gpt-oss-120b', label: 'gpt-oss-120b', tier: 'balanced', tools: true, price: COMPATIBLE_PRICES['openai/gpt-oss-120b'] }],
    note: 'Very fast open models.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', tier: 'top', tools: true, price: COMPATIBLE_PRICES['deepseek-v4-pro'] },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', tier: 'fast', tools: true, vision: true, price: COMPATIBLE_PRICES['deepseek-v4-flash'] },
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    models: [
      { id: 'devstral-latest', label: 'Devstral', tier: 'balanced', tools: true, price: COMPATIBLE_PRICES['devstral-latest'] },
      { id: 'mistral-medium-latest', label: 'Mistral Medium', tier: 'top', tools: true, vision: true, price: COMPATIBLE_PRICES['mistral-medium-latest'] },
    ],
  },
  {
    id: 'xai',
    label: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    keyUrl: 'https://console.x.ai',
    models: [{ id: 'grok-code-fast-1', label: 'Grok Code Fast', tier: 'fast', tools: true, vision: true, price: COMPATIBLE_PRICES['grok-code-fast-1'] }],
  },
  { id: 'custom', label: 'Other (OpenAI-compatible)', baseUrl: '', keyUrl: null, note: 'Any server that speaks the OpenAI Chat Completions API.' },
];

/**
 * Models that can answer a request without being picked: those Claude's server-side fallback runs a declined request
 * on (Claude Opus 5 or Opus 4.8 for Opus 5.5, Claude Sonnet 5 for Sonnet 5.5), at their list prices, so what they
 * used is counted at their own rates.
 */
const SERVED_PRICES: Record<string, Price> = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

/** What the studio knows about a model: from the catalog for its provider, or the shared table for compatible providers. */
export function modelInfo(kind: ProviderKind, id: string): ModelInfo | null {
  const known = CATALOG[kind]?.find((m) => m.id === id);
  if (known) return known;
  // Anything the catalog names under another provider (OpenRouter's "anthropic/claude-sonnet-5-5").
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  for (const list of Object.values(CATALOG)) {
    const m = list?.find((x) => x.id === bare || x.id === id);
    if (m) return { ...m, id };
  }
  const price = COMPATIBLE_PRICES[id] ?? COMPATIBLE_PRICES[bare] ?? SERVED_PRICES[bare];
  return price ? { id, label: id, price } : null;
}

/** Dollars for one call at list price (prompt caching included). */
export function costOf(price: Price | undefined, u: Usage): number | null {
  if (!price) return null;
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  const p = price.longAbove && price.long && prompt > price.longAbove ? price.long : price;
  const cents =
    u.input * p.input +
    u.output * p.output +
    u.cacheRead * (p.cacheRead ?? p.input) +
    u.cacheWrite * (p.cacheWrite ?? p.input);
  return cents / 1_000_000;
}

/** What the cache saved on one call: cached tokens at the full input price, less what they cost. */
export function savedBy(price: Price | undefined, u: Usage): number {
  if (!price || !u.cacheRead) return 0;
  return (u.cacheRead * (price.input - (price.cacheRead ?? price.input))) / 1_000_000;
}

/** A model's name as people say it: "Claude Opus 5.5", "GPT-6.1 Sol", or the id as given. */
export function modelName(id?: string): string {
  if (!id) return 'AI';
  for (const list of Object.values(CATALOG)) {
    const m = list?.find((x) => x.id === id || id.startsWith(`${x.id}-`) || id.endsWith(`/${x.id}`));
    if (m && !/latest|default/i.test(m.label)) return m.label;
  }
  const c = /claude-(\w+)-(\d+)-(\d+)/.exec(id);
  return c ? `Claude ${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2]}.${c[3]}` : id;
}
