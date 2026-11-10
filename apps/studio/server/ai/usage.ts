/**
 * Every model call the studio makes, written down: which app and feature it
 * was for, the model, the tokens (cache reads and writes apart) and what it
 * cost at list price. A subscription's calls are counted too (tokens, and what
 * they would have cost through the API) but bill no dollars. Totals for today
 * and this month feed the budget: a warning near a limit, and, when the person
 * chose it, a stop at the limit until they raise it or reset the count.
 *
 * A stop is a hard limit: before a call is sent, the most it can cost is held
 * against the budget (see `hold`), so no call, and no calls made at the same
 * time, can together go past it. What a call sends is an estimate made before
 * it goes (a generous one, raised for a model seen to send more): when a
 * provider counts more, the limit can be passed by that much, and then nothing
 * more is sent.
 *
 * One JSON line per call, a file per month, in the studio's data folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_BUDGET, FEATURES, type Budget, type BudgetStatus, type Price, type ProviderKind, type Usage, type UsageRow, type UsageSummary, type UsageTotals } from '../../shared/ai.ts';
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
  /** The tokens are the studio's estimate: the provider didn't say (no usage sent, or the call was stopped or failed). */
  estimate?: boolean;
}

/** What a call may be charged, before it is sent. */
export interface CallSize {
  /** The tokens it sends, about (counted generously). */
  input: number;
  /** The most it may answer. */
  maxTokens: number;
  /** The least room to answer it is still worth sending for: with less left in the budget it is refused, not cut short. */
  minTokens: number;
  /** Its model's price, when known. */
  price?: Price | null;
  /** Paid in dollars (an API key). A plan's calls and a local model's are counted in tokens only. */
  billed: boolean;
}

/** A call's most possible cost, held against the budget until it is recorded or fails. */
export interface Hold {
  /** The room it may answer in: as asked, or less when the budget has less left. */
  maxTokens: number;
  usd: number;
  tokens: number;
}

interface Limit {
  dollars: boolean;
  /** What is left of it, after what was spent and what calls still running hold. */
  left: number;
  spent: number;
  limit: number;
  name: string;
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
/** How much of a limit is used: past it at once when the limit is zero and anything at all is used. */
const share = (used: number, limit: number) => (limit > 0 ? used / limit : used > 0 ? Infinity : 0);

/** A model's dearest rates per token for a call that sends `input` tokens: all of it as if written to the cache. */
function dearest(price: Price | null | undefined, input: number): { input: number; output: number } | null {
  if (!price) return null;
  const p = price.long && price.longAbove !== undefined && input > price.longAbove ? price.long : price;
  const r = { input: Math.max(p.input, p.cacheWrite ?? p.input) / 1e6, output: p.output / 1e6 };
  // A rate that isn't a real amount is no price at all: the call is held as one whose price isn't known.
  return Number.isFinite(r.input) && Number.isFinite(r.output) && r.input >= 0 && r.output >= 0 ? r : null;
}

/** A count read back from the ledger, which may have been edited by hand: a finite, non-negative number, or 0. */
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** The budget as read from its file, each value checked with the rules `setBudget` applies. */
function validBudget(raw: unknown): Budget {
  const b: Budget = { ...DEFAULT_BUDGET };
  if (!raw || typeof raw !== 'object') return b;
  const r = raw as Record<string, unknown>;
  for (const k of ['dailyUsd', 'monthlyUsd', 'dailyTokens'] as const) {
    if (!(k in r)) continue;
    const v = r[k];
    if (v === null) b[k] = null;
    else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) b[k] = v;
  }
  if (r.mode === 'warn' || r.mode === 'stop') b.mode = r.mode;
  if (typeof r.warnAt === 'number' && r.warnAt > 0 && r.warnAt <= 1) b.warnAt = r.warnAt;
  return b;
}

