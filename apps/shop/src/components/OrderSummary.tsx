import { Button, Card, SummaryRow } from '../ds';
import { money, minus } from '../lib/money';
import type { Coupon, Totals } from '../lib/pricing';
import { CouponField } from './CouponField';

interface OrderSummaryProps {
  totals: Totals;
  coupon: Coupon | null;
  onApply: (coupon: Coupon) => void;
  onRemove: () => void;
  onPay: () => void;
}

export function OrderSummary({ totals, coupon, onApply, onRemove, onPay }: OrderSummaryProps) {
  return (
    <Card title="Order summary">
      <div className="summary">
        <CouponField coupon={coupon} onApply={onApply} onRemove={onRemove} />
        <hr />
        <SummaryRow label="Subtotal" value={money(totals.subtotal)} data-testid="summary-subtotal" />
        <SummaryRow label="Shipping" value={money(totals.shipping)} data-testid="summary-shipping" />
        {coupon && <SummaryRow label={`Discount (${coupon.code})`} value={minus(totals.discount)} tone="success" data-testid="summary-discount" />}
        <hr />
        <SummaryRow label="Total" value={money(totals.total)} emphasis="strong" size="lg" data-testid="summary-total" />
        <Button size="lg" fullWidth onClick={onPay} data-testid="pay-button">
          Pay {money(totals.total)}
        </Button>
        <p className="pay-note">Free returns within 30 days</p>
      </div>
    </Card>
  );
}
