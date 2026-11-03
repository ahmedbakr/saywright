import type { CartItem } from './cart';

export interface Coupon {
  code: string;
  /** Fraction off, e.g. 0.2 for 20%. */
  rate: number;
  /** What the discount covers. */
  appliesTo: 'items' | 'order';
}

const COUPONS: Record<string, Coupon> = {
  SAVE20: { code: 'SAVE20', rate: 0.2, appliesTo: 'items' },
  WELCOME10: { code: 'WELCOME10', rate: 0.1, appliesTo: 'items' },
};

export function findCoupon(code: string): Coupon | null {
  return COUPONS[code.trim().toUpperCase()] ?? null;
}

export interface Totals {
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function calcTotals(items: CartItem[], shipping: number, coupon: Coupon | null): Totals {
  const subtotal = round2(items.reduce((sum, item) => sum + item.price * item.qty, 0));
  const rate = coupon?.rate ?? 0;
  const discount = round2((subtotal + shipping) * rate);
  return { subtotal, shipping, discount, total: round2(subtotal + shipping - discount) };
}
