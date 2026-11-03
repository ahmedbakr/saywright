# Saywright: brand guide

<p>
  <img src="brand/lockup-on-light.svg" alt="Saywright" height="48">
</p>

## The name

**Saywright**: one word, capital *S*. Not “SayWright”, “Say Wright” or “SAYWRIGHT” (all capitals only where code requires it, such as `SAYWRIGHT_HOME`). In file names, packages and identifiers it is `saywright`.

A *wright* is a maker: a playwright makes plays, a shipwright ships. A saywright makes software by saying what to change, pointing at it in the running app. The name also nods to Playwright, the testing library: Saywright turns what you do in your app into Playwright tests.

In the code the name lives in one place, `apps/studio/shared/brand.ts`.

## Positioning

**Point at your app. Say what to change.** — أشِر إلى تطبيقك وقل ما تريد تغييره.

Saywright is where you change a running web app by pointing and talking, with the AI you already have. Every change is a preview you keep or undo; nothing reaches your code without your keep.

- **For** product teams, designers, developers and testers, in English and Arabic.
- **Unlike** chat-based coding tools, you never describe *where*: you point. Unlike screen recorders, a test session ends in findings tied to your code, and a replay proves them fixed.
- **Promise**: your app, your AI, your code, on your computer. You decide what changes.

## The mark

<p>
  <img src="brand/mark.svg" alt="" height="64">&nbsp;&nbsp;<img src="brand/mark-light.svg" alt="" height="64">
</p>

An amber ring around a cyan core: **you around the AI**. The ring is your cursor, your hand, your selection; the core is the AI working inside what you chose. It is the product's whole idea in one shape: you lead, the AI fills in, and you stay around it.

- Files: [`mark.svg`](brand/mark.svg) (dark tile, the default), [`mark-light.svg`](brand/mark-light.svg) (light tile, for light pages), [`lockup-on-light.svg`](brand/lockup-on-light.svg) and [`lockup-on-dark.svg`](brand/lockup-on-dark.svg) (mark and name). In the product: `apps/studio/src/components/Logo.tsx` and `apps/studio/public/favicon.svg`.
- Keep clear space around the tile of at least a quarter of its width. Smallest size: 16 px (the favicon).
- Don't recolour the ring or the core, swap their colours, add gradients or shadows, rotate it, or set it on a busy photo. On a coloured background use the dark tile.

## Colour

The two brand colours carry meaning everywhere in the product, not just in the mark:

| Colour | Means | Dark theme | Light theme |
| --- | --- | --- | --- |
| **Amber** (human) | What you did or pointed at: the hand cursor, hover, selection, your words | `#FFB224` | `#F29A0B` (text `#B56C00`) |
| **Cyan** (AI) | What the AI did: previews, its answers, “Fix with …” | `#3CC8E8` | `#0C9EC2` (text `#087A97`) |
| Ink | The mark's tile, the darkest surface | `#0B0C10` | |
| Background, panel | Surfaces | `#09090B`, `#111216` | `#F4F4F5`, `#FFFFFF` |
| Text | Primary, secondary, muted | `#ECECEF`, `#A0A3AB`, `#6C7079` | `#15161A`, `#575B64`, `#8A8E97` |
| Status | Done, attention, problem | `#3DD68C`, `#FF8B3E`, `#FF6369` | `#18A058`, `#D4620A`, `#DD3F45` |

Never use amber for something the AI did, or cyan for something a person did. The tokens are in `apps/studio/src/styles/index.css`.

## Type

- **Geist** for everything you read; **Geist Mono** for code, file paths and `file:line` references. Both are open source (SIL Open Font License).
- The name is set in Geist Semibold with slightly tight letter-spacing, as in the top bar.
- Arabic uses the system's Arabic font (Noto Sans Arabic or Tahoma in exported reports), right to left, with no letter-spacing.

## Voice

Plain, specific and calm, like a good colleague sitting next to you.

- **Say what happens**, in the words people use: “Keep”, “Undo”, “Review this page”, “Fix with Claude”. Buttons are a verb and its object.
- **When something fails, say what to do next**, in one sentence: “Run `claude` once in a terminal and sign in.” Not “An error occurred.”
- **Short sentences, everyday words.** No hype, no exclamation marks, no “simply”. Numbers over adjectives (“about half a second”, not “blazing fast”).
- **Name the AI that is working** (“Fix with Claude”, “Ask Gemini”), so people always know who does what, and what it costs.
- **In Arabic**, Modern Standard Arabic on screens; commands understand Egyptian, Gulf and Modern Standard phrasing, with English words mixed in.

### Words we use

| Use | Not |
| --- | --- |
| app, your app, linked apps | project, target, workspace |
| preview, keep, undo | apply, commit, revert (except for git) |
| quick edit | local transform, codemod |
| test session, report, finding | recording, issue ticket |
| Replay & verify | regression run |
| Experts, review, check | audit tool, linter |
| your plan, API key, model on this computer | subscription token, BYOK, local LLM |
