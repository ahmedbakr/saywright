/**
 * Ctrl K (⌘K): every action in the studio, by name. Enter only ever runs a
 * command; sending what was typed as a request (a quick edit or the AI) is its
 * own row at the bottom, run with Ctrl Enter or a click, never a fallback.
 */
import { Command, defaultFilter } from 'cmdk';
import {
  AppWindow,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpToLine,
  Check,
  CircleDot,
  CircleHelp,
  Code2,
  Eraser,
  FlaskConical,
  Footprints,
  Gauge,
  History,
  LayoutGrid,
  Mic,
  Monitor,
  Moon,
  MousePointerClick,
  PanelRight,
  Play,
  Plus,
  RotateCw,
  Search,
  SendHorizontal,
  Settings2,
  Sparkles,
  Square,
  SquareDashedMousePointer,
  Sun,
  Undo2,
  Wand2,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { apps, useApps } from '@/core/apps';
import { controller } from '@/core/controller';
import { experts } from '@/core/experts';
import { sessions, useSessions } from '@/core/sessions';
import { useSettings, type DevicePreset, type PanelTab } from '@/core/settings';
import { set, useStudio } from '@/core/store';
import { tour } from '@/core/tour';
import { shortcut } from '@/lib/format';
import { DEVICES, MODE_LABEL } from './TopBar';
import { useAiName } from '@/lib/ai-name';

function Item({ icon, children, onSelect, kbd, value, keywords }: { icon: ReactNode; children: ReactNode; onSelect: () => void; kbd?: string; value?: string; keywords?: string[] }) {
  return (
    <Command.Item
      value={value}
      keywords={keywords}
      onSelect={onSelect}
      className="flex h-9 cursor-default items-center gap-3 rounded-[8px] px-2.5 text-[13px] text-fg-2 data-[selected=true]:bg-hover data-[selected=true]:text-fg [&_svg]:size-[15px] [&_svg]:text-fg-3"
    >
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {kbd && <Kbd>{kbd}</Kbd>}
    </Command.Item>
  );
}

function Group({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Command.Group heading={heading} className="px-1.5 pb-1 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-3">
      {children}
    </Command.Group>
  );
}

const openPanel = (panelTab: PanelTab) => useSettings.getState().setUi({ panelOpen: true, panelTab });

/**
 * Commands are ranked within their group only, so a stray letter-by-letter match in an earlier group (“tour” in
 * “Write test … record a bug … playwright”) would come before the command named by the word typed: those don't count.
 */
const match = (value: string, search: string, keywords?: string[]) => {
  const score = defaultFilter(value, search, keywords);
  return score < 0.2 ? 0 : score;
};

export function CommandPalette() {
  const open = useStudio((s) => s.overlay === 'palette');
  const pending = useStudio((s) => s.changes.some((c) => c.status === 'preview'));
  const hasSelection = useStudio((s) => !!s.selection);
  const appOpen = useStudio((s) => !!s.status?.app);
  const current = useStudio((s) => s.status?.app?.id ?? null);
  const rec = useStudio((s) => s.recorder);
  const recording = useSessions((s) => s.live.status === 'recording');
  const linked = useApps((s) => s.apps);
  const theme = useSettings((s) => s.theme);
  const ai = useAiName();
  const [q, setQ] = useState('');
  const close = () => {
    set({ overlay: null });
    setQ('');
  };
  const run = (fn: () => void) => () => {
    close();
    setTimeout(fn, 0);
  };
  const said = q.trim();
  const send = run(() => void controller.handleUtterance(said, null, 'typed'));

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? set({ overlay: 'palette' }) : close())} title="Command palette" position="top" focusFirst className="w-[min(600px,calc(100vw-32px))]">
      <Command
        loop
        filter={match}
        className="flex min-h-0 flex-col"
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
          e.preventDefault();
          if (said) send();
        }}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-3.5">
          <Search className="size-4 text-fg-3" />
          <Command.Input
            value={q}
            onValueChange={setQ}
            autoFocus
            placeholder="Search commands…"
            className="h-12 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-fg-3"
          />
          <Kbd>Esc</Kbd>
        </div>
        <Command.List className="max-h-[380px] overflow-y-auto py-1">
          <Command.Empty className="px-4 py-6 text-center text-[12.5px] text-fg-3">No command matches “{said}”.</Command.Empty>
          {pending && (
            <Group heading="Preview">
              <Item icon={<Check />} kbd="↵" onSelect={run(() => void controller.keep('palette'))} keywords={['keep', 'accept']}>
                Keep the preview
              </Item>
              <Item icon={<Undo2 />} kbd={shortcut('mod+z')} onSelect={run(() => void controller.undo('palette'))} keywords={['undo', 'revert']}>
                Undo the preview
              </Item>
            </Group>
          )}
          {appOpen && (
            <Group heading="Modes">
              <Item icon={<SquareDashedMousePointer />} kbd="E" onSelect={run(() => controller.setMode('edit'))}>
                {MODE_LABEL.edit}: point and change
              </Item>
              <Item icon={<MousePointerClick />} kbd="U" onSelect={run(() => controller.setMode('use'))}>
                {MODE_LABEL.use}: click through the app
              </Item>
              <Item icon={<FlaskConical />} kbd="R" onSelect={run(() => controller.setMode('record'))} keywords={['record a bug', 'playwright', 'check']}>
                {MODE_LABEL.record}: narrate a bug, get a Playwright test
              </Item>
            </Group>
          )}
          {appOpen && (
            <Group heading="Test and review">
              {recording ? (
                <Item icon={<Square />} onSelect={run(() => void sessions.stop())} keywords={['record session', 'test session']}>
                  Stop recording and write the report
                </Item>
              ) : (
                <Item icon={<CircleDot />} onSelect={run(() => useSessions.setState({ setup: true }))} keywords={['test session', 'report', 'recording']}>
                  Record session: use the app, get a report
                </Item>
              )}
              <Item icon={<Sparkles />} onSelect={run(() => (openPanel('experts'), void experts.run()))} keywords={['experts', 'audit', 'accessibility', 'seo', 'ux', 'content']}>
                Review this page with the Experts
              </Item>
              <Item icon={<Wand2 />} onSelect={run(() => (openPanel('sessions'), setTimeout(() => document.querySelector<HTMLElement>('[data-autopilot-goal]')?.focus(), 250)))} keywords={['autopilot', 'explore', 'ai tester']}>
                Autopilot: let the AI test your app…
              </Item>
              <Item icon={<History />} onSelect={run(() => openPanel('sessions'))} keywords={['reports', 'recordings']}>
                Sessions and their reports
              </Item>
              {(rec.expectations.length > 0 || rec.spec) && (
                <>
                  <Item icon={<Wand2 />} onSelect={run(() => void controller.generateTest())}>
                    Generate test
                  </Item>
                  <Item icon={<Play />} onSelect={run(() => void controller.runTest())}>
                    Run test
                  </Item>
                  {rec.run?.status === 'failed' && (
                    <Item icon={<Sparkles />} onSelect={run(() => void controller.fix())}>
                      Fix with {ai}
                    </Item>
                  )}
                </>
              )}
            </Group>
          )}
          {hasSelection && (
            <Group heading="Selection">
              <Item icon={<ArrowUpToLine />} kbd="↑" onSelect={run(() => void controller.step('parent'))}>
                Select what contains it
              </Item>
              <Item icon={<ArrowDownToLine />} kbd="↓" onSelect={run(() => void controller.step('child'))}>
                Select inside it
              </Item>
              <Item icon={<ArrowRight />} kbd="→" onSelect={run(() => void controller.step('next'))}>
                Select the next one
              </Item>
              <Item icon={<ArrowLeft />} kbd="←" onSelect={run(() => void controller.step('prev'))}>
                Select the previous one
              </Item>
              <Item icon={<Code2 />} kbd="O" onSelect={run(() => void controller.openInEditor())}>
                Open in editor
              </Item>
              <Item icon={<Eraser />} kbd="Esc" onSelect={run(() => controller.clearTargets())}>
                Clear the selection
              </Item>
            </Group>
          )}
          <Group heading="Voice">
            <Item icon={<Mic />} kbd="Space" onSelect={run(() => controller.startTalk('toggle'))}>
              Start talking (hands-free)
            </Item>
          </Group>
          <Group heading="Apps">
            {appOpen && (
              <Item icon={<RotateCw />} onSelect={run(() => controller.reloadApp())}>
                Reload the app
              </Item>
            )}
            {linked
              .filter((a) => a.id !== current)
              .map((a) => (
                <Item key={a.id} value={`switch ${a.id} ${a.name}`} icon={<AppWindow />} onSelect={run(() => void apps.open(a.id))} keywords={['switch', 'open', a.name]}>
                  Switch to {a.name}
                </Item>
              ))}
            <Item icon={<Plus />} onSelect={run(() => apps.show('folder'))} keywords={['add', 'folder', 'address', 'github']}>
              Link an app…
            </Item>
            <Item icon={<LayoutGrid />} onSelect={run(() => apps.show())}>
              All apps
            </Item>
            {appOpen &&
              (Object.keys(DEVICES) as DevicePreset[]).map((k) => (
                <Item key={k} icon={<Monitor />} onSelect={run(() => useSettings.getState().setUi({ device: k }))}>
                  Viewport: {DEVICES[k].label}
                </Item>
              ))}
          </Group>
          <Group heading="Studio">
            <Item icon={<PanelRight />} kbd="\" onSelect={run(() => useSettings.getState().setUi({ panelOpen: !useSettings.getState().ui.panelOpen }))}>
              Toggle panel
            </Item>
            <Item icon={theme === 'light' ? <Moon /> : <Sun />} onSelect={run(() => useSettings.getState().set({ theme: theme === 'light' ? 'dark' : 'light' }))}>
              {theme === 'light' ? 'Dark theme' : 'Light theme'}
            </Item>
            <Item icon={<Settings2 />} onSelect={run(() => set({ overlay: 'settings', settingsTab: 'general' }))} keywords={['preferences', 'options']}>
              Settings
            </Item>
            <Item icon={<Sparkles />} onSelect={run(() => set({ overlay: 'settings', settingsTab: 'ai' }))} keywords={['connect', 'api key', 'model', 'claude', 'chatgpt', 'gemini']}>
              Settings: connect an AI
            </Item>
            <Item icon={<Gauge />} onSelect={run(() => set({ overlay: 'settings', settingsTab: 'usage' }))} keywords={['cost', 'budget', 'spend', 'money']}>
              Settings: usage and budget
            </Item>
            <Item icon={<CircleHelp />} kbd="?" onSelect={run(() => set({ overlay: 'help' }))} keywords={['help', 'keys']}>
              Phrases and shortcuts
            </Item>
            <Item icon={<Footprints />} onSelect={run(() => tour.start())} keywords={['tour', 'intro', 'getting started', 'onboarding', 'learn']}>
              Take the quick-start tour
            </Item>
          </Group>
        </Command.List>
        {said && (
          <button onClick={send} className="flex h-11 shrink-0 items-center gap-3 border-t border-line px-4 text-start text-[13px] text-fg-2 hover:bg-hover hover:text-fg [&_svg]:size-[15px]" data-send-request>
            <SendHorizontal className="shrink-0 text-ai-fg" />
            <span className="min-w-0 flex-1 truncate">
              Send as a request: “{said}” <span className="text-fg-3">· a quick edit, or {ai === 'AI' ? 'the AI' : ai}</span>
            </span>
            <Kbd>{shortcut('mod+enter')}</Kbd>
          </button>
        )}
      </Command>
    </Dialog>
  );
}
