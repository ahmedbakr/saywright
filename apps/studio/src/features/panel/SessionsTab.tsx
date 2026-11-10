import { CircleDot, FileText, Mic, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Button, IconButton } from '@/components/ui/button';
import { confirmAction } from '@/components/ui/confirm';
import { Empty, Spinner } from '@/components/ui/misc';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { controller } from '@/core/controller';
import { sessions, useSessions } from '@/core/sessions';
import { set, useStudio } from '@/core/store';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/format';
import { scoreTone } from '@/features/report/Scores';
import { BRAND } from '@shared/brand';
import { fmtDuration } from '@shared/session';

export function SessionsTab() {
  const list = useSessions((s) => s.list);
  const live = useSessions((s) => s.live);
  useEffect(() => void sessions.refreshList(), []);
  const recording = live.status === 'recording' || live.status === 'starting';

  return (
    <div className="space-y-3 p-3">
      <div className="rounded-[12px] bg-raised p-3 ring-1 ring-inset ring-line">
        <div className="text-[13px] font-semibold text-fg">Test sessions</div>
        <p className="mt-1 text-[12px] leading-relaxed text-fg-3">Use your app while talking about it. {BRAND.name} captures what happens and writes a report: issues with evidence, scores, and fixes.</p>
        <Button
          size="sm"
          className="mt-2.5 w-full"
          icon={recording ? <span className="size-2 rounded-full bg-bad" style={{ animation: 'rec-pulse 1.4s ease-in-out infinite' }} /> : <CircleDot className="text-bad" />}
          onClick={() => (recording ? void sessions.stop() : useSessions.setState({ setup: true }))}
        >
          {recording ? 'Stop recording' : 'Record a session'}
        </Button>
      </div>
      <AutopilotCard />
      {!list.length && (
        <Empty icon={<Mic />} title="No sessions yet">
          Record one from the top bar. Talk in English or Arabic; nothing leaves this computer unless an AI is connected to write the report.
        </Empty>
      )}
      <div className="space-y-1.5">
        {list.map((m) => {
          const score = m.report?.overall;
          const busy = m.status === 'processing' || m.status === 'recording';
          // What its report found; for a report written before findings were counted, what the recording showed.
          const n = m.report?.findings;
          const found = n != null ? `${n} ${n === 1 ? 'finding' : 'findings'}` : `${m.counts.errors + m.counts.failedRequests + m.counts.frustration} issues`;
          return (
            <div key={m.id} className="group flex items-center gap-3 rounded-[10px] px-2.5 py-2 ring-1 ring-inset ring-transparent hover:bg-hover hover:ring-line">
              <button onClick={() => sessions.openReport(m.id)} className="flex min-w-0 flex-1 items-center gap-3 text-start">
                <span
                  className={cn('flex size-9 shrink-0 items-center justify-center rounded-[9px] text-[13px] font-semibold tabular')}
                  style={score != null ? { background: scoreTone(score).soft, color: scoreTone(score).color } : undefined}
                >
                  {busy ? <Spinner className="size-3.5" /> : score != null ? score : <FileText className="size-4 text-fg-3" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-fg">{m.renamed ? m.name : m.report?.title || m.name}</span>
                  <span className="block truncate text-[11.5px] text-fg-3">
                    {m.status === 'recording' ? 'Recording now' : m.status === 'processing' ? m.stage || 'Writing the report' : m.status === 'failed' ? 'Report failed' : `${ago(m.startedAt)} · ${m.endedAt ? fmtDuration(m.endedAt - m.startedAt) : '?'} · ${m.source === 'autopilot' ? `Autopilot · ${found}` : `${m.counts.speech} said · ${found}`}`}
                  </span>
                </span>
              </button>
              <IconButton
                size="sm"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label="Delete session"
                disabled={m.status === 'recording'}
                onClick={async () => {
                  if (await confirmAction({ title: 'Delete this session?', body: 'Its recordings, screenshots and report are deleted from this computer.', action: 'Delete session', danger: true })) void sessions.remove(m.id);
                }}
              >
                <Trash2 />
              </IconButton>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Autopilot: the AI uses the app like a tester and reports what is wrong (core/autopilot.ts). */
function AutopilotCard() {
  const [goal, setGoal] = useState('');
  const [steps, setSteps] = useState<'10' | '20' | '40'>('20');
  const [risky, setRisky] = useState(false);
  const running = useStudio((s) => !!s.autopilot);
  const connected = useStudio((s) => s.app.connected);
  const aiReady = useStudio((s) => !!s.status?.ai.ready);
  const riskyLabel = useId();
  return (
    <div className="rounded-[12px] bg-raised p-3 ring-1 ring-inset ring-line" data-autopilot-card>
      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
        <Sparkles className="size-3.5 text-ai" />
        Autopilot
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-fg-3">The AI uses your app like a tester, step by step, and reports what is wrong, with the evidence and where it is in the code.</p>
      <input
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        disabled={running}
        placeholder="What to try (optional): add a product and check out"
        aria-label="What Autopilot should try"
        spellCheck={false}
        className="mt-2.5 h-8 w-full rounded-[8px] bg-sunken px-2.5 text-[12.5px] text-fg outline-none ring-1 ring-inset ring-line-strong placeholder:text-fg-3 focus:ring-human-line"
        data-autopilot-goal
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[12px] text-fg-2">Steps, at most</span>
        <Segmented size="sm" value={steps} onChange={setSteps} options={[{ value: '10', label: '10' }, { value: '20', label: '20' }, { value: '40', label: '40' }]} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span id={riskyLabel} className="text-[12px] text-fg-2">
          Let it delete, pay, send and sign out
        </span>
        <Switch checked={risky} onCheckedChange={setRisky} disabled={running} aria-labelledby={riskyLabel} aria-describedby={`${riskyLabel}-hint`} />
      </div>
      <p id={`${riskyLabel}-hint`} className="mt-1 text-[11.5px] leading-snug text-fg-3">
        {risky
          ? 'On: it may use anything, including what deletes, pays, sends or signs out. Use it on test data only.'
          : 'Off: it avoids what looks like deleting, paying, sending or signing out, and never sends a delete request. It can’t know what every control does: use it on test data.'}
      </p>
      <Button
        size="sm"
        className="mt-2.5 w-full"
        icon={<Sparkles />}
        disabled={!running && !connected}
        onClick={() => (running ? controller.autopilot.stop() : void controller.startAutopilot({ goal: goal.trim(), maxSteps: Number(steps), allowRisky: risky }))}
        data-autopilot-start
      >
        {running ? 'Stop Autopilot' : 'Start Autopilot'}
      </Button>
      {!aiReady && (
        <p className="mt-1.5 text-[11.5px] text-fg-3">
          It needs an AI to decide what to try.{' '}
          <button className="font-medium text-human underline-offset-2 hover:underline" onClick={() => set({ overlay: 'settings', settingsTab: 'ai' })}>
            Connect one
          </button>
        </p>
      )}
    </div>
  );
}
