/**
 * The strip under the top bar while a test session records: time, the
 * microphone, the last thing you said (as transcribed), what's been caught so
 * far, and Mark / Pause / Stop.
 */
import { AnimatePresence, motion } from 'motion/react';
import { Flag, MicOff, MonitorOff, Pause, Play, Square, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { VoiceStatus } from '@saywright/vite/client';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { sessions, useSessions } from '@/core/sessions';
import { cn } from '@/lib/cn';
import { clock, useTicker } from './SessionControl';

function Meter({ tone }: { tone: VoiceStatus['tone'] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const level = Math.min(1, sessions.client.micLevel);
      const bars = ref.current?.children;
      if (bars) for (let i = 0; i < bars.length; i++) (bars[i] as HTMLElement).style.height = `${3 + Math.max(0, level * 11 - Math.abs(i - 2) * 2.2)}px`;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div ref={ref} className="flex h-3.5 items-center gap-[2px]" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={cn('block w-[3px] rounded-full transition-[height,background-color] duration-75', tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn/80' : 'bg-bad/70')} style={{ height: 3 }} />
      ))}
    </div>
  );
}

/** The voice status, re-checked a few times a second (only a change re-renders). */
function useVoiceStatus(): VoiceStatus {
  const [status, setStatus] = useState(() => sessions.client.voiceStatus());
  useEffect(() => {
    const t = setInterval(() => {
      const next = sessions.client.voiceStatus();
      setStatus((prev) => (prev.state === next.state && prev.text === next.text ? prev : next));
    }, 150);
    return () => clearInterval(t);
  }, []);
  return status;
}

/** Is my voice getting through? The wave, green while you are heard, and what is happening to what you said. */
function Voice() {
  const status = useVoiceStatus();
  const off = status.state === 'off' || status.state === 'blocked' || status.state === 'unavailable';
  return (
    <Tip label={status.hint}>
      <div className="flex min-w-[64px] flex-col items-center justify-center gap-[3px]" data-voice={status.state}>
        {off ? (
          <span className="flex h-3.5 items-center text-fg-3 [&_svg]:size-[13px]">
            <MicOff />
          </span>
        ) : (
          <Meter tone={status.tone} />
        )}
        <span className={cn('whitespace-nowrap text-[10px] font-medium leading-none', status.tone === 'ok' ? 'text-ok' : status.tone === 'warn' ? 'text-warn' : status.tone === 'bad' ? 'text-bad' : 'text-fg-3')}>{status.text}</span>
      </div>
    </Tip>
  );
}

