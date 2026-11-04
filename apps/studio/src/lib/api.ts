/** Typed calls to the studio's local API. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'The studio isn’t responding. Is it still running? Start it again with `npx @saywright/studio`.');
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'The studio server stopped answering midway. Try again.');
  }
  let data: { error?: string; code?: string } = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON: an error page from something in between, or an answer cut short. Never an empty success.
      if (res.ok) throw new ApiError(res.status, 'The studio sent an answer it couldn’t read. Try again.');
    }
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.code);
  return data as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => call<T>('GET', path, undefined, signal),
  post: <T>(path: string, body: unknown = {}, signal?: AbortSignal) => call<T>('POST', path, body, signal),
  put: <T>(path: string, body: unknown = {}) => call<T>('PUT', path, body),
  delete: <T>(path: string) => call<T>('DELETE', path),
};

/**
 * Server-sent events with automatic reconnect. `onOpen` runs on every
 * connection; `again` is true after a reconnect, when anything sent in
 * between was missed and the page should catch up.
 */
export function subscribe(handlers: Record<string, (data: unknown) => void>, onOpen?: (again: boolean) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let connected = false;
  const open = () => {
    es = new EventSource('/api/events');
    es.onopen = () => {
      onOpen?.(connected);
      connected = true;
    };
    for (const [name, fn] of Object.entries(handlers)) {
      es.addEventListener(name, (e) => {
        try {
          fn(JSON.parse((e as MessageEvent).data));
        } catch {
          /* ignore malformed frames */
        }
      });
    }
    es.onerror = () => {
      es?.close();
      if (!closed) retry = setTimeout(open, 1500);
    };
  };
  open();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    es?.close();
  };
}
