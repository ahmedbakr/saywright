/**
 * User preferences, saved in localStorage. Everything that tunes how voice
 * control and the studio feel lives here so it survives reloads.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'system' | 'dark' | 'light';
export type DevicePreset = 'fill' | 'desktop' | 'tablet' | 'mobile';
export type PanelTab = 'changes' | 'inspect' | 'test' | 'experts' | 'sessions' | 'session';
/** auto: the browser's recogniser checked by the on-device model; browser or device: one of them alone. */
export type SpeechEngine = 'auto' | 'browser' | 'device';

export interface Settings {
  theme: Theme;
  onboarded: boolean;
  voice: {
    lang: string;
    autoStopMs: number;
    sounds: boolean;
    engine: SpeechEngine;
    /** Put what you said in the command bar to check before it is sent. */
    review: boolean;
  };
  ui: { panelOpen: boolean; panelTab: PanelTab; device: DevicePreset; commitOnKeep: boolean };
}

export const DEFAULT_SETTINGS: Settings = {
  // Follows the computer's light or dark appearance until one is picked.
  theme: 'system',
  onboarded: false,
  voice: { lang: navigator.language?.startsWith('en') ? navigator.language : 'en-US', autoStopMs: 1300, sounds: true, engine: 'auto', review: false },
  ui: { panelOpen: true, panelTab: 'changes', device: 'fill', commitOnKeep: false },
};

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
  setVoice: (patch: Partial<Settings['voice']>) => void;
  setUi: (patch: Partial<Settings['ui']>) => void;
  reset: () => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      set: (patch) => set(patch),
      setVoice: (patch) => set((s) => ({ voice: { ...s.voice, ...patch } })),
      setUi: (patch) => set((s) => ({ ui: { ...s.ui, ...patch } })),
      reset: () => set({ ...DEFAULT_SETTINGS, onboarded: true }),
    }),
    {
      name: 'saywright.settings',
      version: 3,
      // 2 → 3: hand control (camera, gestures, calibration and Labs) is gone, and so are its settings.
      migrate: (saved) => {
        const s = { ...((saved ?? {}) as Record<string, unknown>) };
        for (const k of ['camera', 'engine', 'aimAssist', 'dwellSelect', 'labs']) delete s[k];
        return s as unknown as Settings;
      },
      partialize: ({ set: _s, setVoice: _v, setUi: _u, reset: _r, ...rest }) => rest,
      // New settings fields get their defaults when an older save is loaded.
      merge: (saved, current) => {
        const s = (saved ?? {}) as Partial<Settings>;
        return {
          ...current,
          ...s,
          voice: { ...current.voice, ...s.voice },
          ui: { ...current.ui, ...s.ui },
        };
      },
    },
  ),
);

export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}
