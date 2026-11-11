# Changelog

All notable changes to Saywright. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-11-10

A full audit of 0.2.3, as a new user on real apps with Claude and with GPT and through the code area by area: about 150 findings, the ones that matter fixed, each with a test. The first minute is one click, a check means what was said, Autopilot's safety switch holds, a verdict says only what the run could see, and answers stream from every provider.

### Added

- **The sample shop opens in one click.** A first start offered a sample shop that needed `npm install` in a folder you had to find first. **Open the sample shop** on the welcome installs what the shop needs (about a minute, once), starts it and opens it, saying the step it is on; if the install fails, the message says why and what to run by hand. The tour has a new step, **Say the bug, get the test**: it showed every tool but the one the studio is for.
- **A first test needs nothing set up by hand.** An app that doesn't have Playwright is told so at once, and **Add Playwright to this app** on the run's card adds it with the app's own package manager and runs the test. When Playwright's own browser isn't installed, a test runs in the Chrome or Edge on your computer, with nothing to download, and says which browser ran it; a browser install that fails shows its output and why.
- **A note you type.** While a session records, **M** opens a small field: type what you noticed and press Enter (Esc keeps the mark without words). A tester without a microphone no longer records marks that say nothing; the report reads a typed note as it reads what was said.
- **More kinds of check.** “This shouldn't show $51.71”, “this should be visible”, “hidden”, “enabled”, “disabled”, and “selected” on a tab are checks of their own, written with Playwright's own matchers; an image is checked by its name. A state the element can't have is refused with a sentence, and in Write test a sentence shaped like a check is never sent to the AI: the studio says which phrasings it understands.
- **Write test records more of what you do:** a double click, a right click, an app's keys and shortcuts, files chosen in a file input, a drag and drop, the hover that opened a menu, and the answer you gave a `confirm()` or `prompt()`. What a test can't do again (something inside an embedded frame, a shape drawn on a canvas) shows as a **Not recorded** step and a comment in the test, so you know it does less than you did.
- **Undo for a change you kept.** A change just kept has **Undo** on its card in the Changes tab, and “undo” or Ctrl+Z with nothing waiting offers to undo the last change kept.
- **Answers stream from OpenAI, Gemini and OpenAI-compatible providers**, as Claude's did. A long answer (a local model writing a report) is no longer cut at five minutes, a provider that goes quiet for 90 seconds is given up on with a sentence that says so, and **Stop** works at every moment.
- **The models your provider lists.** Each API key's model list is loaded from the provider, so a model released after this version can be picked, and a model id can be typed in Settings → AI. A model nobody has priced shows “price unknown”, never $0: under a budget it is counted at its provider's dearest known rates. Settings says when the prices were checked.
- **Apps served over https on this computer** with their own development certificate (self-signed, mkcert, `next dev --experimental-https`, Vite's basic-ssl) can be linked, started and shown. When a site elsewhere is refused for its certificate, the studio says so.
- **Behind a company proxy.** With `HTTPS_PROXY` set, the studio's AI requests go through the proxy while your app, Ollama and LM Studio are reached directly (Node.js 22.21 or newer). It says so in one line as it starts.
- **`saywright doctor` prints what an issue needs:** versions, the computer, the data folder, the programs it found and the names of the proxy variables that are set, each checked on its own, as text or with `--json`. It says when a newer release is out. A dropped download of a speech model continues where it stopped.

### Changed

- **A quick edit is made only when the whole request is one.** “Don't make it bigger”, “make it bigger if it fits” and “why is this blue?” were read as “make it bigger” or “make it blue” and changed the file without the AI. A sentence is a quick edit now only when all of it is one (a size, a colour, a text, a move, a copy, a removal); a question, a condition, a negation or anything else goes to the AI, which reads the whole sentence.
- **A check passes only when the whole value matches.** “Active” passed on “Inactive”, “5 in stock” on “15 in stock” and $80.80 on “$180.80”. A value is found as a whole word or number, and amounts are compared as amounts, as Replay & verify compares them. A test written by an earlier version is left as it is.
- **Autopilot without leave does less.** With “Let it delete, pay, send and sign out” off, it now also leaves alone controls such as “Remove”, “Subscribe”, “Send feedback” and any control with no name at all, and lists each as a skipped step with the reason. Turn the switch on for an app where those are safe.
- **The AI changes what runs outside the page only when you ask.** A build or server config, a package file, CI and hooks are changed only when your own words name them; what the page says is given to the AI as data, quoted, so a sentence on the page can't pass for yours.
- **Commit when you keep a change commits only that change.** When its file also has changes of yours, or the repository above the app doesn't track it, the change is kept and not committed, and says why; a refused commit leaves nothing staged.
- **Closing the terminal stops the dev servers the studio started**, as Ctrl+C does; so does a crash. The next studio stops any a studio left running (the same command in the same folder), and nothing it didn't start.
- **Through the proxy, a page reaches only what it could reach on its own.** Only a script's CORS request to another port of this computer is passed on. A browser that doesn't say how a request was made (Safari before 16.4) can no longer reach an app's API on another port through the proxy.

### Fixed

#### Security and privacy

- **Autopilot's safety switch holds.** With “Let it delete, pay, send and sign out” off, Autopilot could still delete a record, send a payment and sign out: it judged a control by a short list of English and Arabic words in its name. A control is judged by what it is: its words in eight languages, its icon and classes, where a link goes, the address and method of the form a button sends, whether the app asks before acting. And while Autopilot acts, the page itself refuses delete requests and requests, forms and navigations to addresses that say delete, pay, send or sign out, or that leave the app, and answers `confirm()` “Cancel”.
- **Source maps are followed only at the app's own address.** A page's script could name a source map anywhere: the studio fetched it from the server, and read any “source” it listed from the disk into the session. A map is fetched only from the app's own origin (redirects aren't followed, and its size is limited), and a source is read only when it is a file inside the app's folder.
- **A recording has a size limit.** A page could send the studio video without end and fill the disk. A session's recording stops at 4 GB, or when less than 512 MB of disk is left, and says which.
- **A token in a link or a stack trace is masked wherever a session keeps it,** and so is a card number typed with a pause or in a field labelled in French, Spanish, German, Portuguese, Italian or Turkish. Once a field held a secret, what is typed into it later is masked too.
- **A page shown through the proxy can't read another service of this computer** that doesn't allow it: a no-cors fetch is sent by the browser itself, with its usual opaque answer, and scripts, images and styles get nothing from the proxy's path for another port.
- **Files that hold keys are never read by the AI** or by an AI app over MCP, whatever the case of their names. A key written in code goes out as a placeholder, and an edit keeps the real one. A wrong MCP token is always a refusal.
- **The studio's script keeps its names to itself.** An app whose own script declares `now`, `step` or `find` stopped with “Identifier has already been declared” in the studio. The script is one wrapped function now.

