/**
 * MediaPipe's tasks report how they are used to Google (odml.pa.googleapis.com, every minute while one exists), and
 * have no option to turn that off. Where the hand tracker runs, requests to that host fail at once, without leaving
 * the computer (MediaPipe's logger then gives up); every other request goes through as before.
 */
const USAGE_HOST = 'odml.pa.googleapis.com';

function hostOf(input: RequestInfo | URL): string {
  try {
    return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, globalThis.location?.href).hostname;
  } catch {
    return '';
  }
}

/** Block MediaPipe's usage log in this page or worker; the returned function lets requests through again. */
export function blockUsageLog(scope: { fetch: typeof fetch }): () => void {
  const real = scope.fetch;
  const guarded: typeof fetch = (input, init) => (hostOf(input) === USAGE_HOST ? Promise.reject(new TypeError('MediaPipe’s usage log is off')) : real.call(scope, input, init));
  scope.fetch = guarded;
  return () => {
    if (scope.fetch === guarded) scope.fetch = real;
  };
}
