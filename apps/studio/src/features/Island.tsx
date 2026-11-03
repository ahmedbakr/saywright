/**
 * The status island at the top of the stage: one place that always says what
 * the studio is doing (listening, working, waiting for your decision) and
 * offers the next action. It morphs between states instead of stacking toasts.
 */
import { AnimatePresence, motion } from 'motion/react';
import { Check, CircleCheck, CircleX, Info, KeyRound, MousePointerClick, Sparkles, SquareDashedMousePointer, TriangleAlert, Undo2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PeaceGlyph } from '@/components/ui/gestures';
import { Button, IconButton } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Badge, Spinner } from '@/components/ui/misc';
import { controller } from '@/core/controller';
import { keepUndoHint } from '@/core/keys';
import { set, useStudio, type Binding, type IslandAction, type Island as IslandState, type Tone } from '@/core/store';
import { cn } from '@/lib/cn';
import { fileName, isMac, ms, plural } from '@/lib/format';
import type { Change } from '@shared/api';

const MORPH = { type: 'spring', stiffness: 520, damping: 42, mass: 0.9 } as const;

export function Island() {
  const island = useStudio((s) => s.island);
  const voiceState = useStudio((s) => s.voice.state);
  const request = useStudio((s) => s.request);
  const changes = useStudio((s) => s.changes);
  const replaying = useStudio((s) => !!s.replay);
  const exploring = useStudio((s) => !!s.autopilot);
  const pending = changes.filter((c) => c.status === 'preview');

  let view: string;
  let body: ReactNode;
  if (replaying) {
    view = 'replay';
    body = <Replaying />;
  } else if (exploring) {
    view = 'autopilot';
    body = <Exploring />;
  } else if (voiceState !== 'idle' || island.kind === 'listening') {
    view = 'listening';
    body = <Listening />;
  } else if (request && !holds(island)) {
    view = 'thinking';
    body = <Thinking />;
  } else if (island.kind === 'answer') {
    view = 'answer';
    body = <Answer text={island.text} said={island.said} latencyMs={island.latencyMs} model={island.model} />;
  } else if (island.kind === 'message') {
    view = `message-${island.text}`;
    body = <Message text={island.text} tone={island.tone} actions={island.actions} sticky={island.sticky} />;
  } else if (island.kind === 'needs-key') {
    view = 'needs-key';
    body = <NeedsKey text={island.text} actions={island.actions} />;
  } else if (pending.length) {
    // Changes are newest first.
    view = `preview-${pending[0].id}`;
    body = <Preview changes={pending} />;
  } else {
    view = 'idle';
    body = <Idle />;
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4" data-island={view.split('-')[0]}>
      <motion.div layout transition={MORPH} className="glass pointer-events-auto max-w-full overflow-hidden" style={{ borderRadius: 16 }}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={view}
            layout="position"
            initial={{ opacity: 0, filter: 'blur(6px)', scale: 0.98 }}
            animate={{ opacity: 1, filter: 'blur(0px)', scale: 1 }}
            exit={{ opacity: 0, filter: 'blur(6px)', scale: 0.98, transition: { duration: 0.1 } }}
            transition={{ duration: 0.18, ease: [0.2, 0.9, 0.25, 1] }}
          >
            {body}
            {request && view !== 'thinking' && view !== 'listening' && view !== 'replay' && view !== 'autopilot' && <Working />}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

/** A result to read or act on stays in view while the next request runs (with a strip saying so); a passing note doesn't. */
const holds = (i: IslandState) => i.kind === 'answer' || i.kind === 'needs-key' || (i.kind === 'message' && (!!i.sticky || !!i.actions?.length));

function Idle() {
  const mode = useStudio((s) => s.mode);
  const selection = useStudio((s) => s.selection);
  const pins = useStudio((s) => s.pins.length);
  const handOn = useStudio((s) => s.camera.status === 'on');
  const rec = useStudio((s) => s.recorder);

  let icon: ReactNode = <SquareDashedMousePointer />;
  let text: ReactNode = (
    <>
      Point at anything, hold <Kbd>Space</Kbd> and say what to change
    </>
  );
  if (mode === 'record') {
    icon = <span className="size-2 rounded-full bg-bad" style={{ animation: 'rec-pulse 1.4s ease-in-out infinite' }} />;
    text = (
      <>
        <span className="font-medium text-fg">Recording</span>
        <span className="text-fg-3">
          {plural(rec.steps.length, 'step')} · {plural(rec.expectations.length, 'check')}
        </span>
        <span className="hidden sm:inline">· point at what’s wrong, say what it should show</span>
      </>
    );
  } else if (mode === 'use') {
    icon = <MousePointerClick />;
    text = (
      <>
        Using your app · hold <Kbd>Space</Kbd> to ask or change something
      </>
    );
  } else if (pins > 1) {
    text = (
      <>
        <span className="font-medium text-human-fg">{pins} selected</span> · try “make this look like that”
      </>
    );
  } else if (selection) {
    text = (
      <>
        Say what to change about <span className="max-w-[200px] truncate rounded-[5px] bg-human-soft px-1.5 py-px font-medium text-human-fg">{selection.text && selection.text.length < 28 ? `${selection.name} · ${selection.text}` : selection.name}</span>
      </>
    );
  }
  return (
    <div className="flex h-[38px] items-center gap-2.5 whitespace-nowrap pl-3.5 pr-4 text-[12.5px] text-fg-2 [&_svg]:size-[14px] [&_svg]:text-fg-3">
      {icon}
      <span className="flex items-center gap-1.5">{text}</span>
      {handOn && mode !== 'record' && (
        <span className="hidden items-center gap-1 border-l border-line-strong pl-2.5 text-fg-3 md:flex">
          <PeaceGlyph className="!size-[14px]" /> talk
        </span>
      )}
    </div>
  );
}

function Waveform() {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    let raf = 0;
    const phase = [0.55, 0.85, 1, 0.75, 0.5];
    const tick = (t: number) => {
      const level = controller.voice.level();
      bars.current.forEach((b, i) => {
        if (!b) return;
        const wobble = 0.6 + 0.4 * Math.sin(t / 110 + i * 1.7);
        const h = 4 + Math.min(1, level * phase[i] * wobble * 1.6) * 16;
        b.style.height = `${h}px`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <span className="flex h-5 w-[26px] items-center justify-center gap-[2.5px]" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} ref={(el) => void (bars.current[i] = el)} className="w-[3px] rounded-full bg-human transition-[height] duration-75" style={{ height: 4 }} />
      ))}
    </span>
  );
}

