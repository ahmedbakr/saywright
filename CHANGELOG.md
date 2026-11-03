# Changelog

All notable changes to Saywright. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-03

The first release: `saywright` (the studio and its command) and `@saywright/vite` (the Vite plugin) on npm. Both need Node.js 22.18 or newer, or 24.11 or newer (the LTS lines the Babel parser they read code with supports).

### Added

- **Point and change.** Point at anything in your running app, traced to its file and line, and say or type what to change. Size, variant, text, move and remove are quick edits made on your computer in milliseconds; anything else goes to your AI. Every change is a live preview you keep (<kbd>Enter</kbd>) or undo (<kbd>Ctrl</kbd>+<kbd>Z</kbd>).
- **Modes: Edit, Use and Write test.** Write test turns what you do and say (“this should show $80.80”) into a Playwright test, runs it, and lets the AI fix the bug it proves.
- **Any app.** Link a folder, an address or a GitHub repository. Vite + React apps get exact source locations through `@saywright/vite`; Next.js and other React apps through one development-only script tag; anything else through the studio's local proxy. `saywright connect` sets an app up from the terminal.
- **Your AI.** Your Claude, ChatGPT or Gemini plan (through Claude Code, Codex or Gemini CLI), an API key (Anthropic, OpenAI, Gemini), OpenRouter, Groq, DeepSeek, Mistral, xAI or any OpenAI-compatible address, or Ollama and LM Studio on your computer. A different AI per kind of work, a usage tracker, daily and monthly budgets, and the AI chip in the top bar that always shows who answers and what today cost.
- **Record session.** Use your app and talk about it, in English, Arabic or both, from the studio or from a button in your app's own tab. The report lists findings with their evidence (what you said, errors, requests, screenshots, video) and code locations, scores and suggestions, in English and Arabic, with **Fix with …**, **Fix all**, **Create test**, Markdown and HTML export. **Replay & verify** plays the session again after a fix and marks each finding fixed, still happening or not checkable.
- **Autopilot.** The AI uses your app like a tester, step by step, leaves deleting, paying, sending and signing out alone unless you allow it, and ends in the same report.
- **Experts.** Reviews of any page for SEO, content, UI/UX and accessibility (WCAG 2.2 with axe-core), an AI expert's opinion, fixes in place, Google's real-user data (Chrome UX Report, Search Console, Analytics 4), and the same rules as Agent Skills for your own coding agent.
- **MCP server.** Claude Code, Cursor, Codex, VS Code and Claude Desktop see what you point at, read your code and session reports, and propose changes you keep or undo in the studio.
- **Speech on your computer.** Narration and Arabic commands transcribed by local models (Omnilingual, Parakeet, and optionally Cohere Transcribe), with measured accuracy.
- **Commands:** `npx saywright`, `connect`, `setup`, `doctor` and `mcp`.
- **The plugin and the studio check each other.** They are updated separately; when they can't work together, the studio says which one to update.
- **`@saywright/vite`** works with Vite 4 and newer, and publishes its protocol module (`@saywright/vite/protocol`) with types, for tools that talk to the studio or read its sessions.
- **A quick-start tour** on the live studio for a first run: point, say, keep or undo, see the code, your AI and its cost, then sessions, Autopilot and Experts. Skippable, and replayable from Help.
- **Labs: hand control.** Point and pinch with your hand, tracked by your webcam; off by default.

### Hardened before release

**Security**

- The proxy fetches only the site it shows.
- The studio's live event stream goes to its own page only, and recording into a session takes that session's key.
- No web page can change where the plugin sends recordings, and the script in your app answers only the studio, not any page that frames the app.
- Files are read and written inside the app's folder only (for an app in a monorepo, inside its workspace), also through symbolic links.
- Only the studio, or the page recording a session, can stop it; another page can't take a running recording over.
- Opening a file in your editor is for the studio's own page only, starts no shell (on Windows, an editor's `.cmd` goes through cmd.exe with its arguments escaped), and works in an npm install too.
- On Windows, the AI apps npm installs (Codex, Gemini CLI, Claude Code), `npx` and editors start: Node refuses `.cmd` files without a shell, so an npm app's script is run with Node directly and any other `.cmd` file through cmd.exe with its arguments escaped.
- The hand tracker's library can't send its usage log to Google while it runs.
- Hand control turned off while the camera is still starting (the setup skipped, the Labs switch) stays off: the camera is let go of when it answers, instead of coming on.
- On Windows, **Open in editor** says when it can't find your editor, instead of saying it opened it.
- A removed app's proxy stops answering on IPv6 (`[::1]`) too, even when it was removed right after it opened.
- An empty line in `.env.local` no longer hides a key set in your shell.
- Every model download (voice, hand, speech and voice activity) is checked against a pinned SHA-256 sum, and archives are unpacked only when every entry stays inside the target folder.
- Opening a cloned repository says that it runs the repository's commands.
- Secrets are written readable by you alone from the first byte.
- Generated tests keep page text inside their strings and comments, and the script leaves your app's own browser storage alone.

**Scale and speed**

