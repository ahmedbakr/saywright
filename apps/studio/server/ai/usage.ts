/**
 * Every model call the studio makes, written down: which app and feature it
 * was for, the model, the tokens (cache reads and writes apart) and what it
 * cost at list price. A subscription's calls are counted too (tokens, and what
 * they would have cost through the API) but bill no dollars. Totals for today
 * and this month feed the budget: a warning near a limit, and, when the person
 * chose it, a stop at the limit until they raise it or reset the count.
 *
 * One JSON line per call, a file per month, in the studio's data folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_BUDGET, FEATURES, type Budget, type BudgetStatus, type ProviderKind, type Usage, type UsageRow, type UsageSummary, type UsageTotals } from '../../shared/ai.ts';
import { readJson, writeJson } from '../fsx.ts';

export interface UsageEntry extends Usage {
  t: number;
  app: string | null;
  appName?: string;
  feature: string;
  connection: string;
  kind: ProviderKind;
  model: string;
  /** Paid by a subscription: no dollars billed. */
  plan: boolean;
  /** List price of the call (for a plan: what it would have cost through the API); null when unknown. */
  usd: number | null;
  /** What prompt caching saved. */
  saved?: number;
  ms?: number;
}

interface State {
  budget: Budget;
  /** Counting starts again from these moments (the history stays). */
  resetToday: number | null;
  resetMonth: number | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const monthKey = (t: number) => dayKey(t).slice(0, 7);
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const startOfMonth = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
};

const empty = (): UsageTotals => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, planUsd: 0, unpriced: 0 });

function add(t: UsageTotals, e: UsageEntry): void {
  t.calls++;
  t.input += e.input;
  t.output += e.output;
  t.cacheRead += e.cacheRead;
  t.cacheWrite += e.cacheWrite;
  if (e.usd == null) t.unpriced++;
  else if (e.plan) t.planUsd += e.usd;
  else t.usd += e.usd;
}

const tokensOf = (t: Pick<UsageTotals, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>) => t.input + t.output + t.cacheRead + t.cacheWrite;

