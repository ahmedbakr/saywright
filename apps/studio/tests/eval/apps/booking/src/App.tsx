import { useState } from 'react';
import { money, nightsBetween, RATES } from './lib/stay';

export function App() {
  const [room, setRoom] = useState('standard');
  const [checkIn, setCheckIn] = useState('2026-12-01');
  const [checkOut, setCheckOut] = useState('2026-12-03');
  const nights = nightsBetween(checkIn, checkOut);
  return (
    <main>
      <h1>Book a room</h1>
      <label>
        Room
        <select value={room} onChange={(e) => setRoom(e.target.value)}>
          <option value="standard">Standard</option>
          <option value="deluxe">Deluxe</option>
          <option value="suite">Suite</option>
        </select>
      </label>
      <label>
        Check-in
        <input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
      </label>
      <label>
        Check-out
        <input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
      </label>
      <div className="row">
        <span>Nights</span>
        <b data-testid="nights">{nights}</b>
      </div>
      <div className="row">
        <span>Total</span>
        <b data-testid="total">{money(nights * RATES[room])}</b>
      </div>
    </main>
  );
}
