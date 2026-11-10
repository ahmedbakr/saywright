import { CircleAlert, CircleCheck, CircleX, CornerDownLeft, Download, FlaskConical, Globe2, ListChecks, Lock, MousePointerClick, Play, Plus, RotateCcw, Sparkles, Trash2, Type, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Badge, SectionTitle, Spinner } from '@/components/ui/misc';
import { controller } from '@/core/controller';
import { useStudio } from '@/core/store';
import { cn } from '@/lib/cn';
import { shortUrl } from '@/lib/format';
import { checkNumbers, focusOn, shouldBe } from '@shared/text';
import { CodeBlock } from './DiffView';
import { useAiName } from '@/lib/ai-name';
import { api } from '@/lib/api';
import type { RecordedStep } from '@shared/api';

const STEP_ICON = { click: <MousePointerClick />, fill: <Type />, press: <CornerDownLeft />, goto: <Play />, note: <Plus />, url: <Globe2 /> };
const iconOf = (s: RecordedStep) => (s.secret ? <Lock /> : s.select || s.values ? <ListChecks /> : STEP_ICON[s.kind]);

export function TestTab() {
  const mode = useStudio((s) => s.mode);
  const rec = useStudio((s) => s.recorder);
  const selection = useStudio((s) => s.selection);
  const [expected, setExpected] = useState('');
  const [startingOver, setStartingOver] = useState(false);
  const app = useStudio((s) => s.app);
  const target = useStudio((s) => s.status?.target);
  const recording = mode === 'record';
  const empty = !rec.steps.length && !rec.expectations.length;
  const numbers = checkNumbers(rec.expectations, rec.steps.length);

  return (
    <div className="space-y-4 p-3">
      <div className={cn('rounded-[10px] p-3 ring-1 ring-inset', recording ? 'bg-bad-soft ring-bad/25' : 'bg-raised ring-line')}>
        <div className="flex items-center gap-2.5">
          <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-[8px]', recording ? 'bg-bad/15 text-bad' : 'bg-sunken text-fg-3 ring-1 ring-inset ring-line')}>
            {recording ? <span className="size-2.5 rounded-full bg-bad" style={{ animation: 'rec-pulse 1.4s ease-in-out infinite' }} /> : <FlaskConical className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-fg">{recording ? 'Recording your steps' : 'Narrate a bug, get a test'}</div>
            <div className="truncate text-[11.5px] text-fg-3">{recording ? `From ${shortUrl(ownAddress(rec.startUrl ?? '', target))}` : 'Use the app, then say what you expected.'}</div>
          </div>
          {recording ? (
            <Button size="sm" onClick={() => controller.setMode('edit')}>
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => controller.setMode('record')} kbd={<Kbd tone="onDark">R</Kbd>}>
              Write test
            </Button>
          )}
        </div>
        {recording && empty && (
          <ol className="mt-3 space-y-1.5 text-[12px] leading-relaxed text-fg-2">
            <li>1. Click and type in your app as usual. Each action becomes a step.</li>
            <li>2. Point at the wrong value and say “this should show …”.</li>
            <li>3. Say “generate test”, then “run test”.</li>
          </ol>
        )}
      </div>

      {(rec.steps.length > 0 || recording) && (
        <div>
          <SectionTitle
            action={
              !empty && (
                <button className="flex items-center gap-1 text-[11.5px] text-fg-3 hover:text-fg" onClick={() => (controller.awayFromStart() ? setStartingOver(true) : controller.newRecording())}>
                  <RotateCcw className="size-3" /> Start over
                </button>
              )
            }
          >
            Steps
          </SectionTitle>
          {startingOver && (
            <div className="mb-2 rounded-[8px] bg-raised px-2.5 py-2 text-[12px] leading-relaxed text-fg-2 ring-1 ring-inset ring-line" data-start-over>
              Start the new test from this page ({pageOf(app.url)}), or from the app’s start page? A test opens your app in a fresh browser, signed out: if this page needs signing in, start from the start page and sign in as part of the test.
              <div className="mt-1.5 flex flex-wrap justify-end gap-1">
                <Button size="sm" variant="ghost" onClick={() => setStartingOver(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => (setStartingOver(false), controller.newRecording())}>
                  From this page
                </Button>
                <Button size="sm" variant="primary" onClick={() => (setStartingOver(false), controller.newRecording(true))}>
                  From the start page
                </Button>
              </div>
            </div>
          )}
          {rec.steps.length ? (
            <ol className="space-y-1">
              {rec.steps.map((s, i) => (
                <li key={i} className="group flex items-center gap-2 rounded-[8px] bg-raised px-2 py-1.5 text-[12.5px] ring-1 ring-inset ring-line">
                  <span className="w-4 text-right font-mono text-[11px] text-fg-3">{i + 1}</span>
                  <span className="text-fg-3 [&_svg]:size-[13px]">{iconOf(s)}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-2" title={s.description}>
                    {s.description}
                  </span>
                  {s.secret && (
                    <span className="shrink-0 rounded-[5px] bg-sunken px-1.5 py-0.5 font-mono text-[10.5px] text-fg-3 ring-1 ring-inset ring-line" title={`Typed from SAYWRIGHT_SECRET_${s.secret}: never saved in the test`}>
                      {s.secret}
                    </span>
                  )}
                  <button className="rounded p-0.5 text-fg-3 opacity-0 hover:text-bad group-hover:opacity-100" onClick={() => controller.removeStep(i)} aria-label="Remove step">
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="px-1 text-[12px] text-fg-3">No steps yet. Click around in your app.</p>
          )}
        </div>
      )}

      {(rec.expectations.length > 0 || recording) && (
        <div>
          <SectionTitle>Checks</SectionTitle>
          <div className="space-y-1">
            {rec.expectations.map((e, i) => {
              // How this check did in the last run, by its number in the test: passed, failed, or never got to.
              const ran = rec.run?.steps?.find((x) => x.check && x.title.startsWith(`[check ${numbers[i]}]`));
              const passed = ran ? ran.ok : rec.run?.status === 'passed';
              const failed = ran ? !ran.ok : false;
              const skipped = !!rec.run && rec.run.status !== 'passed' && !ran && !!rec.run.steps?.length;
              const what = shouldBe(e);
              // The value shown on its own: built from the parts, never cut out of the sentence.
              const verb = e.field === 'select' ? 'have' : e.field === 'name' ? 'be named' : 'show';
              return (
                <div key={i} className="group flex items-start gap-2 rounded-[8px] bg-raised px-2 py-1.5 text-[12.5px] ring-1 ring-inset ring-line">
                  <span className="mt-0.5 [&_svg]:size-[14px]" title={skipped ? 'The last run didn’t get to this check.' : undefined}>
                    {passed ? <CircleCheck className="text-ok" /> : failed ? <CircleX className="text-bad" /> : <CircleCheck className="text-fg-3" />}
                  </span>
                  <span className="min-w-0 flex-1 text-fg-2">
                    <span className="text-fg">{e.description}</span> {e.field === 'checked' || e.field === 'state' ? what : <>should {e.not ? 'not ' : ''}{verb} <span className="font-mono text-human-fg">“{e.expected}”</span>{e.field === 'select' ? ' chosen' : ''}</>}
                    {e.actual && <span className="block truncate text-[11.5px] text-fg-3">{e.field === 'checked' || e.field === 'state' ? `It was ${e.actual}` : e.field === 'select' ? `Chosen: ${e.actual}` : `It showed “${focusOn(e.actual, e.expected)}”`}</span>}
                    {skipped && <span className="block text-[11.5px] text-fg-3">The last run didn’t get to it.</span>}
                  </span>
                  <button className="rounded p-0.5 text-fg-3 opacity-0 hover:text-bad group-hover:opacity-100" onClick={() => controller.removeExpectation(i)} aria-label="Remove check">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })}
            {recording && !selection && (
              <p className="px-1 pt-1 text-[12px] leading-relaxed text-fg-3">
                Point at a value in your app and say “this should show …”, or type that in the command bar at the bottom while the pointer rests on it.
              </p>
            )}
            {recording && selection && (
              <form
                className="flex items-center gap-1.5 pt-1"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  if (!expected.trim()) return;
                  void controller.addExpectationFor(selection, expected.trim());
                  setExpected('');
                }}
              >
                <input
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                  placeholder={`${selection.name} should show…`}
                  className="h-7 min-w-0 flex-1 rounded-[7px] bg-sunken px-2 text-[12.5px] text-fg ring-1 ring-inset ring-line outline-none placeholder:text-fg-3 focus:ring-human-line disabled:opacity-60"
                />
                <Button size="sm" type="submit" disabled={!expected.trim()}>
                  Add
                </Button>
              </form>
            )}
          </div>
        </div>
      )}

      {rec.expectations.length > 0 && (
        <div className="flex gap-1.5">
          <Button size="sm" icon={<Wand2 />} onClick={() => void controller.generateTest()}>
            {rec.spec ? 'Regenerate' : 'Generate test'}
          </Button>
          <Button size="sm" variant="primary" icon={rec.running ? <Spinner className="size-3" /> : <Play />} disabled={rec.running} onClick={() => void controller.runTest()}>
            {rec.running ? 'Running…' : 'Run test'}
          </Button>
        </div>
      )}

      {rec.steps.some((s) => s.secret) && <Secrets names={[...new Set(rec.steps.flatMap((s) => (s.secret ? [s.secret] : [])))]} missing={rec.run?.missingSecrets ?? []} />}

      {rec.run && <RunResult />}

      {rec.spec && (
        <div>
          <SectionTitle
            action={
              <button
                className="ml-3 min-w-0 truncate font-mono text-[11.5px] text-fg-3 hover:text-fg"
                title={`Open ${rec.spec.path}`}
                onClick={() => controller.openRelative(rec.spec!.path, 1)}
              >
                {rec.spec.path.split('/').pop()}
              </button>
            }
          >
            Playwright test
          </SectionTitle>
          <CodeBlock code={rec.spec.code} language="typescript" />
        </div>
      )}

      {(rec.installing || rec.installLog.length > 0) && (
        <div>
          <SectionTitle>{rec.installing ? 'Installing the test browser…' : 'Install log'}</SectionTitle>
          <pre tabIndex={0} role="region" aria-label="Install output" className="max-h-[160px] overflow-auto rounded-[8px] bg-sunken p-2 font-mono text-[11px] leading-relaxed text-fg-3 ring-1 ring-inset ring-line">{rec.installLog.join('\n') || '…'}</pre>
        </div>
      )}

      {!recording && empty && !rec.spec && (
        <div className="rounded-[10px] border border-dashed border-line-strong p-3 text-[12px] leading-relaxed text-fg-3">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-fg-2">
            <Download className="size-3.5" /> Tests are saved in your app
          </div>
          Generated specs go to <span className="font-mono text-fg-2">tests/saywright/</span> and run with your project’s own Playwright, each step and check reported, in a fresh browser. Passwords and card numbers are never written into them.
        </div>
      )}
    </div>
  );
}

/**
 * The secrets the test types, by name: saved here (on this computer, outside your code) or taken from the environment.
 * A value is sent to the studio's server once, and never shown again.
 */
function Secrets({ names, missing }: { names: string[]; missing: string[] }) {
  const [set, setSet] = useState<{ saved: string[]; environment: string[] } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  // Asked again when a run finds others missing.
  const missingNow = missing.join();
  useEffect(() => {
    void api.get<{ saved: string[]; environment: string[] }>('/tests/secrets').then(setSet).catch(() => undefined);
  }, [missingNow]);
  const save = async (name: string) => {
    setSet(await api.put<{ saved: string[]; environment: string[] }>('/tests/secrets', { name, value }));
    setEditing(null);
    setValue('');
  };
  return (
    <div>
      <SectionTitle>Secrets</SectionTitle>
      <div className="space-y-1">
        {names.map((n) => {
          const saved = set?.saved.includes(n);
          const env = set?.environment.includes(n);
          return (
            <div key={n} className="rounded-[8px] bg-raised px-2 py-1.5 text-[12.5px] ring-1 ring-inset ring-line">
              <div className="flex items-center gap-2">
                <Lock className="size-3.5 text-fg-3" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-2">{n}</span>
                <span className={cn('text-[11.5px]', saved || env ? 'text-ok' : 'text-warn')}>{saved ? 'Saved' : env ? 'From the environment' : 'Not set'}</span>
                <button className="text-[11.5px] text-fg-3 hover:text-fg" onClick={() => (setEditing(editing === n ? null : n), setValue(''))}>
                  {saved ? 'Change' : 'Set'}
                </button>
              </div>
              {editing === n && (
                <form
                  className="mt-1.5 flex items-center gap-1.5"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    void save(n);
                  }}
                >
                  <input
                    type="password"
                    autoComplete="off"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    aria-label={`Value of ${n}`}
                    placeholder={saved ? 'New value (empty forgets it)' : 'Its value'}
                    className="h-7 min-w-0 flex-1 rounded-[7px] bg-sunken px-2 text-[12.5px] text-fg ring-1 ring-inset ring-line outline-none placeholder:text-fg-3 focus:ring-human-line"
                  />
                  <Button size="sm" type="submit" disabled={!value && !saved}>
                    Save
                  </Button>
                </form>
              )}
            </div>
          );
        })}
        <p className="px-1 text-[11.5px] leading-relaxed text-fg-3">
          The test reads each one from <span className="font-mono">SAYWRIGHT_SECRET_…</span>: saved values stay on this computer, with the studio’s data, never in your code or the test.
        </p>
      </div>
    </div>
  );
}

/** What the run reported of each step and check: what ran, and where it stopped. */
function RunSteps() {
  const steps = useStudio((s) => s.recorder.run?.steps) ?? [];
  if (!steps.length) return null;
  return (
    <ol className="space-y-0.5 text-[11.5px]">
      {steps.map((st, i) => (
        <li key={i} className="flex items-start gap-1.5">
          <span className="mt-0.5 [&_svg]:size-[12px]">{st.ok ? <CircleCheck className="text-ok" /> : <CircleX className="text-bad" />}</span>
          <span className={cn('min-w-0 flex-1', st.ok ? 'text-fg-3' : 'text-fg')}>
            {st.title}
            {st.error && <span className="block truncate font-mono text-[11px] text-bad">{st.error.split('\n')[0]}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function RunResult() {
  const run = useStudio((s) => s.recorder.run)!;
  const verifying = useStudio((s) => s.recorder.verifying);
  const ai = useAiName();
  const counted = run.counts ? `${run.counts.steps} step${run.counts.steps === 1 ? '' : 's'} and ${run.counts.checks} check${run.counts.checks === 1 ? '' : 's'}` : '';
  if (run.status === 'passed' && run.verified)
    return (
      <div className="space-y-2 rounded-[10px] bg-ok-soft p-3 ring-1 ring-inset ring-ok/25">
        <div className="flex items-center gap-2.5">
          <CircleCheck className="size-4 text-ok" />
          <div className="text-[12.5px] text-fg">
            Passed in {(run.durationMs / 1000).toFixed(1)} s{verifying ? ' with the fix applied' : ''}{counted ? `: all ${counted} ran` : ''}.
          </div>
        </div>
        <RunSteps />
      </div>
    );
  if (run.status === 'passed')
    return (
      <div className="space-y-2 rounded-[10px] bg-warn-soft p-3 ring-1 ring-inset ring-warn/25">
        <div className="flex items-start gap-2">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          <span className="text-[12.5px] text-fg">
            <span className="font-medium">Couldn’t verify.</span> {run.unverified}
          </span>
        </div>
        <RunSteps />
      </div>
    );
  if (run.status === 'failed' && run.failedAt === 'replay')
    return (
      <div className="space-y-2 rounded-[10px] bg-warn-soft p-3 ring-1 ring-inset ring-warn/25">
        <div className="flex items-start gap-2">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          <span className="text-[12.5px] text-fg">
            <span className="font-medium">The test doesn’t replay what you did:</span> a step is missing or the page starts differently. The check failed, but the page showed what it expects when you said it, so this isn’t the bug. Add the missing step (or start over from the page it needs), then run it again.
          </span>
        </div>
        {(run.expected || run.received) && (
          <div className="grid grid-cols-[70px_1fr] gap-x-2 gap-y-0.5 font-mono text-[11.5px]">
            <span className="text-fg-3">Expected</span>
            <span className="text-fg">{run.expected}</span>
            <span className="text-fg-3">Seen</span>
            <span className="text-fg">{run.received}</span>
          </div>
        )}
        <RunSteps />
      </div>
    );
  if (run.status === 'failed' && run.failedAt === 'find')
    return (
      <div className="space-y-2 rounded-[10px] bg-warn-soft p-3 ring-1 ring-inset ring-warn/25">
        <div className="flex items-start gap-2">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          <span className="text-[12.5px] text-fg">
            <span className="font-medium">Couldn’t find what this check looks at:</span> nothing on the page matched it, or more than one thing did, so it doesn’t show the bug yet. Point at the value again and say the check once more.
          </span>
        </div>
        <RunSteps />
        <Button size="sm" icon={<Sparkles />} onClick={() => void controller.fix()}>
          Fix with {ai} anyway
        </Button>
      </div>
    );
  if (run.status === 'failed' && run.failedAt === 'step')
    return (
      <div className="space-y-2 rounded-[10px] bg-warn-soft p-3 ring-1 ring-inset ring-warn/25">
        <div className="flex items-start gap-2">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          <span className="text-[12.5px] text-fg">
            <span className="font-medium">It doesn’t show the bug yet:</span> {/^The test didn’t get to the page it starts on/.test(run.message ?? '') ? `${(run.message ?? '').split('. ')[0].replace(/^The test/, 'the test')}. A test starts in a fresh browser, signed out: start it from the sign-in page and sign in as part of it.` : 'the test stopped at a step before its checks. Check the step (the page, a secret, a selector), then run it again.'}
          </span>
        </div>
        <RunSteps />
        <Button size="sm" icon={<Sparkles />} onClick={() => void controller.fix()}>
          Fix with {ai} anyway
        </Button>
      </div>
    );
  if (run.status === 'failed')
    return (
      <div className="space-y-2 rounded-[10px] bg-bad-soft p-3 ring-1 ring-inset ring-bad/25">
        <div className="flex items-center gap-2">
          <CircleX className="size-4 text-bad" />
          <span className="text-[12.5px] font-medium text-fg">The test fails at its check, so it reproduces the bug</span>
        </div>
        {(run.expected || run.received) && (
          <div className="grid grid-cols-[70px_1fr] gap-x-2 gap-y-0.5 font-mono text-[11.5px]">
            <span className="text-fg-3">Expected</span>
            <span className="text-ok">{run.expected}</span>
            <span className="text-fg-3">Received</span>
            <span className="text-bad">{run.received}</span>
          </div>
        )}
        <RunSteps />
        <Button size="sm" variant="ai" icon={<Sparkles />} onClick={() => void controller.fix()}>
          Fix with {ai}
        </Button>
      </div>
    );
  if (run.status === 'setup-needed')
    return (
      <div className="space-y-2 rounded-[10px] bg-warn-soft p-3 ring-1 ring-inset ring-warn/25">
        <div className="text-[12.5px] text-fg">{run.message}</div>
        {/Chromium/.test(run.message ?? '') && (
          <Button size="sm" onClick={() => void controller.installBrowser()}>
            Install test browser
          </Button>
        )}
      </div>
    );
  return (
    <div className="rounded-[10px] bg-bad-soft p-3 text-[12px] text-fg ring-1 ring-inset ring-bad/25">
      <Badge tone="bad">Error</Badge> <span className="ml-1">{run.message}</span>
    </div>
  );
}

/** A page of the app as its path and #route (“/#/book”). */
function pageOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}

/** A page at the app's own address, not the studio proxy's that the frame shows it through. */
function ownAddress(url: string, target: { url: string; frameUrl: string } | undefined): string {
  if (!target || !url) return url;
  try {
    const page = new URL(url);
    const frame = new URL(target.frameUrl);
    const own = new URL(target.url);
    return page.origin === frame.origin && frame.origin !== own.origin ? `${own.origin}${page.pathname}${page.search}${page.hash}` : url;
  } catch {
    return url;
  }
}
