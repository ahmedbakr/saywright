import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronRight, FileCode2, GitCompareArrows, Sparkles, Undo2, Zap } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Empty } from '@/components/ui/misc';
import { controller } from '@/core/controller';
import { useStudio } from '@/core/store';
import { cn } from '@/lib/cn';
import { ago, fileName, ms } from '@/lib/format';
import type { Change } from '@shared/api';
import { DiffView } from './DiffView';

export function ChangesTab() {
  const changes = useStudio((s) => s.changes);
  const pending = changes.filter((c) => c.status === 'preview');
  if (!changes.length)
    return (
      <Empty icon={<GitCompareArrows />} title="No changes yet">
        Point at something in your app and say what to change. Each change lands as a live preview you can keep or undo.
      </Empty>
    );
  return (
    <div className="flex flex-col gap-2 p-3">
      {pending.length > 1 && (
        <div className="flex items-center justify-between rounded-[10px] bg-ai-soft px-3 py-2 ring-1 ring-inset ring-ai-line/30">
          <span className="text-[12.5px] font-medium text-ai-fg">{pending.length} previews stacked</span>
          <div className="flex gap-1">
            <Button size="xs" variant="ghost" onClick={() => void controller.undo('panel')}>
              Undo last
            </Button>
            <Button size="xs" variant="primary" onClick={() => void controller.keep('panel')}>
              Keep all
            </Button>
          </div>
        </div>
      )}
      <AnimatePresence initial={false}>
        {changes.map((c) => (
          <motion.div key={c.id} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
            <ChangeCard change={c} defaultOpen={c.status === 'preview' && c.id === pending[0]?.id} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function ChangeCard({ change: c, defaultOpen }: { change: Change; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const added = c.files.reduce((n, f) => n + f.added, 0);
  const removed = c.files.reduce((n, f) => n + f.removed, 0);
  return (
    <div className={cn('rounded-[10px] bg-raised ring-1 ring-inset', c.status === 'preview' ? 'ring-ai-line/40' : 'ring-line')} data-change={c.id}>
      <button data-hand onClick={() => setOpen(!open)} className="flex w-full items-start gap-2.5 px-3 pb-2 pt-2.5 text-left">
        <span
          className={cn(
            'mt-px flex size-6 shrink-0 items-center justify-center rounded-[7px] [&_svg]:size-[13px]',
            c.source === 'quick' ? 'bg-human-soft text-human-fg' : 'bg-ai-soft text-ai-fg',
          )}
        >
          {c.source === 'quick' ? <Zap /> : <Sparkles />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={cn('truncate text-[13px] font-medium', c.status === 'undone' ? 'text-fg-3 line-through' : 'text-fg')}>{c.title}</span>
          </span>
          {c.said && <span className="mt-0.5 block truncate text-[12px] text-human-fg">“{c.said}”</span>}
          <span className="mt-1 flex items-center gap-1.5 text-[11.5px] text-fg-3">
            <StatusBadge status={c.status} />
            <span>{c.source === 'quick' ? 'Quick edit' : c.source === 'fake' ? 'Test double' : (c.model ?? (c.source === 'claude' ? 'Claude' : 'AI'))}</span>
            {c.latencyMs != null && <span>· {ms(c.latencyMs)}</span>}
            <span>· {ago(c.createdAt)}</span>
            <span className="ml-auto font-mono text-ok">+{added}</span>
            <span className="font-mono text-bad">−{removed}</span>
          </span>
        </span>
        <ChevronRight className={cn('mt-1 size-3.5 shrink-0 text-fg-3 transition-transform', open && 'rotate-90')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="diff" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
            <div className="space-y-2 px-3 pb-3">
              {c.summary && <p className="text-[12.5px] leading-relaxed text-fg-2">{c.summary}</p>}
              {c.files.map((f) => (
                <div key={f.path} className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11.5px] text-fg-2">
                    <FileCode2 className="size-3.5 text-fg-3" />
                    <button data-hand className="truncate font-mono hover:text-fg hover:underline" onClick={() => controller.openRelative(f.path, f.hunks[0]?.newStart ?? 1)} title={f.path}>
                      {f.path}
                    </button>
                    {f.created && <Badge tone="ok">new</Badge>}
                  </div>
                  <DiffView file={f} />
                </div>
              ))}
              {c.status === 'preview' && (
                <div className="flex justify-end gap-1 pt-1">
                  <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={() => void controller.undoChange(c.id)}>
                    Undo
                  </Button>
                  <Button size="sm" variant="primary" icon={<Check />} onClick={() => void controller.keepChange(c.id)}>
                    Keep
                  </Button>
                </div>
              )}
              {c.status === 'kept' && c.files.length === 1 && <div className="text-[11.5px] text-fg-3">Saved in {fileName(c.files[0].path)}.</div>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StatusBadge({ status }: { status: Change['status'] }) {
  if (status === 'preview') return <Badge tone="ai">Preview</Badge>;
  if (status === 'kept') return <Badge tone="ok">Kept</Badge>;
  return <Badge>Undone</Badge>;
}
