# Changelog

All notable changes to Saywright. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-04

The core loop, made safe and honest: observe → reproduce → fix → verify. A secret you type is never recorded, a choice in a list is chosen, a test is written in the order things happened and runs the same way every time, and a fix counts only when the evidence shows it.

### Security

- **Secrets are never recorded.** What you type into a password field (also after “show password”), a field marked `data-saywright-secret` (or with the marks session-replay tools use: `data-private`, `data-sentry-mask`, `.rr-mask`…), a field called like a secret (password, one-time code, API key, token, card number, CVC, IBAN…, in English and Arabic), or any value that looks like a card number, a key or a token, is kept out of sessions, Write test steps, generated tests, reports, exports, what the AI is sent, and MCP. Before, Write test recorded what you typed into any field as it was, a password too, into the test file and the prompt of **Fix with …**.
- **One set of rules for both recorders**, in `@saywright/vite/protocol`, applied again by the studio to whatever an older plugin sends, and as a session's events are kept.
- **Tests type secrets from the environment** (`SAYWRIGHT_SECRET_PASSWORD`): the Test tab's **Secrets** saves their values on this computer, with the studio's data, outside your code and readable by you alone. Replay & verify types them in a replay. Their values are masked out of what a run says.
- **Masked as recorded:** keys, tokens, bearer headers and card numbers in what the screen showed, errors, console lines and failed responses; tokens, keys, signatures and sign-in codes in addresses (also `#access_token=…`).
- **A field's secret value is never an element's text**: hovering a password field showed what was typed in it, and Autopilot and expert reviews could read it (Autopilot masked password fields only).
- **Screenshots and video show secrets as dots.** While a session records, the page shows every secret field as dots and blurs what is marked private. A card number, a CVC or a password shown with “show password” was in the screenshots, the video, the HTML export and what the AI was shown of them.
- **More secrets are recognised**: a one-time code in a field labelled only “Code” (short and numeric), a recovery phrase and a security answer, Stripe webhook secrets, SendGrid and AWS secret keys, a password in a database address, and long random tokens in an address. A “Confirm password” field types the same secret as the password above it. They are masked in a generated test's notes, in what the AI and MCP are told about a page (its address, an element's words), in a session's address and in a test run's output too.
- **The proxy keeps to other local services' CORS rules.** A page shown through the proxy could read any other service on this computer, past its CORS rules and with the app's cookies, where its own tab couldn't. Requests to another port now go from the app's own address, with a preflight where a browser sends one, and an answer reaches the page only if that service allows the app; cookies go only with requests made with credentials.
- **Only the open app's page can start a session.** Any page on this computer could start a session in the open app's history, fill it with what it liked and have it reported on. Starting one now takes the studio's own page or the open app's (at its own address or the proxy's).
- **Symbolic links can't reach `.env`, `.git` or `node_modules`.** A link inside the app pointing at one of them could be read through MCP's `read_file`, and `propose_change` replaced the link with a copy of what it pointed at. A change written through a link now changes the file it points to, and the link stays.
- **Autopilot keeps to “Let it delete, pay, send and sign out”.** Pressing Enter in a field whose form is sent by a pay, delete or send button counts as that button (with the switch off, it paid by pressing Enter in “CVC”), and what it types into a secret field is never written in its steps.

### Fixed

- **Choices in lists.** Write test recorded a drop-down as typing, so every generated test with one failed at that step (Playwright can't fill a `<select>`). A choice is now `selectOption`, by what the option says (or by its value, when that has numbers in it, like a price), and every option chosen in a list that takes several. Sessions, tests made from a report and Replay & verify do the same.
- **Checks in the order you said them.** A check said in the middle of a flow went to the end of the test, after everything that came later. It now sits after the steps before it.
- **Pages that a step opens are waited for** (`toHaveURL`, with the parts of the address that change from run to run left open), so the next step runs on the page it belongs to.
- **Locators as Playwright finds them.** A password field has no role (`getByRole('textbox')` never finds it), a list that takes several choices is a `listbox`, and a label or placeholder is matched as Playwright matches it (“Password” also finds “Show password”), with `{ exact: true }` where needed.
- **Tests run the same way every time**, with a configuration of the studio's own: Chromium, no retries, a fresh browser, and the app the studio has open as the `baseURL`. Your app's Playwright configuration (its retries, browsers, web server or missing `baseURL`) no longer changes the verdict. `tests/saywright/setup.ts`, when there, runs first, to put the data a test needs in place.
- **Write test records what was done, as a test can do it again.** A date, a time, a colour or a range is recorded as the value picked (a date field was recorded as a click, so every run stopped before its checks). A box ticked by clicking its label is one step, `check()`, not two clicks that undo each other. Typing then quickly clicking a suggestion keeps that order (the steps came reversed, the typing replaced by the suggestion). The arrow keys and Escape that choose from a suggestion list are steps too.
- **A check holds once the fix is in.** A check found its element by the words it checks, so after a right fix the test could never pass (“Like this portfolio (1)” should show “(2)”, a word in a summary). It is now found by what the fix doesn't change: its row's heading (`getByRole('row').filter({ hasText: 'You pay' }).locator('td')`), a name with its numbers left open, else its place among the same. A price or a count in a name or text is a pattern for every step too (`/^Pay \$\d[\d.,]* and subscribe$/`), so a fix that changes a total no longer breaks Replay & verify.
- **“This should be checked”** on a checkbox, a radio button or a switch, or its label, checks it with `toBeChecked()` (“shouldn't be checked” too); said of an option of a list as “selected”, the list is checked to have it chosen, however many it takes. Both used to check the element's text for the word “checked”.
- **A link that is a picture is named by its alt**, as Playwright names it: a text link with the same words no longer matches both (a strict-mode error in the test). Long names and labels are found by their beginning, never by a cut name.
- **A test changed after it failed doesn't pass as verified.** Edited by hand or by any AI request, a test that then passed counted as proof, with the bug still there. The Test tab shows each check's own result (all of them showed ✗ when one failed), and a reload keeps the test being written.
- **The pointer is where it stopped.** A pointer flicked across the app and stopped could be taken as being on what it passed over, so a check typed next could be about the wrong element.
- **Quick edits do only what was asked.** A request with “remove”, “delete” or “hide” in it ran as “remove this”: “make the Delete button ask for confirmation” removed the button (from every row, in a list). A rename or a colour with those words is now that, and a request of two parts goes to the AI whole rather than half done. A rename keeps the words as written (“iOS”, a closing “?”).
- **A removal takes what only it used.** “Remove this” left imports and props only the removed element used, which fails a build that checks for unused names. They go with it now (a prop's default value too); anything else only it used (a value worked out, a hook) may do more, so it stays and the change names it.
- **A quick edit says what else it changes**: “(all 50 on this page)” for a list's rows or a component drawn several times, and “Card is used in 6 places” when the component is used elsewhere too.
- **The code changed under a selection** (lines added above it in an editor): a quick edit changed whatever now sat at the old place, or went to a paid AI unasked. The element is found again nearby by its name and words, or the studio says to select it again; a request sends what the page shows now.
- **A studio that restarts during a recording carries on.** Everything recorded after a restart was lost, and the session stayed “recording” until the app was opened again. The page recording it keeps what it records while the studio is away and sends it on: the recording goes on, and its report says the studio restarted. A recording whose page doesn't come back within a minute is finished with what it has, and its report says where it ended. A studio tab open across the restart opens its app again, as it was.
- **A dev server that stops** is said so over the app at once, with its last words and **Start it again**; the app's card offers the same (“Back to it” showed the dead app).
- **The recorder in the app's own tab can get out of the way**: while recording, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> (or its new button) shrinks it to a small dot, and another button moves it to the other side of the page (it covered the cart drawer's checkout button, and could not be hidden while recording).
- **A choice in a list is recorded as chosen in sessions too** (it was typing, so a test made from the session failed at it), page titles are read once the page has set them, and an order row's number, date and quantity are no longer masked as a card number.
- **A Next.js app connected with the script tag** is shown as it is, not through the proxy (a sign-in that returned to the real address lost the studio).
- Messages that said “Is `npm run dev` running?” about the studio name `npx @saywright/studio`.
- **Smaller things:** a mark in the app's own tab is recorded once (it was twice); a session you renamed shows its name in the list, not the report's title; an Arabic report gives a finding's confidence in Arabic; “make this bigger” with nothing pointed at asks you to point first, for free (it went to the AI, which asked what “this” was); a quick edit in a file that doesn't parse says so rather than going to the AI unasked; writing a test again after another check replaces the file written for it before (when nobody changed it since) instead of leaving both to run; a test run cut short no longer leaves its configuration and Playwright's notes behind; Autopilot's timeline notes a step it wasn't allowed to take; **What's sent?** says what **Fix with …** sends; `connect` points a script tag at the studio that runs now, also when it moved to another port; and MCP's `get_context` names a picked element once, with the person's own last request for that app and how long ago it was.
- **A stopping budget counts the call about to be made.** A report admitted at $0.47 of a $0.50 daily limit cost $0.24: a call is now sent only if what it is expected to cost fits.
- **A session that records the screen starts at once.** Starting waited for the shared picture's first frame, and a still page cropped to the app can send none until something on it changes: the session then stayed on “Starting…” for 30 seconds and said sharing the screen didn't start. It now waits for that frame for 1.5 seconds at most, and the start's picture is taken with the first frame.

### Changed

- **A fix counts only with evidence.** Each step and check of a generated test is a numbered `test.step`, and a run is believed only when every one of them reported that it ran and passed, on the first try. A test that fails before its checks says it doesn't show the bug yet, instead of offering a fix for it. After a fix, the test that failed must pass unchanged: a pass of a changed test, a skipped run, a pass only on a retry or a test with no check says **Couldn’t verify**. A fix may not change the test it is checked against (that part of it is left out; a change to the test alone is refused).
- **Replay & verify needs evidence too.** A step on a control that is disabled now stops the replay (it used to count as done, so what came after it looked fixed), and a button that did nothing and is still disabled is still a problem. A problem whose step changed nothing on screen in the replay, when it did the first time, is **Couldn’t check**, not fixed.
- The sample shop has an account page, with a sign-in, a drop-down and a list that takes several choices.

### Removed

- **Hand control (Labs)**: the camera, hand tracking, gestures, calibration, the camera preview, its settings and the hand model download. It may come back later. Voice and mouse pointing are as before. Settings saved by an older studio load without it, and `saywright setup --hand` still runs (with nothing to download).

### Documentation

- [Apps](docs/apps.md#the-proxy): what the proxy passes on to an API on another port (`fetch`, `XMLHttpRequest`, `EventSource`, `WebSocket`, `sendBeacon`), and what it can't (an image or a link at that address loads without the app's cookies).

### Tests

- **A usage benchmark** (`npm run eval:usage`): journeys through point, quick edits, Write test, sessions, Replay & verify, the Experts and MCP over five projects (a shop, invoices, bookings, a to-do list and a sign-up form), each described by a `usage.json`. Free unless `EVAL_AI=real`. The five projects pass all 67 journeys.
- Tested on five more projects, each the way a different user works (a CRM in Edit mode, a clinic's booking app in Write test, a coffee shop's sessions, Replay & verify and Autopilot, Next.js and a monorepo from the terminal and MCP, a ledger for security and reliability): what was found is fixed above, with a test each.
- Regression tests for all of the above: the redaction rules, the generator, what a run proves and Replay & verify's evidence (unit), and browser tests for a password and an API key in Write test and in a session, lists, a test that can't reach its check, a fix that only weakens the test and a shared screen whose first picture is late.
- **An opt-in real-model benchmark** (`npm run eval:ai`, with your AI and a budget): four small apps the AI has never seen, each with a seeded bug and a bug-free twin, through the whole loop. It measures how often the session report finds the bug, false positives on the twins, how reliably the generated test reproduces it, how often the AI's fix is verified (with the test untouched and values the AI never saw right), and the time and cost of each step.
- **Its first run**, with an Anthropic API key and the studio's default models, each test run twice: the session report found 3 of the 4 bugs, and none on the bug-free twins (the invoice that leaves its last line out of the subtotal went unnoticed: nobody said what it should be). The generated test failed at its check on the bug in 8 of 8 runs, and passed on the twins in 8 of 8 with every step and check reported. All 4 fixes were verified, each in one file, with the test untouched and the values it never checked right. A report took 9.8 s and a fix 4.5 s on average (before the run that verifies it), and the whole run cost $0.26.

## [0.1.1] - 2026-11-04

### Fixed

- **`@saywright/vite`'s npm page** names the studio's package and how to start it: `npx @saywright/studio` (0.1.0's still said `npx saywright`, a name npm refused as too close to `playwright`), and links to it.

The studio is the same as in 0.1.0: the two packages keep one version, so a studio and its plugin always match.

## [0.1.0] - 2026-11-03

The first release: `@saywright/studio` (the studio, and its command `saywright`) and `@saywright/vite` (the Vite plugin) on npm. Both need Node.js 22.18 or newer, or 24.11 or newer (the LTS lines the Babel parser they read code with supports).

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
- **Commands:** `npx @saywright/studio`, `connect`, `setup`, `doctor` and `mcp`.
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

[0.2.0]: https://github.com/ahmedbakr/saywright/releases/tag/v0.2.0
[0.1.1]: https://github.com/ahmedbakr/saywright/releases/tag/v0.1.1
[0.1.0]: https://github.com/ahmedbakr/saywright/releases/tag/v0.1.0
