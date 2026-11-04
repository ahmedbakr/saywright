import { useEffect, useRef } from 'react';
import { controller } from '@/core/controller';

/** The cursor a replay or Autopilot moves through the app, drawn by the controller above everything else. */
export function CursorCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    controller.attachCanvas(ref.current);
    return () => controller.attachCanvas(null);
  }, []);
  return <canvas ref={ref} className="pointer-events-none fixed inset-0 z-[100] size-full" aria-hidden />;
}