/** Why a call is refused: a limit used up, or one with too little left for it. */
function refusal(l: Limit, need: number | null, held: boolean): string {
  const amount = (n: number) => (l.dollars ? money(Math.max(0, n)) : compact(Math.max(0, Math.round(n))));
  const of = `your ${amount(l.limit)} ${l.name}`;
  if (l.limit <= 0) return l.dollars ? `Your ${l.name} is $0.00, so no paid AI requests are made.` : `Your ${l.name} is 0, so no AI requests are made.`;
  if (need === null || (l.left <= 0 && !held)) return `Used ${amount(l.spent)} of ${of}${held && l.spent < l.limit ? ', and requests running now may take the rest' : ''}.`;
  // Two amounts that read the same once rounded (“up to $0.01, and $0.01 … is left”) are written closely enough to differ.
  let most = l.dollars ? money(need) : compact(Math.round(need));
  let left = amount(l.left);
  if (most === left) {
    const exact = (n: number) => (l.dollars ? `$${Math.max(0, n).toFixed(4)}` : Math.max(0, Math.round(n)).toLocaleString('en-US'));
    most = exact(need);
    left = exact(l.left);
  }
  return `This could ${l.dollars ? `cost up to ${most}` : `use up to ${most} tokens`}, and ${left} of ${of} is left${held ? ' while other requests are running' : ''}.`;
}

