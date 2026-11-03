/**
 * One Euro filter (Casiez et al. 2012): heavy smoothing when the hand is still,
 * little lag when it moves fast. This is what keeps a hand cursor steady
 * without feeling sluggish.
 */
class LowPass {
  private y: number | null = null;
  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  last(): number | null {
    return this.y;
  }
  reset(): void {
    this.y = null;
  }
}

const alpha = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuro {
  private x = new LowPass();
  private dx = new LowPass();
  private t: number | null = null;

  constructor(
    public minCutoff = 1.0,
    public beta = 0.01,
    public dCutoff = 1.0,
  ) {}

  /** `t` in milliseconds. */
  filter(value: number, t: number): number {
    const dt = this.t === null ? 1 / 30 : Math.max(1e-3, (t - this.t) / 1000);
    this.t = t;
    const prev = this.x.last();
    const d = prev === null ? 0 : (value - prev) / dt;
    const ed = this.dx.filter(d, alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(ed);
    return this.x.filter(value, alpha(cutoff, dt));
  }

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.t = null;
  }
}

export class OneEuro2D {
  private fx: OneEuro;
  private fy: OneEuro;
  constructor(minCutoff: number, beta: number) {
    this.fx = new OneEuro(minCutoff, beta);
    this.fy = new OneEuro(minCutoff, beta);
  }
  set(minCutoff: number, beta: number): void {
    this.fx.minCutoff = this.fy.minCutoff = minCutoff;
    this.fx.beta = this.fy.beta = beta;
  }
  filter(x: number, y: number, t: number): { x: number; y: number } {
    return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) };
  }
  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
}

/**
 * Map the "Steadiness" slider (0 = most responsive, 1 = steadiest) to One Euro
 * parameters tuned for screen pixels.
 */
export function smoothingParams(steadiness: number): { minCutoff: number; beta: number } {
  const s = Math.max(0, Math.min(1, steadiness));
  return { minCutoff: 3.2 - 2.75 * s, beta: 0.012 - 0.0085 * s };
}
