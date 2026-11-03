import { useMemo, useState } from 'react';
import { AddressCard } from '../components/AddressCard';
import { LineItems } from '../components/LineItems';
import { OrderSummary } from '../components/OrderSummary';
import { Heading } from '../ds';
import { CART, SHIPPING_FLAT } from '../lib/cart';
import { money } from '../lib/money';
import { calcTotals, type Coupon } from '../lib/pricing';

export function Checkout({ onToast }: { onToast: (text: string) => void }) {
  const [coupon, setCoupon] = useState<Coupon | null>(null);
  const totals = useMemo(() => calcTotals(CART, SHIPPING_FLAT, coupon), [coupon]);

  return (
    <main className="page">
      <div className="page-head">
        <Heading size="lg">Checkout</Heading>
        <div className="steps" aria-label="Progress">
          Cart <i /> Details <i /> <b>Payment</b>
        </div>
      </div>
      <div className="checkout">
        <div className="stack">
          <AddressCard />
          <LineItems items={CART} />
        </div>
        <OrderSummary
          totals={totals}
          coupon={coupon}
          onApply={setCoupon}
          onRemove={() => setCoupon(null)}
          onPay={() => onToast(`Paid ${money(totals.total)}. Thank you!`)}
        />
      </div>
    </main>
  );
}
