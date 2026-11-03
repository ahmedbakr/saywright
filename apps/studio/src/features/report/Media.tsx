/**
 * What the screen showed: the session video when one was kept, otherwise the
 * screenshot nearest the moment being looked at. Both follow the timeline.
 */
import { ChevronLeft, ChevronRight, ImageOff } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { SessionMeta, SessionShot, VideoPart } from '@shared/session';
import { IconButton } from '@/components/ui/button';
import { fmtClock } from './Findings';

export interface MediaHandle {
  seek: (t: number) => void;
}

function partsOf(video: SessionMeta['video']): VideoPart[] {
  if (!video) return [];
  return video.parts?.length ? video.parts : [{ startedAt: video.startedAt, bytes: video.bytes, file: 'video.webm' }];
}

export const Media = forwardRef<
  MediaHandle,
  { id: string; video: SessionMeta['video']; shots: SessionShot[]; start: number; current: number | null; onTime: (t: number) => void; onZoom: (name: string) => void; lang?: 'en' | 'ar' }
>(function Media({ id, video, shots, start, current, onTime, onZoom, lang = 'en' }, ref) {
  const el = useRef<HTMLVideoElement>(null);
  const ready = useRef(false);
  const parts = partsOf(video);
  // A session can hold several recordings (the screen was shared again after a reload).
  const [part, setPart] = useState(0);
  /** Where to go once the recording being switched to has loaded (seconds into it), and whether to play. */
  const pending = useRef<{ at: number; play: boolean } | null>(null);
  const rec = parts[Math.min(part, parts.length - 1)];

  useImperativeHandle(ref, () => ({
    seek: (t: number) => {
      if (!parts.length) return;
      let i = 0;
      for (let k = 0; k < parts.length; k++) if (parts[k].startedAt <= t) i = k;
      const at = Math.max(0, (t - parts[i].startedAt) / 1000 - 0.5);
      const v = el.current;
      if (i !== part || !v) {
        pending.current = { at, play: false };
        setPart(i);
        return;
      }
      if (ready.current) v.currentTime = at;
      else pending.current = { at, play: false };
    },
  }));

  useEffect(() => {
    const v = el.current;
    if (!v) return;
    ready.current = false;
    const settle = () => {
      ready.current = true;
      const go = pending.current;
      pending.current = null;
      if (go) {
        v.currentTime = go.at;
        if (go.play) void v.play().catch(() => undefined);
      }
    };
    const onMeta = () => {
      // Sessions recorded before lengths were written in: make the browser read the file once, then rewind.
      if (v.duration === Infinity || Number.isNaN(v.duration)) {
        v.currentTime = 1e7;
        v.addEventListener(
          'timeupdate',
          () => {
            v.currentTime = 0;
            settle();
          },
          { once: true },
        );
      } else settle();
    };
    v.addEventListener('loadedmetadata', onMeta);
    return () => v.removeEventListener('loadedmetadata', onMeta);
  }, [video, part]);

  if (rec) {
    const index = parts.indexOf(rec);
    return (
      <div className="space-y-2">
        <div className="overflow-hidden rounded-[12px] bg-black ring-1 ring-line">
          <video
            key={index}
            ref={el}
            src={index === 0 ? `/api/sessions/${id}/video.webm` : `/api/sessions/${id}/video/${index + 1}`}
            controls
            preload="auto"
            className="aspect-video w-full bg-black object-contain"
            onTimeUpdate={(e) => ready.current && onTime(rec.startedAt + e.currentTarget.currentTime * 1000)}
            onEnded={() => {
              if (index + 1 >= parts.length) return;
              pending.current = { at: 0, play: true };
              setPart(index + 1);
            }}
          />
        </div>
        {parts.length > 1 && (
          <div role="tablist" aria-label="Screen recordings" className="flex flex-wrap gap-1">
            {parts.map((p, i) => (
              <button
                key={p.file}
                role="tab"
                aria-selected={i === index}
                data-hand
                onClick={() => {
                  pending.current = { at: 0, play: false };
                  setPart(i);
                }}
                className={`tabular rounded-[6px] px-2 py-1 text-[11px] ring-1 ring-inset ${i === index ? 'bg-ai-soft text-ai-fg ring-ai-line/40' : 'text-fg-3 ring-line hover:text-fg'}`}
              >
                Recording {i + 1} · {fmtClock(p.startedAt - start)}
                {p.ms ? `–${fmtClock(p.startedAt - start + p.ms)}` : ''}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (!shots.length) {
    return (
      <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-[12px] bg-sunken text-[12px] text-fg-3 ring-1 ring-inset ring-line">
        <ImageOff className="size-5" />
        {lang === 'ar' ? 'لا تسجيل للشاشة في هذه الجلسة' : 'No screen recording for this session'}
      </div>
    );
  }

  const t = current ?? shots[0].t;
  let idx = 0;
  for (let i = 0; i < shots.length; i++) if (shots[i].t <= t + 1500) idx = i;
  const shot = shots[idx];
  const go = (i: number) => onTime(shots[Math.max(0, Math.min(shots.length - 1, i))].t);
  return (
    <div className="space-y-2">
      <button data-hand onClick={() => onZoom(shot.name)} className="relative block w-full overflow-hidden rounded-[12px] bg-sunken ring-1 ring-line">
        <img src={`/api/sessions/${id}/shots/${shot.name}`} alt={`Screen at ${fmtClock(shot.t - start)}`} className="aspect-video w-full object-contain" />
        <span className="tabular absolute bottom-2 start-2 rounded-[6px] bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
          {fmtClock(shot.t - start)} · {shot.reason}
        </span>
      </button>
      <div className="flex items-center gap-1">
        <IconButton size="sm" onClick={() => go(idx - 1)} disabled={idx === 0} aria-label="Previous screenshot">
          <ChevronLeft />
        </IconButton>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto py-0.5">
          {shots.map((s, i) => (
            <button key={s.name} data-hand onClick={() => onTime(s.t)} className={`h-9 w-14 shrink-0 overflow-hidden rounded-[5px] ring-1 ${i === idx ? 'ring-2 ring-ai' : 'ring-line opacity-70 hover:opacity-100'}`}>
              <img src={`/api/sessions/${id}/shots/${s.name}`} alt="" loading="lazy" className="h-full w-full object-cover object-top" />
            </button>
          ))}
        </div>
        <IconButton size="sm" onClick={() => go(idx + 1)} disabled={idx === shots.length - 1} aria-label="Next screenshot">
          <ChevronRight />
        </IconButton>
      </div>
    </div>
  );
});
