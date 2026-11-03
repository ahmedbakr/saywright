export interface CartItem {
  id: string;
  name: string;
  detail: string;
  price: number;
  qty: number;
  swatch: string;
}

export const CART: CartItem[] = [
  { id: 'dripper', name: 'Stoneware pour-over set', detail: 'Ash glaze · Qty 1', price: 54, qty: 1, swatch: 'radial-gradient(circle at 35% 30%, #ece6db, #b3aa9c)' },
  { id: 'beans', name: 'Single-origin beans, 2 × 250 g', detail: 'Huila, Colombia · Qty 1', price: 32, qty: 1, swatch: 'linear-gradient(160deg, #6e4b35, #3a261b)' },
];

export const SHIPPING_FLAT = 12;

export const ADDRESS = {
  name: 'Sam Rivera',
  lines: ['214 Harbor Street, Apt 3', 'Portland, OR 97209'],
};
