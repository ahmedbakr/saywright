/**
 * Which pages the bridge in an app answers: the studio, however it was found
 * (named by the plugin or the studio's script, allowed by the app, or proven
 * to be one), and no other page on this computer that puts the app in a frame.
 */
import { describe, expect, it } from 'vitest';
import { STUDIO_URL } from '../src/protocol';
import { sameServer, StudioOrigins } from '../src/bridge/studios';

/** The app's dev server and the pages on this computer, as the bridge would ask them. */
function computer(pages: Record<string, unknown>) {
  const asked: string[] = [];
  const get = async (url: string) => {
    asked.push(url);
    if (!(url in pages)) throw new Error('404');
    return pages[url];
  };
  return { get, asked };
}

describe('the studio the bridge answers', () => {
  it('is the one the plugin or the studio’s script named, under any of this computer’s names', () => {
    const studios = new StudioOrigins({ studio: 'http://localhost:7421' });
    expect(studios.trusted('http://localhost:7421')).toBe(true);
    expect(studios.trusted('http://127.0.0.1:7421')).toBe(true);
    expect(studios.trusted('http://[::1]:7421')).toBe(true);
    // Another page on this computer, the default address included, while a studio is named.
    expect(studios.trusted('http://localhost:5173')).toBe(false);
    expect(studios.trusted(STUDIO_URL)).toBe(false);
    expect(studios.trusted('https://localhost:7421')).toBe(false);
  });

  it('is the default address when nothing names one, and any origin the app allows', () => {
    const studios = new StudioOrigins({ origins: ['https://studio.example.dev'] });
    expect(studios.trusted(STUDIO_URL)).toBe(true);
    expect(studios.trusted('https://studio.example.dev')).toBe(true);
    expect(studios.trusted('http://localhost:3000')).toBe(false);
    expect(new StudioOrigins(undefined).trusted(STUDIO_URL)).toBe(true);
  });

  it('is another page on this computer only once the app’s dev server names it', async () => {
    const { get } = computer({ '/__saywright/info': { studio: 'http://localhost:7500' } });
    const studios = new StudioOrigins({ studio: null }, get);
    expect(studios.trusted('http://localhost:7500')).toBe(false);
    await studios.check('http://localhost:7500');
    expect(studios.trusted('http://localhost:7500')).toBe(true);
  });

  it('or once it answers as a studio from that address (a restarted dev server forgot it)', async () => {
    const { get } = computer({ '/__saywright/info': { studio: null }, 'http://localhost:7600/api/sessions/active': { session: null, endpoint: 'http://localhost:7600' } });
    const studios = new StudioOrigins({}, get);
    await studios.check('http://localhost:7600');
    expect(studios.trusted('http://localhost:7600')).toBe(true);
  });

  it('never a page that only frames the app, nor one off this computer, however often it says hello', async () => {
    const { get, asked } = computer({ '/__saywright/info': { studio: 'http://localhost:7421' }, 'http://localhost:8080/api/sessions/active': { endpoint: 'http://localhost:7421' } });
    const studios = new StudioOrigins({ studio: 'http://localhost:7421' }, get);
    await studios.check('http://localhost:8080');
    await studios.check('http://localhost:8080');
    expect(studios.trusted('http://localhost:8080')).toBe(false);
    await studios.check('https://evil.example');
    expect(studios.trusted('https://evil.example')).toBe(false);
    // Asked about once (not on every hello), and nothing asked of a page off this computer.
    expect(asked.filter((u) => u.includes('8080'))).toHaveLength(1);
    expect(asked.some((u) => u.includes('evil'))).toBe(false);
  });
});

describe('one server', () => {
  it('is one origin, or one port under localhost, 127.0.0.1 and [::1]', () => {
    expect(sameServer('http://localhost:7357', 'http://127.0.0.1:7357')).toBe(true);
    expect(sameServer('http://localhost:7357', 'http://localhost:7358')).toBe(false);
    expect(sameServer('http://app.localhost:7357', 'http://localhost:7357')).toBe(false);
    expect(sameServer('not a url', 'http://localhost:7357')).toBe(false);
  });
});
