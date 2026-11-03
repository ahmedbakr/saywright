/**
 * Reach calibration: point at four targets near the screen corners and hold
 * still (or pinch). The comfortable area your fingertip covers in the camera
 * becomes the whole screen, so small, relaxed movements reach everywhere.
 */
import { AnimatePresence, motion } from 'motion/react';
import { Check, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { HandPreview } from '@/components/HandPreview';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { controller } from '@/core/controller';
import type { HandFrame } from '@/core/hand/engine';
import { useSettings } from '@/core/settings';
import { get, set, useStudio } from '@/core/store';
import { cn } from '@/lib/cn';

const INSET = 0.07;
const TARGETS = [
  { x: INSET, y: INSET, label: 'top left' },
  { x: 1 - INSET, y: INSET, label: 'top right' },
  { x: 1 - INSET, y: 1 - INSET, label: 'bottom right' },
  { x: INSET, y: 1 - INSET, label: 'bottom left' },
];
const HOLD_MS = 750;
const STILL = 0.014;
/** How far (camera units) the fingertip must travel from the last corner before the next one counts. */
const MOVE_ON = 0.05;

type Pt = { x: number; y: number };

/** Solve the linear mapping camera → screen from the four captured points. */
function boxFromSamples(s: Pt[]): { x0: number; y0: number; x1: number; y1: number } | null {
  if (s.length !== 4) return null;
  const left = (s[0].x + s[3].x) / 2;
  const right = (s[1].x + s[2].x) / 2;
  const top = (s[0].y + s[1].y) / 2;
  const bottom = (s[2].y + s[3].y) / 2;
  const sw = (right - left) / (1 - 2 * INSET);
  const sh = (bottom - top) / (1 - 2 * INSET);
  if (sw < 0.1 || sh < 0.08 || sw > 1.4 || sh > 1.4) return null;
  return { x0: left - INSET * sw, x1: right + INSET * sw, y0: top - INSET * sh, y1: bottom + INSET * sh };
}

export function Calibration() {
  const open = useStudio((s) => s.overlay === 'calibrate');
  const cam = useStudio((s) => s.camera.status);
  const present = useStudio((s) => s.hand.present);
  const [step, setStep] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const samples = useRef<Pt[]>([]);
  const buf = useRef<{ t: number; x: number; y: number }[]>([]);
  const wasPinching = useRef(false);
  const done = step >= 4;

  useEffect(() => {
    if (!open) return;
    controller.calibrating = true;
    setStep(0);
    setProgress(0);
    setError(null);
    samples.current = [];
    buf.current = [];
    if (cam !== 'on') void controller.startCamera();
    return () => {
      controller.calibrating = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per opening: the camera starting mustn't restart it
  }, [open]);

  useEffect(() => {
    if (!open || done) return;
    const onFrame = (f: HandFrame) => {
      const lm = controller.engine.state.landmarks;
      if (!controller.engine.state.present || !lm) {
        buf.current = [];
        setProgress(0);
        return;
      }
      const p = { t: f.t, x: 1 - lm[8].x, y: lm[8].y };
      // After a capture, wait until the hand clearly moves on, so one still hand can't fill two corners.
      const prev = samples.current[samples.current.length - 1];
      if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < MOVE_ON) {
        buf.current = [];
        setProgress(0);
        return;
      }
      buf.current.push(p);
      // The last HOLD_MS and the frame just before them, so the stillness reaches HOLD_MS however the camera's frames
      // fall: a window of only the last HOLD_MS stays one frame short when they come evenly (every 40 ms: 720 ms).
      while (buf.current.length > 1 && buf.current[1].t <= f.t - HOLD_MS) buf.current.shift();
      const n = buf.current.length;
      const mx = buf.current.reduce((a, b) => a + b.x, 0) / n;
      const my = buf.current.reduce((a, b) => a + b.y, 0) / n;
      const spread = Math.max(...buf.current.map((b) => Math.hypot(b.x - mx, b.y - my)));
      const span = buf.current[n - 1].t - buf.current[0].t;
      const pinching = controller.engine.state.pinching;
      const pinched = pinching && !wasPinching.current;
      wasPinching.current = pinching;
      if (spread > STILL) {
        // Moving: keep only the newest sample so the hold restarts.
        buf.current = [p];
        setProgress(0);
        if (!pinched) return;
      } else setProgress(Math.min(1, span / HOLD_MS));
      if (pinched || (spread <= STILL && span >= HOLD_MS)) {
        samples.current.push(pinched ? { x: p.x, y: p.y } : { x: mx, y: my });
        buf.current = [];
        setProgress(0);
        setStep((s) => s + 1);
      }
    };
    controller.frameListeners.add(onFrame);
    return () => void controller.frameListeners.delete(onFrame);
  }, [open, done]);

  useEffect(() => {
    if (!open || !done) return;
    const box = boxFromSamples(samples.current);
    if (!box) {
      setError('Those points were too close together. Point at each target with your whole arm, and try again.');
      return;
    }
    useSettings.getState().setEngine({ box });
  }, [open, done]);

  const close = () => {
    const back = get().calibrateReturn;
    set({ overlay: back, calibrateReturn: null, ...(back === 'onboarding' ? { onboardingStep: get().onboardingStep + 1 } : {}) });
  };
  const retry = () => {
    samples.current = [];
    buf.current = [];
    setError(null);
    setProgress(0);
    setStep(0);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') set({ overlay: get().calibrateReturn, calibrateReturn: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="calibrate"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[90] bg-[#07080a]/92 backdrop-blur-md"
          role="dialog"
          aria-label="Calibrate reach"
        >
          {TARGETS.map((t, i) => (
            <Target key={i} x={t.x} y={t.y} state={i < step ? 'done' : i === step && !done ? 'active' : 'idle'} progress={i === step ? progress : 0} />
          ))}
          <div className="absolute left-1/2 top-1/2 w-[400px] -translate-x-1/2 -translate-y-1/2 text-center">
            <div className="mb-4 flex justify-center gap-1.5">
              {TARGETS.map((_, i) => (
                <span key={i} className={cn('h-1 w-8 rounded-full transition-colors', i < step ? 'bg-human' : 'bg-white/15')} />
              ))}
            </div>
            {error ? (
              <>
                <h2 className="text-[18px] font-semibold text-white">Let’s try that again</h2>
                <p className="mt-2 text-[13px] leading-relaxed text-white/65">{error}</p>
                <div className="mt-5 flex justify-center gap-2">
                  <Button variant="ghost" className="text-white/70 hover:text-white" onClick={close}>
                    Cancel
                  </Button>
                  <Button variant="human" onClick={retry}>
                    Try again
                  </Button>
                </div>
              </>
            ) : done ? (
              <>
                <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-human text-[#1b1203]">
                  <Check className="size-5" />
                </div>
                <h2 className="text-[18px] font-semibold text-white">Reach calibrated</h2>
                <p className="mt-2 text-[13px] leading-relaxed text-white/65">Your comfortable pointing area now covers the whole screen.</p>
                <div className="mt-5 flex justify-center gap-2">
                  <Button variant="ghost" className="text-white/70 hover:text-white" onClick={retry}>
                    Redo
                  </Button>
                  <Button variant="human" onClick={close}>
                    Continue
                  </Button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-[18px] font-semibold text-white">Point at the {TARGETS[step].label} target</h2>
                <p className="mt-2 text-[13px] leading-relaxed text-white/65">
                  {cam !== 'on'
                    ? 'Starting the camera…'
                    : !present
                      ? 'Raise one hand so the camera can see it.'
                      : 'Aim where it feels natural, then hold still for a moment, or pinch.'}
                </p>
                <HandPreview className="mx-auto mt-5 h-[120px] w-[160px] rounded-[12px] ring-1 ring-white/10" box={false} />
                <p className="mt-5 text-[12px] text-white/40">
                  <Kbd tone="onDark">Esc</Kbd> to cancel
                </p>
              </>
            )}
          </div>
          <button data-hand onClick={() => set({ overlay: get().calibrateReturn, calibrateReturn: null })} className="absolute right-5 top-5 rounded-[8px] p-2 text-white/50 hover:bg-white/10 hover:text-white" aria-label="Close">
            <X className="size-4" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Target({ x, y, state, progress }: { x: number; y: number; state: 'idle' | 'active' | 'done'; progress: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${x * 100}%`, top: `${y * 100}%` }}>
      <motion.svg width="76" height="76" viewBox="0 0 76 76" animate={{ scale: state === 'active' ? 1 : 0.8, opacity: state === 'idle' ? 0.35 : 1 }} transition={{ type: 'spring', stiffness: 400, damping: 28 }}>
        <circle cx="38" cy="38" r={r} fill="none" stroke={state === 'done' ? '#3dd68c' : 'rgba(255,255,255,.25)'} strokeWidth="2" />
        {state === 'active' && (
          <circle cx="38" cy="38" r={r} fill="none" stroke="#ffb224" strokeWidth="4" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - progress)} transform="rotate(-90 38 38)" />
        )}
        {state === 'done' ? (
          <path d="M30 38.5l5.5 5.5 11-12" fill="none" stroke="#3dd68c" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <>
            <circle cx="38" cy="38" r="4" fill={state === 'active' ? '#ffb224' : 'rgba(255,255,255,.5)'} />
            {state === 'active' && <circle cx="38" cy="38" r="12" fill="none" stroke="#ffb224" strokeOpacity=".5" strokeWidth="1.5" className="origin-center animate-ping" />}
          </>
        )}
      </motion.svg>
    </div>
  );
}
