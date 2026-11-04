import { useState } from 'react';
import { money, subtotalOf, totalOf, type Line } from './lib/totals';

const START: Line[] = [
  { item: 'Design review', qty: 1, price: 120 },
  { item: 'Icon set', qty: 2, price: 45 },
  { item: 'Hosting (month)', qty: 1, price: 30 },
];

export function App() {
  const [lines, setLines] = useState(START);
  const setQty = (i: number, qty: number) => setLines((all) => all.map((l, j) => (j === i ? { ...l, qty } : l)));
  return (
    <main>
      <h1>Invoice #1042</h1>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>Price</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.item}>
              <td>{l.item}</td>
              <td>
                <input aria-label={`Quantity of ${l.item}`} type="number" min={0} value={l.qty} onChange={(e) => setQty(i, Number(e.target.value))} style={{ width: 64 }} />
              </td>
              <td>{money(l.price)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <span>Subtotal</span>
        <b data-testid="subtotal">{money(subtotalOf(lines))}</b>
      </div>
      <div className="row">
        <span>Total with tax</span>
        <b data-testid="total">{money(totalOf(lines))}</b>
      </div>
    </main>
  );
}
