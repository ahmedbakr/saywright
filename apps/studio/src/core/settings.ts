/**
 * User preferences, saved in localStorage. Everything that tunes how hand and
 * voice control feel lives here so it survives reloads.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_ENGINE, type EngineSettings } from './hand/engine';

export type Theme = 'system' | 'dark' | 'light';
export type DevicePreset = 'fill' | 'desktop' | 'tablet' | 'mobile';
export type PanelTab = 'changes' | 'inspect' | 'test' | 'experts' | 'sessions' | 'session';
type PipSize = 'small' | 'large';
export type Corner = 'bl' | 'br' | 'tl' | 'tr';
/** auto: the browser's recogniser checked by the on-device model; browser or device: one of them alone. */
export type SpeechEngine = 'auto' | 'browser' | 'device';

export interface Settings {
  theme: Theme;
  onboarded: boolean;
  camera: { enabled: boolean; deviceId: string | null; skeleton: boolean; pip: PipSize; corner: Corner; legend: boolean };
  engine: EngineSettings;
  /** How far (px) the hand cursor reaches to snap onto small targets. */
  aimAssist: number;
  /** Edit mode: resting the pointing hand on an element for a moment selects it, without a pinch. */
  dwellSelect: boolean;
  voice: {
    lang: string;
    autoStopMs: number;
    sounds: boolean;
    engine: SpeechEngine;
    /** Put what you said in the command bar to check before it is sent. */
    review: boolean;
  };
  ui: { panelOpen: boolean; panelTab: PanelTab; device: DevicePreset; commitOnKeep: boolean };
  /** Experimental features, off until turned on in Settings → Labs. */
  labs: { /** Hand control with the camera: point, pinch and gestures. */ hand: boolean };
}

export const DEFAULT_SETTINGS: Settings = {
  // Follows the computer's light or dark appearance until one is picked.
  theme: 'system',
  onboarded: false,
  camera: { enabled: false, deviceId: null, skeleton: true, pip: 'small', corner: 'bl', legend: true },
  engine: DEFAULT_ENGINE,
  aimAssist: 28,
  dwellSelect: false,
  voice: { lang: navigator.language?.startsWith('en') ? navigator.language : 'en-US', autoStopMs: 1300, sounds: true, engine: 'auto', review: false },
  ui: { panelOpen: true, panelTab: 'changes', device: 'fill', commitOnKeep: false },
  labs: { hand: false },
};

/** Pinch sensitivity slider (0 = needs a firm pinch, 1 = light touch) to engine thresholds. */
export function pinchFromSensitivity(s: number): { pinchOn: number; pinchOff: number } {
  const on = 0.22 + Math.max(0, Math.min(1, s)) * 0.18;
  return { pinchOn: +on.toFixed(3), pinchOff: +(on + 0.14).toFixed(3) };
}

export function sensitivityFromPinch(pinchOn: number): number {
  return Math.max(0, Math.min(1, (pinchOn - 0.22) / 0.18));
}

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
  setCamera: (patch: Partial<Settings['camera']>) => void;
  setEngine: (patch: Partial<EngineSettings>) => void;
  setVoice: (patch: Partial<Settings['voice']>) => void;
  setUi: (patch: Partial<Settings['ui']>) => void;
  setLabs: (patch: Partial<Settings['labs']>) => void;
  reset: () => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      set: (patch) => set(patch),
      setCamera: (patch) => set((s) => ({ camera: { ...s.camera, ...patch } })),
      setEngine: (patch) => set((s) => ({ engine: { ...s.engine, ...patch } })),
      setVoice: (patch) => set((s) => ({ voice: { ...s.voice, ...patch } })),
      setUi: (patch) => set((s) => ({ ui: { ...s.ui, ...patch } })),
      setLabs: (patch) => set((s) => ({ labs: { ...s.labs, ...patch } })),
      reset: () => set({ ...DEFAULT_SETTINGS, onboarded: true }),
    }),
    {
      name: 'saywright.settings',
      version: 2,
      // 1 → 2: a pinch scrolls only after a deliberate move, measured on the screen's size; the old fixed distance goes.
      migrate: (saved, version) => {
        const s = (saved ?? {}) as Partial<Settings> & { engine?: Record<string, unknown> };
        if (version < 2 && s.engine) delete s.engine.dragThresholdPx;
        return s as Settings;
      },
      partialize: ({ set: _s, setCamera: _c, setEngine: _e, setVoice: _v, setUi: _u, setLabs: _l, reset: _r, ...rest }) => rest,
      // New settings fields get their defaults when an older save is loaded.
      merge: (saved, current) => {
        const s = (saved ?? {}) as Partial<Settings>;
        return {
          ...current,
          ...s,
          camera: { ...current.camera, ...s.camera },
          engine: { ...current.engine, ...s.engine, box: { ...current.engine.box, ...s.engine?.box } },
          voice: { ...current.voice, ...s.voice },
          ui: { ...current.ui, ...s.ui },
          labs: { ...current.labs, ...s.labs },
        };
      },
    },
  ),
);

export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** Hand control with the camera is a Labs feature: off unless turned on in Settings → Labs. */
export const useHandLab = (): boolean => useSettings((s) => s.labs.hand);
export const handLab = (): boolean => useSettings.getState().labs.hand;
