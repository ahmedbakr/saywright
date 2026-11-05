/**
 * A page of an app shown through the studio's proxy is named at the app's own address, to people and to AIs: the
 * proxy's port is the studio's business.
 */
import { describe, expect, it } from 'vitest';
import { appAddress } from '../../server/apps/manager';

describe('the address a page is named by', () => {
  const proxied = { frameUrl: 'http://localhost:5281/', env: { url: 'http://localhost:3000' } } as Parameters<typeof appAddress>[0];
  it('is the app’s own for a page shown through the proxy, path, query and #route kept', () => {
    expect(appAddress(proxied, 'http://localhost:5281/cart?step=2#/pay')).toBe('http://localhost:3000/cart?step=2#/pay');
    expect(appAddress({ ...proxied, env: { ...proxied.env, url: 'https://shop.example.com' } }, 'http://localhost:5281/')).toBe('https://shop.example.com/');
  });
  it('is left as it is when the app is shown as it is, or the page is elsewhere', () => {
    expect(appAddress({ ...proxied, frameUrl: 'http://localhost:3000/' }, 'http://localhost:3000/cart')).toBe('http://localhost:3000/cart');
    expect(appAddress(proxied, 'https://accounts.example.com/login')).toBe('https://accounts.example.com/login');
    expect(appAddress(proxied, 'not a url')).toBe('not a url');
  });
});
