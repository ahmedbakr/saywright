# Troubleshooting

Start with the checkup: it says what is missing and how to fix it.

```bash
npx @saywright/studio doctor      # in a checkout: npm run doctor
```

## Starting the studio

| Problem | What to do |
| --- | --- |
| “Saywright needs Node.js 22.18 or newer” | Install the current LTS from [nodejs.org](https://nodejs.org) (Node 22.18+ or 24.11+). |
| “The studio’s interface isn’t built” | Installed from npm: run `npx @saywright/studio@latest`. In a checkout: start it with `npm run dev`. |
| Port 7357 is taken | The studio takes the next free port and prints it. Apps connected with a script tag look for the studio on 7357: stop the other program, or run `connect` again with `--studio http://localhost:<port>`. `--port` asks for a port outright. |
| No browser opened | Open the address the command printed. A browser isn't opened with `--no-open` or when `CI` is set. |

## Apps

| Problem | What to do |
| --- | --- |
| The app doesn't open, or “Connecting to your app…” never ends | The studio has to start the app or reach it. The opening card shows the command it ran and the app's output; check the dev command and address in the app's menu in **Your apps**. A dev server that is still compiling its first page can take a while. |
| “This folder isn’t an app the studio can start” | Pick the app's own folder, the one with its `package.json` or `index.html`. In a monorepo the studio lists the apps inside: pick one. |
| Clicking an element finds no source | For exact lines in a Vite + React app, add the [`@saywright/vite`](../packages/vite/README.md) plugin (`npx @saywright/studio connect <folder>`). An app linked by its address alone has no code on this computer: link its folder. A place shown as “likely” was found by searching your code for the element's text: check it before changing the code there. |
| Signing in doesn't work in the studio | Sign-in that goes through another site (OAuth, single sign-on) can't return through the proxy. Use the plugin or the script tag (`connect`), so the studio shows the app at its own address. |
| The app's requests to its API fail in the studio (“Network Error”), but work in its own tab | Shown through the proxy, the app's page has another address (`http://localhost:5281`), which the API's CORS rules don't allow. An API on another port of this computer (`http://localhost:5010`) is reached through the proxy, from the app's own address, so it works. An API on another site (`https://api.example.com`) still sees the proxy's address: connect the app (`npx @saywright/studio connect <folder>`) so the studio shows it at its own address, or allow the proxy's address in the API's development CORS settings. |
| The app is slower in the studio than in its own tab, or the studio stalls during an expert review | Chrome and Edge run the app in a process of its own, apart from the studio. Safari and Firefox run both on one thread, so each waits for the other: use Chrome or Edge for test sessions and for reviews of big pages. Open the studio at the address it printed (`localhost`): at `127.0.0.1` your app's sign-in cookies don't reach it. |
| No **Record session** button in my app's own tab | Keep the studio running. <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> shows a hidden button. An app with a script tag loads it from `http://localhost:7357`: if the studio is on another port, run `connect` again with `--studio`. |
| “This app’s Saywright plugin needs an update” | In the app's folder, run `npm i -D @saywright/vite@latest`, then restart its dev server. |
| “This studio is older than the app’s Saywright plugin” | Stop the studio and start it again with `npx @saywright/studio@latest`. |
| “Opening it runs this repository’s own commands” | Linking a cloned repository runs its install and dev scripts on your computer. Only open code you trust. |

## AI

| Problem | What to do |
| --- | --- |
| The top bar says **No AI**, or “That request needs an AI” | Quick edits work without one. For the rest, open **Settings → AI** and connect a plan, a key or a model on your computer. |
| A plan shows *Not installed* or *Sign in needed* | Install its command-line app, then run `claude`, `codex login` or `gemini` once in a terminal and sign in. **Check again** in Settings → AI. |
| Requests are refused with a budget message | Your budget is set to **Stop** and a limit is reached: raise it or reset the count in **Settings → Usage and budget**. |
| More | [AI in Saywright: troubleshooting](ai.md#troubleshooting) |

## Voice

| Problem | What to do |
| --- | --- |
| Voice does nothing | Allow the microphone in the browser's address bar and in your system's privacy settings (on a Mac: System Settings → Privacy & Security → Microphone). Use Chrome, Edge or Safari, or the on-device model in any browser. You can always type with <kbd>/</kbd>. |
| It doesn't understand what I say | **Settings → Voice → Test your microphone** shows what was heard. Pick your variant under **Language**, keep **Recognition** on *Auto*, and turn on **Check before sending**. |
| “The on-device speech model isn’t downloaded” | **Settings → Voice** offers the download (28 MB), or run `npx @saywright/studio setup`. The browser's recogniser works meanwhile. |
| “No speech model for this language yet” when recording a session | Click **Install** in the session setup, or run `npx @saywright/studio setup`. Your voice is still recorded: once a model is installed, use the report's **⋯ → Transcribe the narration again**. |
| Arabic narration has many mistakes | Install the large Arabic model (**Settings → Voice**, or `npx @saywright/studio setup --best-arabic`): it gets about 40% fewer words wrong ([measured](speech-accuracy.md)). A headset helps. |
| “The speech engine can’t run on this computer” | Narration is still recorded, and voice uses the browser's recogniser. |

## Sessions, tests and reviews

| Problem | What to do |
| --- | --- |
| “Another session is recording” | One is still running in another tab, or its tab closed. In the studio, click **Stop it and start this one**. Your app's own tab can stop only a session it started: stop the other one in the studio first. A session that has sent nothing for 45 seconds is stopped for you. |
| “Playwright needs its Chromium browser” | Click **Install test browser** in the Test tab. |
| The test doesn't run | The generated test runs with your app's own Playwright: install `@playwright/test` in the app. The studio runs it with a configuration of its own (your app's address as `baseURL`), so your Playwright configuration isn't needed (see [Write test](guide.md#write-test-narrate-a-bug-get-a-playwright-test)). |
| “This test types PASSWORD” | The test types a secret you typed while writing it, and never saved in it. Save its value in the Test tab's **Secrets**, or set `SAYWRIGHT_SECRET_PASSWORD`. |
| “It doesn’t show the bug yet” | A step before the checks failed, so the test never got to its check: the run lists which step, and why. Fix that step (or record the test again), then run it. |
| “Couldn’t verify” | The test passed, but the run doesn't prove it: the Test tab says why (a step or check that didn't run, a pass only on a retry, a test changed since it failed). |
| The accessibility checks couldn't run | The page's Content Security Policy blocked them. Pages shown through the studio's proxy don't have that problem. |

## Reporting a problem

Open an [issue](https://github.com/ahmedbakr/saywright/issues) with what you did, what you expected, what happened, and the output of `npx @saywright/studio doctor`. Security problems: see [SECURITY.md](../SECURITY.md) instead.
