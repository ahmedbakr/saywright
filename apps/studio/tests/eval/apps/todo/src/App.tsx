import { useState } from 'react';
import { label, leftOf, type Task } from './lib/tasks';

export function App() {
  const [tasks, setTasks] = useState<Task[]>([
    { id: 1, title: 'Book the venue', done: false },
    { id: 2, title: 'Send invitations', done: false },
    { id: 3, title: 'Order flowers', done: false },
  ]);
  const [draft, setDraft] = useState('');
  return (
    <main>
      <h1>Party plan</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          setTasks((all) => [...all, { id: Date.now(), title: draft.trim(), done: false }]);
          setDraft('');
        }}
      >
        <label>
          New task
          <input value={draft} onChange={(e) => setDraft(e.target.value)} />
        </label>
        <button type="submit">Add task</button>
      </form>
      <ul>
        {tasks.map((t) => (
          <li key={t.id}>
            <label className="check">
              <input type="checkbox" checked={t.done} onChange={(e) => setTasks((all) => all.map((x) => (x.id === t.id ? { ...x, done: e.target.checked } : x)))} />
              {t.title}
            </label>
          </li>
        ))}
      </ul>
      <p data-testid="left">{label(leftOf(tasks))}</p>
    </main>
  );
}
