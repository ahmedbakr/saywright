/**
 * Settings → Voice: the speech models on this computer, and a check of how
 * accurately each recogniser hears *your* voice (read sentences, compare).
 */
import { Check, Download, Mic, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dot, Spinner } from '@/components/ui/misc';
import { controller } from '@/core/controller';
import { sessions, useSessions } from '@/core/sessions';
import { useSettings } from '@/core/settings';
import { useStudio, type HeardSentence } from '@/core/store';
import { cn } from '@/lib/cn';
import { wordErrorRate } from '@shared/text-compare';

export function SpeechModels() {
  const speech = useSessions((s) => s.speech);
  useEffect(() => void sessions.refreshSpeech(), []);
  if (!speech) return <Spinner className="size-3.5 text-fg-3" />;
  if (speech.runtime === 'missing')
    return <p className="text-[12px] text-warn">The speech engine isn’t installed for this platform. Run npm install again; voice still works through the browser.</p>;
  // The most accurate Arabic model, when it isn't installed yet: worth saying how much better it is.
  const bestArabic = speech.models.filter((m) => m.wordErrors.ar != null).sort((a, b) => a.wordErrors.ar! - b.wordErrors.ar!)[0];
  const arabicNow = speech.models.find((m) => m.id === speech.active.ar);
  const upgrade = bestArabic && !bestArabic.installed && arabicNow?.wordErrors.ar != null && arabicNow.id !== bestArabic.id ? { now: arabicNow.wordErrors.ar, best: bestArabic } : null;
  return (
    <div className="space-y-2">
      {upgrade && (
        <p className="rounded-[10px] bg-ai-soft px-3 py-2 text-[12px] text-ai-fg ring-1 ring-inset ring-ai-line/30" data-arabic-upgrade>
          For Arabic, {upgrade.best.label.split(' (')[0]} gets {upgrade.best.wordErrors.ar}% of words wrong, against {upgrade.now}% with the model you have (measured on real speech). It is a{' '}
          {(upgrade.best.sizeMb / 1000).toFixed(1)} GB download, once.
        </p>
      )}
      <div className="divide-y divide-line rounded-[10px] ring-1 ring-inset ring-line">
        {speech.runtime === 'failed' && <p className="px-3 py-2 text-[12px] text-bad">The speech engine crashed: {speech.runtimeError}</p>}
        {speech.models.map((m) => {
          const uses = (['ar', 'en'] as const).filter((l) => speech.active[l] === m.id);
          const measured = (['ar', 'en'] as const).filter((l) => m.wordErrors[l] != null).map((l) => `${l === 'ar' ? 'Arabic' : 'English'} ${m.wordErrors[l]}%`);
          return (
            <div key={m.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg">
                  {m.installed && <Dot tone="ok" />}
                  {m.label}
                </div>
                <div className="text-[11.5px] text-fg-3">
                  {m.sizeMb >= 1000 ? `${(m.sizeMb / 1000).toFixed(1)} GB` : `${m.sizeMb} MB`}
                  {measured.length > 0 && <span title="Words it gets wrong per hundred, on real read speech (FLEURS)"> · word errors: {measured.join(', ')}</span>}
                  {uses.length > 0 && ` · used for ${uses.map((l) => (l === 'ar' ? 'Arabic' : 'English')).join(' and ')}`}
                  {m.error && <span className="text-bad"> · {m.error}</span>}
                </div>
                {m.installing != null && (
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-active">
                    <div className="h-full bg-ai transition-[width] duration-300" style={{ width: `${m.installing}%` }} />
                  </div>
                )}
              </div>
              {m.installed ? (
                <Check className="size-4 text-ok" />
              ) : m.installing != null ? (
                <span className="tabular text-[11.5px] text-fg-3">{m.installing}%</span>
              ) : (
                <Button size="xs" icon={<Download />} onClick={() => void sessions.installSpeech(m.id)}>
                  Install
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SENTENCES: Record<'ar' | 'en', string[]> = {
  ar: [
    'كبّر هذا',
    'الإجمالي غلط، المفروض يكون ثمانين دولار وثمانين سنت',
    'زرار الدفع مش بيشتغل لما أضغط عليه',
    'غيّر لون الزرار ده للأخضر',
    'الصفحة بطيئة جدًا في التحميل',
    'تراجع',
  ],
  en: [
    'Make this bigger',
    'The total is wrong, it should be eighty dollars eighty',
    'The pay button does nothing when I click it',
    'Change this button to green',
    'The page takes too long to load',
    'Undo',
  ],
};

interface Attempt {
  said: string;
  browser: string;
  device: string;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function AccuracyCheck() {
  const langSetting = useSettings((s) => s.voice.lang);
  const lang: 'ar' | 'en' = /^ar\b/i.test(langSetting) ? 'ar' : 'en';
  const voice = useStudio((s) => s.voice);
  const [on, setOn] = useState(false);
  const [index, setIndex] = useState(0);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const indexRef = useRef(0);
  indexRef.current = index;
  const list = SENTENCES[lang];

  useEffect(() => {
    if (!on) return;
    const previous = controller.dryRun;
    controller.dryRun = () => {
      const last: HeardSentence | null = useStudio.getState().voice.last;
      if (!last) return;
      const said = list[indexRef.current];
      setAttempts((a) => [...a, { said, browser: last.browser[0] ?? '', device: last.device }]);
      setIndex((i) => Math.min(list.length, i + 1));
    };
    return () => {
      controller.dryRun = previous;
    };
  }, [on, list]);

  if (!on) {
    return (
      <Button size="sm" icon={<Mic />} onClick={() => (setOn(true), setIndex(0), setAttempts([]))}>
        Start the check ({lang === 'ar' ? 'Arabic' : 'English'})
      </Button>
    );
  }
  const live = voice.state === 'starting' || voice.state === 'listening';
  const done = index >= list.length;
  const score = (k: 'browser' | 'device') => {
    const xs = attempts.filter((a) => a[k]);
    if (!xs.length) return null;
    return 1 - xs.reduce((s, a) => s + Math.min(1, wordErrorRate(a.said, a[k])), 0) / xs.length;
  };
  const b = score('browser');
  const d = score('device');
  return (
    <div className="space-y-3 rounded-[12px] bg-sunken p-3 ring-1 ring-inset ring-line" data-accuracy-check>
      {!done ? (
        <>
          <div className="text-[11.5px] text-fg-3">
            Sentence {index + 1} of {list.length}: hold the button, read it naturally, let go.
          </div>
          <div dir="auto" className="text-[16px] font-medium leading-relaxed text-fg">
            {list[index]}
          </div>
          <button
            type="button"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              controller.pressTalk();
            }}
            onPointerUp={() => controller.releaseTalk()}
            onPointerCancel={() => controller.releaseTalk()}
            className={cn('inline-flex h-8 select-none items-center gap-2 rounded-[9px] px-3 text-[12.5px] font-medium', live ? 'bg-human text-[#1b1203]' : 'bg-raised text-fg ring-1 ring-inset ring-line hover:bg-hover')}
          >
            <Mic className="size-[14px]" />
            {voice.state === 'finishing' ? 'Checking…' : live ? 'Listening' : 'Hold to read'}
          </button>
        </>
      ) : (
        <div className="text-[13px] font-medium text-fg">Done. Words heard correctly:</div>
      )}
      {attempts.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-[9px] bg-raised p-2.5 ring-1 ring-inset ring-line">
            <div className="text-[11.5px] text-fg-3">Browser recogniser</div>
            <div className="tabular text-[18px] font-semibold text-fg">{b == null ? '—' : pct(b)}</div>
          </div>
          <div className="rounded-[9px] bg-raised p-2.5 ring-1 ring-inset ring-line">
            <div className="text-[11.5px] text-fg-3">On this computer</div>
            <div className="tabular text-[18px] font-semibold text-fg">{d == null ? '—' : pct(d)}</div>
          </div>
        </div>
      )}
      {attempts.length > 0 && (
        <div className="max-h-[160px] space-y-1.5 overflow-y-auto text-[12px]">
          {attempts.map((a, i) => (
            <div key={i} className="rounded-[8px] bg-raised px-2.5 py-1.5 ring-1 ring-inset ring-line">
              <div dir="auto" className="font-medium text-fg">
                {a.said}
              </div>
              {a.browser && (
                <div dir="auto" className="text-fg-3">
                  Browser: {a.browser} <span className="tabular">({pct(1 - Math.min(1, wordErrorRate(a.said, a.browser)))})</span>
                </div>
              )}
              {a.device && (
                <div dir="auto" className="text-fg-3">
                  Computer: {a.device} <span className="tabular">({pct(1 - Math.min(1, wordErrorRate(a.said, a.device)))})</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Button size="xs" icon={<RotateCcw />} onClick={() => (setIndex(0), setAttempts([]))}>
          Start over
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setOn(false)}>
          Close
        </Button>
      </div>
    </div>
  );
}
