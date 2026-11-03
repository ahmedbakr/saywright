# Using the studio

How to point, say what to change, and keep or undo the result; the three modes; writing a Playwright test by narrating a bug; the keyboard, voice and hand control. New to Saywright? [Getting started](getting-started.md) walks through all of it on the sample shop, with pictures. For linking apps see [Linking your apps](apps.md); for sessions, Autopilot and the Experts see the [documentation index](README.md).

- [The one idea](#the-one-idea)
- [Previews: keep or undo](#previews-keep-or-undo)
- [Modes: Edit, Use, Write test](#modes-edit-use-write-test)
- [Saying or typing what to change](#saying-or-typing-what-to-change)
- [Write test: narrate a bug, get a Playwright test](#write-test-narrate-a-bug-get-a-playwright-test)
- [The screen](#the-screen)
- [Keyboard](#keyboard)
- [Voice](#voice)
- [Hand control (Labs)](#hand-control-labs)
- [A five-minute tour of the sample shop](#a-five-minute-tour-of-the-sample-shop)

## The one idea

**“This” and “that” mean whatever you point at while you say them.** Select the **Apply** button, hold <kbd>Space</kbd>, say “make this bigger”, and let go. To refer to two things, point at the first while you say “this” and at the second while you say “that”, or select both (<kbd>Shift</kbd>+click): the first is “this”, the second “that”.

<img src="media/guide/this-that.png" alt="Two buttons selected: Apply is 1 (“this”), Pay is 2 (“that”)" width="880">

## Previews: keep or undo

Every change is a **preview**. It is already in your code and in your running app, and the **Changes** tab shows its diff. Then:

<img src="media/guide/preview.png" alt="A preview waiting: the Apply button made bigger, with Undo and Keep at the top" width="880">

- **Keep** it with <kbd>Enter</kbd> (or say “keep it”);
- **Undo** it with <kbd>Ctrl</kbd>+<kbd>Z</kbd>, <kbd>⌘</kbd>+<kbd>Z</kbd> on a Mac (or say “undo”).

Previews stack: “bigger”, then “and red”, then “keep it” keeps both; undo removes the newest first. If a file was edited elsewhere after the preview, undo refuses rather than lose that work. Previews survive a restart of the studio: they come back still waiting for keep or undo.

Nothing is committed unless you turn on **Settings → General → Commit when you keep a change** (in a git repository): each kept change then becomes a commit with what you said.

## Modes: Edit, Use, Write test

The switch in the middle of the top bar:

| Mode | Key | What a click does | Use it to |
| --- | --- | --- | --- |
| **Edit** | <kbd>E</kbd> | Hover highlights, click selects (click again to deselect), <kbd>Shift</kbd>+click adds to the selection, right-click opens actions | Point at things and change them |
| **Use** | <kbd>U</kbd> | Clicks go to your app as usual | Get to the right screen or state |
| **Write test** | <kbd>R</kbd> | Clicks go to your app, and each action becomes a test step | Narrate a bug and turn it into a Playwright test |

Don't confuse **Write test** with **Record session** (the button on the right of the top bar). Record session records you using the app and ends in a report of what went wrong: see [Sessions and reports](session-report.md). Write test ends in a Playwright test.

## Saying or typing what to change

Hold <kbd>Space</kbd> and talk, then let go; or tap <kbd>Space</kbd> to talk hands-free (it sends when you pause). Press <kbd>/</kbd> to type instead.

| Say or type | What happens |
| --- | --- |
| “make this bigger / smaller”, “more spacing”, “tighter” | Steps a design-system component's size or padding (a quick edit) |
| “make this red / ghost / primary / outline” | Sets a design-system variant (a quick edit; words map to values through [synonyms](apps.md#describe-your-design-system-saywrightconfigjson)) |
| “rename this to Place order” | Changes the text (a quick edit) |
| “make this look like that” | Copies the look of the second element |
| “move this above that”, “remove this” | Reorders or removes elements (quick edits) |
| “why is the total wrong?” | The AI answers, with `file:line` references you can click ([picture](media/guide/answer.png)) |
| anything else | The AI makes the change and shows it as a preview |
| “keep it”, “undo”, “cancel”, “clear” | Decide on the preview; stop; clear the selection |
| “the card”, “select the button inside”, “go up”, “go inside”, “next”, “previous” | Move the selection |
| “add this”, “this too”, “deselect” | Add what you point at to the selection; clear it |
| “click this”, “type SAVE20 and press enter”, “scroll down” | Drive the app |
| “this should show $80.80” (in Write test) | Adds a check to the test |
| “generate test”, “run test”, “fix it” | The bug-to-test flow below |
| “mark this” (while recording a session) | Marks the moment for the report |

**Quick edits** (size, variant, text, move, remove) are made on your computer in milliseconds, for free, with no AI. They work on React components. When a quick edit can't do something safely (a label built from code, the largest size already), the studio says why and offers **Ask the AI anyway** or the file to open. Everything else goes to the AI you chose in **Settings → AI** ([AI in Saywright](ai.md)).

Requests run one at a time: one you make while another is running waits its turn, and <kbd>Esc</kbd> stops the running one.

## Write test: narrate a bug, get a Playwright test

<img src="media/guide/write-test.png" alt="Write test: the recorded steps, a check, the generated Playwright test, and its failed run" width="880">

1. Switch to **Write test** (<kbd>R</kbd>) and use your app: each click, typing and <kbd>Enter</kbd> is recorded as a step in the **Test** tab.
2. Point at what is wrong and say what it should show: “this should show $80.80”. That becomes a check.
3. Say “generate test” (or **Generate test**): a Playwright spec is written to `tests/saywright/` in your app's folder.
4. Say “run test” (or **Run test**). It runs with your app's own Playwright (`@playwright/test` must be installed in the app). A test that fails proves it reproduces the bug.
5. Say “fix it”: the AI fixes the code and the studio runs the test again with the fix. When it passes, keep the fix.

The generated test opens your app's pages by path (`page.goto('/')`), so your Playwright config needs a `baseURL`. When the studio runs the test, it sets `SAYWRIGHT_TARGET_URL` to the app's address:

```ts
// playwright.config.ts
use: { baseURL: process.env.SAYWRIGHT_TARGET_URL ?? 'http://localhost:5173' },
```

If Playwright's browser isn't installed, the Test tab offers **Install test browser**.

## The screen

<img src="media/guide/overview.png" alt="The studio, numbered: 1 the app menu, 2 the modes, 3 Record session, 4 the AI chip, 5 the side panel, 6 your app, 7 the command bar" width="880">

1 the app menu, 2 the modes, 3 **Record session**, 4 the AI chip, 5 the side panel, 6 your app with what is selected, 7 the command bar.

**The top bar**, from left to right: the app menu (switch apps, **All apps**), reload the app, the mode switch, **Record session**, the viewport size (fit to window, desktop 1280, tablet 820, phone 390), the microphone, the **AI chip**, the command palette, help, settings and the side panel.

**The AI chip** always shows who answers and what today has cost: the model and “$0.42 today” with an API key, “no extra bill” on your plan, “free” for a model on your computer, or “No AI · quick edits are free”. It turns amber near your budget and red at it. Click it for **Settings → AI**, or for the usage once there is some.

**The side panel** (<kbd>\\</kbd> shows or hides it):

| Tab | What it has |
| --- | --- |
| **Changes** | Every preview and decision, with what you said and a word-level diff. Keep or undo any of them. |
| **Inspect** | The selected element: its component, file and line, props and source. Click a design-system value to preview it. |
| **Test** | Write test: the recorded steps and checks, the generated Playwright test and its result. |
| **Experts** | Page reviews for SEO, content, UI/UX and accessibility ([Experts](experts.md)). |
| **Sessions** | **Record a session**, [Autopilot](autopilot.md), and your sessions with their reports ([Sessions and reports](session-report.md)). |
| **Stats** (chart icon) | How you worked: voice or typed, hand or mouse, time to preview, how often you kept a change. **Export session (JSONL)** downloads it. |

**The command palette** (<kbd>Ctrl</kbd>+<kbd>K</kbd>, <kbd>⌘</kbd>+<kbd>K</kbd> on a Mac, [picture](media/guide/palette.png)) lists every action by name. <kbd>Enter</kbd> runs the highlighted one; to send what you typed as a request to the AI instead, choose its own row or press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (<kbd>⌘</kbd>+<kbd>Enter</kbd> on a Mac).

**Settings**: General (appearance, commit when you keep a change, sounds, the setup tour), Voice, AI, Usage and budget, Other AI apps ([MCP](mcp.md)), Google data ([Experts](experts.md#google-data)), Shortcuts, and Labs. Hand appears once hand control is on in Labs.

## Keyboard

<kbd>?</kbd> shows the phrases and the keys in the studio:

<img src="media/guide/shortcuts.png" alt="Phrases and shortcuts: what you can say, and the keyboard" width="880">

| Key | What it does |
| --- | --- |
| <kbd>Space</kbd> (hold) | Talk; let go to send. Tap it for hands-free (sends when you pause). |
| <kbd>Enter</kbd> | Keep the preview |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> (<kbd>⌘</kbd>+<kbd>Z</kbd>) | Undo the preview |
| <kbd>Esc</kbd> | Close what is on top; with nothing open, stop, then clear the selection |
| <kbd>/</kbd> | Type a request |
| <kbd>1</kbd> to <kbd>4</kbd> | Run a suggestion shown above the command bar |
| <kbd>↑</kbd> <kbd>↓</kbd> | Select what contains the selection, or what is inside it |
| <kbd>←</kbd> <kbd>→</kbd> | Select the previous or next one |
| <kbd>O</kbd> | Open the selected element's file at its line in your code editor ([which one](configuration.md#other-variables)) |
| <kbd>Shift</kbd>+click | Add to the selection, or take out |
| <kbd>Alt</kbd>+click (<kbd>⌥</kbd>+click) | Select the inner element instead of the component |
| <kbd>E</kbd> <kbd>U</kbd> <kbd>R</kbd> | Edit, Use, Write test |
| <kbd>M</kbd> | Mark this moment, while recording a session |
| <kbd>\\</kbd> | Show or hide the side panel |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> (<kbd>⌘</kbd>+<kbd>K</kbd>) | Command palette |
| <kbd>?</kbd> | Phrases and shortcuts |
| <kbd>C</kbd> | Hand control on or off (with hand control on in Labs) |

In your app's own tab, the **Record session** button has its own keys: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> starts and stops, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> marks a moment, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> hides the button (<kbd>Option</kbd> for <kbd>Alt</kbd> on a Mac).

## Voice

What you say is heard two ways at once, then checked against the recording:

- **your browser's recogniser** (Chrome, Edge or Safari; Chrome's runs on Google's servers) shows the words while you talk;
- **a speech model on your computer** listens to the same recording: [Moonshine](https://github.com/moonshine-ai/moonshine) for English (28 MB, from `saywright setup` or **Settings → Voice**). It keeps a first word the browser missed, and catches misheard studio words (“make this beggar” becomes “make this bigger”).

The studio keeps the moment before you press <kbd>Space</kbd> and listens a little after you let go, so your first and last words aren't cut off.

**Settings → Voice** has:

<img src="media/guide/settings-voice.png" alt="Settings → Voice" width="880">

- **Recognition**: *Auto* (both, recommended), *Browser* (the browser alone), or *On-device* (only the model on your computer: audio never leaves it).
- **Language**: pick the variant closest to how you speak (US, UK, India…, or an Arabic variant).
- **Speech models on this computer**: install or choose the models that transcribe session narration and Arabic commands ([measured accuracy](speech-accuracy.md)).
- **Test your microphone** and **Accuracy on your voice**: see what each recogniser heard, and how many words each gets right for your voice.
- **Check before sending**: what you said appears in the command bar first, to fix before you press <kbd>Enter</kbd>.
- **Microphone → Turn off now**: after you talk, the microphone stays open for two minutes so your next sentence isn't cut off; this closes it at once.

Tips: point first, then talk. Short, plain phrases work best. A headset helps in a noisy room. Press <kbd>/</kbd> to type a word that keeps being misheard, such as a product name.

### In Arabic

Choose an Arabic variant in **Settings → Voice → Language**. What you say is then also transcribed by the Arabic speech model on your computer (installed by `saywright setup`), and the studio uses the reading it understands. Commands work in Egyptian, Gulf, Levantine and Modern Standard phrasing, with English words mixed in:

| Say | What it does |
| --- | --- |
| كبّر هذا، خليه أكبر، صغّر هذا | Bigger, smaller |
| اجعله أحمر، خلي الزرار ده أزرق | A colour or variant |
| احذف هذا، انقل هذا فوق ذلك، حط ده تحت ده | Remove, reorder |
| اجعل هذا مثل ذلك | Make this look like that |
| زود المسافة بين الكروت | More spacing |
| احتفظ به، تمام كده / تراجع / إلغاء | Keep, undo, cancel |
| المفروض يكون ثمانين دولار وثمانين سنت | In Write test: a check that it shows $80.80 |
| اكتب اختبار لهذا، شغّل الاختبار، صلحه | The bug-to-test flow |
| انزل لتحت، اطلع لفوق، اختار الأب | Scroll, select the parent |

Anything else in Arabic goes to your AI as you said it.

## Hand control (Labs)

Hand control lets you point and pinch with your hand, tracked by your webcam, instead of the mouse. It is a Labs feature, off by default: turn it on in **Settings → Labs → Hand control** ([picture](media/guide/settings-labs.png)). A short setup then checks your camera and calibrates your reach. The camera images are processed in your browser by MediaPipe, Google's hand-tracking library, and never leave your computer; the studio blocks the usage logging MediaPipe has built in ([what leaves your computer](../SECURITY.md#what-leaves-your-computer)). `saywright setup --hand` downloads the hand model once; without it, the page loads it from Google.

| Gesture | What it does |
| --- | --- |
| Point | Moves the cursor with your index finger |
| Pinch | Edit mode: selects what is highlighted (pinch it again to deselect, pinch empty space to clear). Use and Write test: clicks. |
| Pinch and hold | Adds what is highlighted to the selection, or takes it out |
| Pinch and move | Scrolls the app like a touch screen |
| Peace sign | Starts talking; pause to send |
| Thumb up / thumb down (held) | Keep / undo the preview |
| Open palm (held) | Stop: cancel listening or a request, then clear the selection |
| Fist | Freezes the cursor while you move your hand back |

**Settings → Hand** (shown once hand control is on): camera, reach (**Calibrate reach**), which hand, steadiness, pinch sensitivity, aim assist, **Select by resting** (point at something for a second to select it), and which gestures are on. Sit about an arm's length from the camera, with light on your face and hand.

## A five-minute tour of the sample shop

Open the sample shop from **Your apps** (in a checkout: `npm run dev -- --sample`). It has a real bug: the coupon `SAVE20` should take 20% off the items only, but it also discounts shipping.

1. **Select and change.** In Edit mode, click the **Apply** button. Say or type “make this bigger”. Keep it with <kbd>Enter</kbd>.
2. **Point twice.** Select **Apply**, <kbd>Shift</kbd>+click **Pay**, and say “make this look like that”. Undo it with <kbd>Ctrl</kbd>+<kbd>Z</kbd>.
3. **Ask.** Say “why is the total wrong?” (needs an AI).
4. **Narrate the bug.** Press <kbd>R</kbd>. Type `SAVE20` in the coupon field and click **Apply**. Point at the total and say “this should show $80.80”. Say “generate test”, then “run test”: it fails, which proves it reproduces the bug. Say “fix it” (needs an AI): it fixes `src/lib/pricing.ts` and the test runs again. When it passes, keep the fix.
5. **Record a session.** Click **Record session**, use the checkout while saying what you notice, and click **Stop** for a report.
6. **Review it.** Open the **Experts** tab and click **Review this page**.

The same tour with a picture of every step, and what you should see at each: [Getting started](getting-started.md).

To put the sample shop back as it was: `npm run reset:sample` in a checkout. Installed from npm, the sample is a copy in `~/.saywright/sample-shop`: delete that folder and remove the app from the list to start again.
