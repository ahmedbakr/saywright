# @saywright/vite

The Vite plugin for [Saywright](https://www.npmjs.com/package/@saywright/studio), the studio where you point at your running web app, say what to change, and keep or undo the result.

With the plugin, each element you point at in the studio is traced to the exact file, line and column that wrote it, and your app can record sessions from its own tab. It runs on the development server only: production builds are untouched.

## Install

The quickest way is to let Saywright do it. It installs the plugin with your app's package manager and adds it to your Vite config:

```bash
npx @saywright/studio connect path/to/your-app
```

Or by hand:

```bash
npm install -D @saywright/vite
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import saywright from '@saywright/vite';

export default defineConfig({
  plugins: [saywright(), react()],
});
```

Then start your app as usual, start the studio with `npx @saywright/studio`, and open your app in it.

## Options

```ts
saywright({
  include: /\.[jt]sx$/,
  exclude: /[\\/]node_modules[\\/]/,
  studio: 'http://localhost:7357',
  studioOrigins: [],
  widget: true,
});
```

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `include` | `RegExp` | `/\.[jt]sx$/` | Files whose JSX elements get their source location, among your app's and, in a monorepo, its sibling packages' (`../packages/ui/Button.tsx`). |
| `exclude` | `RegExp` | `/[\\/]node_modules[\\/]/` | Files to skip. `node_modules` is skipped whatever you set. |
| `studio` | `string` | the address the studio announces when it opens your app; before that, `SAYWRIGHT_STUDIO_URL`, else `http://localhost:7357` | Where the studio runs. When you set it, the studio's announcements are ignored. |
| `studioOrigins` | `string[]` | `[]` | More studio origins the script in your page may answer. The studio it knows of (announced, set with `studio`, or the default address) is always allowed. |
| `widget` | `boolean` | `true` | Show the **Record session** button when the app is open in its own tab. |

## What it adds, while you develop

- A `data-ds-src` attribute (`src/components/Cart.tsx:18:9`) and a `data-ds-name` attribute (the component's name) on each JSX element of the files it covers: inside Vite's root and, in a monorepo (npm, yarn or pnpm workspaces, Lerna, Nx, Turborepo, Rush), in the packages the workspace lists.
- A small script, the bridge, first in your page's `<head>`. It answers the studio: what is under the pointer, previews, session recording and the page checks, and it shows the **Record session** button when the app is open in its own tab.
- Four routes on your dev server: `/__saywright/bridge.js` (that script), `/__saywright/info` (your app's folder, so the studio finds your code), `/__saywright/studio` (where the studio tells the plugin its address) and `/__saywright/hold` (while the studio writes a change of several files, your page's updates wait and then come as one, so it never runs half of the change). Requests from web pages to the last two are refused.

## Compatibility

- **Vite 4 or newer** (the peer range is `vite >=4`) and **Node.js 22.18 or newer, or 24.11 or newer**.
- **React** apps get exact locations from the JSX. In other apps on Vite (Vue, Svelte…), the plugin still connects the app to the studio and records sessions, and the studio finds an element's source through the framework's development information.
- **Updating.** The plugin and the studio are released together and updated separately: npx runs the newest studio by itself, while the plugin stays as your app installed it. When the plugin is older than the studio (or the studio older than the plugin), the studio says which one to update and does nothing in the app until then: `npm i -D @saywright/vite@latest` in your app (or `npx @saywright/studio connect .`), or `npx @saywright/studio@latest`. What the page refuses for Autopilot, masks in a session and records for a test is in the plugin, so the two have to match.

For tools that talk to the studio or read its sessions, `@saywright/vite/protocol` exports the messages, the session events and `PROTOCOL_VERSION`, with their types.

## Links

- [Saywright on GitHub](https://github.com/ahmedbakr/saywright): the README and the documentation
- [Linking your apps](https://github.com/ahmedbakr/saywright/blob/HEAD/docs/apps.md): the plugin, the script tag, the proxy and monorepos
- [Configuration](https://github.com/ahmedbakr/saywright/blob/HEAD/docs/configuration.md): ports and environment variables
- [Security](https://github.com/ahmedbakr/saywright/blob/HEAD/SECURITY.md) · [Changelog](https://github.com/ahmedbakr/saywright/blob/HEAD/CHANGELOG.md) · [Issues](https://github.com/ahmedbakr/saywright/issues)

Licence: Apache-2.0.
