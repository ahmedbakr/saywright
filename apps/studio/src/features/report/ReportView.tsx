/**
 * A test session's report: verdict and scores, findings with the tester's own
 * words and screenshots, suggestions, and every moment on a timeline that
 * plays back the screen and the narration.
 */
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, Check, ClipboardCopy, Download, FileAudio, Languages, Lightbulb, ListChecks, ListRestart, MoreHorizontal, Plus, RefreshCw, ScanSearch, Sparkles, ThumbsUp, Trash2, X } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import { fmtDuration, nothingToJudge, type ReportSuggestion, type SessionDetail, type SessionReport, type TimelineItem, type TranscriptSegment } from '@shared/session';
import { Button, IconButton } from '@/components/ui/button';
import { confirmAction } from '@/components/ui/confirm';
import { useModal } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/misc';
import { controller } from '@/core/controller';
import { evidenceItems } from '@/core/evidence';
import { sessions, useSessions } from '@/core/sessions';
import { useSettings } from '@/core/settings';
import { useStudio } from '@/core/store';
import { cn } from '@/lib/cn';
import { shortUrl } from '@/lib/format';
import { Details } from './Details';
import { Findings, fmtClock, type FindingActions } from './Findings';
import { STRINGS, type Strings } from './i18n';
import { Media, type MediaHandle } from './Media';
import { Scores } from './Scores';
import { Timeline } from './Timeline';
import { Transcript } from './Transcript';
import { Verification } from './Verification';
import { toMarkdown } from './markdown';
import { modelName, useAiName } from '@/lib/ai-name';

export function ReportView() {
  const open = useSessions((s) => s.open);
  const detail = useSessions((s) => s.detail);
  const error = useSessions((s) => s.detailError);
  // A real modal over the studio: Escape goes back (a zoomed picture keeps it).
  const layer = useModal(!!open, { onEscape: () => !document.querySelector('[data-lightbox]') && sessions.closeReport() });
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="report"
          ref={layer}
          tabIndex={-1}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-40 flex flex-col bg-bg outline-none"
          role="dialog"
          aria-modal="true"
          aria-label="Session report"
        >
          {detail && detail.meta.id === open ? <Report detail={detail} /> : <Loading error={error} />}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Loading({ error }: { error: string | null }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[13px] text-fg-3">
      {error ? <span className="text-bad">{error}</span> : <Spinner />}
      <Button size="sm" onClick={() => sessions.closeReport()}>
        Back to the studio
      </Button>
    </div>
  );
}

/** The report in the language chosen: the one it was written in, or its translation once there is one. */
function shown(detail: SessionDetail, pref: 'en' | 'ar' | null): SessionReport | null {
  const main = detail.report;
  if (!main) return null;
  const want = pref ?? main.lang;
  return want === main.lang ? main : (detail.translation ?? main);
}

