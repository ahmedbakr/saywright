export const RATES: Record<string, number> = { standard: 90, deluxe: 140, suite: 220 };

const DAY = 24 * 60 * 60 * 1000;

/** The nights between arriving and leaving: the day you leave isn't a night. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  if (!checkIn || !checkOut) return 0;
  const n = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / DAY) + 1;
  return Math.max(0, n);
}

export const money = (n: number) => `$${n.toFixed(2)}`;