- A busy app's sessions keep every error and request, even many errors and hundreds of requests a second.
- Long, noisy sessions group repeated problems and build their reports in slices, so the studio stays responsive.
- Code search covers the whole app without freezing the studio, and says when it stopped short.
- Quick edits in long components parse the file once, and expert reviews of big pages run in steps.
- The first screen loads a third less script: rarely used views load when they are first opened.
- Committing a kept change runs alongside the studio, with a time limit.
- Settings are written whole and keep their last good copy, stalled event-stream clients are let go, and malformed addresses get a clear error.
- The local speech engine, which can hold a few gigabytes of models, stops after ten minutes unused and starts again when needed.

**Pointing at the right code**

- Elements in a monorepo's sibling packages are traced and can be changed (Excalidraw: 10% → 80% of elements traced).
- React 19.0, Next.js (Turbopack and webpack) and Astro's dev toolbar give exact places; links and wrappers point at where they are used.
- The text-search fallback no longer answers with the wrong place (0 wrong answers on six real apps, down from 48), and a location that is a guess is marked “likely” everywhere, also to the AI and over MCP.

**Linking and monorepos**

- `connect` and linking find the apps in a monorepo, their package manager and their port, and `connect` adds the plugin in the config's own style.
- Dev servers are found at their “Local” address, a server still compiling its first page isn't taken for a failed one, and none outlives **Stop**.
- An app keeps its proxy port, cookies and storage when its dev server moves, and pages stream through the proxy as they arrive.
- An app connected from the terminal opens when the studio next starts.

**Accessibility**

- All text reads at 4.5:1 or more in both themes.
- Dialogs are real modals that keep and return focus, <kbd>Esc</kbd> closes only the layer on top, and scroll areas can be reached from the keyboard.
- The studio's main screens pass an axe check in light and dark.
- Words in the other language (“Translating…” in Arabic in an English report) are marked as that language, so they read and are announced the right way.

**Honest reports and plain words**

- Reports check what the screen showed. The page's text is read once it settles after each action (dialogs and messages included, card numbers masked), and the AI checks each result against what the action should do, with the code behind it. In a session where nobody said a word, the sample shop's coupon bug is found and traced to `src/lib/pricing.ts:32` (2 of 2 runs with Claude Sonnet 5.5, $0.03 a report with its translation), and **Replay & verify** looks for the expected amount on the screen after the same step: still there before the fix, fixed after it.
- A session's first look at the screen shows it as the session found it, also when the first action comes within a moment of the start (as Autopilot's can): the look is taken before that action.
- The sessions list counts each report's findings, not only the problems the recording showed.
- A report with nothing serious says “No technical problems found” instead of “Ready to ship”, says what a recording can't tell, and offers **Add a check** and Autopilot for the rest.
- One privacy statement, with “What’s sent?”, wherever it matters.
- A refusal says why and offers the next step.
- The modes and buttons are named for what they do: Edit, Use, Write test and **Record session**.

**AI that reads the right things** (measured with the real Claude API on the sample shop)

- Reports read the code that computes what went wrong and name both where a problem showed and its likely cause (`pricing.ts:32`), and a serious finding caps the score: no more “Good” next to a high-severity bug.
- Experts are shown the page's landmarks, live regions and links, never call something missing that the page has, and say each problem once; fixes go to the shared token or style.
- Autopilot doesn't report its own made-up values, notices when it goes round in circles, and presses keys on the focused control.
- Prompt caching only where a prompt is sent again, and plain answers of at most four sentences.
- A budget stop answers every request the same way, and a run that can't start leaves nothing behind.

**Reliability**

- Previews survive a restart or a crash of the studio, still undoable.
- A change to several files lands in the running app at once, so it never shows a half-written state.
- Requests run one at a time, and keep and undo work from the command bar.
- **Replay & verify** checks a value you said while pointing (“this should show eighty dollars eighty”) on what you pointed at; recorded steps name the card a button is in, and generated tests use readable, stable locators.
- A starting session can be cancelled, and every finished report is announced.
- Calibrating reach by holding still works with any camera: at 20, 24 or 25 frames a second a held corner could stay just short of counting.
- Quick renames take only the quoted words; “everywhere” goes to the AI.
- An amount said in words reads “show $80.80” in the transcript, with its space, in English.
- An answer from the studio's server that can't be read (cut short, or an error page from something in between) is an error, never an empty success that empties the list of changes.
- On the welcome screen, keyboard focus starts on the first way to link an app, so no tooltip covers the page.
- `npm run dev` checks for the same Node.js versions as the package.
- An app shown through the proxy reaches its own API on another port of this computer: those requests go through the proxy, from the app's own address and with its cookies, so the API's CORS rules no longer turn them into “Network Error”. Only the app's own page can ask the proxy for that.

### Documentation

- [Getting started](docs/getting-started.md): every feature on the sample shop, one step at a time, with a picture of each and what you should see.
- Screenshots of the real studio throughout the documentation, taken again by `npm run media:screenshots` when the interface changes.

[0.1.0]: https://github.com/ahmedbakr/saywright/releases/tag/v0.1.0
