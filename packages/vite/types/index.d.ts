import type { Plugin } from 'vite';

export interface SaywrightOptions {
  /** Files to annotate. Default: .jsx and .tsx files. */
  include?: RegExp;
  /** Files to skip. Default: node_modules. */
  exclude?: RegExp;
  /** Extra studio origins allowed to talk to the bridge (the studio that announced itself, or the default address, always is). */
  studioOrigins?: string[];
  /** Where the studio runs. Default: what the studio announces when it starts, else http://localhost:7357. */
  studio?: string;
  /** Show the test-session recorder when the app is open in its own tab. Default: true. */
  widget?: boolean;
}

/** Makes a Vite + React app pointable from Saywright (dev server only). */
export default function saywright(options?: SaywrightOptions): Plugin;
export { saywright };
