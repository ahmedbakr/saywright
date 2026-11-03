/**
 * Setting up voice, and hand control when it is on in Labs: how it works, a
 * camera check, reach calibration and a pinch practice, then talking or typing.
 * Never shown by itself (a first run gets the quick-start tour instead): it
 * opens from Settings, from the tour's mic check, and when hand control is
 * turned on. Every step can be skipped; mouse and keyboard always work.
 */
import { AnimatePresence, motion } from 'motion/react';
import { Check, Eye, GitCompareArrows, Hand, Lock, Mic, MousePointer2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HandPreview } from '@/components/HandPreview';
import { Logo } from '@/components/Logo';
import { BRAND } from '@shared/brand';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { PeaceGlyph, PinchGlyph, PointGlyph } from '@/components/ui/gestures';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/misc';
import { Slider } from '@/components/ui/slider';
import { controller } from '@/core/controller';
import { pinchFromSensitivity, sensitivityFromPinch, useHandLab, useSettings } from '@/core/settings';
import { get, set, useStudio } from '@/core/store';
import { useTour } from '@/core/tour';
import { cn } from '@/lib/cn';
import { keys, shortcut } from '@/lib/format';
import { PrivacyNote } from './Privacy';

const STEPS = ['How it works', 'Camera', 'Reach', 'Pinch', 'Talk or type'];
/** The steps shown: the camera ones only with hand control turned on in Labs. */
const shownSteps = (handLab: boolean) => STEPS.map((name, i) => ({ name, i })).filter((s) => handLab || (s.i !== 1 && s.i !== 2 && s.i !== 3));

export function Onboarding() {
  const open = useStudio((s) => s.overlay === 'onboarding');
  const step = useStudio((s) => s.onboardingStep);
  const handLab = useHandLab();
  const steps = shownSteps(handLab);
  const go = (n: number) => set({ onboardingStep: n });
  const [handOff, setHandOff] = useState(false);
  // Opened from the quick-start tour (its mic check): the tour goes on, so no “you’re set” yet.
  const touring = () => useTour.getState().on;
  const finish = (off = handOff) => {
    useSettings.getState().set({ onboarded: true });
    set({ overlay: null, onboardingStep: 0 });
    setHandOff(false);
    if (off) controller.notify('Hand control is off. Turn it on again in Settings → Labs.', 'info');
    else if (!touring()) controller.notify('You’re set. Point at something in your app and talk.', 'ok');
  };
  // Skipping hand control turns the Lab off (no camera, no Camera button); a first tour still goes on to voice.
  const skipHand = () => {
    useSettings.getState().setLabs({ hand: false });
    setHandOff(true);
    if (useSettings.getState().onboarded) finish(true);
    else go(4);
  };
  // Skipping the voice check to type: the command bar has focus, ready.
  const typeInstead = () => {
    finish();
    set({ focusInput: get().focusInput + 1 });
    if (!touring()) controller.notify('You’re set. Point at something in your app, then type what to change.', 'ok');
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) finish();
      }}
      title={`Set up ${BRAND.name}`}
      position="top"
      className="w-[min(600px,calc(100vw-32px))]"
    >
      <div className="flex items-center gap-1.5 border-b border-line px-5 py-3">
        {steps.map(({ name: s, i }, k) => (
          <div key={s} className="flex items-center gap-1.5">
            <span
              className={cn(
                'flex size-[18px] items-center justify-center rounded-full text-[10.5px] font-semibold',
                i < step ? 'bg-human text-[#1b1203]' : i === step ? 'bg-fg text-inverse' : 'bg-active text-fg-3',
              )}
            >
              {i < step ? <Check className="size-3" /> : k + 1}
            </span>
            <span className={cn('text-[12px]', i === step ? 'font-medium text-fg' : 'text-fg-3')}>{s}</span>
            {k < steps.length - 1 && <span className="mx-1 h-px w-4 bg-line-strong" />}
          </div>
        ))}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {/* Steps differ in height: the dialog stays put at the top, and each step's buttons sit at its bottom. */}
        <motion.div key={step} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.16 }} className="flex min-h-[340px] flex-col">
          {step === 0 && <Welcome handLab={handLab} onHands={() => go(1)} onSkip={() => go(4)} />}
          {handLab && step === 1 && <CameraStep onNext={() => go(2)} onSkip={skipHand} />}
          {handLab && step === 2 && <ReachStep onSkip={() => go(3)} />}
          {handLab && step === 3 && <PinchStep onNext={() => go(4)} />}
          {step === 4 && <VoiceStep onDone={() => finish()} onType={typeInstead} />}
        </motion.div>
      </AnimatePresence>
    </Dialog>
  );
}

