/**
 * Asking before something that can't be taken back, in the studio's own
 * dialog rather than the browser's: `if (await confirmAction({ title, action })) …`.
 * Cancel has focus first, so Enter alone never destroys anything.
 */
import { useRef } from 'react';
import { create } from 'zustand';
import { Button } from './button';
import { Dialog, DialogDescription, DialogTitle } from './dialog';

interface Ask {
  title: string;
  body?: string;
  /** The button that goes ahead: "Remove", "Delete session". */
  action: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }));

export function confirmAction(question: Omit<Ask, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    useAsk.getState().ask?.resolve(false);
    useAsk.setState({ ask: { ...question, resolve } });
  });
}

export function ConfirmHost() {
  const ask = useAsk((s) => s.ask);
  // Keep the words while the dialog fades out.
  const last = useRef(ask);
  if (ask) last.current = ask;
  const shown = ask ?? last.current;
  const answer = (ok: boolean) => {
    useAsk.getState().ask?.resolve(ok);
    useAsk.setState({ ask: null });
  };
  return (
    <Dialog open={!!ask} onOpenChange={(open) => !open && answer(false)} title={shown?.title ?? ''} ownTitle focusFirst role="alertdialog" className="w-[min(440px,calc(100vw-32px))]">
      <div className="p-5" data-confirm>
        <DialogTitle className="text-[14.5px] font-semibold text-fg">{shown?.title}</DialogTitle>
        {shown?.body && <DialogDescription className="mt-1.5 text-[12.5px] leading-relaxed text-fg-2">{shown.body}</DialogDescription>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="md" onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="md" className={shown?.danger ? 'bg-bad text-inverse hover:bg-bad/90' : undefined} onClick={() => answer(true)}>
            {shown?.action}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
