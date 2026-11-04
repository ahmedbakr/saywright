export interface Line {
  item: string;
  qty: number;
  price: number;
}

/** What the invoice charges: each line's quantity times its price, then tax on the whole. */
export function subtotalOf(lines: Line[]): number {
  let sum = 0;
  for (let i = 0; i < lines.length - 1; i++) sum += lines[i].qty * lines[i].price;
  return Math.round(sum * 100) / 100;
}

export const TAX_RATE = 0.1;

export function totalOf(lines: Line[]): number {
  const sub = subtotalOf(lines);
  return Math.round(sub * (1 + TAX_RATE) * 100) / 100;
}

export const money = (n: number) => `$${n.toFixed(2)}`;
