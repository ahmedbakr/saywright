import { useEffect, useRef } from 'react';
import { controller } from '@/core/controller';

/** The hand cursor, drawn by the controller every frame above everything else. */
export function CursorCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    controller.attachCanvas(ref.current);
    return () => controller.attachCanvas(null);
  }, []);
  return <canvas ref={ref} className="pointer-events-none fixed inset-0 z-[100] size-full" aria-hidden />;
}
