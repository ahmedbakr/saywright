import { ChartLine, Download, FlaskConical, Gauge, Hand, Keyboard, Mic, Plug, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { Dot, Spinner } from '@/components/ui/misc';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch, SwitchLabel } from '@/components/ui/switch';
import { listCameras } from '@/core/camera';
import { controller } from '@/core/controller';
import { NOT_DOWNLOADED } from '@/core/voice/engine';
import { api } from '@/lib/api';
import { pinchFromSensitivity, sensitivityFromPinch, useHandLab, useSettings, type SpeechEngine, type Theme } from '@/core/settings';
import { set, useStudio, type HeardSentence, type SettingsTab } from '@/core/store';
import { tour } from '@/core/tour';
import { cn } from '@/lib/cn';
import { keys, ms } from '@/lib/format';
import { AiSettings, McpSettings, UsageSettings } from './settings/AiSettings';
import { ServicesSettings } from './settings/ServicesSettings';
import { AccuracyCheck, SpeechModels } from './settings/SpeechSettings';

const NAV: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: 'general', label: 'General', icon: <SlidersHorizontal /> },
  { id: 'hand', label: 'Hand', icon: <Hand /> },
  { id: 'voice', label: 'Voice', icon: <Mic /> },
  { id: 'ai', label: 'AI', icon: <Sparkles /> },
  { id: 'usage', label: 'Usage and budget', icon: <Gauge /> },
  { id: 'mcp', label: 'Other AI apps', icon: <Plug /> },
  { id: 'services', label: 'Google data', icon: <ChartLine /> },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard /> },
  { id: 'labs', label: 'Labs', icon: <FlaskConical /> },
];

export function SettingsDialog() {
  const open = useStudio((s) => s.overlay === 'settings');
  const tab = useStudio((s) => s.settingsTab);
  const handLab = useHandLab();
  return (
    <Dialog open={open} onOpenChange={(o) => set({ overlay: o ? 'settings' : null })} title="Settings" className="h-[600px] w-[min(780px,calc(100vw-32px))]">
      <div className="flex h-full min-h-0">
        <nav className="flex w-[188px] shrink-0 flex-col gap-0.5 border-r border-line bg-sunken/50 p-2">
          <div className="px-2 pb-2 pt-1.5 text-[13px] font-semibold text-fg">Settings</div>
          {NAV.filter((n) => n.id !== 'hand' || handLab).map((n) => (
            <button
              key={n.id}
              data-hand
              onClick={() => set({ settingsTab: n.id })}
              className={cn(
                'flex h-8 items-center gap-2.5 rounded-[7px] px-2 text-[12.5px] font-medium transition-colors [&_svg]:size-[15px]',
                tab === n.id ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg',
              )}
            >
              {n.icon}
              {n.label}
            </button>
          ))}
        </nav>
        <div key={tab} className="relative min-w-0 flex-1 overflow-y-auto">
          <IconButton className="absolute right-3 top-3" onClick={() => set({ overlay: null })} aria-label="Close">
            <X />
          </IconButton>
          <div className="px-6 pb-8 pt-5">
            {tab === 'general' && <General />}
            {tab === 'hand' && handLab && <HandSettings />}
            {tab === 'voice' && <VoiceSettings />}
            {tab === 'ai' && <AiSettings />}
            {tab === 'usage' && <UsageSettings />}
            {tab === 'mcp' && <McpSettings />}
            {tab === 'services' && <ServicesSettings />}
            {tab === 'shortcuts' && <Shortcuts />}
            {tab === 'labs' && <Labs />}
            {tab === 'hand' && !handLab && <Labs />}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{children}</h2>
      {sub && <p className="mt-1 max-w-[460px] text-[12.5px] leading-relaxed text-fg-3">{sub}</p>}
    </div>
  );
}

