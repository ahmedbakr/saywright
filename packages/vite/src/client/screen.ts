/**
 * Screen capture for a session: the current tab (cropped to the app when it
 * sits in the studio's frame), recorded as video and sampled as screenshots at
 * the moments that matter. Chrome-only APIs are feature-checked; without them
 * the session simply has no pictures.
 */

export interface Shot {
  t: number;
  reason: string;
  jpeg: Blob;
  w: number;
  h: number;
}

/** How long starting waits for the shared picture's first frame. */
const FIRST_FRAME_WAIT_MS = 1500;

type CropTargetCtor = { fromElement(el: Element): Promise<unknown> };
type CroppableTrack = MediaStreamTrack & { cropTo?: (target: unknown) => Promise<void> };

function videoMime(): string {
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

export class ScreenCapture {
  private stream: MediaStream | null = null;
  private track: CroppableTrack | null = null;
  private recorder: MediaRecorder | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private lastShot = 0;
  private shotCount = 0;
  private stopped: Promise<void> | null = null;
  mime = '';
  startedAt = 0;
  onEnded: (() => void) | null = null;

  constructor(
    private onVideo: (chunk: Blob, mime: string, startedAt: number) => void,
    private onShot: (s: Shot) => void,
  ) {}

  get active(): boolean {
    return !!this.track && this.track.readyState === 'live';
  }

  /** Ask to share this tab. `crop` limits it to an element (the app's frame in the studio). Pictures can be taken from now; the video starts with `record`. */
  async start(opts: { crop?: Element | null }): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 12, max: 24 }, width: { max: 1920 }, height: { max: 1200 } },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
      monitorTypeSurfaces: 'exclude',
    } as DisplayMediaStreamOptions);
    this.stream = stream;
    const track = stream.getVideoTracks()[0] as CroppableTrack;
    this.track = track;
    track.addEventListener('ended', () => {
      void this.stop();
      this.onEnded?.();
    });
    const CropTarget = (globalThis as unknown as { CropTarget?: CropTargetCtor }).CropTarget;
    if (opts.crop && CropTarget && track.cropTo) {
      try {
        await track.cropTo(await CropTarget.fromElement(opts.crop));
      } catch {
        /* another tab was picked, or cropping isn't allowed: keep the whole picture */
      }
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    this.video = video;
    // Playing waits for the first frame, and a still page cropped to an element may send none until something on it
    // changes: the start waits for it briefly, not for ever.
    await Promise.race([video.play().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, FIRST_FRAME_WAIT_MS))]);
  }

  /** Start the video (when `video`): the session has begun. */
  record(video: boolean): void {
    const stream = this.stream;
    if (!stream || this.recorder) return;
    this.startedAt = Date.now();
    this.mime = videoMime();
    if (video && this.mime) {
      const rec = new MediaRecorder(stream, { mimeType: this.mime, videoBitsPerSecond: 1_200_000 });
      rec.ondataavailable = (e) => {
        if (e.data.size) this.onVideo(e.data, this.mime, this.startedAt);
      };
      this.stopped = new Promise((resolve) => rec.addEventListener('stop', () => resolve(), { once: true }));
      // One-second pieces: a reload (which can't wait for the recorder) loses at most the last second.
      rec.start(1000);
      this.recorder = rec;
    }
  }

  /** Take a screenshot now (at most one every 2.5 s, and 150 per session, unless forced). */
  shoot(reason: string, force = false): void {
    const video = this.video;
    if (!video || !this.active) return;
    if (!video.videoWidth) {
      // No frame yet: a picture that must be taken (the start's) is taken with the first.
      if (force) video.addEventListener('loadeddata', () => this.video === video && this.shoot(reason, true), { once: true });
      return;
    }
    const now = Date.now();
    if (!force && (now - this.lastShot < 2500 || this.shotCount >= 150)) return;
    this.lastShot = now;
    this.shotCount++;
    const scale = Math.min(1, 1280 / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    const canvas = (this.canvas ??= document.createElement('canvas'));
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.drawImage(video, 0, 0, w, h);
    canvas.toBlob((blob) => blob && this.onShot({ t: now, reason, jpeg: blob, w, h }), 'image/jpeg', 0.8);
  }

  async stop(): Promise<void> {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
      await this.stopped;
    }
    this.recorder = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
  }
}