#### Write test

- **A check expects what was said.** “This should show $64.64, not $51.71” kept the comma and could never pass; a quoted value is taken whole (“Item not found”); words said in another case are checked as the page shows them. A check said of a field in its label, or of the label, reads the field: what it holds, or the option chosen in a list, never the label's words.
- **A run's verdict is honest.** A test sent elsewhere as it opens (to a sign-in page) fails at its first step and says where it was sent; a check that finds nothing is “couldn't find what this check looks at”, not the bug; a check that held on screen as it was said and fails in the run says the test doesn't replay what you did, and no fix is offered for it. A check waits as long as you waited before saying it (at most 30 seconds).
- **A typed check is about what the pointer rested on when the command bar took the focus,** however long the typing takes, and the bar names it. The Checks list shows each expected value once.
- **A full page load loses no step.** The recording carries on in the new page before its images have loaded (it waited for the whole page), and the test waits for each new page. A space typed into a field inside a web component is typed, and no longer starts push-to-talk.
- **Steps are found by better names:** a short name with a number (“Row 3000”) by that name, a submit or image button by its words, a field with suggestions as a combobox, a cell by its row, and an element by the heading of its part of the page before its position. While writing a test, pointing reaches a value inside a web component.
- **A step finds its element by the words written in the page.** A step or a check found by its text used the words the screen showed, which a test doesn't read: capitals a style shows (`text-transform`), a line break in the text, an arrow kept from screen readers (`aria-hidden`) or spaces around a price in the markup gave a locator that found nothing when the test ran. An element is found by its words as Playwright reads them, and a check said of “ACTIVE” on a badge that a style writes in capitals expects the “Active” the page holds. A menu that opens on hover is hovered by its own word (“Products”), however the pointer came to it and however the page opens it: a style rule (Tailwind's `group-hover` and rules written with nesting too) or the page's code.
- **The test being written is kept for each app.** It comes back, with Write test on, after a reload, a restart of the studio and a switch to another app and back, and the Test tab says when the app opened again on another page than where the steps end. **Create test** from a report asks before it replaces it.

