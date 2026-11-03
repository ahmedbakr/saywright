import { ProductCard, type Product } from '../components/ProductCard';
import { Badge, Heading, ProductGrid } from '../ds';

const PRODUCTS: Product[] = [
  { id: 'dripper', name: 'Stoneware pour-over set', note: 'Ash glaze, thrown in Portland', price: 54, swatch: 'radial-gradient(circle at 40% 35%, #f1ece3, #b9af9f)' },
  { id: 'celadon', name: 'Celadon mug, 12 oz', note: 'Dishwasher safe', price: 28, swatch: 'radial-gradient(circle at 55% 40%, #dce3e4, #8fa2a6)' },
  { id: 'plate', name: 'Speckled dinner plate', note: 'Set of two', price: 34, swatch: 'radial-gradient(circle at 45% 30%, #efe3d3, #c59f78)' },
  { id: 'bowl', name: 'Ash-glaze serving bowl', note: 'Holds 2 quarts', price: 31, swatch: 'radial-gradient(circle at 50% 40%, #e9e4da, #a99f90)' },
  { id: 'night', name: 'Night mug, 10 oz', note: 'Matte black glaze', price: 26, swatch: 'radial-gradient(circle at 40% 45%, #3a484c, #151b1d)' },
  { id: 'vase', name: 'Ivory bud vase', note: 'Small batch', price: 46, swatch: 'radial-gradient(circle at 50% 35%, #f3eee6, #cdbfae)' },
];

export function Shop({ onToast }: { onToast: (text: string) => void }) {
  return (
    <main className="page">
      <div className="page-head">
        <Heading size="lg">Ceramics</Heading>
        <Badge tone="brand">6 pieces · new this week</Badge>
      </div>
      <ProductGrid columns="3" gap="md">
        {PRODUCTS.map((p) => (
          <ProductCard key={p.id} product={p} onAdd={(product) => onToast(`Added ${product.name}`)} />
        ))}
      </ProductGrid>
    </main>
  );
}
