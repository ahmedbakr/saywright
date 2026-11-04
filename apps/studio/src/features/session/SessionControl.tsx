/**
 * Test sessions in the top bar: a "Record session" button that opens the
 * setup, then a live chip while recording, writing the report, and when the
 * report is ready. (Writing a Playwright test is the "Write test" mode.)
 */
import { CircleDot, FileText, Mic, MonitorUp, Square, Timer } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/misc';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { sessions, useSessions, type SessionPrefs } from '@/core/sessions';
import { useStudio } from '@/core/store';
import { cn } from '@/lib/cn';
import { WhatsSent } from '../Privacy';
import { shortcut } from '@/lib/format';

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
}

/** Re-render every `ms` while `on`. */
export function useTicker(on: boolean, ms = 500): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}

export function SessionControl() {
  const live = useSessions((s) => s.live);
  const setup = useSessions((s) => s.setup);
  const recording = live.status === 'recording' || live.status === 'starting' || live.status === 'stopping';
  const now = useTicker(recording);

  if (recording) {
    return (
      <Tip label={live.status === 'starting' ? 'Cancel: don’t record after all' : 'Stop and write the report'}>
        <button
          onClick={() => void sessions.stop()}
          disabled={live.status === 'stopping'}
          className="inline-flex h-7 items-center gap-2 rounded-[7px] bg-bad-soft pl-2.5 pr-2 text-[12px] font-semibold text-bad ring-1 ring-inset ring-bad/30 transition-colors hover:bg-bad/15"
        >
          <span className="size-2 rounded-full bg-bad" style={{ animation: 'rec-pulse 1.4s ease-in-out infinite' }} />
          <span className="tabular">{live.status === 'starting' ? (live.countdown?.left ? `In ${live.countdown.left}…` : 'Starting…') : live.status === 'stopping' ? 'Saving…' : clock(now - live.startedAt)}</span>
          <Square className="size-3 fill-current" />
        </button>
      </Tip>
    );
  }
  // The last session's report, while it is written and once it is ready; a new session can start meanwhile.
  let report: React.ReactNode = null;
  if (live.status === 'processing' && live.id) {
    report = (
      <Tip label={live.stage || 'Writing the report'}>
        <button onClick={() => sessions.openReport(live.id!)} className="inline-flex h-7 items-center gap-2 rounded-[7px] bg-ai-soft px-2.5 text-[12px] font-medium text-ai-fg ring-1 ring-inset ring-ai-line/40">
          <Spinner className="size-3" />
          Writing report…
        </button>
      </Tip>
    );
  } else if (live.status === 'ready' && live.id) {
    report = (
      <button
        onClick={() => sessions.openReport(live.id!)}
        className="inline-flex h-7 items-center gap-1.5 rounded-[7px] bg-ai px-2.5 text-[12px] font-semibold text-[#021a20] shadow-[0_0_0_3px_var(--ai-soft)]"
      >
        <FileText className="size-3.5" />
        Report ready
      </button>
    );
  } else if (live.status === 'failed' && live.id) {
    report = (
      <Tip label={live.error || 'The report couldn’t be written'}>
        <button onClick={() => sessions.openReport(live.id!)} className="inline-flex h-7 items-center gap-1.5 rounded-[7px] bg-bad-soft px-2.5 text-[12px] font-medium text-bad ring-1 ring-inset ring-bad/30">
          <FileText className="size-3.5" />
          Report failed
        </button>
      </Tip>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      {report}
      <NewSession setup={setup} compact={!!report} />
    </div>
  );
}

function NewSession({ setup, compact }: { setup: boolean; compact: boolean }) {
  // A session's steps are being replayed (and recorded): one recording at a time.
  const replaying = useStudio((s) => !!s.replay);
  return (
    <Popover.Root open={setup && !replaying} onOpenChange={(open) => useSessions.setState({ setup: open })}>
      <Tip label={replaying ? 'Wait for the replay to finish' : 'Record session: use your app and talk, then get a report with what went wrong'}>
        <Popover.Trigger asChild>
          <button
            data-tour="record"
            disabled={replaying}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-[7px] text-[12px] font-medium text-fg-2 ring-1 ring-inset ring-line-strong transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-45',
              compact ? 'w-7 justify-center' : 'px-2.5 max-[1179px]:w-7 max-[1179px]:justify-center max-[1179px]:px-0',
              setup && 'bg-active text-fg',
            )}
          >
            <CircleDot className="size-3.5 text-bad" />
            <span className={cn(compact ? 'sr-only' : 'max-[1179px]:sr-only')}>Record session</span>
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content side="bottom" align="end" sideOffset={8} className="z-[60] w-[360px] rounded-[14px] bg-panel p-4 shadow-pop outline-none" onOpenAutoFocus={(e) => e.preventDefault()}>
          <SessionSetup />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SessionSetup() {
  const prefs = useSessions((s) => s.prefs);
  const speech = useSessions((s) => s.speech);
  const live = useSessions((s) => s.live);
  const [name, setName] = useState('');
  const set = (p: Partial<SessionPrefs>) => sessions.setPrefs(p);
  useEffect(() => void sessions.refreshSpeech(), []);
  // Loading a model takes seconds: start while the session is being set up.
  useEffect(() => {
    if (prefs.mic) sessions.warmSpeech(prefs.lang);
  }, [prefs.lang, prefs.mic]);

  const lang = prefs.lang === 'en' ? 'en' : 'ar';
  const modelId = speech?.active[lang] ?? null;
  const model = speech?.models.find((m) => m.id === modelId);
  const candidate = speech?.models.find((m) => m.langs.includes(lang) && !m.installed) ?? null;
  const installing = speech?.models.find((m) => m.installing != null);
  // Narrating in Arabic with the small model: the large one gets far fewer words wrong (measured, see docs/speech-accuracy.md).
  const bestArabic = speech?.models.filter((m) => m.wordErrors.ar != null).sort((a, b) => a.wordErrors.ar! - b.wordErrors.ar!)[0];
  const arabicNow = speech?.models.find((m) => m.id === speech.active.ar);
  const upgrade = lang === 'ar' && model && bestArabic && !bestArabic.installed && arabicNow?.wordErrors.ar != null && arabicNow.id !== bestArabic.id ? { best: bestArabic, now: arabicNow.wordErrors.ar } : null;

  return (
    <div className="space-y-3.5">
      <div>
        <div className="text-[14px] font-semibold tracking-[-0.01em] text-fg">Record a session</div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-fg-3">
          Use your app and say what you notice, in English or Arabic. Every click, error, request and slow moment is captured; when you stop, you get a report with scores and fixes. For a Playwright test instead, use Write test mode (<b className="font-medium text-fg-2">R</b>).
        </p>
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void sessions.start(name)}
        placeholder="What are you testing? (optional)"
        className="h-8 w-full rounded-[8px] bg-sunken px-2.5 text-[12.5px] text-fg outline-none ring-1 ring-inset ring-line placeholder:text-fg-3 focus:ring-ai-line"
      />
      <div className="space-y-1.5">
        <div className="text-[12px] font-medium text-fg-3">I’ll talk in</div>
        <Segmented
          className="w-full [&>*]:flex-1"
          value={prefs.lang}
          onChange={(v) => set({ lang: v })}
          options={[
            { value: 'en', label: 'English' },
            { value: 'ar', label: 'العربية' },
            { value: 'auto', label: 'Both', title: 'Arabic and English, even in one sentence' },
          ]}
        />
        <SpeechLine speech={speech} model={model?.label ?? null} candidate={candidate} installing={installing} wantsMic={prefs.mic} />
        {upgrade && prefs.mic && !installing && (
          <div className="flex items-center justify-between gap-2 rounded-[8px] bg-ai-soft px-2.5 py-1.5" data-arabic-upgrade>
            <p className="text-[11.5px] leading-snug text-ai-fg">
              More accurate Arabic: {upgrade.best.wordErrors.ar}% of words wrong instead of {upgrade.now}%.
            </p>
            <Button size="xs" variant="ai" onClick={() => void sessions.installSpeech(upgrade.best.id)}>
              Install ({(upgrade.best.sizeMb / 1000).toFixed(1)} GB)
            </Button>
          </div>
        )}
      </div>
      <div className="divide-y divide-line rounded-[10px] ring-1 ring-inset ring-line">
        <Row icon={<Mic />} title="Record my voice" hint="Transcribed on this computer, linked to what you point at" on={prefs.mic} set={(v) => set({ mic: v })} />
        <Row icon={<MonitorUp />} title="Record the screen" hint="Chrome asks what to share: choose this tab" on={prefs.screen} set={(v) => set({ screen: v })} />
        {prefs.screen && <Row title="Keep a video" hint="For replaying moments in the report" on={prefs.video} set={(v) => set({ video: v })} indent />}
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <span className="text-fg-3 [&_svg]:size-[15px]">
            <Timer />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12.5px] font-medium text-fg">Count down first</span>
            <span className="block text-[11.5px] text-fg-3">Checks the mic hears you before recording starts</span>
          </span>
          <Segmented
            value={String(prefs.countdown)}
            onChange={(v) => set({ countdown: Number(v) })}
            options={[
              { value: '0', label: 'Off' },
              { value: '3', label: '3 s' },
              { value: '5', label: '5 s' },
            ]}
          />
        </div>
      </div>
      {live.error && !live.id && (
        <div className="space-y-1.5 rounded-[8px] bg-bad-soft px-2.5 py-2 text-[12px] text-bad">
          <div>{live.error}</div>
          {live.busy && (
            <Button size="xs" onClick={() => void sessions.start(name, true)}>
              Stop it and start this one
            </Button>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button variant="primary" size="md" className="flex-1 !bg-bad !text-inverse hover:!bg-bad/90" icon={<span className="size-2 rounded-full bg-inverse" />} onClick={() => void sessions.start(name)}>
          Start recording
        </Button>
      </div>
      <p className="text-[11.5px] leading-relaxed text-fg-3">
        While recording: <b className="font-medium text-fg-2">M</b> marks a moment (<b className="font-medium text-fg-2">{shortcut('alt+shift+m')}</b> inside the app). Recordings are kept in your app’s <span className="font-mono">.saywright/sessions</span>; a report written by an AI sends it what was recorded. <WhatsSent />
      </p>
    </div>
  );
}

function SpeechLine({
  speech,
  model,
  candidate,
  installing,
  wantsMic,
}: {
  speech: ReturnType<typeof useSessions.getState>['speech'];
  model: string | null;
  candidate: { id: string; label: string; sizeMb: number } | null;
  installing: { label: string; installing: number | null } | undefined;
  wantsMic: boolean;
}) {
  if (!wantsMic || !speech) return null;
  if (installing) {
    return (
      <div className="space-y-1 pt-1">
        <div className="flex justify-between text-[11.5px] text-fg-3">
          <span>Installing {installing.label}…</span>
          <span className="tabular">{installing.installing ?? 0}%</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-active">
          <div className="h-full bg-ai transition-[width] duration-300" style={{ width: `${installing.installing ?? 0}%` }} />
        </div>
      </div>
    );
  }
  if (speech.runtime === 'missing' || speech.runtime === 'failed') {
    return <p className="pt-1 text-[11.5px] leading-relaxed text-warn">The speech engine can’t run on this computer{speech.runtimeError ? ` (${speech.runtimeError})` : ''}. Your voice is still recorded; transcribe it later.</p>;
  }
  if (model) return <p className="pt-1 text-[11.5px] text-fg-3">Transcribed on this computer with {model}.</p>;
  if (candidate) {
    return (
      <div className="flex items-center justify-between gap-2 pt-1">
        <p className="text-[11.5px] leading-snug text-warn">No speech model for this language yet.</p>
        <Button size="xs" variant="ai" onClick={() => void sessions.installSpeech(candidate.id)}>
          Install ({candidate.sizeMb} MB)
        </Button>
      </div>
    );
  }
  return null;
}

function Row({ icon, title, hint, on, set, indent }: { icon?: React.ReactNode; title: string; hint: string; on: boolean; set: (v: boolean) => void; indent?: boolean }) {
  return (
    <label className={cn('flex cursor-default items-center gap-2.5 px-3 py-2.5', indent && 'pl-9')}>
      {icon && <span className="text-fg-3 [&_svg]:size-[15px]">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-medium text-fg">{title}</span>
        <span className="block text-[11.5px] text-fg-3">{hint}</span>
      </span>
      <Switch checked={on} onCheckedChange={set} />
    </label>
  );
}
