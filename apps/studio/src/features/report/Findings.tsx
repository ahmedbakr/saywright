import { Bug, ChevronDown, CircleCheck, CircleHelp, CircleX, Code2, Eye, EyeOff, FlaskConical, Play, Quote, RotateCcw, Sparkles, Wand2 } from 'lucide-react';
import { useState } from 'react';
import type { ReportFinding, SessionAnalysis, Severity, TimelineItem, TranscriptSegment, Verdict, VerifyResult } from '@shared/session';
import { Button } from '@/components/ui/button';
import { evidenceItems } from '@/core/evidence';
import { cn } from '@/lib/cn';
import type { ReportLang, Strings } from './i18n';
import { useAiName } from '@/lib/ai-name';

export const SEVERITY_STYLE: Record<Severity, { bar: string; chip: string }> = {
  critical: { bar: 'bg-bad', chip: 'bg-bad text-inverse' },
  high: { bar: 'bg-[#f76b15]', chip: 'bg-[#f76b15]/15 text-[#a94405] dark:text-[#ff8a3d]' },
  medium: { bar: 'bg-warn/70', chip: 'bg-warn-soft text-warn' },
  low: { bar: 'bg-fg-3/50', chip: 'bg-active text-fg-2' },
};

/** After a replay: fixed, still happening, or not something a replay can tell. */
export const VERDICT_STYLE: Record<Verdict, { chip: string; bar: string; icon: typeof CircleCheck }> = {
  fixed: { chip: 'bg-ok-soft text-ok', bar: 'bg-ok', icon: CircleCheck },
  still: { chip: 'bg-bad-soft text-bad', bar: 'bg-bad', icon: CircleX },
  unknown: { chip: 'bg-active text-fg-2', bar: 'bg-fg-3/40', icon: CircleHelp },
};

function VerdictChip({ r, t, lang }: { r: VerifyResult; t: Strings; lang: ReportLang }) {
  const st = VERDICT_STYLE[r.verdict];
  const Icon = st.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-[5px] px-1.5 py-px text-[10.5px] font-semibold', st.chip)} title={lang === 'ar' ? r.whyAr : r.why} data-verdict={r.verdict}>
      <Icon className="size-3" />
      {t.verdicts[r.verdict]}
    </span>
  );
}

export interface FindingActions {
  show: (t: number) => void;
  play: (seg: TranscriptSegment) => void;
  fix: (f: ReportFinding) => void;
  /** Every finding not set aside, in one request. */
  fixAll: (fs: ReportFinding[]) => void;
  test: (f: ReportFinding) => void;
  skip: (f: ReportFinding) => void;
  restore: (f: ReportFinding) => void;
  shotUrl: (name: string) => string;
  zoom: (name: string) => void;
}

function pictureFor(f: ReportFinding, a: SessionAnalysis, items: TimelineItem[]): string | null {
  const direct = items.find((x) => x.shot)?.shot;
  if (direct) return direct;
  const issue = a.issues.find((g) => f.evidence.includes(g.id) || g.evidence.some((e) => f.evidence.includes(e)));
  if (issue?.shot) return issue.shot;
  const t = items[0]?.t;
  if (t == null || !a.shots.length) return null;
  let best = a.shots[0];
  for (const s of a.shots) if (Math.abs(s.t - t - 500) < Math.abs(best.t - t - 500)) best = s;
  return Math.abs(best.t - t) < 10_000 ? best.name : null;
}

function quoteSegment(f: ReportFinding, a: SessionAnalysis, items: TimelineItem[]): TranscriptSegment | null {
  const sItem = items.find((x) => x.kind === 'speech');
  const norm = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
  if (f.quote) {
    const q = norm(f.quote).slice(0, 40);
    const hit = a.transcript.find((s) => norm(s.text).includes(q) || q.includes(norm(s.text).slice(0, 30)));
    if (hit) return hit;
  }
  if (sItem) return a.transcript.find((s) => s.start === sItem.t) ?? null;
  return null;
}

/** A finding's text can carry a stack trace: the words, and the frames apart. */
function splitStack(text: string): { prose: string; frames: string[] } {
  const lines = text.split('\n');
  const isFrame = (l: string) => /^\s*at\s/.test(l);
  return { prose: lines.filter((l) => !isFrame(l)).join(' ').trim(), frames: lines.filter(isFrame).map((l) => l.trim()) };
}

function What({ text }: { text: string }) {
  const { prose, frames } = splitStack(text);
  return (
    <>
      {prose && <p className="text-fg">{prose}</p>}
      {frames.length > 0 && (
        <pre tabIndex={0} role="region" aria-label="Stack trace" className="overflow-x-auto rounded-[8px] bg-sunken px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg-2 ring-1 ring-inset ring-line" dir="ltr">
          {frames.join('\n')}
        </pre>
      )}
    </>
  );
}

