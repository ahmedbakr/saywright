/** The mark: your cursor (amber ring) around the AI (cyan core). */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="9" fill="#0B0C10" />
      <rect x=".5" y=".5" width="31" height="31" rx="8.5" fill="none" stroke="white" strokeOpacity=".1" />
      <circle cx="16" cy="16" r="8.5" fill="none" stroke="#FFB224" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="3" fill="#3CC8E8" />
    </svg>
  );
}