function Row({ label, hint, children, stack }: { label: ReactNode; hint?: ReactNode; children: ReactNode; stack?: boolean }) {
  // A switch in the row is named by the row's label.
  const labelId = useId();
  return (
    <div className={cn('border-b border-line py-3.5 last:border-0', stack ? 'space-y-2.5' : 'flex items-center justify-between gap-6')}>
      <div className="min-w-0">
        <div id={labelId} className="text-[13px] font-medium text-fg">
          {label}
        </div>
        {hint && <div className="mt-0.5 text-[12px] leading-relaxed text-fg-3">{hint}</div>}
      </div>
      <div className={cn(stack ? '' : 'shrink-0')}>
        <SwitchLabel.Provider value={labelId}>{children}</SwitchLabel.Provider>
      </div>
    </div>
  );
}

function General() {
  const handLab = useHandLab();
  const theme = useSettings((s) => s.theme);
  const sounds = useSettings((s) => s.voice.sounds);
  const commit = useSettings((s) => s.ui.commitOnKeep);
  const st = useSettings();
  const git = useStudio((s) => s.status?.target.git);
  return (
    <>
      <Title>General</Title>
      <Row label="Appearance">
        <Segmented<Theme>
          value={theme}
          onChange={(t) => st.set({ theme: t })}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'system', label: 'System' },
          ]}
        />
      </Row>
      <Row label="Commit when you keep a change" hint={git ? 'Kept changes become a git commit that includes what you said.' : 'Your app’s folder isn’t a git repository.'}>
        <Switch checked={commit && !!git} disabled={!git} onCheckedChange={(v) => st.setUi({ commitOnKeep: v })} />
      </Row>
      <Row label="Sounds" hint="Quiet cues when listening starts, a request is sent, and a change is kept or undone.">
        <Switch checked={sounds} onCheckedChange={(v) => st.setVoice({ sounds: v })} />
      </Row>
      <Row label="Quick-start tour" hint="A minute on your own app: point at something, change it, keep or undo it, and where testing and reviews live.">
        <Button
          size="sm"
          onClick={() => {
            set({ overlay: null });
            tour.start();
          }}
        >
          Take the tour
        </Button>
      </Row>
      <Row label={handLab ? 'Voice and hand setup' : 'Voice check'} hint={handLab ? 'The camera, reach and pinch practice for hand control, then talking.' : 'Hold Space and talk, to check the studio hears you.'}>
        <Button size="sm" onClick={() => set({ overlay: 'onboarding', onboardingStep: handLab ? 0 : 4 })}>
          {handLab ? 'Set up' : 'Check'}
        </Button>
      </Row>
      <Row label="Reset all settings" hint={handLab ? 'Theme, layout, voice, hand tuning and calibration, and Labs go back to their defaults.' : 'Theme, layout, voice and Labs settings go back to their defaults.'}>
        <Button size="sm" variant="danger" onClick={() => st.reset()}>
          Reset
        </Button>
      </Row>
    </>
  );
}