#### Sessions, Verify fixes and reports

- **Verify fixes says “fixed” only when the replay could have seen the problem.** It clicked another row's Delete and called the bug fixed. A step is recorded by what tells it apart (the row's own words) before the click changes the page, and a step that now matches several elements stops the replay as “couldn't check”. When the app starts the replay from other saved data than the recording did, or the replay stopped listening before the problem had taken to show the first time, the answer is “couldn't confirm”. The result says that what the replay's steps changed in the app stays changed.
- **A page answered with an error, and a request that never answered, are findings.** A form sent to a page that answered 500 scored 100. A session with nothing in it says “Nothing to judge yet” where it showed a score, and a page opened by a full load has its title.
- **Fewer false alarms.** An HTML answer is a finding only when the app asked for data; quick clicks that each do something aren't rage clicks; drawing on a canvas or downloading a file isn't a dead click.
- **A report never calls a value right that nobody spoke about.** When the tester said nothing, a report described “the correct total”; it describes what was on the screen.
- **A frame inside the app is part of its page.** A same-origin frame (a payment widget, a preview) carried a recording on as a page of its own after a reload, and the report gained a page nobody opened. In Write test, a check said of an embedded frame is refused with why: a test can only check what the page shows itself.
- **The SEO review finds more:** a canonical that names another site than the page's own addresses, more than one title, more than one main heading. **Add to this app** no longer replaces a skill of your own with the same name: it updates only the files the studio wrote, and says which it left alone.
- **The studio's own dialogs work with a keyboard.** The Record session dialog is named and takes the focus, every dialog, the report and the command palette give the focus back to what opened them, Settings' lists and slider have names, the help dialog's list can be scrolled, and the island's messages are announced. A click made as a dialog closes is no longer lost to its fading backdrop.

#### Edit mode and the AI

