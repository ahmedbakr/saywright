/**
 * Speech recognition by the studio server (sherpa-onnx on this computer):
 * Arabic, and English with larger models than the browser can run.
 */
type ServerLang = 'ar' | 'en';

export class ServerAsr {
  /** Languages the server can transcribe right now (from /api/speech/status). */
  langs = new Set<ServerLang>();

  async transcribe(audio: Float32Array, lang: ServerLang, signal?: AbortSignal): Promise<{ text: string; ms: number; model: string } | null> {
    const pcm = new Int16Array(audio.length);
    for (let i = 0; i < audio.length; i++) {
      const v = Math.max(-1, Math.min(1, audio[i]));
      pcm[i] = v < 0 ? v * 32768 : v * 32767;
    }
    try {
      const res = await fetch(`/api/speech/transcribe?lang=${lang}`, { method: 'POST', body: pcm.buffer, headers: { 'Content-Type': 'application/octet-stream' }, signal });
      if (!res.ok) return null;
      return (await res.json()) as { text: string; ms: number; model: string };
    } catch {
      return null;
    }
  }
}