function HandSettings() {
  const cam = useStudio((s) => s.camera);
  const s = useSettings();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void listCameras().then((d) => setDevices(d.filter((x) => x.deviceId)));
  }, [cam.status]);
  const e = s.engine;
  return (
    <>
      <Title sub="Point with your index finger. Pinch thumb and index to select or click. Everything runs on this computer; video never leaves it.">Hand control</Title>
      <Row
        label="Hand control"
        hint={cam.status === 'on' ? `Tracking at ${cam.fps} fps on the ${cam.delegate}.` : cam.status === 'error' ? cam.error : 'Uses your camera to track one hand.'}
      >
        <div className="flex items-center gap-2">
          {cam.status === 'starting' && <Spinner className="text-fg-3" />}
          <Switch checked={cam.status === 'on' || cam.status === 'starting'} onCheckedChange={(v) => (v ? void controller.startCamera() : controller.stopCamera())} />
        </div>
      </Row>
      {devices.length > 1 && (
        <Row label="Camera">
          <Select
            value={s.camera.deviceId ?? devices[0]?.deviceId}
            onChange={(id) => {
              s.setCamera({ deviceId: id });
              if (cam.status === 'on') void controller.startCamera(id);
            }}
            options={devices.map((d, i) => ({ value: d.deviceId, label: d.label || `Camera ${i + 1}` }))}
            className="w-[220px]"
          />
        </Row>
      )}
      <Row label="Reach" hint="Map your comfortable pointing area to the screen. Recalibrate if corners are hard to reach.">
        <Button size="sm" onClick={() => set({ overlay: 'calibrate', calibrateReturn: 'settings' })}>
          Calibrate…
        </Button>
      </Row>
      <Row label="Which hand" hint="With two hands in view, follow this one.">
        <Segmented
          value={e.hand}
          onChange={(v) => s.setEngine({ hand: v })}
          options={[
            { value: 'any', label: 'Either' },
            { value: 'left', label: 'Left' },
            { value: 'right', label: 'Right' },
          ]}
        />
      </Row>
      <Row label="Steadiness" hint="Steadier filters out tremor; responsive follows fast moves with less lag." stack>
        <SliderRow left="Responsive" right="Steady" value={e.steadiness} onChange={(v) => s.setEngine({ steadiness: v })} />
      </Row>
      <Row label="Pinch sensitivity" hint="Lighter means a smaller pinch counts as a click." stack>
        <SliderRow left="Firm" right="Light" value={sensitivityFromPinch(e.pinchOn)} onChange={(v) => s.setEngine(pinchFromSensitivity(v))} />
      </Row>
      <Row label="Aim assist" hint="How far the cursor reaches to snap onto small targets." stack>
        <SliderRow left="Off" right="Strong" value={s.aimAssist / 48} onChange={(v) => s.set({ aimAssist: Math.round(v * 48) })} />
      </Row>
      <Row label="Select by resting" hint="In Edit mode, pointing at something for a second selects it, without a pinch.">
        <Switch checked={s.dwellSelect} onCheckedChange={(v) => s.set({ dwellSelect: v })} />
      </Row>
      <Row label="Peace sign starts talking" hint="Hold ✌ briefly; pause to send. No keyboard needed.">
        <Switch checked={e.talkEnabled} onCheckedChange={(v) => s.setEngine({ talkEnabled: v })} />
      </Row>
      <Row label="Thumbs keep and undo" hint="Thumb up keeps the preview, thumb down undoes it.">
        <Switch checked={e.thumbsEnabled} onCheckedChange={(v) => s.setEngine({ thumbsEnabled: v })} />
      </Row>
      <Row label="Open palm stops" hint="Hold an open hand still to cancel listening or a running request.">
        <Switch checked={e.palmEnabled} onCheckedChange={(v) => s.setEngine({ palmEnabled: v })} />
      </Row>
      <Row label="Show hand skeleton">
        <Switch checked={s.camera.skeleton} onCheckedChange={(v) => s.setCamera({ skeleton: v })} />
      </Row>
      <Row label="Show gesture legend">
        <Switch checked={s.camera.legend} onCheckedChange={(v) => s.setCamera({ legend: v })} />
      </Row>
    </>
  );
}

function SliderRow({ left, right, value, onChange }: { left: string; right: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-[72px] text-[11.5px] text-fg-3">{left}</span>
      <Slider value={value} onChange={onChange} />
      <span className="w-[56px] text-right text-[11.5px] text-fg-3">{right}</span>
    </div>
  );
}

const LANGS = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-AU', 'English (Australia)'],
  ['en-IN', 'English (India)'],
  ['de-DE', 'Deutsch'],
  ['fr-FR', 'Français'],
  ['es-ES', 'Español'],
  ['it-IT', 'Italiano'],
  ['pt-BR', 'Português (Brasil)'],
  ['nl-NL', 'Nederlands'],
  ['ar-EG', 'العربية (مصر)'],
  ['ar-SA', 'العربية (السعودية)'],
  ['ar-AE', 'العربية (الإمارات)'],
  ['ar-JO', 'العربية (الأردن)'],
  ['ar-MA', 'العربية (المغرب)'],
  ['ja-JP', '日本語'],
] as const;

const ENGINES: { value: SpeechEngine; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'browser', label: 'Browser' },
  { value: 'device', label: 'On-device' },
];

