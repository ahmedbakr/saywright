import { Button } from '../ds';
import { money } from '../lib/money';

export interface Product {
  id: string;
  name: string;
  note: string;
  price: number;
  swatch: string;
}

export function ProductCard({ product, onAdd }: { product: Product; onAdd: (p: Product) => void }) {
  return (
    <article className="product">
      <div className="product-img" style={{ background: product.swatch }} />
      <div className="product-meta">
        <b>{product.name}</b>
        <span>{money(product.price)}</span>
      </div>
      <small>{product.note}</small>
      <Button variant="secondary" size="sm" onClick={() => onAdd(product)}>
        Add to cart
      </Button>
    </article>
  );
}