function Words({ words, bindings }: { words: string[]; bindings: Binding[] }) {
  const byIndex = new Map(bindings.map((b) => [b.index, b]));
  return (
    <span className="leading-[1.6]">
      {words.map((w, i) => {
        const b = byIndex.get(i);
        if (!b) return <span key={i}>{w} </span>;
        return (
          <span key={i}>
            <span
              className={cn(
                'inline-flex items-baseline gap-1 rounded-[5px] px-1 py-px',
                b.el ? 'bg-human-soft text-human-fg' : 'border border-dashed border-line-strong text-fg-3',
              )}
            >
              {w}
              <span className="max-w-[140px] truncate text-[11px] font-medium opacity-75">{b.el ? b.el.name : '?'}</span>
            </span>{' '}
          </span>
        );
      })}
    </span>
  );
}

function Listening() {
  const v = useStudio((s) => s.voice);
  const hover = useStudio((s) => s.hover);
  const starting = v.state === 'starting';
  return (
    <div className="flex min-h-[44px] w-[min(620px,calc(100vw-80px))] items-center gap-3 py-2 pl-3.5 pr-2" data-voice={v.state}>
      {starting ? <Spinner className="mx-[5px] size-4 text-human" /> : <Waveform />}
      <div className="min-w-0 flex-1 text-[14px] text-fg">
        {v.words.length ? (
          <Words words={v.words} bindings={v.bindings} />
        ) : (
          <span className="text-fg-3">
            {starting ? 'Starting the mic…' : v.state === 'finishing' ? 'Working out what you said…' : 'Listening…'}
            {hover && !starting && v.state !== 'finishing' && (
              <span className="ml-2 text-[12px]">
                pointing at <span className="text-human-fg">{hover.name}</span>
              </span>
            )}
          </span>
        )}
      </div>
      <span className="shrink-0 text-[11.5px] text-fg-3">{v.state === 'finishing' ? (v.words.length ? 'Finishing…' : '') : starting ? 'One moment' : v.trigger === 'hold' ? 'Release to send' : 'Pause to send'}</span>
      <IconButton size="sm" onClick={() => controller.cancelTalk()} aria-label="Cancel">
        <X />
      </IconButton>
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  return <span className="tabular shrink-0 font-mono text-[11.5px] text-fg-3">{((now - since) / 1000).toFixed(1)}s</span>;
}

function AiOrb() {
  return (
    <span className="relative flex size-6 shrink-0 items-center justify-center">
      <span className="absolute inset-0 rounded-full" style={{ background: 'conic-gradient(from 0deg, transparent, var(--ai))', animation: 'spin 1.1s linear infinite', mask: 'radial-gradient(circle, transparent 7.5px, #000 8px)' }} />
      <Sparkles className="size-[12px] text-ai" />
    </span>
  );
}

/** Replay & verify: which step of the session is being played again, and a way out. */
function Replaying() {
  const r = useStudio((s) => s.replay);
  if (!r) return null;
  const share = r.phase === 'finishing' ? 1 : r.phase === 'playing' ? (r.step - 0.5) / Math.max(1, r.total) : 0;
  return (
    <div className="relative flex h-[48px] w-[min(560px,calc(100vw-80px))] items-center gap-3 pl-3 pr-1.5" data-replay={r.phase}>
      <AiOrb />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11.5px] text-fg-3">
          Replaying “{r.name}”{r.phase === 'playing' && <span className="tabular"> · step {r.step} of {r.total}</span>}
        </div>
        <div className="shimmer-text truncate text-[12.5px] font-medium" data-replay-step>
          {r.description}
          {r.phase === 'playing' ? '' : '…'}
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={() => controller.replayer.stop()} kbd={<Kbd>Esc</Kbd>} data-replay-stop>
        Stop
      </Button>
      <span className="absolute bottom-0 start-0 h-[2px] bg-ai transition-[width] duration-500 ease-out" style={{ width: `${share * 100}%` }} />
    </div>
  );
}