function FindingCard({ f, a, t, act, index, start, verdict, lang }: { f: ReportFinding; a: SessionAnalysis; t: Strings; act: FindingActions; index: number; start: number; verdict?: VerifyResult; lang: ReportLang }) {
  const [open, setOpen] = useState(index < 3);
  const ai = useAiName();
  const items = evidenceItems(f, a);
  const shot = pictureFor(f, a, items);
  const seg = quoteSegment(f, a, items);
  const at = items[0]?.t;
  const sev = SEVERITY_STYLE[f.severity];
  return (
    <article className="group relative overflow-hidden rounded-[14px] bg-raised ring-1 ring-inset ring-line transition-shadow hover:ring-line-strong" data-finding={f.id} data-verdict={verdict?.verdict}>
      <span className={cn('absolute inset-y-0 start-0 w-[3px]', sev.bar)} />
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 px-4 pb-3 pt-3.5 text-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {verdict && <VerdictChip r={verdict} t={t} lang={lang} />}
            <span className={cn('rounded-[5px] px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-[0.04em]', sev.chip)}>{t.severity[f.severity]}</span>
            <span className="rounded-[5px] px-1.5 py-px text-[10.5px] font-medium text-fg-3 ring-1 ring-inset ring-line">{t.category[f.category]}</span>
            {at != null && <span className="tabular text-[11px] text-fg-3">{fmtClock(at - start)}</span>}
            {f.confidence !== 'high' && (
              <span className="text-[11px] text-fg-3">
                · {t.confidence(f.confidence)}
              </span>
            )}
          </div>
          <h3 className="mt-1.5 text-[14.5px] font-semibold leading-snug tracking-[-0.01em] text-fg">{f.title}</h3>
          {!open && <p className="mt-1 line-clamp-1 text-[12.5px] text-fg-3">{splitStack(f.what).prose}</p>}
        </div>
        {shot && !open && <img src={act.shotUrl(shot)} alt="" className="h-12 w-20 shrink-0 rounded-[6px] object-cover object-top ring-1 ring-line" loading="lazy" />}
        <ChevronDown className={cn('mt-1 size-4 shrink-0 text-fg-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="grid gap-4 px-4 pb-4 md:grid-cols-[1fr_auto]">
          <div className="min-w-0 space-y-3 text-[13px] leading-relaxed text-fg-2">
            {verdict && (
              <p className={cn('rounded-[8px] px-2.5 py-1.5 text-[12.5px]', VERDICT_STYLE[verdict.verdict].chip)} data-verdict-why>
                <span className="font-semibold">{t.verdicts[verdict.verdict]}: </span>
                {lang === 'ar' ? verdict.whyAr : verdict.why}
              </p>
            )}
            <What text={f.what} />
            {f.quote && (
              <figure className="flex items-start gap-2 rounded-[10px] bg-human-soft px-3 py-2">
                <Quote className="mt-0.5 size-3.5 shrink-0 text-human-fg" />
                <blockquote dir="auto" className="min-w-0 flex-1 text-[13px] font-medium text-fg">
                  {f.quote}
                </blockquote>
                {seg && (
                  <button title={t.play} onClick={() => act.play(seg)} className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-human text-[#1b1203] hover:brightness-105">
                    <Play className="size-3 fill-current" />
                  </button>
                )}
              </figure>
            )}
            {f.expected && (
              <p>
                <span className="font-medium text-fg">{t.expected}: </span>
                {f.expected}
              </p>
            )}
            <div className="rounded-[10px] bg-ai-soft/60 px-3 py-2 ring-1 ring-inset ring-ai-line/25">
              <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-semibold text-ai-fg">
                <Wand2 className="size-3.5" />
                {t.howToFix}
              </div>
              <p className="text-fg">{f.fix}</p>
              {f.location && (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-[6px] bg-raised px-2 py-0.5 font-mono text-[11.5px] text-fg-2 ring-1 ring-inset ring-line" dir="ltr" title={t.where}>
                  <Code2 className="size-3" />
                  {f.location}
                </div>
              )}
              {f.shown && f.shown !== f.location && (
                <p className="mt-1.5 text-[11.5px] text-fg-3" data-shown>
                  {t.shownAt}:{' '}
                  <span className="font-mono" dir="ltr">
                    {f.shown}
                  </span>
                </p>
              )}
            </div>
            {f.steps.length > 0 && (
              <details className="group/steps">
                <summary className="cursor-default list-none text-[12px] font-medium text-fg-3 hover:text-fg-2">
                  <ChevronDown className="me-1 inline size-3 transition-transform group-open/steps:rotate-180" />
                  {t.steps} ({f.steps.length})
                </summary>
                <ol className="mt-1.5 list-decimal space-y-0.5 ps-6 text-[12.5px]">
                  {f.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </details>
            )}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <Button size="sm" variant="ai" icon={<Sparkles />} onClick={() => act.fix(f)}>
                {t.fixWith(ai)}
              </Button>
              <Button size="sm" icon={<FlaskConical />} onClick={() => act.test(f)}>
                {t.createTest}
              </Button>
              {at != null && (
                <Button size="sm" variant="ghost" icon={<Eye />} onClick={() => act.show(at)}>
                  {t.showMoment}
                </Button>
              )}
              <Button size="sm" variant="ghost" icon={<EyeOff />} onClick={() => act.skip(f)} data-skip>
                {t.skip}
              </Button>
              {f.evidence.length > 0 && (
                <span className="ms-auto text-[11px] text-fg-3" dir="ltr">
                  {t.evidence}: {f.evidence.slice(0, 6).join(' ')}
                </span>
              )}
            </div>
          </div>
          {shot && (
            <button onClick={() => act.zoom(shot)} className="block self-start overflow-hidden rounded-[10px] ring-1 ring-line transition hover:ring-line-strong md:w-[260px]">
              <img src={act.shotUrl(shot)} alt="Screenshot at this moment" className="w-full object-cover object-top" loading="lazy" />
            </button>
          )}
        </div>
      )}
    </article>
  );
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function Findings({
  findings: all,
  skipped,
  analysis,
  t,
  act,
  start,
  verdicts,
  lang,
}: {
  findings: ReportFinding[];
  skipped: Set<string>;
  analysis: SessionAnalysis;
  t: Strings;
  act: FindingActions;
  start: number;
  /** From the last replay, by finding id. */
  verdicts: Record<string, VerifyResult> | null;
  lang: ReportLang;
}) {
  const [filter, setFilter] = useState<Severity | 'all'>('all');
  const [showSkipped, setShowSkipped] = useState(false);
  const ai = useAiName();
  // Set aside by the tester: out of the counts and of “Fix all”, listed at the end.
  const findings = all.filter((f) => !skipped.has(f.id));
  const aside = all.filter((f) => skipped.has(f.id));
  const counts = findings.reduce<Record<string, number>>((m, f) => ((m[f.severity] = (m[f.severity] ?? 0) + 1), m), {});
  const shown = filter === 'all' ? findings : findings.filter((f) => f.severity === filter);
  // Once a replay has shown some are fixed, "Fix all" is about the rest.
  const toFix = verdicts ? findings.filter((f) => verdicts[f.id]?.verdict !== 'fixed') : findings;
  return (
    <section className="space-y-3" data-findings>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-fg">
          <Bug className="size-4 text-fg-3" />
          {t.findings}
          <span className="tabular text-fg-3">{findings.length}</span>
        </h2>
        {toFix.length > 1 && (
          <Button size="sm" variant="ai" icon={<Sparkles />} onClick={() => act.fixAll(toFix)} title={t.fixAllHint} data-fix-all>
            {t.fixAll(toFix.length, ai)}
          </Button>
        )}
        <div className="ms-auto flex flex-wrap gap-1">
          {(['all', 'critical', 'high', 'medium', 'low'] as const).map((k) =>
            k === 'all' || counts[k] ? (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={cn('h-6 rounded-full px-2.5 text-[11.5px] font-medium ring-1 ring-inset ring-line', filter === k ? 'bg-fg text-inverse ring-fg' : 'text-fg-2 hover:bg-hover')}
              >
                {k === 'all' ? t.all : t.severity[k]} {k !== 'all' && <span className="tabular opacity-70">{counts[k]}</span>}
              </button>
            ) : null,
          )}
        </div>
      </div>
      {!findings.length && <p className="rounded-[14px] bg-ok-soft px-4 py-3 text-[13px] text-ok">{t.noFindings}</p>}
      <div className="space-y-2.5">
        {shown.map((f, i) => (
          <FindingCard key={f.id} f={f} a={analysis} t={t} act={act} index={i} start={start} verdict={verdicts?.[f.id]} lang={lang} />
        ))}
      </div>
      {aside.length > 0 && (
        <div className="rounded-[14px] ring-1 ring-inset ring-line" data-skipped>
          <button onClick={() => setShowSkipped(!showSkipped)} className="flex w-full items-center gap-2 px-4 py-2.5 text-start text-[12.5px] font-medium text-fg-3 hover:text-fg-2">
            <EyeOff className="size-3.5" />
            {t.skippedTitle(aside.length)}
            <ChevronDown className={cn('ms-auto size-3.5 transition-transform', showSkipped && 'rotate-180')} />
          </button>
          {showSkipped && (
            <div className="space-y-1 border-t border-line px-2 py-2">
              <p className="px-2 pb-1 text-[11.5px] text-fg-3">{t.skippedHint}</p>
              {aside.map((f) => (
                <div key={f.id} className="flex items-center gap-2 rounded-[8px] px-2 py-1.5 hover:bg-hover">
                  <span className={cn('rounded-[5px] px-1.5 py-px text-[10px] font-semibold uppercase', SEVERITY_STYLE[f.severity].chip)}>{t.severity[f.severity]}</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3 line-through decoration-fg-3/40">{f.title}</span>
                  <Button size="xs" variant="ghost" icon={<RotateCcw />} onClick={() => act.restore(f)}>
                    {t.restore}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
