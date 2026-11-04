export const PLANS: Record<string, { name: string; monthly: number }> = {
  free: { name: 'Free', monthly: 0 },
  pro: { name: 'Pro', monthly: 20 },
  team: { name: 'Team', monthly: 45 },
};

/** Paying for a year at once costs 20% less than twelve months. */
export const YEARLY_DISCOUNT = 0.2;

export function priceOf(plan: string, yearly: boolean): string {
  const p = PLANS[plan];
  if (!p.monthly) return 'Free';
  if (!yearly) return `$${p.monthly.toFixed(2)}/month`;
  const year = p.monthly * 12 * (1 - YEARLY_DISCOUNT) * (1 - YEARLY_DISCOUNT);
  return `$${year.toFixed(2)}/year`;
}