function Body({ children }: { children: ReactNode }) {
  return <div className="flex-1 px-6 pb-2 pt-5">{children}</div>;
}

function Footer({ children, left }: { children: ReactNode; left?: ReactNode }) {
  return (
    <div className="mt-4 flex shrink-0 items-center justify-between border-t border-line px-5 py-3">
      <div>{left}</div>
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

function Feature({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-sunken text-fg-2 ring-1 ring-inset ring-line [&_svg]:size-[16px]">{icon}</span>
      <div>
        <div className="text-[13px] font-medium text-fg">{title}</div>
        <div className="text-[12.5px] leading-relaxed text-fg-3">{children}</div>
      </div>
    </div>
  );
}

function Welcome({ handLab, onHands, onSkip }: { handLab: boolean; onHands: () => void; onSkip: () => void }) {
  return (
    <>
      <Body>
        <Logo className="mb-4 size-10" />
        <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-fg">Point at your app. Say what to change.</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-fg-3">{BRAND.name} turns pointing and talking into code changes you can see right away, keep, or undo.</p>
        <div className="mt-5 space-y-3.5">
          <Feature icon={<MousePointer2 />} title="“This” is whatever you point at">
            Point while you talk or type: “make <b className="font-medium text-human-fg">this</b> look like <b className="font-medium text-human-fg">that</b>”.
          </Feature>
          <Feature icon={<GitCompareArrows />} title="Every change is a live preview">
            It lands in your code and your app at once. <Kbd>{shortcut('enter')}</Kbd> keeps it,{' '}
            {keys('mod+z').map((k) => (
              <Kbd key={k} className="me-0.5">
                {k}
              </Kbd>
            ))}{' '}
            undoes it.
          </Feature>
          <Feature icon={<Sparkles />} title="Simple edits are instant, AI does the rest">
            Size, variant, text, move and remove run offline in milliseconds. Bigger asks go to the AI you connect: your Claude, ChatGPT or Gemini plan, an API key, or a model on this computer.
          </Feature>
          <Feature icon={<Lock />} title="What leaves your computer">
            <PrivacyNote className="text-[12.5px]" />
          </Feature>
        </div>
      </Body>
      <Footer
        left={
          handLab ? (
            <button data-hand onClick={onSkip} className="text-[12.5px] text-fg-3 hover:text-fg">
              Skip, I’ll use the mouse
            </button>
          ) : null
        }
      >
        {handLab ? (
          <Button variant="primary" size="md" icon={<Hand />} onClick={onHands}>
            Set up hand control
          </Button>
        ) : (
          <Button variant="primary" size="md" onClick={onSkip}>
            Continue
          </Button>
        )}
      </Footer>
    </>
  );
}

function CameraStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const cam = useStudio((s) => s.camera);
  const present = useStudio((s) => s.hand.present);
  useEffect(() => {
    if (get().camera.status !== 'on') void controller.startCamera();
  }, []);
  return (
    <>
      <Body>
        <h2 className="text-[17px] font-semibold text-fg">Show your hand to the camera</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-fg-3">Allow camera access when your browser asks. Sit about an arm’s length away, with your hand in front of your chest.</p>
        <div className="relative mt-4 aspect-[4/3] w-full overflow-hidden rounded-[12px] ring-1 ring-line">
          <HandPreview className="absolute inset-0" box={false} />
          {cam.status !== 'on' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-sunken text-[12.5px] text-fg-3">
              {cam.status === 'error' ? (
                <>
                  <Eye className="size-5 text-bad" />
                  <span className="max-w-[360px] text-center text-fg-2">{cam.error}</span>
                  <Button size="sm" onClick={() => void controller.startCamera()}>
                    Try again
                  </Button>
                </>
              ) : (
                <>
                  <Spinner className="size-5" />
                  Starting the camera and the hand model…
                </>
              )}
            </div>
          )}
          {cam.status === 'on' && (
            <div className={cn('absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1.5 text-[12.5px] font-medium backdrop-blur', present ? 'bg-human text-[#1b1203]' : 'bg-black/60 text-white')}>
              {present ? (
                <>
                  <Check className="size-4" /> Hand found
                </>
              ) : (
                <>Raise one hand, palm towards the screen</>
              )}
            </div>
          )}
        </div>
      </Body>
      <Footer
        left={
          <button data-hand onClick={onSkip} className="text-[12.5px] text-fg-3 hover:text-fg">
            Skip hand control
          </button>
        }
      >
        <Button variant="primary" size="md" disabled={cam.status !== 'on'} onClick={onNext}>
          Continue
        </Button>
      </Footer>
    </>
  );
}

