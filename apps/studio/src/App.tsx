import { Suspense, useEffect, useReducer, useState, type ComponentType } from 'react';
import { controller } from '@/core/controller';
import { useSessions } from '@/core/sessions';
import { set, useStudio } from '@/core/store';
import { CursorCanvas } from '@/features/CursorCanvas';
import { SidePanel } from '@/features/SidePanel';
import { Stage } from '@/features/Stage';
import { TopBar } from '@/features/TopBar';
import { Onboarding } from '@/features/Onboarding';
import { Tour } from '@/features/Tour';
import { Launcher, OpeningCard, PendingSwitch } from '@/features/apps/Launcher';
import { Countdown } from '@/features/session/Countdown';
import { SessionBar } from '@/features/session/SessionBar';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/misc';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConfirmHost } from '@/components/ui/confirm';

/**
 * A view most visits never open. Its code isn't part of the studio's start: it loads once the page is idle, so it
 * is there when the view is first opened.
 */
interface Later {
  view: ComponentType | null;
  failed: boolean;
  load: () => Promise<void>;
}

function later(load: () => Promise<ComponentType>): Later {
  let loading: Promise<void> | null = null;
  const it: Later = {
    view: null,
    failed: false,
    load: () =>
      (loading ??= load().then(
        (view) => {
          it.view = view;
          it.failed = false;
        },
        () => {
          // Tried again the next time the view is opened.
          it.failed = true;
          loading = null;
        },
      )),
  };
  return it;
}

const VIEWS = {
  settings: later(() => import('@/features/SettingsDialog').then((m) => m.SettingsDialog)),
  palette: later(() => import('@/features/CommandPalette').then((m) => m.CommandPalette)),
  help: later(() => import('@/features/HelpDialog').then((m) => m.HelpDialog)),
  calibrate: later(() => import('@/features/Calibration').then((m) => m.Calibration)),
  report: later(() => import('@/features/report/ReportView').then((m) => m.ReportView)),
};

/**
 * Mounts its view once it is first wanted, and keeps it mounted (so it can animate out, and open quickly again).
 * Wanted before its code has arrived, a dialog shows its frame straight away: what is behind it is out of reach
 * meanwhile, as it is once the dialog is there.
 */
function Once({ of, wanted, frame }: { of: Later; wanted: boolean; frame?: string }) {
  const [seen, setSeen] = useState(wanted);
  const [, arrived] = useReducer((n: number) => n + 1, 0);
  if (wanted && !seen) setSeen(true);
  const View = of.view;
  useEffect(() => {
    if (seen && wanted && !View) void of.load().then(arrived);
  }, [of, seen, wanted, View]);
  if (View)
    return seen ? (
      <Suspense fallback={null}>
        <View />
      </Suspense>
    ) : null;
  if (!wanted || !frame) return null;
  return (
    <Dialog open title={frame} onOpenChange={(o) => !o && set({ overlay: null })} className="w-[min(420px,calc(100vw-32px))]">
      <div className="grid h-40 place-items-center px-6 text-center text-[12.5px] text-fg-3">{of.failed ? 'This didn’t load. Reload the studio, then try again.' : <Spinner />}</div>
    </Dialog>
  );
}

function LaterViews() {
  const overlay = useStudio((s) => s.overlay);
  const report = useSessions((s) => !!s.open);
  useEffect(() => {
    const all = () => {
      for (const v of Object.values(VIEWS)) void v.load();
    };
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(all, { timeout: 4000 });
      return () => cancelIdleCallback(id);
    }
    const timer = setTimeout(all, 2000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <>
      <Once of={VIEWS.settings} wanted={overlay === 'settings'} frame="Settings" />
      <Once of={VIEWS.palette} wanted={overlay === 'palette'} frame="Command palette" />
      <Once of={VIEWS.help} wanted={overlay === 'help'} frame="Help" />
      {/* The setup steps (voice check, hand control), opened from Settings, Labs and the tour: small, so not loaded later. */}
      <Onboarding />
      <Once of={VIEWS.calibrate} wanted={overlay === 'calibrate'} frame="Calibration" />
      <Once of={VIEWS.report} wanted={report} />
    </>
  );
}

export function App() {
  useEffect(() => {
    controller.start();
  }, []);

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <TopBar />
        <Tour />
        <SessionBar />
        <div className="flex min-h-0 flex-1">
          <Stage />
          <SidePanel />
        </div>
      </div>
      <LaterViews />
      <Launcher />
      <OpeningCard />
      <PendingSwitch />
      <Countdown />
      <ConfirmHost />
      <CursorCanvas />
    </TooltipProvider>
  );
}
