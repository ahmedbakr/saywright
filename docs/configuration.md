# Configuration

Most of Saywright is set up in the studio itself (**Settings**). This page lists what you can set outside it: the commands and their options, the ports, where data is kept, and every environment variable the code reads.

- [Commands](#commands)
- [Ports](#ports)
- [Data folders](#data-folders)
- [Environment variables](#environment-variables)
- [`.env` and `.env.local`](#env-and-envlocal)

## Commands

### Installed from npm

| Command | What it does |
| --- | --- |
| `npx @saywright/studio` | Starts the studio and opens it in your browser. Same as `npx @saywright/studio start`. |
| `npx @saywright/studio connect <app folder>` | Connects an app once: adds the Vite plugin or a script tag where they help, and opens the app first the next time the studio starts. See [Linking apps](apps.md#connect-from-the-terminal). |
| `npx @saywright/studio setup` | Downloads the optional extras (voice and speech models). |
| `npx @saywright/studio doctor` | Checks what the studio needs and says how to fix what is missing. Exits with code 1 when something must be fixed. |
| `npx @saywright/studio mcp` | Connects an AI app that starts MCP servers as programs (Claude Desktop) to the running studio. See [MCP](mcp.md). |
| `npx @saywright/studio --version` (`-v`) | Prints the version. |
| `npx @saywright/studio --help` (`-h`) | Prints the commands. Each command also takes `--help`. |

#### `saywright` (start)

| Option | Default | What it does |
| --- | --- | --- |
| `--port <number>` (`-p`) | `7357` | Where the studio listens. Without `--port`, the next free port is used when 7357 is taken; with it, that port or an error. |
| `--no-open` | opens | Don't open a browser. It isn't opened when `CI` is set either. |
| `--target <url>` | | Open this running app straight away. |
| `--root <folder>` | | Where that app's code is, when the app can't say (an app without the plugin, such as Next.js or Create React App). |

If a studio already answers on the port, the command opens it instead of starting a second one. **Ctrl+C** stops the studio and the dev servers it started.

#### `saywright connect`

| Option | Default | What it does |
| --- | --- | --- |
| `--url <address>` | the port in the app's config, else its framework's usual one; for a folder of HTML, the address it gets when it is served | Where the app runs. |
| `--start "<command>"` | the app's dev script | The command that starts it. |
| `--no-start` | | You start the app yourself. |
| `--studio <address>` | `http://localhost:7357` | Where the studio runs. A script tag loads from this address. |
| `--dry-run` | | Shows what would change and changes nothing. |

#### `saywright setup`

| Option | What it does |
| --- | --- |
| `--no-speech` | Skips the speech models (Arabic and English, about 740 MB). |
| `--best-arabic` | Adds the most accurate Arabic model without asking (1.6 GB more). |
| `--no-best-arabic` | Doesn't add it, and doesn't ask. |
| `--hand` | Adds the hand model (7.8 MB), for hand control in **Settings → Labs**. |

What it downloads, once:

| Extra | Size | From | Used for |
| --- | --- | --- | --- |
| On-device voice model (Moonshine tiny, English) | 28 MB | the npm registry | Voice commands checked on your computer. Without it, the browser's recogniser works alone. |
| Speech models: Omnilingual (Arabic, English and more), Parakeet (English) | 279 MB + 460 MB | sherpa-onnx releases on GitHub | Session narration transcribed on your computer, and Arabic voice commands. |
| Cohere Transcribe (optional) | 1.6 GB | sherpa-onnx releases on GitHub | The most accurate Arabic ([measured](speech-accuracy.md)). Asked in a terminal; skipped without one. |
| Hand model (`--hand` only) | 7.8 MB | Google's MediaPipe models | Hand control. Without it, the studio's page loads it from Google. |
| Test browser (in a checkout only) | | Playwright | Running the sample shop's generated tests. |

You can also install speech models later in **Settings → Voice**, and the voice model from the same place.

#### `saywright doctor`

No options. It checks Node.js, the studio's built files, the voice and speech models, whether an AI is available (it asks Claude Code, Codex and Gemini CLI whether they are signed in, looks for API keys in the environment and in `.env.local`, and for Ollama and LM Studio on this computer), the test browser (in a checkout), and whether port 7357 is free.

#### `saywright mcp`

No options. It finds the studio's address in `server.json` in the data folder (written when the studio starts), else `SAYWRIGHT_URL`, else `http://localhost:7357`, and reads the MCP token from the same folder. It writes nothing but the protocol to its output.

### In a checkout of this repository

| Command | What it does |
| --- | --- |
| `npm run dev` | The studio with hot reload, at `http://localhost:7357` (the next free port when it is taken). Options after `--`: `--sample` (open the sample shop, on port 5174, or `--app-port <n>`), `--target <url>`, `--root <folder>`, `--port <n>`, `--no-open`. |
| `npm run connect -- <app folder> [options]` | `saywright connect`, from the sources. |
| `npm run setup -- [options]` | `saywright setup`, plus the test browser the sample shop's tests use. |
| `npm run doctor` | `saywright doctor`. |
| `npm run build`, then `npm start` | Builds the npm package and runs it as it would be installed (`npm start -- --port 7360`). |
| `npm run reset:sample` | Puts the sample shop back as it is committed. |
| `node scripts/mcp-stdio.mjs` | `saywright mcp`, from the sources. |

The test commands are in [CONTRIBUTING.md](../CONTRIBUTING.md#tests).

## Ports

| Port | What | To change it |
| --- | --- | --- |
| 7357 | The studio: its page, its API, the MCP server (`/api/mcp`) and the script for script tags (`/saywright.js`) | `--port`, or `npm run dev -- --port <n>` |
| 5281 and up | The proxy: each app address shown through it gets its own port, kept from one run to the next (`proxy-ports.json`) | `SAYWRIGHT_PROXY_PORT` (the first port to try) |
| Your app's | Your dev server, started by the studio. When it moves to another port, the studio follows it. | Your app's config, or its address in the app list |
| 5174 | The sample shop | `npm run dev -- --sample --app-port <n>` (in a checkout) |
| 5273, 5274 | The end-to-end tests' studio and sample shop copy | `E2E_STUDIO_PORT`, `E2E_SHOP_PORT` |
| 11434, 1234 | Where the studio looks for Ollama and LM Studio | |

The studio and the proxy listen on this computer only (`127.0.0.1`; the proxy also on `::1`).

**When the studio isn't on 7357.** The Vite plugin learns the studio's address when the studio starts, so nothing changes. A script tag added by `connect` loads from `http://localhost:7357`: run `connect` again with `--studio http://localhost:<port>`.

## Data folders

| | Installed from npm | In a checkout |
| --- | --- | --- |
| The studio's data | `~/.saywright` | `.saywright/` at the repository's root |
| API keys (`.env.local`) | `~/.saywright/.env.local` | `.env.local` at the repository's root |
| Each app's own data | `.saywright/` in the app's folder, or `<studio data>/apps/<id>/` for an app linked by its address | the same |
| GitHub clones | `~/saywright-apps/<name>` (**Clone into** in the link dialog changes it) | the same |
| The sample shop | copied to `~/.saywright/sample-shop` the first time you open it | `apps/shop` |
| Generated Playwright tests | `tests/saywright/` in the app's folder | the same |

`SAYWRIGHT_HOME` moves the studio's data (and, when installed from npm, its `.env.local` with it).

**In the studio's data folder:**

| File or folder | What it holds |
| --- | --- |
| `apps.json` | The linked apps and their addresses |
| `ai.json` | AI connections you added, which AI does what, effort |
| `usage/` | The AI usage log and your budget |
| `studio.json` | Studio settings kept on the server, such as the speech model per language |
| `mcp-token` | The MCP token (readable by you alone) |
| `server.json` | Where the running studio listens, for `saywright mcp` |
| `proxy-ports.json` | The proxy's port for each app address |
| `google-service-account.json` | The Google service account key, if you added one (readable by you alone) |
| `models/` | The on-device voice model and the hand model |
| `speech/` | Speech models (`SAYWRIGHT_SPEECH_DIR` moves them) |
| `target.json` | Left by `connect`; read and removed when the studio next starts |

**In each app's `.saywright/` folder** (the studio adds a `.gitignore` there, so none of it is committed):

| File or folder | What it holds |
| --- | --- |
| `sessions/` | Recorded sessions: events, narration audio, transcript, screenshots, video and the report |
| `changes.json` | Previews and decisions, so a preview survives a restart of the studio |
| `reviews/` | Expert reviews, per page |
| `metrics.jsonl` | How you worked (the **Stats** tab) |
| `google.json` | This app's Search Console and Analytics properties |

Preferences you set in the studio's page (theme, layout, voice, hand tuning, Labs) are kept in your browser's local storage.

## Environment variables

### Saywright

| Variable | Read by | What it does |
| --- | --- | --- |
| `SAYWRIGHT_HOME` | the commands and the studio | Where the studio keeps its data. Default: `~/.saywright` (npm), `.saywright/` (checkout). |
| `SAYWRIGHT_AI` | the studio | `fake` answers every AI request with the test stand-in: a deterministic double that knows the sample shop's coupon bug and never calls a real AI. For tests and demos. |
| `SAYWRIGHT_MODEL` | the studio | An Anthropic model id (as listed in `apps/studio/shared/models.ts`) for changes and questions, in place of the choice in **Settings → AI**. Needs an Anthropic API key. |
| `SAYWRIGHT_TARGET_URL` | the studio | Opens this running app when the studio starts (what `--target` sets). |
| `SAYWRIGHT_TARGET_ROOT` | the studio | That app's code folder (what `--root` sets). |
| `SAYWRIGHT_PROXY_PORT` | the studio | The first port the proxy tries. Default: 5281. |
| `SAYWRIGHT_SPEECH_DIR` | the studio, `setup` and `doctor` | Where speech models are kept. Default: `speech/` in the data folder. |
| `SAYWRIGHT_STUDIO_URL` | the Vite plugin, in your app's dev server | Where the studio runs. Default: what the studio announces when it starts, else `http://localhost:7357`. The plugin's `studio` option wins over it. |
| `SAYWRIGHT_URL` | `saywright mcp` | The studio's address, when the data folder has no `server.json`. |
| `SAYWRIGHT_KEY_<NAME>` | the studio | The key of an OpenAI-compatible provider you added in **Settings → AI**; the studio writes it to `.env.local`. |
| `SAYWRIGHT_FLEURS` | `npm run eval:speech` | Where the FLEURS recordings are kept. Default: `fleurs/` in the data folder. |

The studio sets two variables for programs it starts: `SAYWRIGHT_TARGET_URL` when it runs your generated tests (point your Playwright config's `baseURL` at it), and `SAYWRIGHT_MCP_TOKEN` for Codex runs.

### AI keys

| Variable | For |
| --- | --- |
| `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` | The Anthropic API. The Anthropic SDK also reads its own variables, such as `ANTHROPIC_BASE_URL`, and a profile saved by the Anthropic CLI (under `$XDG_CONFIG_HOME/anthropic`, or `~/.config/anthropic`). |
| `OPENAI_API_KEY` | The OpenAI API |
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | The Gemini API |
| `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY` | Those providers, once you add them in **Settings → AI → Other providers** (the studio saves the key under this name) |
| `PAGESPEED_API_KEY` | The Google API key for the Chrome UX Report (**Settings → Google data → Speed for real users**) |

When the studio runs Claude Code, Codex or Gemini CLI for your plan, it leaves that provider's API key variables out of the program's environment, so your plan is used and not a key.

### Other variables

| Variable | What it does |
| --- | --- |
| `CI` | When set, `saywright` and `npm run dev` don't open a browser. |
| `NO_COLOR` | No colours in the commands' output. |
| `BROWSER` | The browser `npm run dev` opens. On a Mac, when it isn't set and Chrome is installed, Chrome is used. |
| `LAUNCH_EDITOR`, `VISUAL`, `EDITOR` | The code editor <kbd>O</kbd> opens files in. Without `LAUNCH_EDITOR`, the studio uses an editor it finds running (VS Code, Cursor, WebStorm, Zed and others), then `VISUAL` or `EDITOR`; with none, it says so. |
| `HOME`, `USERPROFILE` | Where GitHub clones go by default (`~/saywright-apps`). |
| `E2E_STUDIO_PORT`, `E2E_SHOP_PORT`, `PW_CHROMIUM_PATH` | The end-to-end tests: see [CONTRIBUTING.md](../CONTRIBUTING.md#tests). |

Downloads use Node's `fetch` and fall back to `curl`, which honours `HTTPS_PROXY` and similar proxy settings.

## `.env` and `.env.local`

When it starts, the studio reads `.env`, then `.env.local`, from:

- `~/.saywright/` when installed from npm (or `SAYWRIGHT_HOME`);
- the repository's root in a checkout.

A variable already set in the environment wins, with one exception: an API key saved from **Settings** (the `*_API_KEY` variables above, and `SAYWRIGHT_KEY_*`) wins when it is in `.env.local`, so a key you change in the studio takes effect. An empty line such as `OPENAI_API_KEY=` never replaces a key set in your shell.

Put API keys and the studio's own settings (`SAYWRIGHT_AI`, `SAYWRIGHT_MODEL`, `SAYWRIGHT_TARGET_URL`, `SAYWRIGHT_TARGET_ROOT`, `SAYWRIGHT_PROXY_PORT`, `SAYWRIGHT_SPEECH_DIR`) there. Set `SAYWRIGHT_HOME` in your shell instead (it decides where the file is), `SAYWRIGHT_STUDIO_URL` in your app's environment, and `SAYWRIGHT_URL` in the MCP settings of the app that runs `saywright mcp`.

The studio writes `.env.local` readable by you alone. In a checkout it is git-ignored; [`.env.example`](../.env.example) lists what you can put in it.