function ReachStep({ onSkip }: { onSkip: () => void }) {
  return (
    <>
      <Body>
        <h2 className="text-[17px] font-semibold text-fg">Map your reach to the screen</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-fg-3">
          You’ll point at four targets near the corners. Small, relaxed movements will then cover the whole screen, so your arm doesn’t get tired.
        </p>
        <div className="mt-5 grid grid-cols-3 gap-3">
          {[
            ['Point', 'with your index finger, where it feels natural', <PointGlyph key="p" />],
            ['Hold still', 'for a moment, or pinch, to capture each corner', <PinchGlyph key="q" />],
            ['Four corners', 'top left, top right, bottom right, bottom left', <Hand key="h" />],
          ].map(([t, d, icon]) => (
            <div key={t as string} className="rounded-[10px] bg-sunken p-3 ring-1 ring-inset ring-line">
              <span className="text-human-fg [&_svg]:size-5">{icon}</span>
              <div className="mt-2 text-[12.5px] font-medium text-fg">{t}</div>
              <div className="text-[12px] leading-snug text-fg-3">{d}</div>
            </div>
          ))}
        </div>
      </Body>
      <Footer
        left={
          <button data-hand onClick={onSkip} className="text-[12.5px] text-fg-3 hover:text-fg">
            Use the default reach
          </button>
        }
      >
        <Button variant="primary" size="md" onClick={() => set({ overlay: 'calibrate', calibrateReturn: 'onboarding' })}>
          Start calibration
        </Button>
      </Footer>
    </>
  );
}

function PinchMeter() {
  const fill = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const st = controller.engine.state;
      if (fill.current) {
        fill.current.style.width = `${(st.present ? st.pinchAmount : 0) * 100}%`;
        fill.current.style.background = st.pinching ? 'var(--human)' : 'var(--fg-3)';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="relative h-2 overflow-hidden rounded-full bg-active">
      <div ref={fill} className="absolute inset-y-0 left-0 rounded-full transition-[background] duration-100" />
    </div>
  );
}