/** Autopilot: which step it is on, what it is doing, what it has found, and a way out. */
function Exploring() {
  const a = useStudio((s) => s.autopilot);
  if (!a) return null;
  const share = a.phase === 'finishing' ? 1 : a.step / Math.max(1, a.total);
  return (
    <div className="relative flex h-[48px] w-[min(560px,calc(100vw-80px))] items-center gap-3 pl-3 pr-1.5" data-autopilot={a.phase}>
      <AiOrb />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11.5px] text-fg-3">
          Autopilot{a.goal ? `: ${a.goal}` : ''}
          {a.step > 0 && a.phase !== 'finishing' && <span className="tabular"> · step {a.step} of {a.total}</span>}
          {a.found > 0 && <span className="tabular text-warn"> · {a.found} found</span>}
        </div>
        <div className="shimmer-text truncate text-[12.5px] font-medium" data-autopilot-step>
          {a.description}
          {a.phase === 'acting' ? '' : '…'}
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={() => controller.autopilot.stop()} kbd={<Kbd>Esc</Kbd>} data-autopilot-stop>
        Stop
      </Button>
      <span className="absolute bottom-0 start-0 h-[2px] bg-ai transition-[width] duration-500 ease-out" style={{ width: `${share * 100}%` }} />
    </div>
  );
}

/** What waits after the running request, in a few words. */
function Next() {
  const waiting = useStudio((s) => s.waiting);
  if (!waiting.length) return null;
  return (
    <span title={waiting.map((w) => `“${w.text}”`).join('\n')}>
      {' '}
      · next: “{waiting[0].text}”{waiting.length > 1 ? ` and ${waiting.length - 1} more` : ''}
    </span>
  );
}

function Thinking() {
  const r = useStudio((s) => s.request);
  const waiting = useStudio((s) => s.waiting.length);
  if (!r) return null;
  const stopping = r.step === 'Stopping';
  const step = r.detail ? `${r.step} · ${r.detail}` : r.step;
  return (
    <div className="flex h-[48px] w-[min(560px,calc(100vw-80px))] items-center gap-3 pl-3 pr-1.5" data-waiting={waiting}>
      <AiOrb />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11.5px] text-fg-3">
          “{r.text}”
          <Next />
        </div>
        <div className="shimmer-text truncate text-[12.5px] font-medium">{step}…</div>
      </div>
      <Elapsed since={r.startedAt} />
      {r.kind !== 'test' && !stopping && (
        <Button variant="ghost" size="sm" onClick={() => void controller.cancelRequest()} kbd={<Kbd>Esc</Kbd>}>
          Stop
        </Button>
      )}
    </div>
  );
}

