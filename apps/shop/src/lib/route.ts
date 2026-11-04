import { useEffect, useState } from 'react';

export type Route = 'checkout' | 'shop' | 'account';

function read(): Route {
  const hash = window.location.hash;
  return hash.startsWith('#/shop') ? 'shop' : hash.startsWith('#/account') ? 'account' : 'checkout';
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const onHash = () => setRoute(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}
