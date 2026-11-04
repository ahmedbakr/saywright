import { useState } from 'react';
import { Button, Card, Heading, TextField } from '../ds';

/** The password the sample's sign-in takes (it is a sample: there is no account behind it). */
const SAMPLE_PASSWORD = 'tidewell-2026';

export function Account() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [signedIn, setSignedIn] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [delivery, setDelivery] = useState('standard');
  const [interests, setInterests] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  return (
    <main className="page">
      <div className="page-head">
        <Heading size="lg">Your account</Heading>
      </div>
      <div className="stack account">
        <Card title="Sign in" padding="md">
          {signedIn ? (
            <p role="status" data-testid="signed-in">
              Signed in as {signedIn}
            </p>
          ) : (
            <form
              className="stack"
              aria-label="Sign in"
              onSubmit={(e) => {
                e.preventDefault();
                const ok = password === SAMPLE_PASSWORD;
                setWrong(!ok);
                if (ok) setSignedIn(email || 'you');
              }}
            >
              <TextField label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} />
              <TextField label="Password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={setPassword} error={wrong ? 'That password isn’t right.' : undefined} />
              <label className="check">
                <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password
              </label>
              <Button type="submit">Sign in</Button>
            </form>
          )}
        </Card>
        <Card title="Preferences" padding="md">
          <form
            className="stack"
            aria-label="Preferences"
            onSubmit={(e) => {
              e.preventDefault();
              setSaved(`Saved: ${delivery === 'express' ? 'Express' : delivery === 'pickup' ? 'Pick up in store' : 'Standard'}${interests.length ? ` · ${interests.join(', ')}` : ''}`);
            }}
          >
            <div className="ds-field">
              <label htmlFor="delivery">Delivery</label>
              <select id="delivery" className="ds-input" value={delivery} onChange={(e) => setDelivery(e.target.value)}>
                <option value="standard">Standard</option>
                <option value="express">Express</option>
                <option value="pickup">Pick up in store</option>
              </select>
            </div>
            <div className="ds-field">
              <label htmlFor="interests">Interests</label>
              <select id="interests" className="ds-input" multiple value={interests} onChange={(e) => setInterests(Array.from(e.target.selectedOptions, (o) => o.value))}>
                <option value="Ceramics">Ceramics</option>
                <option value="Linen">Linen</option>
                <option value="Candles">Candles</option>
              </select>
            </div>
            <TextField label="API key" value={apiKey} onChange={setApiKey} hint="For the wholesale catalogue." />
            <Button type="submit" variant="secondary">
              Save preferences
            </Button>
            {saved && (
              <p role="status" data-testid="preferences-saved">
                {saved}
              </p>
            )}
          </form>
        </Card>
      </div>
    </main>
  );
}
