/**
 * What the tester said, sentence by sentence: click one to hear it and see the
 * screen at that moment, or correct a word the recogniser got wrong. The
 * recogniser's words are kept; rewriting the report uses the corrections.
 */
import { Check, Pencil, Play, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { TranscriptSegment } from '@shared/session';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { fmtClock } from './Findings';
import type { Strings } from './i18n';
import { nameOfTarget } from './markdown';

export function Transcript({
  segments,
  start,
  current,
  t,
  reportAt,
  onPlay,
  onCorrect,
  onRewrite,
}: {
  segments: TranscriptSegment[];
  start: number;
  current: number | null;
  t: Strings;
  /** When the report was written: corrections made since aren't in it. */
  reportAt: number | null;
  onPlay: (s: TranscriptSegment) => void;
  onCorrect: (s: TranscriptSegment, text: string) => Promise<void>;
  onRewrite: () => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const pending = reportAt == null ? 0 : segments.filter((s) => s.editedAt && s.editedAt > reportAt).length;
  const box = useRef<HTMLDivElement>(null);
  const active = current == null ? null : segments.reduce<TranscriptSegment | null>((best, s) => (s.start <= current + 300 ? s : best), null);
  useEffect(() => {
    if (active && editing == null) box.current?.querySelector(`[data-seg="${active.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active?.id]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {pending > 0 && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-[10px] bg-ai-soft px-3 py-2 ring-1 ring-inset ring-ai-line/30" data-rewrite>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-ai-fg">{t.notInReport(pending)}</p>
          <Button size="xs" variant="ai" icon={<RefreshCw />} onClick={onRewrite}>
            {t.rewrite}
          </Button>
        </div>
      )}
      {segments.length > 0 && <p className="px-3.5 pb-2 text-[11.5px] leading-snug text-fg-3">{t.correctHint}</p>}
      <div ref={box} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-transcript>
        {!segments.length && <p className="px-3 py-6 text-center text-[12px] text-fg-3">{t.noNarration}</p>}
        {segments.map((s) => (
          <Sentence key={s.id} s={s} start={start} t={t} active={active?.id === s.id} editing={editing === s.id} onEdit={(on) => setEditing(on ? s.id : null)} onPlay={() => onPlay(s)} onCorrect={(text) => onCorrect(s, text)} />
        ))}
      </div>
    </div>
  );
}

function Sentence({
  s,
  start,
  t,
  active,
  editing,
  onEdit,
  onPlay,
  onCorrect,
}: {
  s: TranscriptSegment;
  start: number;
  t: Strings;
  active: boolean;
  editing: boolean;
  onEdit: (on: boolean) => void;
  onPlay: () => void;
  onCorrect: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState(s.text);
  const [saving, setSaving] = useState(false);
  useEffect(() => setText(s.text), [s.text, editing]);
  const save = async () => {
    const next = text.replace(/\s+/g, ' ').trim();
    if (!next || next === s.text) return onEdit(false);
    setSaving(true);
    try {
      await onCorrect(next);
      onEdit(false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div data-seg={s.id} className={cn('group flex gap-2.5 rounded-[9px] px-2 py-2', active && !editing ? 'bg-human-soft' : 'hover:bg-hover')}>
      <button onClick={onPlay} title="Play" className="mt-px flex shrink-0 flex-col items-center gap-1 text-fg-3 hover:text-fg">
        <span className="tabular text-[11px]">{fmtClock(s.start - start)}</span>
        <Play className="size-3 fill-current opacity-60 group-hover:opacity-100" />
      </button>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="space-y-1.5">
            <textarea
              autoFocus
              dir="auto"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void save();
                } else if (e.key === 'Escape') {
                  e.stopPropagation();
                  onEdit(false);
                }
              }}
              rows={Math.min(5, Math.max(2, Math.ceil(text.length / 48)))}
              className="w-full resize-none rounded-[8px] bg-sunken px-2 py-1.5 text-[13px] leading-relaxed text-fg outline-none ring-1 ring-ai-line"
              aria-label={t.correct}
            />
            <div className="flex items-center gap-1.5">
              <Button size="xs" variant="ai" icon={<Check />} onClick={() => void save()} disabled={saving}>
                {t.save}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => onEdit(false)}>
                {t.cancel}
              </Button>
              {s.original && <span className="min-w-0 truncate text-[11px] text-fg-3" dir="auto">{t.heard(s.original)}</span>}
            </div>
          </div>
        ) : (
          <button onClick={() => onEdit(true)} className="block w-full text-start" title={t.correct}>
            <span dir="auto" className="block text-[13px] leading-relaxed text-fg">
              {s.text}
              <Pencil className="ms-1.5 inline size-3 text-fg-3 opacity-0 group-hover:opacity-100" />
            </span>
          </button>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg-3">
          <span className="rounded-[4px] bg-active px-1 text-[10px] uppercase">{s.lang}</span>
          {s.original && !editing && (
            <span className="rounded-[4px] bg-ai-soft px-1 text-[10px] text-ai-fg" title={t.heard(s.original)} data-corrected>
              {t.corrected}
            </span>
          )}
          {s.el && <span className="truncate">{t.pointingAt(nameOfTarget(s.el))}</span>}
        </div>
      </div>
    </div>
  );
}
