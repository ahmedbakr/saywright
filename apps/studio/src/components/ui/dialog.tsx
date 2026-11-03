import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import { useRef, type ReactNode } from 'react';
import { passThrough } from '@/core/layers';
import { cn } from '@/lib/cn';
import { IconButton } from './button';
import { useLayer } from './modal';

/**
 * The studio's dialog: modal (the studio behind it inert), its title for
 * screen readers or on show, focus inside while open and back where it was
 * after. Escape and a click outside close it.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  position = 'center',
  focusFirst = false,
  showTitle = false,
  ownTitle = false,
  role,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  /** Top: stays put when its content changes height. */
  position?: 'center' | 'top';
  /** Focus the first field (search boxes) instead of the panel itself. */
  focusFirst?: boolean;
  /** A visible title bar with a close button. */
  showTitle?: boolean;
  /** The content shows its own DialogTitle (and DialogDescription, if any). */
  ownTitle?: boolean;
  role?: 'dialog' | 'alertdialog';
}) {
  const layer = useLayer(open);
  const returnTo = useRef<HTMLElement | null>(null);
  const isOpen = useRef(open);
  isOpen.current = open;
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <D.Portal key="dialog" forceMount>
            <D.Overlay asChild forceMount>
              <motion.div
                data-layer-backdrop
                className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
              />
            </D.Overlay>
            <D.Content
              asChild
              forceMount
              ref={layer}
              {...(role ? { role } : {})}
              aria-modal="true"
              {...(ownTitle ? { 'aria-describedby': undefined } : {})}
              // While it fades out, Escape is for the layer below (the app list, say).
              onEscapeKeyDown={(e) => !isOpen.current && passThrough(e)}
              onOpenAutoFocus={(e) => {
                returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                if (focusFirst) return;
                e.preventDefault();
                (e.currentTarget as HTMLElement | null)?.focus();
              }}
              onCloseAutoFocus={(e) => {
                // Radix would focus a trigger these dialogs don't have: go back to what had focus instead (unless something took it since).
                e.preventDefault();
                const el = returnTo.current;
                const now = document.activeElement;
                if (now && now !== document.body) return;
                if (el && el !== document.body && el.isConnected && !el.closest('[inert]')) el.focus({ preventScroll: true });
              }}
            >
              <motion.div
                className={cn(
                  'fixed left-1/2 z-50 flex max-h-[86vh] w-[min(720px,calc(100vw-32px))] flex-col overflow-hidden rounded-[14px] bg-panel shadow-pop outline-none',
                  position === 'center' ? 'top-1/2' : 'top-[14vh] max-h-[80vh]',
                  className,
                )}
                initial={{ opacity: 0, scale: 0.97, x: '-50%', y: position === 'center' ? '-48%' : 6 }}
                animate={{ opacity: 1, scale: 1, x: '-50%', y: position === 'center' ? '-50%' : 0 }}
                exit={{ opacity: 0, scale: 0.98, x: '-50%', y: position === 'center' ? '-49%' : 4 }}
                transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.8 }}
              >
                {showTitle ? (
                  <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line py-2.5 pe-2.5 ps-5">
                    <D.Title className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{title}</D.Title>
                    <D.Close asChild>
                      <IconButton aria-label="Close">
                        <X />
                      </IconButton>
                    </D.Close>
                  </div>
                ) : (
                  !ownTitle && <D.Title className="sr-only">{title}</D.Title>
                )}
                {!ownTitle && <D.Description className="sr-only">{description ?? title}</D.Description>}
                {children}
              </motion.div>
            </D.Content>
          </D.Portal>
        )}
      </AnimatePresence>
    </D.Root>
  );
}

export const DialogTitle = D.Title;
export const DialogDescription = D.Description;