- **Several picked elements: the right ones are changed.** “Remove these” with several picked could remove another element than the one picked. Each is found in the code before any is changed, and the imports and props only they used are tidied once. Removing the fallback of `a || <El/>` leaves `a`, and removing one branch of a condition leaves the other.
- **A ninth element isn't picked by letting the first one go.** At most eight can be picked together, and the studio says so.
- **A component is given only its own variants.** AlertTitle or SheetTitle were offered the variants of the only cva in their file. A boolean variant is written as `fullWidth` or `fullWidth={false}` and a number as `{2}`, so the build's type check passes.
- **A change keeps a file as it was:** its encoding and line ends (a CRLF file came back with LF, and a file that isn't UTF-8 lost its accented letters), its permissions, and the link it is reached through. Undo puts back the very bytes.
- **A change cut off at the length limit is never applied.** An answer that stopped mid-change wrote the half it had. After Claude's server switches models mid-answer, only what came after is acted on.
- **Nothing is called saved that wasn't.** When the list of changes can't be written (a full disk, a folder that can't be written), a preview fails whole and Keep keeps nothing, with a sentence that says why. When the app's folder is moved or deleted while the studio runs, the studio says so and never makes an empty folder in its place. The studio's memory stays flat through a long day of changes.
- **The budget counts every call it can know about.** A stopped or failed request is counted, an answer that came without usage is counted at an estimate, never as free, the connection **Test** is held to the budget, and a damaged budget file keeps **Stop** in force and says so.
- **Provider errors are sentences with what to do:** out of credit, a prompt that is too long, an overloaded provider, a wrong address, a model that can't call tools, a connection lost mid-answer (“terminated” before). A rate limit or a server error is tried once more. A search pattern that could freeze the studio is refused, and the code sent with a request has a limit.
- **A spoken command heard as a word that sounds like it is still the command.** “Undo” heard as “Andi” was taken as “Andi”: the sound-alike, tried first, kept the command from being weighed against the audio. It is weighed like any short command, as it was when two words were heard (“and you”).

#### Apps and the proxy

- **Another program on an app's port is never shown as the app.** The studio checks that what answers there serves the app's folder; if not, it starts the app on its own port.
- **A dev command that starts several servers opens the web one.** A command that printed its API's address first was opened there, and that address saved. The web server's “Local” line wins, an address that answers with an API's 404 or JSON is never taken, and a “Local” line printed later moves the studio there.
- **The proxy waits as long as a browser does.** An answer that took more than 30 seconds was cut, and so was an event stream that went quiet. A request waits up to five minutes for the app to start answering, and a stream is never cut for being quiet.
- **Pages that aren't UTF-8 show correctly** (Latin-1, Shift_JIS): the studio's script is added without re-encoding the page. A form the page's script builds with the app's full address keeps its method and fields, and a server that uses zstd or Brotli is asked only for what the browser accepts.
- **An app whose script tag points at a studio on another port** is shown through the proxy, and its notes say how to fix the tag, where it said “Connecting…” for ever. An element written in a Next.js 16 server layout is traced, or found in the layout as a guess.

#### The command line

- **`connect` edits only what it understands.** It found the Vite config's `plugins` with a pattern, and could add the plugin to a PostCSS or Rollup list, break the app's CSS and say “Connected”. It reads the file with a parser now: the config's own plugins, a layout's `<body>`, a document's `<Head>`. A file it can't change safely is left as it is, with the lines to add by hand; a plugin an earlier version put in the wrong list is moved. A Vue app on Vite gets the plugin, which runs on the dev server only.
- **`connect` links the app at once in a studio that is running**, and a stopped studio no longer leaves its address behind for `connect` and `doctor` to trust.
- **A damaged data file is set aside.** The app list (two studios on one data folder keep each other's apps), `ai.json` or a usage line of the wrong shape: the studio starts with its defaults and says so. Every command checks the data folder first.
- **The app list's switch saves again.** “Show at start” answered 404 since 0.2.0: its address was taken for an app's.
- **`--target` is checked before the studio starts.** One that isn't an address, and `--root` without `--target`, are refused with a sentence; an address that never answers isn't kept in your apps.
- The Node.js message says the versions as they are (22.18 or newer, or 24.11 or newer), `--port` takes digits only, GitHub clones go to `saywright-apps` in the home folder the operating system names, and where the speech engine can't run `doctor` and `setup` say so and download nothing.

### Tests

- 1,225 unit tests (907 in 0.2.3) and 157 browser tests (129). Recorded steps are run through Playwright itself: each must find the one element that was used. The first run is tested with the real install, not a stand-in: its bug shipped behind one.
- The package's smoke test opens the packaged sample shop with the plugin from the tarball.

### Documentation

- [Getting started](docs/getting-started.md): the sample shop in one click, and a first test with nothing to set up.
- [The guide](docs/guide.md): what a quick edit is and what goes to the AI; every kind of check; what Write test records; undo after keep.
- [Autopilot](docs/autopilot.md): what the safety switch judges and what the page refuses. [Sessions](docs/session-report.md): what Verify fixes can and can't confirm, and what is masked.
- [Apps](docs/apps.md), [Configuration](docs/configuration.md) and [Troubleshooting](docs/troubleshooting.md): local https apps, updating and removing Saywright, behind a proxy, in a container, in WSL and over SSH.
- [AI in Saywright](docs/ai.md): streaming, model lists and prices, what the AI never reads.

## [0.2.3] - 2026-11-05

What an audit of 0.2.2 and a review of its fixes found, each fixed with a test: what is private stays private everywhere and from the first frame, a test is verified only when each of its tests ran its own checks, and a budget counts all it pays for.

### Fixed

- **A private rich text editor stays private.** A rich text editor (`contenteditable`) marked private, itself or through a part of the page it is in (`data-private`, `data-saywright-secret`…), had its text recorded in Write test's step and in the test. It is recorded by name, as a secret field is (`secret('PRIVATE_NOTES')`). What it holds, or what a part marked private says, is left out of a session's targets, headings and screen text and of what Autopilot reads, also when it is inside the element described.
- **Screen masking reaches into shadow roots, and masks from the first frame.** While a session recorded, a secret field inside a web component's open shadow root showed in its pictures and video. Every open shadow root is masked now, nested ones too; a root made while recording is masked as it is made, before anything is drawn in it (a closed one too), where before a field filled in as it was drawn could show for up to a second. A privacy mark added during the session (`data-private`, a class such as `fs-mask`) masks what it covers from the next frame; it went unnoticed. Nothing of the mask is left when the session ends.
- **A focused test is never verified.** A file with `test.only` (or `describe.only`) ran only that test, so a passing one before a failing one was verified. The studio refuses to run it and says to remove `.only`. Each test must run its own steps and checks, as often as it has them: a test whose `[check 1]` never ran was covered by another test that ran its own `[check 1]` twice.
- **Every attempt is counted, at its own model's price.** When Claude declines a request and runs it again on another model (its server-side fallback), both attempts are billed, but only the last was counted, at the price of the model asked for. Each is counted now at the price of the model that ran it, as is a request another model answered; one answered under its provider's own name for the model asked for (OpenAI's dated snapshots, Gemini's versions, OpenRouter's maker prefix) is counted as that model, so its use isn't split across names. Under a budget set to Stop, a declined request isn't run again on another model, since that second run's cost can't be set aside first, and the message says so.
- **A budget's estimate is no longer short.** What a request sends was estimated below Claude's own count (it counts a fifth to a half more for code, CSS and JSON, and three times more for a large screenshot), so a request under Stop could pass a limit. It is estimated now from each kind of text and each picture's size, at rates measured against Claude's count, and a model seen to send more than estimated has its later requests counted that much bigger.
- **A refusal tells close amounts apart.** “This could cost up to $0.01, and $0.01 … is left” now reads “up to $0.0110, and $0.0105”, and token amounts the same way.

### Tests and benchmarks

- `npm run eval:usage` without `EVAL_AI=real` turns off every AI the studio would find on the computer (a plan's app, a key in `.env.local`, a local server), and stops if one is still usable: an installed Codex was used for its reports.
- The keyboard test waits for the new preview before pressing Enter. The session test records with the panel closed, and says, with both widths, when the browser lays the app out wider than its frame while the tab is shared (seen with a headless browser on a Mac, where a click can't be aimed into it); everywhere else every check stands.
- A browser test looks at the first frame drawn after a field appears or is marked private, not only at what is masked in the end.

### Documentation

- [AI in Saywright](docs/ai.md#usage-and-budget): how a request is counted before it goes, what is counted when Claude declines one, and why Stop doesn't run it again on another model.
- [Write test](docs/guide.md#write-test-narrate-a-bug-get-a-playwright-test) and [Sessions](docs/session-report.md#what-is-captured): private rich text editors, shadow roots, and focused tests.

## [0.2.2] - 2026-11-05

What a fresh audit of 0.2.1 found, each fixed with a test: a studio that keeps running whatever the browser does, a pass you can believe, your edits never lost, and a budget that is a limit.

### Fixed

- **The studio keeps running when a browser gives up on a request.** A reload, a cancelled request or a closed tab while the app behind the proxy was still answering ended the studio (`ERR_STREAM_UNABLE_TO_PIPE`). The answer is dropped, what fed it is freed, and the proxy serves the next request. Files the studio sends (the app's pages, videos, screenshots) are sent the same way.
- **Verified means every check ran and passed.** A check that failed inside a `try`/`catch`, a second test in the file that failed, a skipped part, or a Playwright run that didn't end cleanly could still be called verified. A run is verified now only when every test, step and check in the file passed on its first try and Playwright ended cleanly; a check that failed is a failure, even when the test caught its error.
- **Long tests are written whole.** A test of more than 100 steps or 20 checks was cut to that without a word, so a failing 21st check never ran and the test passed, verified. Up to 1,000 steps and 100 checks are written whole; past that, nothing is written and the studio says so. A step or check that can't be written (one that isn't a step, a fill with no locator, a value that isn't text, a check that could never fail) is refused with what is wrong, not with a server error.
- **A long expected value is checked.** A field's expected value of more than 1,000 characters is checked as text: as a pattern it was more than a browser compiles (“Regular expression too large”). A failure says the value as it was said (“80.80”), not as its pattern (“/80\.80/”).
- **A change is never written over your edits.** A change made from a file you saved meanwhile (in your editor, or by another change made at the same time) replaced your edit, and Undo then put back the file as it was before both. Each file is checked against what the change was made from, when the change arrives and again right before it is written: if it changed, nothing is written and the studio says so, with **Ask again**. An AI app over MCP is told to read the file again.
- **A budget set to Stop is a limit.** A $0 limit still let a call through, a call could cost more than was left ($0.03 on a $0.01 budget), the steps of a change weren't counted ahead, and two reports at once could together go past the limit. Before each call, the most it could cost is now set aside until what it used is recorded: a call that could go past a limit isn't sent, and when little is left a step of a change answers in less room. Dollar limits apply to API keys; plans and local models count toward the token limit.
- **A click as a recording starts lands where it was aimed.** The session bar slid in as the recording began, moving the app under the mouse: a click on a small control right after **Start recording** could miss it. The bar takes its place at once.
- **Write test records every field.** An option that says the same as another of its list (“Standard” twice) was written by what it says, so a run chose the first; it is chosen by its value now, in the test, in Replay & verify and in a test made from a session. What is typed into a rich text editor (`contenteditable`) or into a field inside an open shadow root wasn't recorded at all; both are, and replayed.

### Tests and benchmarks

- **The benchmarks fail when a case does.** `npm run eval:usage` failed no test when a journey failed, `npm run eval:ai` passed a case that didn't finish or didn't reproduce its bug, and a session a failed case left recording kept the next from starting. Each fails now, its rates count every case (and say how many didn't get that far), and a session left recording is stopped.
- The browser tests read the keys as the studio names them on the computer they run on (Return and ⌘Z on a Mac), and wait for a test run to end rather than a fixed time.

### Documentation

- [AI in Saywright](docs/ai.md#usage-and-budget): what **Stop** does, call by call.
- [Write test](docs/guide.md#write-test-narrate-a-bug-get-a-playwright-test): what verified means, how long a test can be, lists with options that say the same, rich text editors and web components.

## [0.2.1] - 2026-11-05

The rest of what the five test users found: the smaller things, each fixed with a test.

### Fixed

- **Several picked, all changed.** With elements picked (⇧ click), “make these smaller”, “rename these” or “remove these” changed only the first. Each changes now, together as one change; one that can't be done stops them all, and says which and why.
- **Undo on an older preview says what else goes.** Undoing a preview in the Changes tab also undoes the newer ones (they may build on it), with no hint: its button now says “Undo (and 2 newer)” and asks first, naming them.
- **Escape stops a request just sent.** Right after sending, Escape in the empty command bar only left the bar, and the request went on and was paid for.
- **A label with its field inside is renamed by a quick edit** (“Email” beside its input, “Save” beside an icon): it went to the AI. Words written among other words say so.
- **Every studio tab shows the same changes.** A preview made, kept or undone in one tab showed in another only after a reload, and Ctrl Z there said “Nothing to undo”.
- **A component is named as the Inspector names it**: “Remove “VIP” Badge”, not “… span”.
- **The palette's theme entry** says “Switch to dark theme” (or light), for the theme not shown now, and “dark” finds it. Ctrl K closes the palette from its search box.
- **Reload the app stays on the page it is on**, rather than going back to the start page.
- **Start over** on another page asks whether the new test starts there or on the app's start page: a test opens the app signed out, so a page behind a sign-in is reached by signing in as part of the test.
- **A check on a list** says which option is chosen, not every option it has; a test's file name ends at a word.
- **A replay's or Autopilot's own clicks are not layout shifts.** What a scripted step moved (a menu opening, a row it added) was reported as the page shifting, in every replay and Autopilot run.
- **Create test from a finding** stops at the moment the check is about, not at a payment made later in the session, and finds the element the finding's expected value is named after when its evidence names none.
- **A session's video and first picture** start once the countdown has left the screen.
- **What the session didn't show isn't a bug.** A report's finding that says it wasn't triggered in the session is a test worth adding, not a high bug, and the verdict follows what was seen. A finding without a place in the code gets where its evidence showed; amounts are worked out step by step.
- **A small control with room around it** passes in session analysis, as in the Experts (WCAG 2.5.8's spacing exception): well-spaced navigation links were flagged.
- **The AI experts see what is there**: links and buttons named as a screen reader names them (a picture link by its alt), and each field's `inputmode`, which they called missing.
- **Linking the right app.** Picking an app inside a monorepo kept the first one's name, command and address; **Use this folder** took the folder listed, not the one typed; and the first listing, coming late, could replace a folder asked for since.
- **“Link its folder…”** on an app linked by its address gives that app its code, keeping its addresses and moving its sessions along; it made a second app.
- **PHP and Vue apps.** A PHP folder is recognised and started with PHP's own server (`php artisan serve` for Laravel); a Vue app is called Vue, and words from data lead to the component file Vue names. A folder of pages shows no package manager, a PHP app offers no `npm install`, and an app linked by its address isn't named “Sign in” from its page's title.
- **In a monorepo, `search_code` and `list_files`** reach the workspace's other packages, as `read_file` does.
- **The Claude Desktop entry** in Settings carries `SAYWRIGHT_HOME`, so a copied entry finds a studio that keeps its data elsewhere.
- **The app's own address** is shown (the Test tab's “From …”) and told to AIs and MCP, not the studio proxy's.
- **`connect`**: several apps connected before the studio starts are each linked (only the last was); a folder of plain HTML or a PHP app connects through the proxy, every page; `--dry-run` says what it would do and shows the lines; the import is written in the config's own style (no semicolon where it has none); a Next.js layout gets no line of spaces.
- **`doctor`** says where a running studio listens, rather than calling its usual port free; the studio names the app it is opening rather than “No app open”.

### Documentation

- [Write test](docs/guide.md#write-test-narrate-a-bug-get-a-playwright-test): a `tests/saywright/setup.ts` example, and the same setup as `globalSetup` when your CI runs the tests; when a quick edit goes to the AI.
- [Apps](docs/apps.md) and [MCP](docs/mcp.md): PHP, Vue, linking a folder to an app linked by its address, `connect` for several apps, and what MCP reaches in a monorepo.

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

[0.3.0]: https://github.com/ahmedbakr/saywright/releases/tag/v0.3.0
[0.2.3]: https://github.com/ahmedbakr/saywright/releases/tag/v0.2.3
[0.2.2]: https://github.com/ahmedbakr/saywright/releases/tag/v0.2.2
[0.2.1]: https://github.com/ahmedbakr/saywright/releases/tag/v0.2.1
[0.2.0]: https://github.com/ahmedbakr/saywright/releases/tag/v0.2.0
[0.1.1]: https://github.com/ahmedbakr/saywright/releases/tag/v0.1.1
[0.1.0]: https://github.com/ahmedbakr/saywright/releases/tag/v0.1.0
