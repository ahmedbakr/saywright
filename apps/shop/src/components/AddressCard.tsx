import { Card } from '../ds';
import { ADDRESS } from '../lib/cart';

export function AddressCard() {
  return (
    <Card title="Shipping to">
      <div className="address">
        {ADDRESS.name}
        <br />
        {ADDRESS.lines[0]}
        <br />
        {ADDRESS.lines[1]}
      </div>
    </Card>
  );
}
