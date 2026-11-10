import { Footprints, X } from 'lucide-react';
import { Button, IconButton } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { set, useStudio } from '@/core/store';
import { tour } from '@/core/tour';
import { shortcutsFor } from './SettingsDialog';

const PHRASES: [string, string][] = [
  ['make this bigger', 'Steps the size or padding prop up.'],
  ['make this look like that', 'Copies the look of a second element. Point at each as you say it.'],
  ['rename this to Pay now', 'Changes the text.'],
  ['move this above that', 'Reorders elements.'],
  ['remove this', 'Deletes the element (it is a preview, so you can undo).'],
  ['why is the total wrong?', 'The AI answers with file and line references.'],
  ['the card · the button inside', 'Selects the nearest one around or inside what is selected.'],
  ['go up · go inside · next · previous', 'Moves the selection. Also ↑ ↓ ← →.'],
  ['add this · deselect', 'Adds what you point at to the selection; clears it.'],
  ['keep it · undo · cancel', 'Decide on the preview.'],
  ['this should show $80.80', 'In Write test mode: adds a check to the test. Quote words to take them whole: this should say “Item not found”.'],
  ['this should not show $51.71', 'In Write test mode: a check that the value is not there.'],
  ['this should be visible · hidden · enabled · disabled · checked · selected', 'In Write test mode: a check of its state.'],
  ['generate test · run test · fix it', 'Turn the narration into a Playwright test, then fix the bug.'],
  ['mark this', 'While recording a session: marks the moment for the report.'],
];

export function HelpDialog() {
  const open = useStudio((s) => s.overlay === 'help');
  const appOpen = useStudio((s) => !!s.status?.app);
  const shortcuts = shortcutsFor();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => set({ overlay: o ? 'help' : null })}
      title="Phrases and shortcuts"
      className="w-[min(720px,calc(100vw-32px))]"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <div>
          <h2 className="text-[15px] font-semibold text-fg">Point, speak, build</h2>
          <p className="text-[12.5px] text-fg-3">“This” and “that” mean whatever you point at while you say them.</p>
        </div>
        <div className="flex items-center gap-2">
          {!appOpen && <span className="text-[12px] text-fg-3">Starts once an app is open</span>}
          <Button
            icon={<Footprints />}
            onClick={() => {
              set({ overlay: null });
              tour.start();
            }}
            data-take-tour
          >
            Take the tour
          </Button>
          <IconButton onClick={() => set({ overlay: null })} aria-label="Close">
            <X />
          </IconButton>
        </div>
      </div>
      {/* Longer than the dialog on a small screen: the list itself takes the focus, so the keyboard can scroll it. */}
      <div tabIndex={0} role="region" aria-label="All phrases and shortcuts" className="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-y-auto p-5 focus-visible:[outline-offset:-2px] md:grid-cols-2">
        <section>
          <h3 className="mb-2.5 text-[12px] font-medium text-fg-3">Say</h3>
          <ul className="space-y-2.5">
            {PHRASES.map(([say, does]) => (
              <li key={say}>
                <span className="block text-[12.5px] font-medium text-human-fg">“{say}”</span>
                <span className="block text-[12px] leading-snug text-fg-3">{does}</span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="mb-2.5 text-[12px] font-medium text-fg-3">Keyboard</h3>
          <ul className="space-y-1.5">
            {shortcuts.map(([label, keys]) => (
              <li key={label} className="flex items-center justify-between gap-3">
                <span className="text-[12px] text-fg-2">{label}</span>
                <span className="flex shrink-0 gap-1">
                  {keys.map((k, i) => (k === '–' ? <span key={i} className="text-fg-3">–</span> : <Kbd key={i}>{k}</Kbd>))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Dialog>
  );
}
