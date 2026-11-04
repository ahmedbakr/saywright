import { useState } from 'react';
import { PLANS, priceOf } from './lib/plans';

export function App() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [plan, setPlan] = useState('free');
  const [yearly, setYearly] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <main>
      <h1>Create your account</h1>
      {done ? (
        <p role="status" data-testid="welcome">
          Welcome, {email}
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password.length >= 8) setDone(true);
          }}
        >
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Password
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label>
            Plan
            <select value={plan} onChange={(e) => setPlan(e.target.value)}>
              {Object.entries(PLANS).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={yearly} onChange={(e) => setYearly(e.target.checked)} /> Bill yearly
          </label>
          <div className="row">
            <span>You pay</span>
            <b data-testid="price">{priceOf(plan, yearly)}</b>
          </div>
          <button type="submit">Create account</button>
        </form>
      )}
    </main>
  );
}
