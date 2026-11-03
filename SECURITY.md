# Security

Saywright runs on your computer, reads and changes your code, starts your apps' commands, and sends requests to the AI you choose. This page says what it protects against, what it leaves to you, and how to report a problem.

## Supported versions

| Version | Security fixes |
| --- | --- |
| 0.1.x (latest) | Yes |

Until 1.0, security fixes go into the latest release only. Update with `npx saywright@latest`, and `npm install -D @saywright/vite@latest` in your apps.

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private reporting: **Security → Report a vulnerability** on [this repository](https://github.com/ahmedbakr/saywright/security/advisories/new). Include the version, what is affected, how to reproduce it, and what an attacker could do with it.

We aim to answer within three working days, and to fix confirmed problems in the next release, crediting you unless you prefer otherwise.

## What Saywright is, for security purposes

- **A local studio.** A web server on your computer (port 7357) and a page in your browser. It reads and writes the code of the apps you link, runs their dev commands, and can clone a GitHub repository and install its dependencies.
- **A local proxy.** Sites linked by their address, and apps without the plugin, are shown through a proxy on `localhost` that adds the studio's script to their pages.
- **A Vite plugin** in your app's dev server (development only), and a script in your app's page while you develop.
- **An MCP server** at `/api/mcp`, for AI apps on your computer.
- **AI requests** to the providers you connect, or to models on your computer.

### What it defends against

1. **Web pages you visit**, on any site, reaching the studio, the proxy, the plugin or the MCP server on `localhost` (cross-site requests, DNS rebinding).
2. **Other pages on this computer**, such as the app you are testing or another app on `localhost`, reading the studio's data or tampering with your recordings.
3. **A linked repository** making the studio read or write files outside its folder, for example through symbolic links.
4. **Tampered downloads** of models and archives.

### What it leaves to you

- **Code you open runs as you.** Opening an app runs its dev command; installing its dependencies runs its install scripts. Only open code you trust. The studio says so before it opens a cloned repository, and when a folder's dependencies need installing.
- **Previews are real files.** A change, from a quick edit, your AI or an AI app over MCP, is written to your files at once, so your dev server runs it before you keep or undo it. Read what a change does, especially when the request or the code came from someone else (text in a page or a file can try to instruct an AI).
- **Programs running as you** can use the studio as you can: it has no login of its own.
- **The AI you choose** receives what is described in [What leaves your computer](#what-leaves-your-computer), under its provider's terms. A model on your computer keeps everything on it.
- **Pages shown through the proxy** lose their Content Security Policy and framing headers while they are in the studio (needed to show them and add the studio's script). Use test accounts and a development or staging back end, as with any testing tool.

## Protections in place

### Network

- **This computer only.** The studio and the proxy listen on `127.0.0.1` (the proxy also on `::1`). `npx saywright` and the proxy answer only requests addressed to `localhost`, `127.0.0.1` or `[::1]`, so a web page can't reach them by pointing its own domain at your computer (DNS rebinding). In a checkout, `npm run dev` serves the studio through Vite, which applies the same host check.
- **The API answers the studio's own page.** Requests from any other origin are refused. The only exceptions are the few routes an app's page uses to record a session, which accept pages on `localhost`.
- **Recordings take a key.** Each session gets a key, given to whoever started it. Another page on this computer can learn that a session is running, but can't follow it, stop it, or add events, screenshots or audio to it.
- **The live event stream** (previews with their code, your apps' dev server output) is sent to the studio's own page only.
- **Open in editor** (<kbd>O</kbd>) answers the studio's own page only, for a file inside the open app, and starts your editor without a shell (on Windows, an editor's `.cmd` file goes through cmd.exe with every argument escaped).
- **Other programs** (Claude Code, Codex, Gemini CLI, Playwright, `npx`) are started without a shell too. On Windows, an app npm installed is a `.cmd` file whose script Saywright runs with Node directly, so cmd.exe never reads its arguments; any other `.cmd` file goes through cmd.exe with every argument escaped.
- **The plugin can't be redirected.** The Vite plugin's endpoint that learns the studio's address refuses requests from web pages and accepts only addresses on this computer, so no site can send your app's recordings elsewhere.
- **The script in your app answers the studio only.** Any page on this computer could put your app in a frame; the script answers only the studio the plugin or the script tag names (or the default address), the origins you allow with `studioOrigins`, and another local page only once your app's dev server names it, or its own API shows it is a studio.
- **The proxy fetches the site it shows, and nothing else.** A request naming another host is refused, so a page can't use the proxy to reach other sites or addresses inside your network. Service workers are blocked while a site is shown, and each app's cookies are kept apart from other apps'.
- **The studio can't be framed.** Installed from npm, the studio's page tells browsers that no other site may show it in a frame.
- **Plain HTML folders** the studio serves itself are served on `127.0.0.1`, with the same host check, from inside the folder only (links are followed and checked), without dot files.

### Files

- **Inside the app's code only.** Every file the studio reads or writes as your code (previews, quick edits, the Inspector, the AI's tools and AI apps' tools over MCP), or opens in your editor, goes through one check: the path must stay inside the linked folder — or, for an app in a monorepo, inside the workspace that lists it (its sibling packages) — with every symbolic link followed, so a repository that ships a link to `~/.ssh` can't be used to read or write there. `.env` files, `node_modules`, `.git` and the build folders at the app's top (`dist`, `build`, `.next`…) are refused. File lists and code search skip links and dot folders.
- **Whole writes.** Files are written to a temporary file and renamed into place, so neither your dev server nor the studio ever reads half a file. Settings keep their last good copy.
- **Undo that doesn't lose work.** Undo refuses to restore a file that was changed after the preview.

### Downloads

- Every model the studio downloads is checked against a pinned SHA-256 sum before it is used: the on-device voice model, the hand model, the speech models and the voice-activity model narration uses.
- Speech models come over HTTPS from the [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) releases on GitHub. Before an archive is unpacked, every entry is checked: only plain files and folders that land inside the models folder; links, devices and paths that leave it are refused. Archives are unpacked without their stored ownership.

### Secrets

- API keys (`.env.local`), the MCP token (`mcp-token`) and a Google service account key are written readable by you alone (`0600`), from the first byte.
- The studio's API never returns a key: Settings shows a hint such as `sk-ant…cdef`. A key goes only to its own provider.
- **MCP** requests need the token: 48 random hexadecimal characters, compared in constant time. When the studio runs Claude Code, Codex or Gemini CLI for you, each run gets its own short-lived token that offers one tool, `propose_change`.
- **Your plans.** Saywright asks Claude Code, Codex and Gemini CLI whether they are signed in, and never reads their sign-in files. It runs them without your API key variables, so plan usage can't turn into an API bill.
- **Google data** is read with read-only access (Search Console and Analytics), and Saywright keeps only the service account's email and private key.

## What leaves your computer

Saywright itself sends no telemetry. Data leaves your computer only in these cases:

| When | What, and to whom |
| --- | --- |
| You ask the AI something (a change, a question, a fix) | Your words, what you pointed at (name, text, file and line), the code around it, your app's file names, and the files the AI reads, to the AI you chose. Details: [docs/ai.md](docs/ai.md#what-is-sent-and-where). |
| A session report, an expert opinion or Autopilot uses an AI | The session's evidence (steps, what the screen said with card numbers masked, errors, what was said, a few screenshots, code excerpts), the page summary, or a description of each page, to the AI you chose. |
| You talk, with **Recognition** on *Auto* or *Browser* | The audio goes to your browser's speech service (Chrome's is Google's). *On-device* keeps it on your computer. |
| You connect Google data | Requests for your page's public address to Google's APIs. |
| An expert review of a public page | The page, its `robots.txt` and its sitemap are fetched from your computer, as a browser would. |
| You link an address, or clone a repository | The proxy fetches that site; git or the GitHub CLI clones from GitHub. |
| You download extras | The npm registry (voice model), GitHub (speech models), Google's storage (hand model); hand control in an npm install also loads MediaPipe's runtime from jsDelivr. |

Hand control (Labs) processes camera images in your browser. MediaPipe, Google's hand-tracking library, has usage logging to Google built in (`odml.pa.googleapis.com`), with no option to turn it off: the studio blocks those requests while hand control runs.

Everything else stays on your computer: your sessions (recordings, audio, transcripts, screenshots, video), changes, reviews, usage log and settings, in the folders listed in [docs/configuration.md](docs/configuration.md#data-folders). Typed passwords and card numbers are never recorded.