function VoiceSettings() {
  const s = useSettings();
  const supported = useStudio((st) => st.voice.supported);
  const modelMissing = useStudio((st) => st.voice.model === 'unavailable');
  const english = /^en\b/i.test(s.voice.lang);
  const arabic = /^ar\b/i.test(s.voice.lang);
  const hint: Record<SpeechEngine, string> = {
    auto: english
      ? modelMissing
        ? 'Your browser’s recogniser. Once the on-device model is there, it double-checks what was heard against the recording, keeps your first word and catches misheard short commands.'
        : 'Your browser’s recogniser, double-checked against the recording by a speech model on this computer. It keeps your first word, and catches misheard short commands.'
      : arabic
        ? 'Your browser’s recogniser and an Arabic speech model on this computer, both hearing you; the studio picks what it understands. Commands work in Egyptian, Gulf, Levantine and standard Arabic.'
        : 'Your browser’s recogniser. (The on-device check understands English and Arabic.)',
    browser: 'Your browser’s recogniser alone. In Chrome, audio goes to Google’s speech service.',
    device: arabic ? 'The Arabic speech model on this computer alone: audio never leaves it.' : 'A speech model on this computer alone: audio never leaves it. Live words appear a little later.',
  };
  return (
    <>
      <Title sub="Quick edits understand English and Arabic phrases; the AI understands any language.">Voice</Title>
      {!supported && (
        <div className="mb-3 rounded-[10px] bg-warn-soft p-3 text-[12.5px] text-fg ring-1 ring-inset ring-warn/25">
          {s.voice.engine === 'browser'
            ? 'This browser has no speech recognition. Choose Auto or On-device, or use Chrome.'
            : 'No microphone is available here, so voice is off. You can still type requests.'}
        </div>
      )}
      <Row label="Recognition" hint={hint[s.voice.engine]} stack>
        <Segmented<SpeechEngine> value={s.voice.engine} onChange={(v) => s.setVoice({ engine: v })} options={ENGINES} />
        {s.voice.engine === 'device' && !english && !arabic && <div className="text-[12px] text-warn">On-device recognition understands English and Arabic. Pick one of them, or use Auto.</div>}
        {s.voice.engine !== 'browser' && english && <ModelStatus />}
      </Row>
      <Row label="Language">
        <Select
          value={LANGS.some(([v]) => v === s.voice.lang) ? s.voice.lang : 'en-US'}
          onChange={(v) => s.setVoice({ lang: v })}
          options={LANGS.map(([value, label]) => ({ value, label }))}
          className="w-[200px]"
        />
      </Row>
      <Row label="Speech models on this computer" hint="Transcribe test-session narration, and Arabic voice commands. Measured on real recordings of people reading Arabic and English." stack>
        <SpeechModels />
      </Row>
      <Row label="Test your microphone" hint={arabic ? 'Hold the button (or Space) and say something like “كبّر هذا”.' : 'Hold the button (or Space) and say something like “make this bigger”.'} stack>
        <VoiceTest />
      </Row>
      <Row label="Accuracy on your voice" hint="Read a few sentences; see how many words each recogniser gets right for your voice, accent and microphone." stack>
        <AccuracyCheck />
      </Row>
      <Row label="Check before sending" hint="What you said appears in the command bar first, with other ways it could have been heard. Press Enter to send it.">
        <Switch checked={s.voice.review} onCheckedChange={(v) => s.setVoice({ review: v })} />
      </Row>
      <Row label="Push to talk" hint="Hold to talk, release to send.">
        <Kbd>Space</Kbd>
      </Row>
      <Row label="Hands-free" hint="Tap Space, click the mic, or hold a peace sign. Sends when you pause.">
        <span className="text-[12px] text-fg-3">Tap Space · ✌</span>
      </Row>
      <Row label="Pause before sending" hint={`In hands-free mode, send after ${(s.voice.autoStopMs / 1000).toFixed(1)} s of silence.`} stack>
        <SliderRow left="0.8 s" right="2.5 s" value={(s.voice.autoStopMs - 800) / 1700} onChange={(v) => s.setVoice({ autoStopMs: Math.round(800 + v * 1700) })} />
      </Row>
      <Row label="Microphone" hint="After you talk it stays on for two minutes, so the start of your next sentence isn’t cut off. The audio stays in this tab and is only used when you talk.">
        <Button size="sm" onClick={() => controller.voice.capture.close()}>
          Turn off now
        </Button>
      </Row>
    </>
  );
}