/** Under a result still in view: the next request, already working. */
function Working() {
  const r = useStudio((s) => s.request);
  const waiting = useStudio((s) => s.waiting.length);
  if (!r) return null;
  return (
    <div className="flex h-[36px] items-center gap-2.5 border-t border-line pl-3.5 pr-1.5 text-[11.5px] text-fg-3" data-working data-waiting={waiting}>
      <Spinner className="size-3 shrink-0 text-ai" />
      <span className="min-w-0 flex-1 truncate">
        {r.step === 'Stopping' ? 'Stopping' : 'Working on'} “{r.text}”
        <Next />
      </span>
      <Elapsed since={r.startedAt} />
      {r.kind !== 'test' && r.step !== 'Stopping' && (
        <Button variant="ghost" size="xs" onClick={() => void controller.cancelRequest()}>
          Stop
        </Button>
      )}
    </div>
  );
}

function sourceLabel(c: Change): string {
  if (c.source === 'quick') return 'Quick edit';
  if (c.source === 'fake') return 'AI (test double)';
  return c.model ?? (c.source === 'claude' ? 'Claude' : 'AI');
}

function Preview({ changes }: { changes: Change[] }) {
  const c = changes[0];
  const verifying = useStudio((s) => s.recorder.verifying);
  const running = useStudio((s) => s.recorder.running);
  const added = c.files.reduce((n, f) => n + f.added, 0);
  const removed = c.files.reduce((n, f) => n + f.removed, 0);
  return (
    <div className="flex min-h-[50px] w-max max-w-[min(720px,calc(100vw-48px))] items-center gap-3 py-1.5 pl-3 pr-1.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-ai-soft text-ai-fg ring-1 ring-inset ring-ai-line/30">
        <Sparkles className="size-[14px]" />
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-fg">{c.title}</span>
          {changes.length > 1 && <Badge tone="ai">{changes.length} previews</Badge>}
        </div>
        <div className="flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-fg-3">
          {verifying && running ? (
            <span className="flex items-center gap-1.5 text-ai-fg">
              <Spinner className="size-3" /> Checking with your test…
            </span>
          ) : (
            <>
              {c.said && (
                <span className="max-w-[220px] truncate text-fg-2" title="What you said">
                  “{c.said}” ·
                </span>
              )}
              <span>{sourceLabel(c)}</span>
              {c.latencyMs != null && <span>· {ms(c.latencyMs)}</span>}
              <span>·</span>
              <span className="font-mono">{c.files.length === 1 ? fileName(c.files[0].path) : plural(c.files.length, 'file')}</span>
              <span className="font-mono text-ok">+{added}</span>
              <span className="font-mono text-bad">−{removed}</span>
            </>
          )}
        </div>
      </div>
      <div className="ml-3 flex flex-col items-end gap-1">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" icon={<Undo2 />} onClick={() => void controller.undo('click')} aria-keyshortcuts={isMac ? 'Meta+Z' : 'Control+Z'}>
            Undo
          </Button>
          <Button variant="primary" size="sm" icon={<Check />} onClick={() => void controller.keep('click')} aria-keyshortcuts="Enter">
            {changes.length > 1 ? 'Keep all' : 'Keep'}
          </Button>
        </div>
        <span className="whitespace-nowrap pr-1 text-[11px] text-fg-3" data-keys>
          {keepUndoHint(isMac)}
        </span>
      </div>
    </div>
  );
}

const FILE_REF = /((?:[\w.-]+\/)*[\w.-]+\.(?:tsx|ts|jsx|js|css|json|md|html)):(\d+)/g;

