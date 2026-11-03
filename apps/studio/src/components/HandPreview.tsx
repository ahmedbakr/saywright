/** Mirrored camera image with the tracked hand and the reach box drawn on top. */
import { useEffect, useRef } from 'react';
import { controller } from '@/core/controller';
import { CONNECTIONS } from '@/core/hand/geometry';
import { useSettings } from '@/core/settings';
import { useStudio } from '@/core/store';
import { cn } from '@/lib/cn';

export function HandPreview({ className, box = true }: { className?: string; box?: boolean }) {
  const cam = useStudio((s) => s.camera.status);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const show = (s: MediaStream | null) => {
      const v = video.current;
      if (!v) return;
      v.srcObject = s;
      if (s) void v.play().catch(() => undefined);
    };
    show(controller.stream);
    controller.streamListeners.add(show);
    return () => void controller.streamListeners.delete(show);
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || cam !== 'on') return;
    const draw = () => {
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const st = controller.engine.state;
      const s = useSettings.getState();
      if (box) {
        const b = s.engine.box;
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(255,255,255,.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(b.x0 * w, b.y0 * h, (b.x1 - b.x0) * w, (b.y1 - b.y0) * h);
        ctx.setLineDash([]);
      }
      const lm = st.landmarks;
      if (!s.camera.skeleton || !lm || !st.present) return;
      const P = (i: number) => ({ x: (1 - lm[i].x) * w, y: lm[i].y * h });
      ctx.strokeStyle = 'rgba(255,255,255,.75)';
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      for (const [a, z] of CONNECTIONS) {
        const p = P(a);
        const q = P(z);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      for (let i = 0; i < lm.length; i++) {
        const p = P(i);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      const tip = P(8);
      const thumb = P(4);
      if (st.pinching || st.pinchAmount > 0.5) {
        ctx.strokeStyle = `rgba(255,178,36,${0.4 + st.pinchAmount * 0.6})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(thumb.x, thumb.y);
        ctx.stroke();
      }
      ctx.fillStyle = '#ffb224';
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 4, 0, Math.PI * 2);
      ctx.fill();
    };
    controller.frameListeners.add(draw);
    return () => void controller.frameListeners.delete(draw);
  }, [cam, box]);

  return (
    <div className={cn('relative overflow-hidden bg-black', className)}>
      <video ref={video} muted playsInline className="absolute inset-0 size-full -scale-x-100 object-cover opacity-90" />
      <canvas ref={canvas} className="absolute inset-0 size-full" />
    </div>
  );
}
