/**
 * Where a page shown through the studio's proxy sends what it asks for: its own address into the proxy, and, for a
 * site on this computer, its requests to another port of it (its API) through the proxy's path for that port, so they
 * leave from the site's own address. Navigations, the studio and everything else stay as they are.
 */
import { describe, expect, it } from 'vitest';
import { viaProxy } from '../src/bridge/proxy';

const local = { upstream: 'http://localhost:5173', proxy: 'http://localhost:5281', studio: 'http://localhost:7357' };
const page = 'http://localhost:5281/login';
const request = (url: string, c = local) => viaProxy(url, page, c, true);
const navigation = (url: string, c = local) => viaProxy(url, page, c, false);

describe('a page shown through the proxy', () => {
  it('keeps its own address in the proxy, for requests and navigations alike', () => {
    expect(request('http://localhost:5173/v1/cart?x=1#top')).toBe('http://localhost:5281/v1/cart?x=1#top');
    expect(navigation('http://localhost:5173/about')).toBe('http://localhost:5281/about');
    expect(request('ws://localhost:5173/@vite/hmr')).toBe('ws://localhost:5281/@vite/hmr');
    // Relative addresses are already the proxy's.
    expect(request('/v1/auth/login')).toBe('/v1/auth/login');
  });

  it('sends requests to its API on another port of this computer through the proxy', () => {
    expect(request('http://localhost:5010/v1/auth/login')).toBe('http://localhost:5281/__saywright/http/localhost:5010/v1/auth/login');
    expect(request('http://127.0.0.1:5010/v1/me?x=1')).toBe('http://localhost:5281/__saywright/http/127.0.0.1:5010/v1/me?x=1');
    expect(request('https://localhost:7001/api')).toBe('http://localhost:5281/__saywright/https/localhost:7001/api');
    expect(request('ws://localhost:5010/hub')).toBe('ws://localhost:5281/__saywright/http/localhost:5010/hub');
    expect(request('wss://localhost:7001/hub')).toBe('ws://localhost:5281/__saywright/https/localhost:7001/hub');
    expect(request('http://[::1]:5010/v1')).toBe('http://localhost:5281/__saywright/http/[::1]:5010/v1');
  });

  it('leaves navigations, the studio, the proxy itself and other sites as they are', () => {
    // A link to the API's own pages (its docs, say) leaves the proxy, as before.
    expect(navigation('http://localhost:5010/swagger')).toBe('http://localhost:5010/swagger');
    expect(request('http://localhost:7357/api/sessions/s1/events')).toBe('http://localhost:7357/api/sessions/s1/events');
    expect(request('http://localhost:5281/v1/cart')).toBe('http://localhost:5281/v1/cart');
    expect(request('https://api.example.com/v1')).toBe('https://api.example.com/v1');
    expect(request('data:text/plain,hi')).toBe('data:text/plain,hi');
    expect(request('blob:http://localhost:5281/1234')).toBe('blob:http://localhost:5281/1234');
  });

  it('sends a deployed site’s requests to this computer as they are', () => {
    const deployed = { upstream: 'https://shop.example', proxy: 'http://localhost:5282' };
    expect(viaProxy('http://localhost:5010/v1', 'http://localhost:5282/', deployed, true)).toBe('http://localhost:5010/v1');
    expect(viaProxy('https://shop.example/cart', 'http://localhost:5282/', deployed, true)).toBe('http://localhost:5282/cart');
  });
});
