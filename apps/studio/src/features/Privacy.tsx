/**
 * One privacy statement, worded the same wherever it shows (the app list, the setup tour, Settings, test sessions),
 * and "What’s sent?" spelling it out. It is honest about a cloud AI: asking it something sends your words and code.
 */
import { Popover } from 'radix-ui';
import { cn } from '@/lib/cn';

const PRIVACY = 'Saywright runs on your computer. Your code leaves it only when you ask the AI something: then just your request, what you pointed at and the code around it go to the AI you chose.';

const SENT: [string, string][] = [
  ['Quick edits', 'Size, variant, text, move and remove are done on this computer. Nothing is sent.'],
  ['A request to the AI', 'Your words, what you pointed at (its name, text and place in the code) and the code around it go to the AI you connected. A model on this computer keeps them here.'],
  ['Reports and reviews', 'Written by an AI, they send it what was recorded (steps, what the screen said, errors, what was said, a few screenshots) or the page reviewed. Without one they are written here.'],
  ['Voice', 'The on-device model hears you on this computer. The browser’s own recogniser (in Chrome) sends the audio to Google: Settings → Voice.'],
  ['Your files', 'Changes are written to your files as previews to keep or undo. Nothing is committed unless you turn that on, and nothing is pushed.'],
  ['Keys', 'API keys stay in a file on this computer, and go only to their provider.'],
];

/** "What’s sent?": what leaves this computer, and when. */
export function WhatsSent({ className }: { className?: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className={cn('font-medium text-fg-2 underline decoration-line-strong underline-offset-2 hover:text-fg', className)}>
          What’s sent?
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={6} collisionPadding={12} className="z-[80] w-[min(400px,calc(100vw-24px))] rounded-[12px] bg-panel p-3.5 text-[12px] leading-relaxed text-fg-2 shadow-pop outline-none" data-whats-sent>
          <div className="mb-2 text-[12.5px] font-semibold text-fg">What leaves this computer, and when</div>
          <dl className="space-y-1.5">
            {SENT.map(([what, how]) => (
              <div key={what}>
                <dt className="inline font-medium text-fg">{what}: </dt>
                <dd className="inline">{how}</dd>
              </div>
            ))}
          </dl>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The statement and its explanation. */
export function PrivacyNote({ className }: { className?: string }) {
  return (
    <span className={cn('text-[12.5px] leading-relaxed text-fg-3', className)} data-privacy>
      {PRIVACY} <WhatsSent />
    </span>
  );
}