function RichText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  text.split(/(`[^`]+`)/g).forEach((chunk, i) => {
    if (chunk.startsWith('`') && chunk.endsWith('`')) {
      parts.push(
        <code key={i} className="rounded-[4px] bg-sunken px-1 py-px font-mono text-[12px] text-fg ring-1 ring-inset ring-line">
          {chunk.slice(1, -1)}
        </code>,
      );
      return;
    }
    let last = 0;
    for (const m of chunk.matchAll(FILE_REF)) {
      if (m.index! > last) parts.push(chunk.slice(last, m.index));
      const [whole, file, line] = m;
      parts.push(
        <button
          key={`${i}-${m.index}`}
          data-hand
          onClick={() => controller.openRelative(file, Number(line))}
          className="rounded-[4px] bg-ai-soft px-1 py-px font-mono text-[12px] text-ai-fg hover:underline"
          title="Open in editor"
        >
          {whole}
        </button>,
      );
      last = m.index! + whole.length;
    }
    if (last < chunk.length) parts.push(chunk.slice(last));
  });
  return <>{parts}</>;
}

function Answer({ text, said, latencyMs, model }: { text: string; said: string; latencyMs?: number; model?: string }) {
  return (
    <div className="w-[min(580px,calc(100vw-48px))] py-2.5 pl-3.5 pr-2">
      <div className="mb-1 flex items-center gap-2 text-[11.5px] text-fg-3">
        <Sparkles className="size-[13px] text-ai" />
        <span className="font-medium text-ai-fg">{model && model !== 'fake-claude' ? model : 'AI'}</span>
        {latencyMs != null && <span>· {ms(latencyMs)}</span>}
        <span className="min-w-0 flex-1 truncate">· “{said}”</span>
        <IconButton size="sm" onClick={() => controller.dismissIsland()} aria-label="Close">
          <X />
        </IconButton>
      </div>
      <div className="max-h-[220px] overflow-y-auto pr-2 text-[13px] leading-relaxed text-fg">
        <RichText text={text} />
      </div>
    </div>
  );
}

const TONE: Record<Tone, { icon: ReactNode; cls: string }> = {
  info: { icon: <Info />, cls: 'text-fg-3' },
  ok: { icon: <CircleCheck />, cls: 'text-ok' },
  warn: { icon: <TriangleAlert />, cls: 'text-warn' },
  error: { icon: <CircleX />, cls: 'text-bad' },
};

function Message({ text, tone, actions, sticky }: { text: string; tone: Tone; actions?: { label: string; run: () => void; primary?: boolean }[]; sticky?: boolean }) {
  return (
    <div className="flex min-h-[40px] w-max max-w-[min(680px,calc(100vw-48px))] items-center gap-2.5 py-1.5 pl-3.5 pr-1.5">
      <span className={cn('shrink-0 [&_svg]:size-[15px]', TONE[tone].cls)}>{TONE[tone].icon}</span>
      <span className="text-[12.5px] leading-snug text-fg">{text}</span>
      {actions?.map((a) => (
        <Button key={a.label} size="sm" variant={a.primary ? 'primary' : 'ghost'} onClick={a.run} className="ml-1 first-of-type:ml-2">
          {a.label}
        </Button>
      ))}
      {(sticky || actions?.length) && (
        <IconButton size="sm" onClick={() => controller.dismissIsland()} aria-label="Dismiss">
          <X />
        </IconButton>
      )}
      {!sticky && !actions?.length && <span className="w-1.5" />}
    </div>
  );
}

function NeedsKey({ text, actions }: { text: string; actions?: IslandAction[] }) {
  const buttons = actions ?? [{ label: 'Connect an AI', primary: true, run: () => set({ overlay: 'settings', settingsTab: 'ai', island: { kind: 'idle' } }) }];
  return (
    <div className="flex min-h-[44px] w-max max-w-[min(680px,calc(100vw-48px))] items-center gap-2.5 py-1.5 pl-3.5 pr-1.5">
      <KeyRound className="size-[15px] shrink-0 text-warn" />
      <span className="text-[12.5px] leading-snug text-fg">{text}</span>
      {buttons.map((a) => (
        <Button key={a.label} size="sm" variant={a.primary ? 'primary' : 'ghost'} className="ml-1 shrink-0 first-of-type:ml-2" onClick={a.run}>
          {a.label}
        </Button>
      ))}
      <IconButton size="sm" onClick={() => controller.dismissIsland()} aria-label="Dismiss">
        <X />
      </IconButton>
    </div>
  );
}
