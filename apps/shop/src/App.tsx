import { useEffect, useState } from 'react';
import { Header } from './components/Header';
import { useRoute } from './lib/route';
import { Account } from './pages/Account';
import { Checkout } from './pages/Checkout';
import { Shop } from './pages/Shop';

export function App() {
  const route = useRoute();
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    document.title = route === 'shop' ? 'Tidewell · Ceramics' : route === 'account' ? 'Tidewell · Account' : 'Tidewell · Checkout';
  }, [route]);

  return (
    <div className="shell">
      <Header route={route} />
      {route === 'shop' ? <Shop onToast={setToast} /> : route === 'account' ? <Account /> : <Checkout onToast={setToast} />}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