function PinchStep({ onNext }: { onNext: () => void }) {
  const [hit, setHit] = useState<boolean[]>([false, false, false]);
  const pinchOn = useSettings((s) => s.engine.pinchOn);
  const setEngine = useSettings((s) => s.setEngine);
  const all = hit.every(Boolean);
  return (
    <>
      <Body>
        <h2 className="text-[17px] font-semibold text-fg">Pinch the three targets</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-fg-3">
          Point at a target and tap your thumb and index finger together. The click lands where you were pointing just before the pinch, so a little wobble is fine.
        </p>
        <div className="mt-5 flex justify-center gap-6">
          {hit.map((h, i) => (
            <button
              key={i}
              data-hand
              onClick={() => setHit((x) => x.map((v, j) => (j === i ? true : v)))}
              className={cn(
                'flex size-[86px] items-center justify-center rounded-[18px] text-[13px] font-medium transition-all duration-200',
                h ? 'bg-human text-[#1b1203]' : 'bg-sunken text-fg-2 ring-1 ring-inset ring-line-strong hover:text-fg',
              )}
            >
              {h ? <Check className="size-6" /> : `Target ${i + 1}`}
            </button>
          ))}
        </div>
        <div className="mt-6 space-y-2 rounded-[10px] bg-sunken p-3 ring-1 ring-inset ring-line">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-fg-2">Pinch closeness</span>
            <span className="text-fg-3">fills up as your fingers close</span>
          </div>
          <PinchMeter />
          <div className="flex items-center gap-3 pt-1">
            <span className="w-[86px] text-[12px] text-fg-2">Sensitivity</span>
            <span className="text-[11.5px] text-fg-3">Firm</span>
            <Slider value={sensitivityFromPinch(pinchOn)} onChange={(v) => setEngine(pinchFromSensitivity(v))} />
            <span className="text-[11.5px] text-fg-3">Light</span>
          </div>
        </div>
      </Body>
      <Footer
        left={
          <button data-hand onClick={() => set({ overlay: 'calibrate', calibrateReturn: 'onboarding', onboardingStep: 2 })} className="text-[12.5px] text-fg-3 hover:text-fg">
            Recalibrate reach
          </button>
        }
      >
        <Button variant={all ? 'primary' : 'secondary'} size="md" onClick={onNext}>
          {all ? 'Continue' : 'Skip'}
        </Button>
      </Footer>
    </>
  );
}

function VoiceStep({ onDone, onType }: { onDone: () => void; onType: () => void }) {
  const voice = useStudio((s) => s.voice);
  const handOn = useStudio((s) => s.camera.status === 'on');
  const [heard, setHeard] = useState<string | null>(null);
  useEffect(() => {
    controller.dryRun = (t) => setHeard(t);
    return () => {
      controller.dryRun = null;
    };
  }, []);
  const live = voice.state === 'starting' || voice.state === 'listening';
  return (
    <>
      <Body>
        <h2 className="text-[17px] font-semibold text-fg">Talk to it</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-fg-3">
          Hold <Kbd>Space</Kbd> and say something, like “make this bigger”, then let go. Rather type? Everything works typed too: press <Kbd>/</Kbd> or click the box at the bottom.
          {handOn && (
            <>
              {' '}
              Or hold a peace sign <PeaceGlyph className="inline size-4 align-[-3px] text-human-fg" /> and pause when you’re done.
            </>
          )}
        </p>
        <div
          className={cn(
            'mt-5 flex min-h-[110px] flex-col items-center justify-center gap-2 rounded-[12px] p-4 text-center ring-1 ring-inset transition-colors',
            live ? 'bg-human-soft ring-human-line' : heard ? 'bg-ok-soft ring-ok/25' : 'bg-sunken ring-line',
          )}
        >
          {!voice.supported ? (
            <span className="text-[12.5px] text-fg-2">Voice isn’t available here (no microphone, or no speech recognition in this browser). Type your requests instead.</span>
          ) : live ? (
            <>
              <Mic className="size-5 text-human-fg" />
              <span className="text-[15px] text-fg">{voice.words.join(' ') || 'Listening…'}</span>
            </>
          ) : heard ? (
            <>
              <Check className="size-5 text-ok" />
              <span className="text-[15px] text-fg">“{heard}”</span>
              <span className="text-[12px] text-fg-3">Heard you. In the studio, that would apply to what you point at.</span>
            </>
          ) : voice.error ? (
            <span className="text-[12.5px] text-bad">
              {voice.error} You can type your requests instead.
            </span>
          ) : (
            <>
              <Mic className="size-5 text-fg-3" />
              <span className="text-[12.5px] text-fg-3">Waiting for you to talk…</span>
            </>
          )}
        </div>
        <p className="mt-3 text-[12px] text-fg-3">
          Your browser recognises speech{voice.model === 'ready' ? ', and a speech model on this computer double-checks it' : ''}. Not catching you well? Settings → Voice has a mic test and other options.
        </p>
      </Body>
      <Footer
        left={
          !heard && (
            <button data-hand onClick={onType} className="text-[12.5px] text-fg-3 hover:text-fg" data-skip-voice>
              Skip, I’ll type
            </button>
          )
        }
      >
        <Button variant="primary" size="md" onClick={onDone}>
          {heard ? 'Start building' : 'Finish'}
        </Button>
      </Footer>
    </>
  );
}
