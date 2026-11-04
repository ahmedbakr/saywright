import { Download } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { SectionTitle } from '@/components/ui/misc';
import { controller } from '@/core/controller';
import { useStudio } from '@/core/store';
import { ms } from '@/lib/format';

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-[10px] bg-raised p-3 ring-1 ring-inset ring-line">
      <div className="text-[11.5px] text-fg-3">{label}</div>
      <div className="tabular mt-1 text-[20px] font-semibold tracking-[-0.02em] text-fg">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-fg-3">{hint}</div>}
    </div>
  );
}

function Split({ label, a, b, aLabel, bLabel }: { label: string; a: number; b: number; aLabel: string; bLabel: string }) {
  const total = a + b || 1;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-[11.5px]">
        <span className="text-fg-3">{label}</span>
        <span className="tabular text-fg-2">
          {aLabel} {a} · {bLabel} {b}
        </span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-active">
        <div className="bg-human transition-[width] duration-300" style={{ width: `${(a / total) * 100}%` }} />
        <div className="bg-ai transition-[width] duration-300" style={{ width: `${(b / total) * 100}%` }} />
      </div>
    </div>
  );
}

export function SessionTab() {
  const s = useStudio((st) => st.summary);
  useEffect(() => {
    void controller.refreshSummary();
    const t = setInterval(() => void controller.refreshSummary(), 5000);
    return () => clearInterval(t);
  }, []);
  if (!s) return <div className="p-4 text-[12px] text-fg-3">Loading…</div>;
  return (
    <div className="space-y-4 p-3">
      <p className="px-0.5 text-[12px] leading-relaxed text-fg-3">
        This session, measured on your machine. Use it to compare pointing and talking with how you usually work.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Requests" value={s.commands} hint={`${s.changes} changes · ${s.answers} answers`} />
        <Stat label="Kept on first try" value={s.keepRate == null ? '—' : `${Math.round(s.keepRate * 100)}%`} hint={`${s.kept} kept · ${s.undone} undone`} />
        <Stat label="Time to preview" value={ms(s.medianLatencyMs)} hint={`median · ${s.quick} quick, ${s.ai} AI`} />
        <Stat label="Time to decide" value={ms(s.medianDecisionMs)} hint="median, preview → keep/undo" />
        <Stat label="Words per request" value={s.medianWords ?? '—'} hint="median" />
        <Stat label="Tests" value={`${s.testsPassed}/${s.testsRun}`} hint="passed / run" />
      </div>
      <div className="space-y-3 rounded-[10px] bg-raised p-3 ring-1 ring-inset ring-line">
        <SectionTitle>How you worked</SectionTitle>
        <Split label="Input" a={s.byInput.voice} b={s.byInput.typed} aLabel="voice" bLabel="typed" />
        {/* Requests made while pointing at something (an older studio counted its hand control as pointing too). */}
        <Split label="Pointing" a={s.byPointer.mouse + s.byPointer.hand} b={s.byPointer.none} aLabel="pointed" bLabel="not" />
      </div>
      <a href="/api/metrics/export" download>
        <Button size="sm" icon={<Download />} className="w-full">
          Export session (JSONL)
        </Button>
      </a>
      <p className="px-0.5 text-[11.5px] leading-relaxed text-fg-3">
        Every event is also appended to <span className="font-mono text-fg-2">.saywright/metrics.jsonl</span> in your app’s folder. Nothing is sent anywhere.
      </p>
    </div>
  );
}
