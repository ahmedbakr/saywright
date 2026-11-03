/**
 * What the bridge reads from React's development build about where an element came from, on fibers shaped the way
 * React leaves them: its own JSX first, then where each component around it was used, marked as an instance site
 * only where the component passes the element its props.
 */
import { describe, expect, it } from 'vitest';
import { instanceFrames, reactFrames, type Fiber } from '../src/bridge/react';

type F = Fiber & { child?: F | null; stateNode?: unknown };

/** A DOM element with its fiber, as React attaches it. */
function element(tag: string, fiber: F): Element {
  const el = { tagName: tag.toUpperCase() } as unknown as Element;
  (el as unknown as Record<string, unknown>).__reactFiber$test = fiber;
  fiber.stateNode = el;
  return el;
}

const stack = (fn: string, at: string) => ({ stack: `Error: react-stack-top-frame\n    at ${fn} (${at})` });

function component(name: string, props: Record<string, unknown>, fields: Partial<F>): F {
  const type = { [name]: () => null }[name];
  return { type, return: null, memoizedProps: props, ...fields } as F;
}

describe('React ≥19.1: its own JSX, then where the components around it were used', () => {
  function login() {
    const button: F = { type: 'button', return: null, memoizedProps: { type: 'submit', className: 'inline-flex w-full', children: 'Login' }, _debugStack: stack('Button', 'http://x/src/ui/button.tsx:56:5') } as F;
    const form: F = { type: 'form', return: null, memoizedProps: {} } as F;
    const loginForm = component('LoginForm', {}, { child: form, _debugStack: stack('Page', 'http://x/src/page.tsx:10:5'), _debugOwner: null });
    const Button = component('Button', { type: 'submit', className: 'w-full', children: 'Login' }, { child: button, _debugStack: stack('LoginForm', 'http://x/src/login-form.tsx:40:9'), _debugOwner: loginForm });
    button._debugOwner = Button;
    button.return = Button;
    element('form', form);
    return element('button', button);
  }

  it('marks where a component that passes the element its props was used as an instance site, and stops there', () => {
    expect(reactFrames(login())).toEqual([
      { at: 'http://x/src/ui/button.tsx:56:5', name: 'button' },
      { at: 'http://x/src/login-form.tsx:40:9', name: 'Button', root: true },
      { at: 'http://x/src/page.tsx:10:5', name: 'LoginForm' },
    ]);
  });

  it('passes over the layers an element was handed through when they cloned it (asChild)', () => {
    const a: F = { type: 'a', return: null, memoizedProps: { href: '/crm', children: 'CRM' }, _debugStack: stack('LinkComponent', 'http://x/_next/chunks/link.js:454:50') } as F;
    const group: F = { type: 'div', return: null, memoizedProps: {} } as F;
    element('div', group);
    const navMain = component('NavMain', { items: [] }, { child: group, _debugStack: stack('AppSidebar', 'http://x/src/app-sidebar.tsx:44:7'), _debugOwner: null });
    const menuButton = component('SidebarMenuButton', { asChild: true }, { child: a, _debugStack: stack('NavMain', 'http://x/src/nav-main.tsx:28:7'), _debugOwner: navMain });
    const slot = component('Slot', { className: 'peer' }, { child: a, _debugStack: stack('SidebarMenuButton', 'http://x/src/ui/sidebar.tsx:507:5'), _debugOwner: menuButton });
    const link = component('LinkComponent', { href: '/crm', children: 'CRM' }, { child: a, _debugStack: stack('NavMain', 'http://x/src/nav-main.tsx:30:9'), _debugOwner: slot });
    a._debugOwner = link;
    expect(reactFrames(element('a', a))).toEqual([
      { at: 'http://x/_next/chunks/link.js:454:50', name: 'a' },
      { at: 'http://x/src/nav-main.tsx:30:9', name: 'LinkComponent', root: true },
    ]);
  });

  it('a library’s layers pass the element along; their own frames are not kept', () => {
    const div: F = { type: 'div', return: null, memoizedProps: { className: 'menu-item x' }, _debugStack: stack('Primitive', 'http://x/node_modules/.vite/deps/radix.js?v=1:9:9') } as F;
    const app = component('MenuItem', { className: 'x' }, { child: div, _debugStack: stack('Menu', 'http://x/src/Menu.tsx:12:7'), _debugOwner: null });
    const layer = component('Primitive', { asChild: true }, { child: div, _debugStack: stack('MenuItem', 'http://x/node_modules/.vite/deps/radix.js?v=1:5:5'), _debugOwner: app });
    div._debugOwner = layer;
    expect(reactFrames(element('div', div))).toEqual([{ at: 'http://x/src/Menu.tsx:12:7', name: 'MenuItem', root: true }]);
  });

  it('counts the text a component was given and its element shows: where the item was used sets it', () => {
    const div: F = { type: 'div', return: null, memoizedProps: { className: 'menu-item', children: null }, _debugStack: stack('Primitive', 'http://x/node_modules/.vite/deps/radix.js?v=1:9:9') } as F;
    const menu = component('Menu', {}, { child: null, _debugStack: stack('App', 'http://x/src/App.tsx:30:7'), _debugOwner: null });
    const item = component('SubTrigger', { children: 'Preferences' }, { child: div, _debugStack: stack('Menu', 'http://x/src/Menu.tsx:44:7'), _debugOwner: menu });
    const layer = component('Primitive', { className: 'menu-item' }, { child: div, _debugStack: stack('SubTrigger', 'http://x/src/SubTrigger.tsx:12:5'), _debugOwner: item });
    div._debugOwner = layer;
    const el = element('div', div);
    (el as unknown as { textContent: string }).textContent = 'Preferences ›';
    expect(reactFrames(el)).toEqual([
      { at: 'http://x/src/SubTrigger.tsx:12:5', name: 'Primitive', root: true },
      { at: 'http://x/src/Menu.tsx:44:7', name: 'SubTrigger', root: true },
    ]);
    // Text it doesn't show: where the item was used is only where the component around it is.
    (el as unknown as { textContent: string }).textContent = 'Settings ›';
    expect(reactFrames(el)[1]).toEqual({ at: 'http://x/src/Menu.tsx:44:7', name: 'SubTrigger' });
  });

  it('reads a frame written as a Windows path (as Node writes them there) like any other', () => {
    const div: F = { type: 'div', return: null, memoizedProps: {}, _debugStack: stack('Menu', 'D:\\app\\src\\Menu.tsx:12:7'), _debugOwner: null } as F;
    expect(reactFrames(element('div', div))).toEqual([{ at: 'D:\\app\\src\\Menu.tsx:12:7', name: 'div' }]);
  });

  it('ignores the stand-in stack React gives once it has made too many elements at once', () => {
    const p: F = { type: 'p', return: null, memoizedProps: {}, _debugStack: { stack: 'Error: react-stack-top-frame\n    at UnknownOwner (http://x/react.js:847:16)\n    at module evaluation (http://x/chunk.js:981:2)' }, _debugOwner: null } as F;
    expect(reactFrames(element('p', p))).toEqual([]);
  });
});

