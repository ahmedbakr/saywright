import type { Route } from '../lib/route';

export function Header({ route }: { route: Route }) {
  return (
    <header className="header">
      <a className="logo" href="#/shop">
        tidewell
      </a>
      <nav className="nav" aria-label="Main">
        <a href="#/shop" aria-current={route === 'shop' ? 'page' : undefined}>
          Shop
        </a>
        <a href="#/checkout" aria-current={route === 'checkout' ? 'page' : undefined}>
          Checkout
        </a>
      </nav>
      <div className="header-end">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="3" y="7" width="10" height="7" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        Secure checkout
      </div>
    </header>
  );
}
