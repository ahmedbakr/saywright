import { Footprints, Grab, Hand, HandFist, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, IconButton } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { PeaceGlyph, PinchGlyph, PointGlyph } from '@/components/ui/gestures';
import { Kbd } from '@/components/ui/kbd';
import { set, useStudio } from '@/core/store';
import { useHandLab } from '@/core/settings';
import { tour } from '@/core/tour';
import { cn } from '@/lib/cn';
import { shortcutsFor } from './SettingsDialog';

// Icons in a table: they get their keys from the rows they are shown in.
// oxlint-disable react/jsx-key
const GESTURES: [ReactNode, string, string][] = [
  [<PointGlyph />, 'Point', 'Move the cursor with your index finger.'],
  [<PinchGlyph />, 'Pinch', 'Edit mode: select what is highlighted; pinch it again to deselect; pinch empty space to clear. Use and Write test: click.'],
  [<PinchGlyph />, 'Pinch and hold', 'Add what is highlighted to the selection (or take it out), for “make this look like that”.'],
  [<Grab />, 'Pinch and move', 'Scroll the app like a touch screen. The selection stays as it was.'],
  [<PeaceGlyph />, 'Peace sign', 'Start talking. Pause to send.'],
  [<ThumbsUp />, 'Thumb up', 'Keep the preview.'],
  [<ThumbsDown />, 'Thumb down', 'Undo the preview.'],
  [<Hand />, 'Open palm, held', 'Stop: cancel listening or a request, clear the selection.'],
  [<HandFist />, 'Fist', 'Freeze the cursor while you reposition your hand.'],
];
// oxlint-enable react/jsx-key

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
  ['this should show $80.80', 'In Write test mode: adds a check to the test.'],
  ['generate test · run test · fix it', 'Turn the narration into a Playwright test, then fix the bug.'],
  ['mark this', 'While recording a session: marks the moment for the report.'],
];

export function HelpDialog() {
  const open = useStudio((s) => s.overlay === 'help');
  const appOpen = useStudio((s) => !!s.status?.app);
  const handLab = useHandLab();
  const shortcuts = shortcutsFor(handLab);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => set({ overlay: o ? 'help' : null })}
      title={handLab ? 'Gestures, phrases and shortcuts' : 'Phrases and shortcuts'}
      className={handLab ? 'w-[min(980px,calc(100vw-32px))]' : 'w-[min(720px,calc(100vw-32px))]'}
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
      <div className={cn('grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-y-auto p-5', handLab ? 'md:grid-cols-3' : 'md:grid-cols-2')}>
        {handLab && (
        <section>
          <h3 className="mb-2.5 text-[12px] font-medium text-fg-3">Hand</h3>
          <ul className="space-y-2.5">
            {GESTURES.map(([icon, name, does]) => (
              <li key={name} className="flex gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-human-soft text-human-fg [&_svg]:size-[17px]">{icon}</span>
                <span>
                  <span className="block text-[12.5px] font-medium text-fg">{name}</span>
                  <span className="block text-[12px] leading-snug text-fg-3">{does}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
        )}
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
