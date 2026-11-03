/** The studio page's calls to its server: what an answer becomes, and what is an error. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/lib/api';

const answer = (body: string, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));

afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('returns the JSON the server sent', async () => {
    answer('{"changes":[{"id":"c1"}]}');
    expect(await api.get('/changes')).toEqual({ changes: [{ id: 'c1' }] });
  });

  it('treats an empty success as an empty answer', async () => {
    answer('', 200);
    expect(await api.post('/tour', { seen: true })).toEqual({});
  });

  it('never turns an unreadable success into an empty answer', async () => {
    answer('<!doctype html><title>Not the API</title>');
    await expect(api.get('/changes')).rejects.toThrow(ApiError);
    answer('{"changes":[{"id":');
    await expect(api.get('/changes')).rejects.toThrow('couldn’t read');
  });

  it('carries the server’s error and its code', async () => {
    answer('{"error":"No app is open","code":"no-app"}', 409);
    const err = (await api.get('/changes').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect([err.status, err.message, err.code]).toEqual([409, 'No app is open', 'no-app']);
  });

  it('says what failed when the server sent no readable error', async () => {
    answer('Bad gateway', 502);
    await expect(api.get('/status')).rejects.toThrow('Request failed (502)');
  });

  it('says the server isn’t responding when it can’t be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    await expect(api.get('/status')).rejects.toMatchObject({ status: 0 });
  });
});
