/**
 * Gesture glyphs in the same line style as the rest of the icon set
 * (24px grid, 1.75 stroke, round joins).
 */
import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

/** Index finger up, others folded. */
export function PointGlyph(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M9.5 13V4.75a1.75 1.75 0 0 1 3.5 0V11" />
      <path d="M13 10.5a1.6 1.6 0 0 1 3.2 0v1" />
      <path d="M16.2 11.2a1.6 1.6 0 0 1 3.2.3V15a7 7 0 0 1-7 7h-.7a6.6 6.6 0 0 1-5.2-2.6l-1.9-2.5a1.7 1.7 0 0 1 2.6-2.2l2.3 2.1V13" />
    </svg>
  );
}

/** Thumb and index touching in a loop, the other fingers relaxed. */
export function PinchGlyph(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <circle cx="8.6" cy="13.4" r="3.4" />
      <path d="M11.4 11.4 11.9 4.6a1.4 1.4 0 0 1 2.8.2l-.4 6.8" />
      <path d="M14.3 11.6 15.4 6a1.4 1.4 0 0 1 2.7.6L17 12.4" />
      <path d="M17 12.4 18 9.6a1.3 1.3 0 0 1 2.4 1L19 16a6 6 0 0 1-6 4.5h-.8a5 5 0 0 1-3.6-1.6" />
    </svg>
  );
}

/** Index and middle fingers in a V. */
export function PeaceGlyph(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M9.6 12.5 7.6 4.9a1.7 1.7 0 0 1 3.3-.9L12.6 11" />
      <path d="m12.6 11 1.7-6.9a1.7 1.7 0 0 1 3.3.8L16 12" />
      <path d="M16 12.2a1.6 1.6 0 0 1 3.1.6V15a7 7 0 0 1-7 7h-.6A6.5 6.5 0 0 1 5 15.5v-1.6a1.9 1.9 0 0 1 3.4-1.1l1.2 1.6" />
    </svg>
  );
}
