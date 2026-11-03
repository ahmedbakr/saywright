import { motion } from 'motion/react';
import { Tabs } from 'radix-ui';
import { ChartNoAxesColumn, X } from 'lucide-react';
import { IconButton } from '@/components/ui/button';
import { useSettings, type PanelTab } from '@/core/settings';
import { useStudio } from '@/core/store';
import { cn } from '@/lib/cn';
import { ChangesTab } from './panel/ChangesTab';
import { ExpertsTab } from './panel/ExpertsTab';
import { InspectTab } from './panel/InspectTab';
import { SessionTab } from './panel/SessionTab';
import { SessionsTab } from './panel/SessionsTab';
import { useSessions } from '@/core/sessions';
import { useExperts } from '@/core/experts';
import { TestTab } from './panel/TestTab';

const WIDTH = 400;

export function SidePanel() {
  const open = useSettings((s) => s.ui.panelOpen);
  const tab = useSettings((s) => s.ui.panelTab);
  const setUi = useSettings((s) => s.setUi);
  const pending = useStudio((s) => s.changes.filter((c) => c.status === 'preview').length);
  const recording = useStudio((s) => s.mode === 'record');
  const hasSelection = useStudio((s) => !!s.selection);
  const sessionLive = useSessions((s) => s.live.status === 'recording');
  const reviewing = useExperts((s) => s.running || Object.values(s.thinking).some(Boolean));

  const tabs: { id: PanelTab; label: string; icon?: React.ReactNode; badge?: React.ReactNode }[] = [
    { id: 'changes', label: 'Changes', badge: pending ? <span className="rounded-full bg-ai px-1.5 text-[10.5px] font-semibold leading-[16px] text-[#021a20]">{pending}</span> : null },
    { id: 'inspect', label: 'Inspect', badge: hasSelection ? <span className="size-1.5 rounded-full bg-human" /> : null },
    { id: 'test', label: 'Test', badge: recording ? <span className="size-1.5 rounded-full bg-bad" style={{ animation: 'rec-pulse 1.4s ease-in-out infinite' }} /> : null },
    { id: 'experts', label: 'Experts', badge: reviewing ? <span className="size-1.5 rounded-full bg-ai" /> : null },
    { id: 'sessions', label: 'Sessions', badge: sessionLive ? <span className="size-1.5 rounded-full bg-bad" style={{ animation: 'rec-pulse 1.4s ease-in-out infinite' }} /> : null },
    { id: 'session', label: 'Stats', icon: <ChartNoAxesColumn /> },
  ];

  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? WIDTH : 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 42 }}
      className="relative shrink-0 overflow-hidden border-l border-line bg-panel"
      aria-hidden={!open}
    >
      <Tabs.Root value={tab} onValueChange={(v) => setUi({ panelTab: v as PanelTab })} className="flex h-full flex-col" style={{ width: WIDTH }}>
        <div className="flex h-[42px] shrink-0 items-center gap-1 border-b border-line pl-2 pr-1.5">
          <Tabs.List className="flex flex-1 items-center gap-0.5">
            {tabs.map((t) => (
              <Tabs.Trigger
                key={t.id}
                value={t.id}
                data-hand
                data-tab={t.id}
                title={t.icon ? t.label : undefined}
                aria-label={t.icon ? t.label : undefined}
                className={cn(
                  'relative inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-[12.5px] font-medium transition-colors [&_svg]:size-[15px]',
                  tab === t.id ? 'bg-active text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg-2',
                )}
              >
                {t.icon ?? t.label}
                {t.badge}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <IconButton size="sm" onClick={() => setUi({ panelOpen: false })} aria-label="Close panel">
            <X />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Tabs.Content value="changes" className="outline-none">
            <ChangesTab />
          </Tabs.Content>
          <Tabs.Content value="inspect" className="outline-none">
            <InspectTab />
          </Tabs.Content>
          <Tabs.Content value="test" className="outline-none">
            <TestTab />
          </Tabs.Content>
          <Tabs.Content value="experts" className="outline-none">
            <ExpertsTab />
          </Tabs.Content>
          <Tabs.Content value="sessions" className="outline-none">
            <SessionsTab />
          </Tabs.Content>
          <Tabs.Content value="session" className="outline-none">
            <SessionTab />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </motion.aside>
  );
}
