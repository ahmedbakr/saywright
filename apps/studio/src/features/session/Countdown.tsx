/**
 * Before a test session records: a count in the middle of the screen while
 * the microphone opens and is heard, the screen is shared, the speech model
 * loads and the app connects. Recording starts when the count is over and all
 * of that is ready, or straight away on "Start now". Enter starts, Esc cancels.
 */
import { AnimatePresence, motion } from 'motion/react';
import { AppWindow, AudioLines, Check, Mic, MonitorUp, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Countdown as CountdownState } from '@saywright/vite/client';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/misc';
import { useModal } from '@/components/ui/modal';
import { sessions, useSessions } from '@/core/sessions';
import { cn } from '@/lib/cn';

type Tone = 'ok' | 'wait' | 'warn' | 'bad';

function Level() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const level = Math.min(1, sessions.client.micLevel);
      const bars = ref.current?.children;
      if (bars) for (let i = 0; i < bars.length; i++) (bars[i] as HTMLElement).style.height = `${3 + Math.max(0, level * 13 - Math.abs(i - 3) * 2.2)}px`;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div ref={ref} className="flex h-4 items-center gap-[2px]" aria-hidden>
      {Array.from({ length: 7 }, (_, i) => (
        <span key={i} className="block w-[3px] rounded-full bg-ok transition-[height] duration-75" style={{ height: 3 }} />
      ))}
    </div>
  );
}

/** Whether speech is coming through right now (not just the room's hiss). */
function useSpeaking(on: boolean): boolean {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setSpeaking(sessions.client.voiceStatus().state === 'speaking'), 150);
    return () => clearInterval(t);
  }, [on]);
  return on && speaking;
}

function Item({ icon, label, status, tone, extra }: { icon: ReactNode; label: string; status: string; tone: Tone; extra?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 py-2" data-check={label} data-tone={tone}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-active text-fg-2 [&_svg]:size-[15px]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-medium text-fg">{label}</span>
        <span className={cn('block text-[11.5px] leading-snug', tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-fg-3')}>{status}</span>
      </span>
      {extra}
      <span className="flex size-5 shrink-0 items-center justify-center [&_svg]:size-[14px]">
        {tone === 'ok' ? <Check className="text-ok" /> : tone === 'wait' ? <Spinner className="size-3.5 text-fg-3" /> : tone === 'warn' ? <TriangleAlert className="text-warn" /> : <X className="text-bad" />}
      </span>
    </li>
  );
}

function Checks({ c }: { c: CountdownState }) {
  const speaking = useSpeaking(c.mic === 'ok');
  const mic: Record<Exclude<CountdownState['mic'], 'off'>, [string, Tone]> = {
    opening: ['Opening… allow it if the browser asks', 'wait'],
    checking: ['Listening…', 'wait'],
    ok: [speaking ? 'Hearing you' : 'Working. Say something to check', 'ok'],
    quiet: ['No sound from it: is it muted?', 'warn'],
    blocked: ['Blocked: allow it from the address bar', 'bad'],
    failed: ['Couldn’t be opened: is one connected?', 'bad'],
  };
  const screen: Record<Exclude<CountdownState['screen'], 'off'>, [string, Tone]> = {
    ok: ['Sharing this tab', 'ok'],
    denied: ['Not shared: no video or pictures', 'warn'],
    unsupported: ['This browser can’t record it', 'warn'],
  };
  const speech: Record<Exclude<CountdownState['speech'], 'off'>, [string, Tone]> = {
    loading: ['Loading…', 'wait'],
    ok: ['Ready to write down what you say', 'ok'],
    unavailable: ['Not installed: your voice is kept, not written down yet', 'warn'],
  };
  return (
    <ul className="divide-y divide-line">
      {c.mic !== 'off' && <Item icon={<Mic />} label="Microphone" status={mic[c.mic][0]} tone={mic[c.mic][1]} extra={c.mic === 'ok' || c.mic === 'checking' ? <Level /> : null} />}
      {c.speech !== 'off' && <Item icon={<AudioLines />} label="Speech model" status={speech[c.speech][0]} tone={speech[c.speech][1]} />}
      {c.screen !== 'off' && <Item icon={<MonitorUp />} label="Screen" status={screen[c.screen][0]} tone={screen[c.screen][1]} />}
      <Item icon={<AppWindow />} label="Your app" status={c.app === 'ok' ? 'Connected' : 'Connecting…'} tone={c.app === 'ok' ? 'ok' : 'wait'} />
    </ul>
  );
}

/** The count, in a ring that empties over the whole countdown; a spinner while recording waits for something. */
function Count({ c }: { c: CountdownState }) {
  const R = 46;
  const C = 2 * Math.PI * R;
  const waiting = c.left === 0;
  return (
    <div className="relative mx-auto size-[120px]" data-count={c.left}>
      <svg viewBox="0 0 120 120" className={cn('absolute inset-0 -rotate-90', waiting && 'animate-spin [animation-duration:1.4s]')}>
        <circle cx="60" cy="60" r={R} fill="none" strokeWidth="5" className="stroke-active" />
        <circle
          cx="60"
          cy="60"
          r={R}
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          className="stroke-bad"
          strokeDasharray={waiting ? `${C * 0.22} ${C}` : C}
          style={waiting ? undefined : { strokeDashoffset: 0, animation: `countdown-ring ${c.total}s linear forwards` }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <AnimatePresence mode="popLayout">
          {waiting ? (
            <motion.span key="wait" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} className="text-fg-2 [&_svg]:size-7">
              <Mic />
            </motion.span>
          ) : (
            <motion.span
              key={c.left}
              initial={{ opacity: 0, scale: 1.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={{ duration: 0.35, ease: [0.2, 0.9, 0.25, 1] }}
              className="tabular text-[56px] font-semibold leading-none tracking-[-0.03em] text-fg"
            >
              {c.left}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export function Countdown() {
  const c = useSessions((s) => (s.live.status === 'starting' && !s.live.id ? (s.live.countdown ?? null) : null));
  const on = !!c;
  // Modal while it counts: Enter and Esc are handled below, before anything else sees them.
  const layer = useModal(on);
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape') sessions.cancelStart();
      else sessions.startNow();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [on]);

  return (
    <AnimatePresence>
      {c && (
        <motion.div
          key="countdown"
          ref={layer}
          className="fixed inset-0 z-[75] flex items-center justify-center bg-black/40 backdrop-blur-[3px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          data-countdown
        >
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="w-[min(380px,calc(100vw-32px))] rounded-[18px] bg-panel p-5 shadow-pop ring-1 ring-inset ring-line"
            role="dialog"
            aria-modal="true"
            aria-label="Recording starts soon"
          >
            <Count c={c} />
            <p className="mt-3 text-center text-[14px] font-semibold text-fg" aria-live="polite">
              {c.left > 0 ? 'Recording starts in a moment' : c.waiting ?? 'Starting…'}
            </p>
            <p className="mt-0.5 text-center text-[12px] text-fg-3">{c.left > 0 ? 'Getting everything ready meanwhile.' : 'Recording starts as soon as it is.'}</p>
            <div className="mt-3 rounded-[12px] bg-raised px-3 ring-1 ring-inset ring-line">
              <Checks c={c} />
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Button variant="primary" size="md" className="flex-1 !bg-bad !text-inverse hover:!bg-bad/90" onClick={() => sessions.startNow()} data-start-now>
                {c.goLabel}
              </Button>
              <Button size="md" variant="ghost" onClick={() => sessions.cancelStart()} data-cancel-start>
                Cancel
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