const money = (usd: number) => (usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`);
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

export class UsageLedger {
  private state: State;
  /** Entries by month ("2026-10"), loaded on first use. */
  private months = new Map<string, UsageEntry[]>();

  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.state = this.loadState();
  }

  private get stateFile() {
    return path.join(this.dir, 'state.json');
  }

  private loadState(): State {
    const raw = readJson<Partial<State>>(this.stateFile);
    if (!raw || typeof raw !== 'object') return { budget: { ...DEFAULT_BUDGET }, resetToday: null, resetMonth: null };
    return { budget: { ...DEFAULT_BUDGET, ...raw.budget }, resetToday: raw.resetToday ?? null, resetMonth: raw.resetMonth ?? null };
  }

  private saveState(): void {
    writeJson(this.stateFile, this.state);
  }

  private month(key: string): UsageEntry[] {
    let list = this.months.get(key);
    if (!list) {
      list = [];
      try {
        for (const line of fs.readFileSync(path.join(this.dir, `${key}.jsonl`), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            list.push(JSON.parse(line) as UsageEntry);
          } catch {
            /* a torn last line */
          }
        }
      } catch {
        /* no calls that month */
      }
      this.months.set(key, list);
    }
    return list;
  }

  record(e: UsageEntry): void {
    const key = monthKey(e.t);
    this.month(key).push(e);
    fs.appendFileSync(path.join(this.dir, `${key}.jsonl`), JSON.stringify(e) + '\n');
  }

  get budget(): Budget {
    return this.state.budget;
  }

  setBudget(patch: Partial<Budget>): Budget {
    const b = { ...this.state.budget };
    const limit = (v: unknown) => (v === null ? null : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
    for (const k of ['dailyUsd', 'monthlyUsd', 'dailyTokens'] as const) {
      if (k in patch) {
        const v = limit(patch[k]);
        if (v !== undefined) b[k] = v;
      }
    }
    if (patch.mode === 'warn' || patch.mode === 'stop') b.mode = patch.mode;
    if (typeof patch.warnAt === 'number' && patch.warnAt > 0 && patch.warnAt <= 1) b.warnAt = patch.warnAt;
    this.state.budget = b;
    this.saveState();
    return b;
  }

  /** Start counting again: today's totals, this month's, or forget every call. */
  reset(scope: 'today' | 'month' | 'all', now = Date.now()): void {
    if (scope === 'all') {
      for (const f of fs.readdirSync(this.dir)) if (f.endsWith('.jsonl')) fs.rmSync(path.join(this.dir, f), { force: true });
      this.months.clear();
      this.state.resetToday = null;
      this.state.resetMonth = null;
    } else if (scope === 'today') {
      this.state.resetToday = now;
    } else {
      this.state.resetMonth = now;
      this.state.resetToday = now;
    }
    this.saveState();
  }

  /** Where today's and this month's counts start: the period's start, or just after a reset. */
  private since(now: number): { day: number; month: number } {
    const day = Math.max(startOfDay(now), (this.state.resetToday ?? -1) + 1);
    const month = Math.max(startOfMonth(now), (this.state.resetMonth ?? -1) + 1);
    return { day: Math.max(day, month), month };
  }

  totals(now = Date.now()): { today: UsageTotals; month: UsageTotals } {
    const { day, month } = this.since(now);
    const today = empty();
    const all = empty();
    for (const e of this.month(monthKey(now))) {
      if (e.t >= month) add(all, e);
      if (e.t >= day) add(today, e);
    }
    return { today, month: all };
  }

  /** Where spending stands against the budget, optionally with one more call of `extraUsd` on top. */
  status(now = Date.now(), extraUsd = 0, extraTokens = 0): BudgetStatus {
    const b = this.state.budget;
    const { today, month } = this.totals(now);
    const parts: { used: number; text: string }[] = [];
    if (b.dailyUsd) parts.push({ used: (today.usd + extraUsd) / b.dailyUsd, text: `${money(today.usd)} of your ${money(b.dailyUsd)} daily budget` });
    if (b.monthlyUsd) parts.push({ used: (month.usd + extraUsd) / b.monthlyUsd, text: `${money(month.usd)} of your ${money(b.monthlyUsd)} monthly budget` });
    if (b.dailyTokens) parts.push({ used: (tokensOf(today) + extraTokens) / b.dailyTokens, text: `${compact(tokensOf(today))} of your ${compact(b.dailyTokens)} daily tokens` });
    if (!parts.length) return { level: 'ok', message: null, used: 0 };
    const worst = parts.reduce((a, c) => (c.used > a.used ? c : a));
    if (worst.used >= 1) return { level: 'over', used: worst.used, message: `Used ${worst.text}.` };
    if (worst.used >= b.warnAt) return { level: 'warn', used: worst.used, message: `Used ${worst.text}.` };
    return { level: 'ok', used: worst.used, message: null };
  }

  /** Whether a call may go ahead. In "stop" mode, not once a limit is reached. */
  allow(now = Date.now()): { ok: boolean; status: BudgetStatus } {
    const status = this.status(now);
    return { ok: !(status.level === 'over' && this.state.budget.mode === 'stop'), status };
  }

  summary(now = Date.now(), appNames: Record<string, string> = {}): UsageSummary {
    const { today, month } = this.totals(now);
    const { month: from } = this.since(now);
    const entries = this.month(monthKey(now)).filter((e) => e.t >= from);

    const group = (keyOf: (e: UsageEntry) => string, labelOf: (k: string, e: UsageEntry) => string): UsageRow[] => {
      const rows = new Map<string, UsageRow>();
      for (const e of entries) {
        const k = keyOf(e);
        let r = rows.get(k);
        if (!r) rows.set(k, (r = { key: k, label: labelOf(k, e), ...empty() }));
        add(r, e);
      }
      return [...rows.values()].sort((a, b) => b.usd + b.planUsd - (a.usd + a.planUsd) || tokensOf(b) - tokensOf(a));
    };

    // The last 30 days, from the files of this month and the one before.
    const days: { date: string; usd: number; tokens: number }[] = [];
    const byDay = new Map<string, { usd: number; tokens: number }>();
    const prev = new Date(startOfMonth(now));
    prev.setMonth(prev.getMonth() - 1);
    for (const key of [monthKey(prev.getTime()), monthKey(now)]) {
      for (const e of this.month(key)) {
        const d = dayKey(e.t);
        const v = byDay.get(d) ?? { usd: 0, tokens: 0 };
        if (!e.plan && e.usd) v.usd += e.usd;
        v.tokens += tokensOf(e);
        byDay.set(d, v);
      }
    }
    for (let i = 29; i >= 0; i--) {
      const d = dayKey(startOfDay(now) - i * 86_400_000 + 3_600_000);
      days.push({ date: d, ...(byDay.get(d) ?? { usd: 0, tokens: 0 }) });
    }

    return {
      today,
      month,
      days,
      byModel: group((e) => `${e.connection}:${e.model}`, (_k, e) => e.model),
      byFeature: group((e) => e.feature, (k) => FEATURES[k] ?? k),
      byApp: group((e) => e.app ?? '-', (k, e) => appNames[k] ?? e.appName ?? (k === '-' ? 'No app' : k)),
      resetAt: { today: this.state.resetToday, month: this.state.resetMonth },
      budget: this.state.budget,
      status: this.status(now),
      savedUsd: entries.reduce((s, e) => s + (e.saved ?? 0), 0),
    };
  }
}
