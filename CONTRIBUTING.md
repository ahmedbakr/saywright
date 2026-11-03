# Contributing to Saywright

Thank you for helping. Bug reports, ideas and pull requests are all welcome. Please follow the [code of conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node.js 22 (the version in `.nvmrc`; 22.18 is the oldest supported, and 24.11 or newer works too), git, and Chrome or Chromium.

```bash
git clone https://github.com/ahmedbakr/saywright.git
cd saywright
npm install          # also builds the Vite plugin (packages/vite/dist)
npm run dev          # the studio, with hot reload, at http://localhost:7357
```

- `npm run dev -- --sample` opens the sample shop straight away. The other options are in [Configuration](docs/configuration.md#in-a-checkout-of-this-repository).
- `npm run setup` downloads the optional extras: the voice and speech models, and the browser the sample shop's tests use.
- `npm run doctor` checks your setup.
- The studio changes the sample shop (`apps/shop`) while you try things: `npm run reset:sample` puts it back.

Work on a branch of your own (`git switch -c fix/short-name`), and open the pull request against the repository's default branch.

## The code

| Folder | What lives there |
| --- | --- |
| `apps/studio/src` | The studio's interface (React): `core/` holds state and logic, `features/` the screens, `components/` shared pieces. |
| `apps/studio/server` | The studio's server: the API (`index.ts`), linked apps and the proxy (`apps/`), AI connections (`ai/`), sessions and reports (`sessions/`), expert reviews (`experts/`), quick edits (`quick/`), speech (`speech/`), the MCP server (`mcp.ts`, `mcp-tools.ts`). `standalone.ts` serves it without Vite, as the npm package does. |
| `apps/studio/cli` | The `saywright` command. |
| `apps/studio/shared` | Types and helpers both sides use, and the product's name (`brand.ts`). |
| `apps/studio/tests` | `unit/` (Vitest), `e2e/` (Playwright), `speech/` (the speech engine), `eval/` (speech accuracy), `fixtures/`. |
| `packages/vite` | `@saywright/vite`: the plugin (`src/index.ts`), the bridge that runs in your app's page (`src/bridge/`), the session client shared by the studio and the app's own tab (`src/client/`), and the messages between them (`src/protocol.ts`). |
| `apps/shop` | The sample shop, with a deliberate checkout bug: `SAVE20` also discounts shipping. Leave the bug in; the tour and the tests rely on it. |
| `scripts/` | `npm run dev`, the commands from source, the install step, the package smoke test, the speech evaluation, and the documentation's pictures (`demo/`). |
| `docs/` | The documentation. |

**How the pieces fit.** The plugin adds `data-ds-src="file:line:col"` to each JSX element while you develop, and puts a small script, the bridge, in your app's page. The studio shows your app in a frame and asks the bridge, over `postMessage`, what is under the pointer. Without the plugin, the bridge (loaded by a script tag, or added by the proxy) finds an element's source through React's or the framework's development information, or the server searches your code for it. Requests go to the server, which makes quick edits itself or asks the AI, and writes every change to disk as a preview that is kept or undone.

## Tests

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | TypeScript, every workspace |
| `npm run lint` | [oxlint](https://oxc.rs) with `.oxlintrc.json`: errors fail it (and CI), warnings are worth a look |
| `npm test` | Unit tests (Vitest, a few seconds): `apps/studio/tests/unit` and `packages/vite/tests` |
| `npm run test:watch` | The unit tests again on every change |
| `npm run test:speech` | The speech engine on real recordings in Arabic and English. Skipped when the models aren't installed (`npm run setup`). It measures speed, so it runs on its own. |
| `npm run test:e2e` | End-to-end tests in Chromium (minutes) |
| `npm run check` | All of the above in a row (typecheck, lint, unit, speech, end-to-end) |
| `npm run eval:speech` | Speech accuracy on FLEURS recordings (add `-- --fetch` the first time): see [docs/speech-accuracy.md](docs/speech-accuracy.md) |
| `npm run build`, then `npm start` | The npm package as it would be published, run as it would be installed |

### End-to-end tests

`npm run test:e2e` starts a throwaway copy of the sample shop (port 5274) and the studio (port 5273), with the AI test stand-in (`SAYWRIGHT_AI=fake`) and their own data folder (`apps/studio/tests/.e2e-home`), so your settings, apps and AI are never touched. No test calls a real AI or uses your plan. The hand is simulated with landmarks recorded from real photos; speech comes from a scripted browser recogniser, and from recordings played into Chromium's fake microphone (`apps/studio/tests/fixtures/speech`).

- **The browser.** Install Playwright's Chromium once (`npx playwright install chromium`, or `npm run setup`), or use one you have: `PW_CHROMIUM_PATH=/path/to/chromium npm run test:e2e`.
- **The voice tests** use the on-device voice model: `npm run setup -- --no-speech` downloads it (28 MB) and the test browser, without the large speech models.
- **Other ports**, to run two suites side by side: `E2E_STUDIO_PORT=5373 E2E_SHOP_PORT=5374 npm run test:e2e`.
- **One spec**: `npm run test:e2e -- apps.spec.ts`.

### The accessibility check

`npm run test:e2e -- a11y.spec.ts` runs axe-core (WCAG 2.2 AA and best practice, the engine the Experts use) on the studio's main screens in light and dark, and checks that dialogs are real modals and that <kbd>Esc</kbd> closes only the layer on top. Keep it passing when you change the interface.

### Adding a test

- **Unit tests** go in `apps/studio/tests/unit/<area>.test.ts` (or `packages/vite/tests/`). `apps/studio/tests/unit/helpers.ts` has `tempShop()` (a throwaway copy of the sample shop), `tree()` (a folder from a map of files) and `monorepo()` (a workspace).
- **End-to-end tests** go in `apps/studio/tests/e2e/<flow>.spec.ts`. Start each test from `resetAll()` and open the studio with `openStudio(page)` (both in `helpers.ts`). The AI's answers come from the stand-in in `apps/studio/server/ai/fake.ts`: extend it when a flow needs a new answer.
- Name a test by what a person or a caller observes (“stacks previews: keep keeps all, undo peels the newest”), and run the specs whose flows or text you changed.

## Screenshots and the demo video

The pictures in the documentation are taken from the real studio on the sample shop, by scripts, so they can be taken again when the interface changes:

| Command | What it makes |
| --- | --- |
| `npm run media:screenshots` | `docs/media/guide/*.png`: every screen in [Getting started](docs/getting-started.md), in two passes (first with no AI connected, as a newcomer meets the studio, then with an AI). `-- --only inspect,preview` takes just those. |
| `npm run media:demo` | `docs/media/demo.mp4` and `demo.gif` (the README's video), `studio-light.png`, `studio-dark.png`, `report.png` and `autopilot.png`. Needs ffmpeg. |

Both use a throwaway copy of the sample shop and their own data folder in `.saywright/demo/`, so your apps and settings are never touched, and the AI's test stand-in unless you set `DEMO_AI=real` with `ANTHROPIC_API_KEY` (then the real Claude answers, for a few cents). Settings → AI is only taken with no AI connected, so no key is ever on screen. `DEMO_STUDIO_PORT=7357` makes the addresses on screen match the documentation's. When a step fails, `.saywright/demo/failed.png` shows what the studio showed.

## Style

- Match the code around you: its naming, a short header comment saying why a module exists, and few comments (why, not what).
- Plain, specific wording on screen: sentence case, curly quotes and apostrophes (’ “ ”), no exclamation marks, no jargon. [docs/brand.md](docs/brand.md) has the voice and the words we use.
- Small functions, existing helpers before new ones, and no new runtime dependency unless it can't be avoided (say why in the pull request).
- Changing a message between the bridge and the studio: people update the plugin and the studio separately, so read the note on `PROTOCOL_VERSION` in `packages/vite/src/protocol.ts` first.

## Commits and pull requests

- One logical change per commit. The subject says the effect a person sees, in the imperative: “Keep previews across a restart of the studio”, “Answer malformed addresses with 400”. The body says why, in a few short lines.
- Keep a pull request focused: one fix or feature.
- Before you open it: `npm run typecheck`, `npm run lint` and `npm test` pass, and so do the end-to-end specs for the flows you touched.
- Update the documentation when behaviour changes, and add a line to [CHANGELOG.md](CHANGELOG.md).

CI runs on pull requests and on pushes to `main`: the type check, lint, the unit tests and the packed package on Linux, macOS and Windows, and the end-to-end suite in Chromium on Linux.

## Releases

For maintainers: pushing a version tag (`v0.1.0`) publishes `@saywright/vite` and `saywright` to npm from CI, with provenance, after the type check and unit tests pass and only when the tag matches both packages' version, then creates the GitHub release with that version's section of the changelog. It needs the `NPM_TOKEN` repository secret. Run again after a failure, the workflow skips what is already done.

## Reporting bugs

Open an issue with what you did, what you expected and what happened, and the output of `npx saywright doctor` (or `npm run doctor` in a checkout). Security problems: see [SECURITY.md](SECURITY.md) instead.

## Licence

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