describe('React 19.0: where the components are, found by running them', () => {
  it('names the component the element is written in, and what to look for there', () => {
    function IconButton(props: { title: string }) {
      return props.title;
    }
    const button: F = { type: 'button', return: null, memoizedProps: {}, _debugOwner: null } as F;
    const owner = { type: IconButton, return: null, child: button, memoizedProps: {}, _debugOwner: null } as unknown as F;
    button._debugOwner = owner;
    const frames = reactFrames(element('button', button));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ name: 'button', inside: true });
    expect(frames[0].at).toMatch(/react\.test\.ts:\d+:\d+$/);
  });
});

describe('the Vite plugin’s pages: where a component that passes the element its props was used', () => {
  it('comes from the instance’s attribute when the component doesn’t spread its props', () => {
    const button: F = { type: 'button', return: null, memoizedProps: { 'data-ds-src': 'src/IconButton.tsx:162:7', title: 'Undo' } } as F;
    const icon = component('IconButton', { 'data-ds-src': 'src/Tools.tsx:284:7', title: 'Undo' }, { child: button });
    button.return = icon;
    const el = element('button', button);
    expect(instanceFrames(el, 'data-ds-src', 'src/IconButton.tsx:162:7')).toEqual([{ at: 'src/Tools.tsx:284:7', name: 'IconButton', root: true }]);
  });

  it('starts past the component whose attribute the element already shows (it spread its props)', () => {
    const a: F = { type: 'a', return: null, memoizedProps: { 'data-ds-src': 'src/Menu.tsx:44:7', href: '/plus' } } as F;
    const item = component('MenuItemLink', { 'data-ds-src': 'src/Menu.tsx:44:7', href: '/plus' }, { child: a });
    const radix = component('Item', { 'data-ds-src': 'src/MenuItemLink.tsx:37:5', href: '/plus' }, { child: a });
    a.return = radix;
    radix.return = item;
    expect(instanceFrames(element('a', a), 'data-ds-src', 'src/Menu.tsx:44:7')).toEqual([]);
  });
});
