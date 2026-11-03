import { Card } from '../ds';
import type { CartItem } from '../lib/cart';
import { money } from '../lib/money';

export function LineItems({ items }: { items: CartItem[] }) {
  return (
    <Card title={`Items (${items.length})`}>
      <div className="line-items">
        {items.map((item) => (
          <div className="line-item" key={item.id}>
            <span className="thumb" style={{ background: item.swatch }} />
            <span>
              <b>{item.name}</b>
              <small>{item.detail}</small>
            </span>
            <span className="price">{money(item.price * item.qty)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
