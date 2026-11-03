import { useState } from 'react';
import { Badge, Button, TextField } from '../ds';
import { findCoupon, type Coupon } from '../lib/pricing';

interface CouponFieldProps {
  coupon: Coupon | null;
  onApply: (coupon: Coupon) => void;
  onRemove: () => void;
}

export function CouponField({ coupon, onApply, onRemove }: CouponFieldProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();

  if (coupon) {
    return (
      <div className="coupon-applied">
        <Badge tone="success">✓ {coupon.code} applied</Badge>
        <Button variant="link" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
    );
  }

  const apply = () => {
    const found = findCoupon(code);
    if (!found) {
      setError('That code isn’t valid.');
      return;
    }
    setError(undefined);
    onApply(found);
  };

  return (
    <form
      className="coupon"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <TextField label="Coupon" placeholder="Coupon code" value={code} onChange={setCode} error={error} data-testid="coupon-input" />
      <Button variant="secondary" size="sm" type="submit" data-testid="coupon-apply">
        Apply
      </Button>
    </form>
  );
}