export function SessionBar() {
  const live = useSessions((s) => s.live);
  const noting = useSessions((s) => s.noting);
  const recording = live.status === 'recording' || live.status === 'starting' || live.status === 'stopping';
  const now = useTicker(recording, 250);
  const caption = live.captions[live.captions.length - 1];
  const freshIssue = live.lastIssue && now - live.lastIssue.t < 7000 ? live.lastIssue : null;
  const issues = live.counts.errors + live.counts.failedRequests + live.counts.frustration;

  return (
    <AnimatePresence initial={false}>
      {recording && (
        // Its full height at once, while it says “Starting…”, and only its look fades: the app below never moves once
        // the recording is on, or a click as it begins would land where the control used to be.
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="relative z-10 h-10 shrink-0 overflow-hidden border-b border-bad/25 bg-[linear-gradient(90deg,var(--bad-soft),transparent_55%)]"
        >
          <div className="flex h-10 items-center gap-3 px-3">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-bad" style={{ animation: live.paused || live.status === 'starting' ? undefined : 'rec-pulse 1.4s ease-in-out infinite' }} />
              {/* Not "Recording" until the app's recorder is on: what is done before that isn't captured. */}
              <span className="text-[12px] font-semibold text-bad">{live.status === 'starting' ? 'Starting…' : live.paused ? 'Paused' : 'Recording'}</span>
              <span className="tabular text-[12.5px] font-semibold text-fg">{live.status === 'starting' ? '—' : clock(now - live.startedAt)}</span>
            </div>
            {live.status !== 'starting' && <Voice />}
            {live.screen !== 'on' && live.status === 'recording' && (
              <Tip label={live.screen === 'denied' ? 'Screen sharing was declined: no screenshots this time' : 'Not recording the screen'}>
                <span className="text-fg-3 [&_svg]:size-[14px]">
                  <MonitorOff />
                </span>
              </Tip>
            )}

            <div className="relative h-full min-w-0 flex-1">
              <AnimatePresence mode="popLayout" initial={false}>
                {noting ? (
                  <motion.div key={`n${noting.t}`} initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -12, opacity: 0 }} className="absolute inset-0 flex items-center gap-2">
                    <Flag className="size-3.5 shrink-0 text-human-fg" />
                    {/* Leaving the field (a click back into the app) keeps the mark with what was typed. */}
                    <input
                      autoFocus
                      id="session-note"
                      dir="auto"
                      value={noting.text}
                      maxLength={300}
                      onChange={(e) => sessions.noteText(e.target.value)}
                      onBlur={() => sessions.saveNote()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') sessions.saveNote();
                        else if (e.key === 'Escape') sessions.saveNote(false);
                        else return;
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      aria-label="What did you notice?"
                      placeholder="Marked. What did you notice? Enter saves it, Esc keeps the mark alone"
                      className="h-7 min-w-0 flex-1 rounded-[7px] bg-raised px-2.5 text-[12.5px] text-fg outline-none ring-1 ring-inset ring-line-strong placeholder:text-fg-3 focus:ring-human-line"
                      data-session-note
                    />
                  </motion.div>
                ) : freshIssue ? (
                  <motion.div key={`i${freshIssue.t}`} initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -12, opacity: 0 }} className="absolute inset-0 flex items-center gap-1.5 text-[12.5px] text-bad">
                    <TriangleAlert className="size-3.5 shrink-0" />
                    <span className="truncate">{freshIssue.text}</span>
                  </motion.div>
                ) : caption ? (
                  <motion.div key={`c${caption.t}`} initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -12, opacity: 0 }} className="absolute inset-0 flex items-center">
                    <span dir="auto" className="truncate text-[12.5px] text-fg-2">
                      “{caption.text}”
                    </span>
                  </motion.div>
                ) : (
                  <motion.div key="hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 flex items-center text-[12.5px] text-fg-3">
                    {live.mic === 'on' || live.mic === 'starting' ? 'Use your app and say what you notice — it appears here as you talk.' : 'Use your app; everything you do is being captured. Press M to note what you notice.'}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="hidden items-center gap-3 text-[11.5px] text-fg-3 md:flex">
              <span>
                <b className="tabular font-semibold text-fg">{live.counts.events}</b> events
              </span>
              <span>
                <b className="tabular font-semibold text-fg">{live.counts.speech}</b> said
              </span>
              <span className={issues ? 'text-bad' : ''}>
                <b className={issues ? 'tabular font-semibold' : 'tabular font-semibold text-fg'}>{issues}</b> issues
              </span>
              {live.lost ? (
                <Tip label="The studio couldn’t be reached for a long while: some narration or video wasn’t kept. Check that the studio is still running.">
                  <span className="text-bad">some not saved</span>
                </Tip>
              ) : (
                live.backlog > 6 && (
                  <Tip label="Waiting to reach the studio; nothing is lost yet.">
                    <span className="text-warn">uploading…</span>
                  </Tip>
                )
              )}
            </div>

            <div className="flex items-center gap-1">
              <Tip label="Mark this moment, and say what you noticed" kbd="M">
                <Button size="sm" variant="ghost" icon={<Flag />} onClick={() => sessions.mark('', 'button')} disabled={live.status !== 'recording'}>
                  Mark
                </Button>
              </Tip>
              {live.mic === 'on' && (
                <Tip label={live.paused ? 'Resume recording your voice' : 'Pause recording your voice'}>
                  <Button size="sm" variant="ghost" icon={live.paused ? <Play /> : <Pause />} onClick={() => sessions.client.setPaused(!live.paused)}>
                    {live.paused ? 'Resume' : 'Pause'}
                  </Button>
                </Tip>
              )}
              {/* While it starts, the same button calls it off: starting can wait on the browser, and that mustn't trap you. */}
              <Button size="sm" variant="primary" className="!bg-bad !text-white hover:!bg-bad/90" icon={<Square className="fill-current" />} onClick={() => void sessions.stop()} disabled={live.status === 'stopping'}>
                {live.status === 'stopping' ? 'Saving…' : live.status === 'starting' ? 'Cancel' : 'Stop'}
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
