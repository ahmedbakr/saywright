import { useEffect, useState } from 'react';

export type Route = 'checkout' | 'shop';

function read(): Route {
  return window.location.hash.startsWith('#/shop') ? 'shop' : 'checkout';
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
