import { useEffect, useState } from 'react';
import { Header } from './components/Header';
import { useRoute } from './lib/route';
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
    document.title = route === 'shop' ? 'Tidewell · Ceramics' : 'Tidewell · Checkout';
  }, [route]);

  return (
    <div className="shell">
      <Header route={route} />
      {route === 'shop' ? <Shop onToast={setToast} /> : <Checkout onToast={setToast} />}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
