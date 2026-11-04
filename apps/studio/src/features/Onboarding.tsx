/**
 * The voice check: how the studio works, then talking or typing. Never shown
 * by itself (a first run gets the quick-start tour instead): it opens from
 * Settings and from the tour's mic check. Every step can be skipped; mouse and
 * keyboard always work.
 */
import { AnimatePresence, motion } from 'motion/react';
import { Check, GitCompareArrows, Lock, Mic, MousePointer2, Sparkles } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Logo } from '@/components/Logo';
import { BRAND } from '@shared/brand';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { controller } from '@/core/controller';
import { useSettings } from '@/core/settings';
import { get, set, useStudio } from '@/core/store';
import { useTour } from '@/core/tour';
import { cn } from '@/lib/cn';
import { keys, shortcut } from '@/lib/format';
import { PrivacyNote } from './Privacy';

const STEPS = ['How it works', 'Talk or type'];
/** The voice step, where Settings and the tour open it. */
export const VOICE_STEP = 1;

export function Onboarding() {
  const open = useStudio((s) => s.overlay === 'onboarding');
  const step = useStudio((s) => s.onboardingStep);
  const go = (n: number) => set({ onboardingStep: n });
  // Opened from the quick-start tour (its mic check): the tour goes on, so no “you’re set” yet.
  const touring = () => useTour.getState().on;
  const finish = () => {
    useSettings.getState().set({ onboarded: true });
    set({ overlay: null, onboardingStep: 0 });
    if (!touring()) controller.notify('You’re set. Point at something in your app and talk.', 'ok');
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
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-1.5">
            <span
              className={cn(
                'flex size-[18px] items-center justify-center rounded-full text-[10.5px] font-semibold',
                i < step ? 'bg-human text-[#1b1203]' : i === step ? 'bg-fg text-inverse' : 'bg-active text-fg-3',
              )}
            >
              {i < step ? <Check className="size-3" /> : i + 1}
            </span>
            <span className={cn('text-[12px]', i === step ? 'font-medium text-fg' : 'text-fg-3')}>{s}</span>
            {i < STEPS.length - 1 && <span className="mx-1 h-px w-4 bg-line-strong" />}
          </div>
        ))}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {/* Steps differ in height: the dialog stays put at the top, and each step's buttons sit at its bottom. */}
        <motion.div key={step} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.16 }} className="flex min-h-[340px] flex-col">
          {step === 0 && <Welcome onNext={() => go(VOICE_STEP)} />}
          {step === VOICE_STEP && <VoiceStep onDone={finish} onType={typeInstead} />}
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

function Welcome({ onNext }: { onNext: () => void }) {
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
      <Footer>
        <Button variant="primary" size="md" onClick={onNext}>
          Continue
        </Button>
      </Footer>
    </>
  );
}

function VoiceStep({ onDone, onType }: { onDone: () => void; onType: () => void }) {
  const voice = useStudio((s) => s.voice);
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
            <button onClick={onType} className="text-[12.5px] text-fg-3 hover:text-fg" data-skip-voice>
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