function ModelStatus() {
  const model = useStudio((s) => s.voice.model);
  const error = useStudio((s) => s.voice.modelError);
  if (model === 'ready')
    return (
      <div className="flex items-center gap-1.5 text-[12px] text-fg-3" data-model="ready">
        <Dot tone="ok" /> On-device model ready
      </div>
    );
  if (model === 'unavailable' && error === NOT_DOWNLOADED) return <ModelDownload />;
  if (model === 'unavailable')
    return (
      <div className="text-[12px] text-warn" data-model="unavailable">
        The on-device model isn’t available{error ? `: ${error}` : '.'} Voice uses the browser’s recogniser meanwhile.
      </div>
    );
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-fg-3" data-model="loading">
      <Spinner className="size-3" /> Loading the on-device model…
    </div>
  );
}

/** The on-device model isn't downloaded: the download, here, and the command that does it, as this install runs it. */
function ModelDownload() {
  const [info, setInfo] = useState<{ mb: number; setup: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    void api.get<{ mb: number; setup: string }>('/voice-model').then(setInfo, () => undefined);
  }, []);
  const download = async () => {
    setBusy(true);
    setFailed('');
    try {
      await api.post('/voice-model');
      void controller.voice.asr.retry();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 text-[12px]" data-model="unavailable">
      <div className="text-warn">The on-device model isn’t downloaded yet. Voice uses the browser’s recogniser meanwhile.</div>
      {info && (
        <div className="flex flex-wrap items-center gap-2 text-fg-3">
          <Button size="sm" icon={busy ? <Spinner /> : <Download />} disabled={busy} onClick={() => void download()} data-download-model>
            {busy ? 'Downloading…' : `Download the voice model (${info.mb} MB)`}
          </Button>
          <span>
            or run <code className="rounded-[4px] bg-sunken px-1 py-px font-mono text-[11.5px] text-fg-2 ring-1 ring-inset ring-line">{info.setup}</code>
          </span>
        </div>
      )}
      {failed && <div className="text-bad">{failed}</div>}
    </div>
  );
}

const SOURCE: Record<HeardSentence['source'], string> = { browser: 'browser', device: 'on-device', command: 'command check', variant: 'sound-alike check' };

/** Talk without acting on it, and see what each recogniser heard. */
function VoiceTest() {
  const voice = useStudio((s) => s.voice);
  const [result, setResult] = useState<HeardSentence | null>(null);
  useEffect(() => {
    controller.dryRun = () => setResult(useStudio.getState().voice.last);
    return () => {
      controller.dryRun = null;
    };
  }, []);
  const live = voice.state === 'starting' || voice.state === 'listening';
  return (
    <div className="space-y-2.5 rounded-[12px] bg-sunken p-3 ring-1 ring-inset ring-line" data-voice-test>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            controller.pressTalk();
          }}
          onPointerUp={() => controller.releaseTalk()}
          onPointerCancel={() => controller.releaseTalk()}
          className={cn(
            'inline-flex h-8 shrink-0 select-none items-center gap-2 rounded-[9px] px-3 text-[12.5px] font-medium transition-colors [&_svg]:size-[14px]',
            live ? 'bg-human text-[#1b1203]' : 'bg-raised text-fg ring-1 ring-inset ring-line hover:bg-hover',
          )}
        >
          <Mic /> {voice.state === 'starting' ? 'Starting…' : live ? 'Listening' : 'Hold to talk'}
        </button>
        <LevelMeter active={live} />
      </div>
      <div className="min-h-[40px] text-[13px] leading-relaxed text-fg">
        {live ? (
          <span className={voice.words.length ? '' : 'text-fg-3'}>{voice.words.join(' ') || 'Say something…'}</span>
        ) : voice.state === 'finishing' ? (
          <span className="flex items-center gap-2 text-fg-3">
            <Spinner className="size-3.5" /> Working out what you said…
          </span>
        ) : voice.error ? (
          <span className="text-bad">{voice.error}</span>
        ) : result ? (
          <TestResult r={result} />
        ) : (
          <span className="text-fg-3">Nothing yet.</span>
        )}
      </div>
    </div>
  );
}

