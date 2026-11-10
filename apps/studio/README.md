# Saywright

**Say the bug. Get the test. Prove the fix.** And point at your app, say what to change, then keep or undo the result.

Saywright is a studio that runs on your computer, next to the web app you are building. Point at anything in your running app, traced to the file and line that wrote it, and say or type what to change: the change appears in your code and your live app at once, as a preview you keep or undo. Record yourself using the app and get a report with evidence, let Autopilot test it, have the Experts review a page, and turn what you do into a Playwright test.

## Start

```bash
npx @saywright/studio
```

The studio opens in your browser at `http://localhost:7357`. Link your app (a folder on this computer, an address, or a GitHub repository), or try the sample shop, which has a real bug to find. You need Node.js 22 (22.18 or newer) or Node.js 24 and later (24.11 or newer).

Or set your app up from the terminal first, then start the studio:

```bash
npx @saywright/studio connect ./my-app
npx @saywright/studio
```

For a Vite app, `connect` adds the [`@saywright/vite`](https://www.npmjs.com/package/@saywright/vite) plugin, which runs on the dev server only and, with React, gives the exact file, line and column of every element. Next.js gets one development-only script tag. Other apps with an HTML page (Create React App, webpack, Angular…) get a script tag at the top of that page, which isn't removed from production builds: `connect` says so, and you remove it before you deploy. Anything else works through the studio's local proxy, with no change.

## What you can do

- **Point and change.** “Make this bigger”, “rename this to Place order”, “why is the total wrong?”. Size, variant, text, move and remove are quick edits made on your computer, free and offline; anything else goes to your AI. Keep a preview with <kbd>Enter</kbd>, undo it with <kbd>Ctrl</kbd>+<kbd>Z</kbd>.
- **Record session.** Use your app and talk about what you notice, in English or Arabic. The report lists what went wrong with its evidence and code locations, each a click from a fix, and **Verify fixes** replays the session to check them.
- **Autopilot.** The AI uses your app like a tester and writes the same kind of report.
- **Experts.** Review a page for SEO, content, UI/UX and accessibility (WCAG 2.2 with axe-core), and fix findings in place.
- **Write test.** Narrate a bug (“this should show $80.80”) and get a Playwright test that reproduces it.
- **Your AI apps.** Claude Code, Cursor, Codex, VS Code and Claude Desktop connect over MCP: they see what you point at and propose changes you keep or undo.

## Commands

| Command | What it does |
| --- | --- |
| `npx @saywright/studio` | Start the studio and open it (`--port <n>`, `--no-open`, `--target <url>`, `--root <folder>`) |
| `npx @saywright/studio connect <folder>` | Connect an app once (`--url`, `--start "<command>"`, `--no-start`, `--studio <address>`, `--dry-run`) |
| `npx @saywright/studio setup` | Download the optional extras: the on-device voice model (28 MB) and speech models for Arabic and English (about 740 MB; `--no-speech`, `--best-arabic`, `--no-best-arabic`) |
| `npx @saywright/studio doctor` | Check what the studio needs, and how to fix what is missing; what to paste into an issue (`--json`) |
| `npx @saywright/studio mcp` | For AI apps that start MCP servers as programs (Claude Desktop) |

Every command takes `--help`. All options, ports and environment variables: [Configuration](https://github.com/ahmedbakr/saywright/blob/HEAD/docs/configuration.md).

## AI

Quick edits need no AI. For the rest, connect one in **Settings → AI**: your Claude, ChatGPT or Gemini plan through Claude Code, Codex or Gemini CLI (no API key, no extra bill), an API key (Anthropic, OpenAI, Gemini), OpenRouter, Groq, DeepSeek, Mistral, xAI or any OpenAI-compatible address, or Ollama and LM Studio on your computer (free, nothing leaves it). The top bar always shows who answers and what today cost, and a daily and monthly budget can warn or stop.

Measured on the sample shop with an Anthropic API key: about $0.02 per change and $0.05 per session report. Details, and what is sent: [AI in Saywright](https://github.com/ahmedbakr/saywright/blob/HEAD/docs/ai.md).

## Your code and data

Saywright runs on your computer. Your code leaves it only when you ask the AI something, and then only your request, what you pointed at and the code around it go to the AI you chose. Settings, linked apps and AI keys live in `~/.saywright` (keys readable by you alone; `SAYWRIGHT_HOME` moves it); each app's sessions and previews live in its own `.saywright/` folder. More: [Security](https://github.com/ahmedbakr/saywright/blob/HEAD/SECURITY.md).

## Requirements

- Node.js 22 (22.18 or newer) or Node.js 24 and later (24.11 or newer), on macOS, Windows or Linux.
- A current Chrome or Edge. Voice uses the browser's recogniser in Chrome, Edge or Safari, or the on-device model in any browser.
- Optional: git (to link GitHub repositories), and Playwright in your app (to run the tests it writes).

## More

- [Documentation](https://github.com/ahmedbakr/saywright#readme), [troubleshooting](https://github.com/ahmedbakr/saywright/blob/HEAD/docs/troubleshooting.md), [changelog](https://github.com/ahmedbakr/saywright/blob/HEAD/CHANGELOG.md) and [issues](https://github.com/ahmedbakr/saywright/issues).
- Licence: Apache-2.0. Third-party licences: `dist/THIRD_PARTY_NOTICES.md` in the package. The optional speech engine, [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache-2.0, with ONNX Runtime, MIT), is installed beside it under its own licence.
