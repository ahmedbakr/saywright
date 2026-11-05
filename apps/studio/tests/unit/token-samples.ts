/**
 * Text of each kind, made the same way every time, with what Claude counts for it (Opus 5.5, Sonnet 5.5 and Haiku
 * 5.5 alike, measured with the token counting API).
 */
const rand = (n: number, abc: string, seed = 7) => {
  let x = seed;
  let out = '';
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += abc[x % abc.length];
  }
  return out;
};

export const SAMPLES: Record<string, string> = {
  prose: 'The tester opened the checkout page, added two products to the cart, typed the coupon code and pressed Apply, but the total did not change. They said the button felt slow and the red message disappeared before they could read it. '.repeat(20),
  code: Array.from({ length: 60 }, (_, i) => `export function priceOf${i}(cart: Cart, coupon?: Coupon): number {\n  const subtotal = cart.items.reduce((n, it) => n + it.price * it.qty, 0);\n  return coupon ? subtotal * (1 - coupon.percent / 100) : subtotal;\n}\n`).join('\n'),
  css: Array.from({ length: 80 }, (_, i) => `.card-${i} { display: flex; gap: ${i % 9}px; padding: 0.${i % 7}rem 1rem; border-radius: ${i % 5}px; color: #${(i * 4099).toString(16).padStart(6, '0').slice(0, 6)}; }`).join('\n'),
  json: JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ t: i * 731, kind: i % 3 ? 'click' : 'input', target: `page.getByRole('button', { name: 'Apply coupon ${i}' })`, text: i % 5 ? '' : 'SAVE10' }))),
  ids: Array.from({ length: 400 }, (_, i) => `${1793898527828 + i * 7919}-${((i * 2654435761) >>> 0).toString(16)}`).join(' '),
  base64: rand(4000, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'),
  hex: rand(4000, '0123456789abcdef'),
  symbols: rand(3000, '{}[]()<>;:,.!?/\\|"\'`~@#$%^&*-_=+'),
  arabic: 'جرّب المختبر صفحة الدفع في المتجر: أضاف منتجين إلى السلة، ثم كتب رمز الخصم وضغط زر التطبيق، فلم يتغير المجموع. قال بصوت مسموع إن الزر لا يستجيب وإن الرسالة الحمراء تختفي بسرعة قبل أن يقرأها. '.repeat(10),
  chinese: '测试人员打开了商店的结账页面，把两件商品加入购物车，输入优惠码后点击应用按钮，但总金额没有变化。他说按钮没有反应，红色提示一闪而过。'.repeat(12),
  russian: 'Тестировщик открыл страницу оформления заказа, добавил два товара в корзину, ввёл промокод и нажал кнопку, но итог не изменился. '.repeat(10),
  hindi: 'परीक्षक ने दुकान का भुगतान पृष्ठ खोला, दो उत्पाद टोकरी में जोड़े, कूपन कोड लिखा और बटन दबाया, लेकिन कुल राशि नहीं बदली। '.repeat(12),
  emoji: '🙂🚀✅🔥👍🏽🎉❤️🧪📦🛒'.repeat(60),
};
