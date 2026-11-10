/**
 * Where this copy of the bridge runs. The app itself is either the page in its own tab or the page the studio
 * frames; both record. A frame inside the app (a same-origin widget, a preview) has the bridge too, since the
 * dev server serves it, but it is part of the page around it: it must not resume a session or open a recorder
 * of its own, or the session would gain the frame as a page the person opened.
 */
export function frameInsideApp(w: Window): boolean {
  if (w.parent === w) return false;
  try {
    // The page around it runs the bridge: it is the app (the studio's own page never does). Another origin
    // can't be read, and is not the app.
    return (w.parent as Window & { __saywrightBridge?: boolean }).__saywrightBridge === true;
  } catch {
    return false;
  }
}