export class UsageLedger {
  private state: State;
  /** Entries by month ("2026-10"), loaded on first use. */
  private months = new Map<string, UsageEntry[]>();
  /** What calls being made right now hold against the budget. */
  private holds = new Set<Hold>();

  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.state = this.loadState();
  }

  private get stateFile() {
    return path.join(this.dir, 'state.json');
  }

  /** Said in Usage and budget when the budget file was damaged and what it held may be lost. */
  private notice: string | null = null;

  private loadState(): State {
    let text = '';
    try {
      text = fs.readFileSync(this.stateFile, 'utf8');
    } catch {
      /* no budget saved yet */
    }
    let damaged = false;
    try {
      if (text) JSON.parse(text);
    } catch {
      damaged = true;
    }
    const raw = readJson<Partial<State>>(this.stateFile);
    const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const state: State = { budget: validBudget(raw && typeof raw === 'object' ? raw.budget : undefined), resetToday: time(raw?.resetToday), resetMonth: time(raw?.resetMonth) };
    if (damaged) {
      // What the damaged file still shows is kept where it is the safer choice: a stop, and a lower limit. A budget
      // set to stop must not quietly become a warning because its file was cut short.
      if (/"mode"\s*:\s*"stop"/.test(text)) state.budget.mode = 'stop';
      for (const k of ['dailyUsd', 'monthlyUsd', 'dailyTokens'] as const) {
        const m = new RegExp(`"${k}"\\s*:\\s*(\\d+(?:\\.\\d+)?)`).exec(text);
        const v = m ? Number(m[1]) : NaN;
        if (Number.isFinite(v) && (state.budget[k] == null || v < state.budget[k]!)) state.budget[k] = v;
      }
      this.notice = `The budget file was damaged, so its last good copy${raw ? '' : ' (none was found, so the defaults)'} is used${state.budget.mode === 'stop' ? ', still set to stop' : ''}. Check the limits below and save them again.`;
    }
    return state;
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
            const e = JSON.parse(line) as UsageEntry;
            if (!e || typeof e !== 'object' || typeof e.t !== 'number') continue;
            for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) e[k] = num(e[k]);
            if (e.usd != null) e.usd = num(e.usd);
            list.push(e);
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
    const file = path.join(this.dir, `${key}.jsonl`);
    // A line cut short by a crash would swallow this one too: it starts on a line of its own.
    let after = '';
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const last = Buffer.alloc(1);
        if (size > 0 && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) after = '\n';
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* a new file */
    }
    fs.appendFileSync(file, after + JSON.stringify(e) + '\n');
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
    this.notice = null;
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
    // A limit of zero is a limit: nothing may be spent.
    if (b.dailyUsd != null) parts.push({ used: share(today.usd + extraUsd, b.dailyUsd), text: `${money(today.usd)} of your ${money(b.dailyUsd)} daily budget` });
    if (b.monthlyUsd != null) parts.push({ used: share(month.usd + extraUsd, b.monthlyUsd), text: `${money(month.usd)} of your ${money(b.monthlyUsd)} monthly budget` });
    if (b.dailyTokens != null) parts.push({ used: share(tokensOf(today) + extraTokens, b.dailyTokens), text: `${compact(tokensOf(today))} of your ${compact(b.dailyTokens)} daily tokens` });
    if (!parts.length) return { level: 'ok', message: null, used: 0 };
    const worst = parts.reduce((a, c) => (c.used > a.used ? c : a));
    if (worst.used >= 1) return { level: 'over', used: worst.used, message: `Used ${worst.text}.` };
    if (worst.used >= b.warnAt) return { level: 'warn', used: worst.used, message: `Used ${worst.text}.` };
    return { level: 'ok', used: worst.used, message: null };
  }

  /** The limits a call is held to in "stop" mode: dollars when it is paid in dollars, tokens always. */
  private limits(now: number, billed: boolean): Limit[] {
    const b = this.state.budget;
    const { today, month } = this.totals(now);
    let usd = 0;
    let tokens = 0;
    for (const h of this.holds) {
      usd += h.usd;
      tokens += h.tokens;
    }
    const out: Limit[] = [];
    if (billed && b.dailyUsd != null) out.push({ dollars: true, left: b.dailyUsd - today.usd - usd, spent: today.usd, limit: b.dailyUsd, name: 'daily budget' });
    if (billed && b.monthlyUsd != null) out.push({ dollars: true, left: b.monthlyUsd - month.usd - usd, spent: month.usd, limit: b.monthlyUsd, name: 'monthly budget' });
    if (b.dailyTokens != null) out.push({ dollars: false, left: b.dailyTokens - tokensOf(today) - tokens, spent: tokensOf(today), limit: b.dailyTokens, name: 'daily tokens' });
    return out;
  }

  /** Whether a call is held to a hard limit: the budget is set to stop, and a limit applies to it. */
  bounded(billed: boolean, now = Date.now()): boolean {
    return this.state.budget.mode === 'stop' && this.limits(now, billed).length > 0;
  }

  /**
   * Whether a call whose size isn't known (a subscription app's run) may start. In "stop" mode, not once a limit
   * it is held to is used up (`billed`: it is paid in dollars, so the dollar limits count too).
   */
  allow(now = Date.now(), billed = true): { ok: boolean; status: BudgetStatus } {
    const status = this.status(now);
    if (this.state.budget.mode !== 'stop') return { ok: true, status };
    const out = this.limits(now, billed).find((l) => l.left <= 0);
    return out ? { ok: false, status: { ...status, level: 'over', message: refusal(out, null, this.holds.size > 0) } } : { ok: true, status };
  }

  /**
   * Before a call is sent, in "stop" mode: the most it can cost (what it sends, at the dearest rate it may be billed
   * at, and the most it may answer) is held against every limit it is held to until it is recorded or fails, so
   * calls made at the same time count each other and can't together go past a limit. Its room to answer is cut to
   * what the budget has left, but not below `minTokens`: then it is refused, with why. In "warn" mode it goes ahead
   * as asked. Let the hold go with `release` once what the call used is recorded.
   */
  hold(call: CallSize, now = Date.now()): Hold | { refused: string } {
    const asked: Hold = { maxTokens: call.maxTokens, usd: 0, tokens: 0 };
    if (this.state.budget.mode !== 'stop') return asked;
    const rate = call.billed ? dearest(call.price, call.input) : { input: 0, output: 0 };
    const sent = rate ? call.input * rate.input : 0;
    let room = call.maxTokens;
    let short: Limit | null = null;
    for (const l of this.limits(now, call.billed)) {
      // The room this limit leaves to answer in, after what the call sends. A call whose price isn't known can't be
      // measured in dollars: it may go only while the limit isn't used up.
      const fits = !l.dollars ? l.left - call.input : !rate ? (l.left > 0 ? Infinity : -1) : rate.output > 0 ? Math.floor((l.left - sent) / rate.output) : l.left >= sent ? Infinity : -1;
      if (fits < room) {
        room = fits;
        short = l;
      }
    }
    const least = Math.min(call.minTokens, call.maxTokens);
    // What it needs at least: unknown in dollars when its price is.
    const need = !short?.dollars ? call.input + least : rate ? sent + least * rate.output : null;
    if (short && room < least) return { refused: refusal(short, need, this.holds.size > 0) };
    const hold: Hold = { maxTokens: room, usd: sent + room * (rate?.output ?? 0), tokens: call.input + room };
    this.holds.add(hold);
    return hold;
  }

  release(hold: Hold): void {
    this.holds.delete(hold);
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
      savedUsd: entries.reduce((s, e) => s + num(e.saved), 0),
      estimated: entries.filter((e) => e.estimate).length,
      ...(this.notice ? { notice: this.notice } : {}),
    };
  }
}
