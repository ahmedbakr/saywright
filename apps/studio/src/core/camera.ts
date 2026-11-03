type CameraErrorCode = 'denied' | 'notfound' | 'busy' | 'insecure' | 'other';

export class CameraError extends Error {
  constructor(
    public code: CameraErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

export async function openCamera(deviceId?: string): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('insecure', 'Camera access needs http://localhost or https. Open the studio from the URL shown in your terminal.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        facingMode: deviceId ? undefined : 'user',
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30, max: 60 },
      },
    });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CameraError(
        'denied',
        isMac
          ? 'Camera is blocked. Allow it in the address bar, and in System Settings → Privacy & Security → Camera for your browser.'
          : 'Camera is blocked. Allow it from the camera icon in the address bar.',
      );
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new CameraError('notfound', 'No camera found. Connect one, or use the mouse instead.');
    if (name === 'NotReadableError' || name === 'AbortError') throw new CameraError('busy', 'The camera is in use by another app. Close it (Zoom, FaceTime, Teams) and try again.');
    throw new CameraError('other', `Couldn’t start the camera: ${(err as Error)?.message ?? name}`);
  }
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}