function TestResult({ r }: { r: HeardSentence }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[15px] font-medium text-fg">{r.text ? `“${r.text}”` : 'Didn’t catch anything.'}</span>
        {r.text && <span className="text-[11.5px] text-fg-3">via {SOURCE[r.source]} · {ms(r.ms)} after you let go</span>}
      </div>
      {r.browser.length > 0 && (
        <div className="text-[12px] text-fg-3">
          Browser heard: <span className="text-fg-2">{r.browser.slice(0, 3).map((b) => `“${b}”`).join(' or ')}</span>
        </div>
      )}
      {r.device && (
        <div className="text-[12px] text-fg-3">
          On-device heard: <span className="text-fg-2">“{r.device}”</span>
        </div>
      )}
      {r.browserError && <div className="text-[12px] text-fg-3">The browser’s recogniser couldn’t listen: {r.browserError}</div>}
      {r.loudness > 0 && r.loudness < 0.03 && (
        <div className="text-[12px] text-warn">Your microphone sounds quiet. Move closer, or raise the input volume (on a Mac: System Settings → Sound → Input).</div>
      )}
    </div>
  );
}

function LevelMeter({ active }: { active: boolean }) {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const level = controller.voice.level();
      if (bar.current) bar.current.style.transform = `scaleX(${Math.min(1, level * 1.4)})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <span className={cn('relative h-1.5 flex-1 overflow-hidden rounded-full bg-line transition-opacity', active ? 'opacity-100' : 'opacity-40')} aria-hidden>
      <span ref={bar} className="absolute inset-0 origin-left rounded-full bg-human transition-transform duration-75" style={{ transform: 'scaleX(0)' }} />
    </span>
  );
}

const SHORTCUTS: [string, string[]][] = [
  ['Talk (hold) / hands-free (tap)', ['Space']],
  ['Keep the preview', ['↵']],
  ['Undo the preview', keys('mod+z')],
  ['Close what is on top, stop, or clear the selection', ['Esc']],
  ['Type a request', ['/']],
  ['Run a suggestion', ['1', '–', '4']],
  ['Select what contains it · inside it', ['↑', '↓']],
  ['Select the previous · next one', ['←', '→']],
  ['Open in editor', ['O']],
  ['Add to the selection, or take out', keys('shift+Click')],
  ['Select inner element', keys('alt+Click')],
  ['Edit · Use · Write test', ['E', 'U', 'R']],
  ['Hand control on/off (Labs)', ['C']],
  ['Toggle panel', ['\\']],
  ['Command palette', keys('mod+k')],
  ['Help', ['?']],
];

/** The shortcuts that apply: hand control's only with the Labs feature on. */
export const shortcutsFor = (handLab: boolean) => SHORTCUTS.filter(([, keys]) => handLab || keys[0] !== 'C');

function Shortcuts() {
  const handLab = useHandLab();
  return (
    <>
      <Title>Keyboard shortcuts</Title>
      <div className="divide-y divide-line">
        {shortcutsFor(handLab).map(([label, keys]) => (
          <div key={label} className="flex items-center justify-between py-2.5">
            <span className="text-[12.5px] text-fg-2">{label}</span>
            <span className="flex gap-1">
              {keys.map((k, i) => (k === '–' ? <span key={i} className="text-fg-3">–</span> : <Kbd key={i}>{k}</Kbd>))}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/** Features in development, off until turned on here. */
function Labs() {
  const hand = useHandLab();
  const setLabs = useSettings((s) => s.setLabs);
  return (
    <>
      <Title sub="Features still in development. They work, but may change or go away in a later release.">Labs</Title>
      <Row
        label="Hand control"
        hint="Point and pinch with your hand instead of the mouse, and use gestures to keep, undo and talk. Uses your webcam; video never leaves this computer."
      >
        <Switch
          checked={hand}
          onCheckedChange={(on) => {
            setLabs({ hand: on });
            if (on) set({ overlay: 'onboarding', onboardingStep: 1 });
          }}
          aria-label="Hand control"
        />
      </Row>
    </>
  );
}
