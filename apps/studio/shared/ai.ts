/**
 * AI connections, shared by the studio and its server: the providers a person
 * can connect (an API key, a subscription they already pay for through its
 * official app, or a model on their own computer), which model does which job,
 * and what it all costs.
 */

/** How the studio talks to a provider. */
export type ProviderKind =
  /** Anthropic API (key). */
  | 'anthropic'
  /** OpenAI API (key). */
  | 'openai'
  /** Google Gemini API (key from AI Studio). */
  | 'gemini'
  /** Any OpenAI-compatible endpoint: OpenRouter, Groq, DeepSeek, Mistral, xAI, Ollama, LM Studio… */
  | 'compatible'
  /** The person's Claude plan, through the official Claude Code app on this computer. */
  | 'claude-code'
  /** The person's ChatGPT plan, through the official Codex app on this computer. */
  | 'codex'
  /** The person's Google account, through the official Gemini CLI on this computer. */
  | 'gemini-cli';

type AuthKind = 'key' | 'subscription' | 'local';

/** What a model is used for. */
export type AiTask =
  /** Changes and questions about the code (an agent with tools). */
  | 'code'
  /** Session reports and expert reviews (long evidence, screenshots, structured output). */
  | 'report'
  /** Small jobs: translating a report, naming things. Cheap and quick. */
  | 'light';

export const AI_TASKS: { id: AiTask; label: string; hint: string }[] = [
  { id: 'code', label: 'Changes and questions', hint: 'Edits code and answers questions about it. The most capable model pays off here.' },
  { id: 'report', label: 'Reports and reviews', hint: 'Writes session reports and expert reviews from screenshots and evidence.' },
  { id: 'light', label: 'Small jobs', hint: 'Translations and short texts. A fast, inexpensive model is plenty.' },
];

export type AiEffort = 'low' | 'medium' | 'high';

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  /** Reading from the prompt cache. */
  cacheRead?: number;
  /** Writing to the prompt cache (5-minute entries). */
  cacheWrite?: number;
  /** Prompts over this many tokens pay `long` instead (Haiku 5.5 over 100K). */
  longAbove?: number;
  long?: Omit<Price, 'longAbove' | 'long'>;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** top: the most capable; balanced; fast: quickest and cheapest. */
  tier?: 'top' | 'balanced' | 'fast';
  vision?: boolean;
  /** Can call tools (needed to make changes). */
  tools?: boolean;
  price?: Price;
  note?: string;
}

export type ConnectionStatus = 'ready' | 'needs-key' | 'needs-login' | 'missing' | 'offline' | 'error';

/** A connection as the studio shows it (secrets never leave the server). */
export interface ConnectionView {
  id: string;
  kind: ProviderKind;
  label: string;
  auth: AuthKind;
  status: ConnectionStatus;
  /** "Key ending 4f2a", "Signed in (Claude Max)", "3 models on this computer"… */
  detail?: string;
  models: ModelInfo[];
  /** OpenAI-compatible: where it lives, and which preset it came from. */
  baseUrl?: string;
  preset?: string;
  /** Found on this computer or in the environment rather than added by hand. */
  detected?: boolean;
  /** Turned off by the person: kept, but never used. */
  disabled?: boolean;
}

export interface Route {
  connection: string;
  model: string;
}

export interface Budget {
  /** Daily and monthly limits in USD (null: none). */
  dailyUsd: number | null;
  monthlyUsd: number | null;
  /** Daily limit in tokens, for plans and local models that bill no dollars. */
  dailyTokens: number | null;
  /** At the limit: warn and carry on, or stop until it is raised or reset. */
  mode: 'warn' | 'stop';
  /** Warn from this share of a limit (0.8 = 80%). */
  warnAt: number;
}

export const DEFAULT_BUDGET: Budget = { dailyUsd: 5, monthlyUsd: 50, dailyTokens: null, mode: 'warn', warnAt: 0.8 };

/** What one model call used. */
export interface Usage {
  /** Input tokens billed at the full rate (not read from or written to the cache). */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Part of `output` spent thinking. */
  reasoning?: number;
}

export interface UsageTotals {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Dollars billed (API keys). */
  usd: number;
  /** What the plan's usage would have cost through the API (subscriptions), for comparison. */
  planUsd: number;
  /** Calls whose price isn't known (a model with no listed price). */
  unpriced: number;
}

export interface UsageRow extends UsageTotals {
  key: string;
  label: string;
}

export interface BudgetStatus {
  level: 'ok' | 'warn' | 'over';
  message: string | null;
  /** Share of the tightest limit used (0..1+). */
  used: number;
}

export interface UsageSummary {
  today: UsageTotals;
  month: UsageTotals;
  /** The last 30 days, oldest first. */
  days: { date: string; usd: number; tokens: number }[];
  byModel: UsageRow[];
  byFeature: UsageRow[];
  byApp: UsageRow[];
  /** When the counts were last reset (ms), if they were. */
  resetAt: { today: number | null; month: number | null };
  budget: Budget;
  status: BudgetStatus;
  /** Prompt-cache savings this month, in USD. */
  savedUsd: number;
}

/** The features that spend tokens, for the usage breakdown. */
export const FEATURES: Record<string, string> = {
  edit: 'Changes',
  answer: 'Questions',
  fix: 'Bug fixes',
  report: 'Session reports',
  translate: 'Translations',
  review: 'Expert reviews',
  autopilot: 'Autopilot',
  test: 'Connection tests',
  other: 'Other',
};

/** Today's AI use, for the top bar. */
export interface UsagePill {
  usd: number;
  planUsd: number;
  tokens: number;
  calls: number;
  level: BudgetStatus['level'];
  message: string | null;
}

export interface AiState {
  connections: ConnectionView[];
  /** What does each task now: the person's choice, or the automatic pick. */
  routes: Record<AiTask, Route | null>;
  /** The person's own choices (the rest are automatic). */
  chosen: Partial<Record<AiTask, Route>>;
  effort: AiEffort;
  /** Whether any connection can make changes. */
  ready: boolean;
  usage: UsageSummary;
  /** Ways to add Saywright to other AI apps (Claude Desktop, Cursor, VS Code…) as an MCP server. */
  /** `stdio.env`: what the program needs to find this studio (its data folder, wherever SAYWRIGHT_HOME put it). */
  mcp: { url: string; token: string; stdio: { command: string; args: string[]; env?: Record<string, string> } } | null;
  /** Where keys saved from Settings are kept. */
  keysFile?: string;
}

/** Presets for OpenAI-compatible providers. */
export interface CompatiblePreset {
  id: string;
  label: string;
  baseUrl: string;
  /** Where to get a key (null: none needed). */
  keyUrl: string | null;
  local?: boolean;
  /** Suggested models when the provider doesn't list its own. */
  models?: ModelInfo[];
  note?: string;
}