function Report({ detail }: { detail: SessionDetail }) {
  const { meta, analysis, decisions } = detail;
  const pref = useSessions((s) => s.reportLang);
  const report = shown(detail, pref);
  const lang = report?.lang ?? 'en';
  const t: Strings = STRINGS[lang];
  const [current, setCurrent] = useState<number | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [side, setSide] = useState<'timeline' | 'transcript'>('timeline');
  const media = useRef<MediaHandle>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const start = meta.startedAt;
  const busy = meta.status === 'processing' || meta.status === 'recording';
  const replay = useReplay(detail);

  const show = (time: number) => {
    setCurrent(time);
    media.current?.seek(time);
  };
  const play = (seg: TranscriptSegment) => {
    show(seg.start);
    const a = audio.current;
    if (!a || seg.audioAt == null) return;
    a.currentTime = Math.max(0, seg.audioAt - 0.2);
    void a.play();
    const stopAt = seg.audioAt + (seg.end - seg.start) / 1000 + 0.4;
    const check = () => {
      if (a.currentTime >= stopAt) a.pause();
      else if (!a.paused) requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  };
  const pick = (it: TimelineItem) => {
    if (it.kind === 'speech') {
      const seg = analysis?.transcript.find((s) => s.start === it.t);
      if (seg) return play(seg);
    }
    show(it.t);
  };

  // Findings set aside are kept by their title in the report's own language; ids are the same in both languages.
  const titleOf = (id: string) => detail.report?.findings.find((x) => x.id === id)?.title;
  const skipped = new Set((detail.report?.findings ?? []).filter((f) => decisions.skipped.includes(f.title)).map((f) => f.id));
  const act: FindingActions = {
    show,
    play,
    shotUrl: (name) => `/api/sessions/${meta.id}/shots/${name}`,
    zoom: setZoom,
    fix: (f) => {
      if (!analysis) return;
      sessions.closeReport();
      void controller.fixFromReport(f, evidenceItems(f, analysis), analysis);
    },
    fixAll: (fs) => {
      if (!analysis) return;
      sessions.closeReport();
      void controller.fixFindings(
        fs.map((f) => ({ f, items: evidenceItems(f, analysis) })),
        analysis,
      );
    },
    test: async (f) => {
      if (!analysis) return;
      // A test being written (its steps and checks) is not thrown away without asking.
      const rec = useStudio.getState().recorder;
      if ((rec.steps.length || rec.expectations.length) && !(await confirmAction({ title: 'Replace the test you are writing?', body: `Its ${rec.steps.length} step${rec.steps.length === 1 ? '' : 's'} and ${rec.expectations.length} check${rec.expectations.length === 1 ? '' : 's'} are replaced by this finding's steps.`, action: 'Replace it', danger: true }))) return;
      sessions.closeReport();
      void controller.testFromReport(f, evidenceItems(f, analysis), analysis, meta.appUrl);
    },
    skip: (f) => {
      const title = titleOf(f.id);
      if (title) void sessions.setSkipped(meta.id, [...decisions.skipped, title]);
    },
    restore: (f) => {
      const title = titleOf(f.id);
      void sessions.setSkipped(
        meta.id,
        decisions.skipped.filter((x) => x !== title),
      );
    },
  };

  return (
    <>
      <Header detail={detail} report={report} t={t} replay={replay} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-[1480px] gap-6 px-5 py-6 xl:grid-cols-[minmax(0,1fr)_440px]" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
          <main className="min-w-0 space-y-6">
            <Summary detail={detail} report={report} t={t} busy={busy} open={report ? report.findings.filter((f) => !skipped.has(f.id)).length : 0} />
            {report && <Verification verification={detail.verification} verifying={detail.verifying} findings={report.findings.filter((f) => !skipped.has(f.id))} t={t} lang={lang} canReplay={replay.can} onReplay={replay.run} />}
            {analysis && !nothingToJudge(analysis) && <Scores scores={analysis.scores} previous={detail.previous?.scores ?? null} report={report} t={t} />}
            {report && analysis && <Findings findings={report.findings} skipped={skipped} analysis={analysis} t={t} act={act} start={start} verdicts={detail.verification?.findings ?? null} lang={lang} />}
            {report && <Suggestions report={report} t={t} />}
            {report && <Story report={report} t={t} />}
            {analysis && <Details analysis={analysis} start={start} onPick={show} lang={lang} t={t} />}
          </main>
          <aside className="min-w-0">
            <div className="space-y-3 xl:sticky xl:top-0 xl:flex xl:max-h-[calc(100vh-120px)] xl:flex-col">
              <Media ref={media} id={meta.id} video={meta.video} shots={analysis?.shots ?? []} start={start} current={current} onTime={setCurrent} onZoom={setZoom} lang={lang} />
              {meta.audioSeconds > 0 && (
                <div className="flex items-center gap-2 rounded-[10px] bg-raised px-2.5 py-1.5 ring-1 ring-inset ring-line">
                  <FileAudio className="size-4 shrink-0 text-fg-3" />
                  <audio ref={audio} src={`/api/sessions/${meta.id}/audio.wav`} controls preload="metadata" className="h-8 w-full" />
                </div>
              )}
              {analysis && (
                <div className="flex min-h-[320px] flex-col rounded-[14px] bg-raised pt-2.5 ring-1 ring-inset ring-line xl:min-h-0 xl:flex-1">
                  <div className="flex items-center gap-4 px-3.5 pb-2" role="tablist">
                    <SideTab on={side === 'timeline'} onClick={() => setSide('timeline')}>
                      {t.timeline}
                    </SideTab>
                    <SideTab on={side === 'transcript'} onClick={() => setSide('transcript')}>
                      {t.transcript} <span className="tabular text-fg-3">{analysis.transcript.length}</span>
                    </SideTab>
                    <span className="tabular ms-auto text-[11.5px] text-fg-3">{fmtClock(analysis.durationMs)}</span>
                  </div>
                  {side === 'timeline' ? (
                    <Timeline items={analysis.timeline} omitted={analysis.more?.timeline} start={start} current={current} onPick={pick} lang={lang} t={t} />
                  ) : (
                    <Transcript
                      segments={analysis.transcript}
                      start={start}
                      current={current}
                      t={t}
                      reportAt={detail.report?.at ?? null}
                      onPlay={play}
                      onCorrect={(seg, text) => sessions.correctSentence(meta.id, seg.id, text)}
                      onRewrite={() => void sessions.regenerate(meta.id, true)}
                    />
                  )}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
      <AnimatePresence>
        {zoom && (
          <motion.div data-lightbox initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={() => setZoom(null)}>
            <img src={act.shotUrl(zoom)} alt="" className="max-h-full max-w-full rounded-[10px] shadow-pop" />
            <IconButton className="absolute end-4 top-4 text-white hover:bg-white/10" onClick={() => setZoom(null)} aria-label="Close">
              <X />
            </IconButton>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** Replay & verify: whether this session's steps can be played again now, and doing it. */
function useReplay(detail: SessionDetail): { can: boolean; steps: number; run: () => void } {
  const replaying = useStudio((s) => !!s.replay);
  const steps = detail.analysis?.steps.filter((s) => s.kind !== 'navigate' && s.locator).length ?? 0;
  const can = steps > 0 && detail.meta.status === 'ready' && detail.meta.source !== 'replay' && !detail.verifying && !replaying;
  return { can, steps, run: () => void controller.verifySession(detail) };
}

function SideTab({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      role="tab"
      aria-selected={on}
      onClick={onClick}
      className={cn('relative h-7 text-[13px] font-semibold transition-colors', on ? 'text-fg after:absolute after:inset-x-0 after:-bottom-[1px] after:h-0.5 after:bg-fg' : 'text-fg-3 hover:text-fg-2')}
    >
      {children}
    </button>
  );
}

/** English or Arabic: both are always there, the other one a moment after the report when Claude translates it. */
function LangToggle({ detail, report }: { detail: SessionDetail; report: SessionReport | null }) {
  const main = detail.report;
  if (!main) return null;
  const other = main.lang === 'ar' ? 'en' : 'ar';
  const waiting = !detail.translation && detail.translating;
  return (
    <div className="flex items-center gap-1.5" data-report-lang={report?.lang}>
      <div className="flex rounded-[8px] bg-sunken p-0.5 ring-1 ring-inset ring-line" role="radiogroup" aria-label="Report language">
        {(['en', 'ar'] as const).map((l) => (
          <button
            key={l}
            role="radio"
            aria-checked={report?.lang === l}
            onClick={() => sessions.setReportLang(l)}
            className={cn('h-6 rounded-[6px] px-2 text-[12px] font-medium transition-colors', report?.lang === l ? 'bg-raised text-fg shadow-sm' : 'text-fg-3 hover:text-fg-2')}
          >
            {l === 'en' ? 'English' : 'العربية'}
          </button>
        ))}
      </div>
      {waiting && (
        <span className="flex items-center gap-1 text-[11.5px] text-fg-3">
          <Spinner className="size-3" />
          {/* Isolated, so an Arabic label keeps its ellipsis at its own end. */}
          <bdi lang={other}>{STRINGS[other].translating}</bdi>
        </span>
      )}
      {!detail.translation && !detail.translating && main.source !== 'local' && (
        <Button size="xs" variant="ghost" icon={<Languages />} onClick={() => void sessions.retranslate(detail.meta.id)}>
          <bdi lang={other}>{STRINGS[other].translate}</bdi>
        </Button>
      )}
    </div>
  );
}

function Header({ detail, report, t, replay }: { detail: SessionDetail; report: SessionReport | null; t: Strings; replay: ReturnType<typeof useReplay> }) {
  const { meta } = detail;
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState(meta.name);
  const [editing, setEditing] = useState(false);
  useEffect(() => setName(meta.name), [meta.name]);
  const length = meta.endedAt ? fmtDuration(meta.endedAt - meta.startedAt) : null;
  // Its language, and transcribing it again, only mean something when there is narration.
  const narrated = meta.audioSeconds > 0 || !!detail.analysis?.transcript.length;
  const copy = async () => {
    if (!detail.analysis || !report) return;
    await navigator.clipboard.writeText(toMarkdown({ ...detail, report }));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <header className="flex h-[54px] shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
      <IconButton onClick={() => sessions.closeReport()} aria-label={t.back}>
        <ArrowLeft />
      </IconButton>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (name.trim() && name !== meta.name) void sessions.rename(meta.id, name.trim());
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            className="h-6 w-full max-w-[420px] rounded-[6px] bg-sunken px-1.5 text-[13.5px] font-semibold text-fg outline-none ring-1 ring-ai-line"
          />
        ) : (
          <button onClick={() => setEditing(true)} className="max-w-full truncate text-start text-[13.5px] font-semibold text-fg hover:underline hover:decoration-line-strong">
            {meta.name}
          </button>
        )}
        <div className="flex items-center gap-1.5 truncate text-[11.5px] text-fg-3">
          <span>{new Date(meta.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
          {length && <span>· {length}</span>}
          <span className="truncate font-mono">· {shortUrl(meta.appUrl)}</span>
          {meta.git && (
            <span className="font-mono">
              · {meta.git.branch}@{meta.git.commit}
              {meta.git.dirty ? '*' : ''}
            </span>
          )}
          {narrated && <span>· {meta.lang === 'ar' ? 'العربية' : meta.lang === 'en' ? 'English' : 'Arabic + English'}</span>}
        </div>
      </div>
      <div className="flex items-center gap-1">
        {meta.source !== 'replay' && (
          <Button size="sm" variant="ai" icon={<ListRestart />} disabled={!replay.can} title={replay.steps ? t.verifyHint : t.noSteps} onClick={replay.run} data-verify>
            {t.verify}
          </Button>
        )}
        <span className="mx-1 h-5 w-px bg-line" />
        <LangToggle detail={detail} report={report} />
        <span className="mx-1 h-5 w-px bg-line" />
        <Button size="sm" icon={copied ? <Check /> : <ClipboardCopy />} onClick={() => void copy()} disabled={!report}>
          {copied ? 'Copied' : 'Copy as Markdown'}
        </Button>
        <a
          href={`/api/sessions/${meta.id}/export.html?download=1&lang=${report?.lang ?? ''}`}
          download
          aria-disabled={!report || undefined}
          className={cn(
            'inline-flex h-7 shrink-0 select-none items-center gap-1.5 whitespace-nowrap rounded-[7px] bg-raised px-2.5 text-[12.5px] font-medium text-fg ring-1 ring-inset ring-line-strong transition-colors hover:bg-hover [&_svg]:size-[14px]',
            !report && 'pointer-events-none opacity-45',
          )}
        >
          <Download />
          Export HTML
        </a>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <IconButton aria-label="More">
              <MoreHorizontal />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={6} className="z-[60] min-w-[230px] rounded-[10px] bg-raised p-1 shadow-pop">
              <MenuItem icon={<Sparkles />} onSelect={() => void sessions.regenerate(meta.id, true)}>
                Rewrite the report
              </MenuItem>
              {meta.audioSeconds > 0 && (
                <>
                  <MenuItem icon={<RefreshCw />} onSelect={() => void sessions.retranscribe(meta.id)}>
                    Transcribe the narration again
                  </MenuItem>
                  <DropdownMenu.Sub>
                    <DropdownMenu.SubTrigger className="flex h-8 cursor-default items-center gap-2 rounded-[7px] px-2 text-[12.5px] text-fg outline-none data-[highlighted]:bg-hover [&_svg]:size-[14px] [&_svg]:text-fg-3">
                      <Languages />
                      Transcribe as…
                    </DropdownMenu.SubTrigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.SubContent className="z-[61] min-w-[160px] rounded-[10px] bg-raised p-1 shadow-pop">
                        <MenuItem onSelect={() => void sessions.retranscribe(meta.id, 'en')}>English</MenuItem>
                        <MenuItem onSelect={() => void sessions.retranscribe(meta.id, 'ar')}>العربية</MenuItem>
                        <MenuItem onSelect={() => void sessions.retranscribe(meta.id, 'auto')}>Arabic + English</MenuItem>
                      </DropdownMenu.SubContent>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Sub>
                </>
              )}
              <a href={`/api/sessions/${meta.id}/export.html?lang=${report?.lang ?? ''}`} target="_blank" rel="noreferrer">
                <MenuItem icon={<ListChecks />}>Open the printable report</MenuItem>
              </a>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <MenuItem
                icon={<Trash2 />}
                danger
                onSelect={async () => {
                  if (await confirmAction({ title: 'Delete this session?', body: 'Its recordings, screenshots and report are deleted from this computer.', action: 'Delete session', danger: true })) void sessions.remove(meta.id);
                }}
              >
                Delete session
              </MenuItem>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}

function MenuItem({ icon, children, onSelect, danger }: { icon?: React.ReactNode; children: React.ReactNode; onSelect?: () => void; danger?: boolean }) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn('flex h-8 cursor-default items-center gap-2 rounded-[7px] px-2 text-[12.5px] text-fg outline-none data-[highlighted]:bg-hover [&_svg]:size-[14px] [&_svg]:text-fg-3', danger && 'text-bad [&_svg]:text-bad')}
    >
      {icon}
      {children}
    </DropdownMenu.Item>
  );
}

function Summary({ detail, report, t, busy, open }: { detail: SessionDetail; report: SessionReport | null; t: Strings; busy: boolean; open: number }) {
  const { meta } = detail;
  if (meta.source === 'replay' && meta.replayOf && !busy) {
    const of = meta.replayOf;
    return (
      <section className="flex items-center gap-3 rounded-[16px] bg-raised p-6 ring-1 ring-inset ring-line">
        <ListRestart className="size-5 text-ai" />
        <div className="text-[13.5px] text-fg-2">A replay of another session’s steps, to check its fixes. Its results are in that session’s report.</div>
        <Button size="sm" className="ms-auto" onClick={() => sessions.openReport(of)}>
          Open that report
        </Button>
      </section>
    );
  }
  if (busy || !report) {
    return (
      <section className="rounded-[16px] bg-raised p-6 ring-1 ring-inset ring-line">
        <div className="flex items-center gap-3">
          {meta.status === 'failed' ? <X className="size-5 text-bad" /> : <Spinner className="size-5 text-ai" />}
          <div>
            <div className="text-[15px] font-semibold text-fg">{meta.status === 'failed' ? 'The report couldn’t be finished' : meta.status === 'recording' ? 'Still recording…' : 'Preparing the report'}</div>
            <div className={cn('mt-0.5 text-[12.5px]', meta.status === 'failed' ? 'text-bad' : 'shimmer-text')}>{meta.status === 'failed' ? meta.error : meta.stage || 'Working'}</div>
          </div>
          {meta.status === 'failed' && (
            <Button size="sm" className="ms-auto" icon={<RefreshCw />} onClick={() => void sessions.regenerate(meta.id, true)}>
              Try again
            </Button>
          )}
        </div>
      </section>
    );
  }
  const verdict = { ship: 'bg-ok-soft text-ok', 'fix-first': 'bg-warn-soft text-warn', blocked: 'bg-bad-soft text-bad' }[report.verdict];
  const secs = report.ms ? Math.round(report.ms / 1000) : null;
  // Nothing was tried: no score, no verdict, and no “no problems found”.
  if (nothingToJudge(detail.analysis))
    return (
      <section className="rounded-[16px] bg-raised p-6 ring-1 ring-inset ring-line" data-nothing-to-judge>
        <span className="inline-flex h-6 items-center rounded-full bg-sunken px-2.5 text-[12px] font-semibold text-fg-2" data-verdict-badge>
          {t.nothing}
        </span>
        <h1 className="mt-3 text-[24px] font-semibold leading-tight tracking-[-0.02em] text-fg">{t.nothing}</h1>
        <p className="mt-2 max-w-[78ch] text-[14px] leading-relaxed text-fg-2">{t.nothingWhy}</p>
      </section>
    );
  return (
    <section className="relative overflow-hidden rounded-[16px] bg-raised p-6 ring-1 ring-inset ring-line">
      <div className="pointer-events-none absolute -end-24 -top-24 size-72 rounded-full bg-ai-soft blur-3xl" />
      <div className="relative">
        <span className={cn('inline-flex h-6 items-center rounded-full px-2.5 text-[12px] font-semibold', verdict)} data-verdict-badge>
          {report.verdict === 'ship' && !open ? t.clean : t.verdict[report.verdict]}
        </span>
        <h1 className="mt-3 text-[24px] font-semibold leading-tight tracking-[-0.02em] text-fg">{report.title}</h1>
        <p className="mt-2 max-w-[78ch] text-[14px] leading-relaxed text-fg-2">{report.summary}</p>
        {report.verdict === 'ship' && <Scope detail={detail} t={t} />}
        <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-fg-3">
          {report.source !== 'local' ? <Sparkles className="size-3.5 text-ai" /> : <Lightbulb className="size-3.5" />}
          {report.source !== 'local' ? t.writtenBy(modelName(report.model), secs) : t.writtenLocally}
          {report.translatedFrom && <span>· {t.translatedFrom(report.translatedFrom, report.translatedBy && modelName(report.translatedBy))}</span>}
        </p>
      </div>
    </section>
  );
}

/**
 * What a session without serious problems does and doesn't show: recordings catch errors, failures and friction,
 * never a wrong value. The ways to check those: a check of your own, or Autopilot trying the main flows.
 */
function Scope({ detail, t }: { detail: SessionDetail; t: Strings }) {
  const analysis = detail.analysis;
  const autopilot = () => {
    sessions.closeReport();
    useSettings.getState().setUi({ panelOpen: true, panelTab: 'sessions' });
    setTimeout(() => document.querySelector<HTMLInputElement>('[data-autopilot-goal]')?.focus(), 250);
  };
  return (
    <div className="mt-4 max-w-[78ch] rounded-[12px] bg-sunken px-3.5 py-3 ring-1 ring-inset ring-line" data-scope>
      <p className="text-[12.5px] leading-relaxed text-fg-2">{t.scope}</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {analysis && (
          <Button size="sm" icon={<Plus />} title={t.addCheckHint} onClick={() => (sessions.closeReport(), controller.checkSession(analysis, detail.meta.appUrl))} data-add-check>
            {t.addCheck}
          </Button>
        )}
        {detail.meta.source !== 'autopilot' && (
          <Button size="sm" variant="ghost" icon={<ScanSearch />} onClick={autopilot} data-try-autopilot>
            {t.tryAutopilot}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Suggestions to pick from: tick any, then the AI implements them together. */
function Suggestions({ report, t }: { report: SessionReport; t: Strings }) {
  // By position: the same in both languages.
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const ai = useAiName();
  if (!report.suggestions.length) return null;
  const cols = (['fix', 'improve', 'add'] as const)
    .map((k) => ({ k, items: report.suggestions.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === k) }))
    .filter((c) => c.items.length);
  const toggle = (i: number) => {
    const next = new Set(picked);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setPicked(next);
  };
  const implement = () => {
    const chosen: ReportSuggestion[] = report.suggestions.filter((_, i) => picked.has(i));
    sessions.closeReport();
    void controller.implementSuggestions(chosen, report);
  };
  const all = picked.size === report.suggestions.length;
  return (
    <section className="space-y-3" data-suggestions>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-fg">
          <Lightbulb className="size-4 text-fg-3" />
          {t.suggestions}
        </h2>
        <span className="text-[11.5px] text-fg-3">{t.pickHint(ai)}</span>
        <div className="ms-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setPicked(all ? new Set() : new Set(report.suggestions.map((_, i) => i)))}>
            {all ? t.selectNone : t.selectAll}
          </Button>
          <Button size="sm" variant="ai" icon={<Sparkles />} disabled={!picked.size} onClick={implement} data-implement>
            {t.implementSelected(picked.size)}
          </Button>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {cols.map((c) => (
          <div key={c.k} className="space-y-2">
            <div className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-fg-3">{t[c.k]}</div>
            {c.items.map(({ s, i }) => (
              <label
                key={i}
                className={cn('flex cursor-default gap-2.5 rounded-[12px] bg-raised p-3 ring-1 ring-inset transition-shadow', picked.has(i) ? 'ring-ai-line' : 'ring-line hover:ring-line-strong')}
              >
                <input type="checkbox" checked={picked.has(i)} onChange={() => toggle(i)} className="mt-0.5 size-3.5 shrink-0 accent-[var(--ai)]" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium leading-snug text-fg">{s.title}</span>
                  <span className="mt-1 block text-[12px] leading-relaxed text-fg-3">{s.why}</span>
                  <span className="mt-2 inline-block rounded-[5px] bg-active px-1.5 text-[10.5px] text-fg-2">{t.effortIs(t.effort[s.effort])}</span>
                </span>
              </label>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function Story({ report, t }: { report: SessionReport; t: Strings }) {
  const blocks = [
    { title: t.journey, items: report.journey, icon: <ListChecks className="size-4 text-fg-3" />, ordered: true },
    { title: t.positives, items: report.positives, icon: <ThumbsUp className="size-4 text-ok" />, ordered: false },
    { title: t.nextSteps, items: report.nextSteps, icon: <Check className="size-4 text-ai" />, ordered: true },
  ].filter((b) => b.items.length);
  if (!blocks.length) return null;
  return (
    <section className="grid gap-3 md:grid-cols-3">
      {blocks.map((b) => (
        <div key={b.title} className="rounded-[14px] bg-raised p-4 ring-1 ring-inset ring-line">
          <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-fg">
            {b.icon}
            {b.title}
          </h3>
          <ol className={cn('space-y-1.5 text-[12.5px] leading-relaxed text-fg-2', b.ordered ? 'list-decimal ps-4' : 'list-disc ps-4')}>
            {b.items.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}
