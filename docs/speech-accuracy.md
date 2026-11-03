# How accurately Saywright hears Arabic and English

Everything here was measured, not estimated: the studio's own speech engine, run the way the studio runs it, on recordings of real people. You can repeat it on your computer with one command (see [Measure it yourself](#measure-it-yourself)).

## In short

| You speak | Model Saywright uses | Words it gets wrong | Characters it gets wrong | Sentences exactly right |
| --- | --- | --- | --- | --- |
| Arabic | **Cohere Transcribe** (1.6 GB download, optional) | **9.1%** | **4.7%** | 36% |
| Arabic | Omnilingual 300M (279 MB download, installed by setup) | 15.8% | 4.8% | 13% |
| English | **Parakeet TDT 0.6B** (460 MB download, installed by setup) | **6.2%** | **3.3%** | 33% |

Real read speech (FLEURS), whole sentences. "Words wrong" counts every substituted, missing or extra word, so one misspelled word in a ten-word sentence is 10%. In Arabic most of Omnilingual's word errors are a letter or two off (its character error rate is as low as Cohere's), which is why it still reads well; Cohere gets far more words exactly right.

For narration during a test session, speech is cut into sentences at your pauses, which costs a little accuracy:

| Narration (split at pauses) | Words wrong | Characters wrong |
| --- | --- | --- |
| Arabic, Cohere | 10.2% | 5.5% |
| Arabic, Omnilingual | 18.5% | 5.7% |

**Which to install.** `npx saywright setup` (`npm run setup` in a checkout) installs Omnilingual (Arabic, English and mixed sentences) and Parakeet (English) and asks whether to add Cohere for Arabic (`--best-arabic` adds it without asking). If you narrate or speak in Arabic, say yes: it gets 40% fewer words wrong. You can also add it later in **Settings → Voice**, which shows these numbers next to each model.

**When you speak both.** In a session set to *Arabic + English*, each sentence is first transcribed by Omnilingual, which hears both and handles sentences that mix them. When a sentence is clearly one language, it is transcribed again by the best installed model for that language.

## How it was measured

- **Recordings**: [FLEURS](https://huggingface.co/datasets/google/fleurs) (Google, CC BY 4.0), people reading Wikipedia sentences aloud, 4 to 24 seconds each (10 s typical). Arabic: the Egyptian Arabic (`ar_eg`) test set, 120 sentences spread evenly over it (every 3rd or 4th). English: the US English (`en_us`) test set, 100 sentences. A few comparison models were measured on 40.
- **Scoring**: what the model wrote against what was read, after the same normalisation the studio uses everywhere (`apps/studio/shared/text-compare.ts`): Arabic letter forms folded (أ إ آ → ا, ة → ه, ى → ي), diacritics, tatweel and punctuation removed, digits unified. Word and character errors are counted over all sentences together (edit distance), not averaged per sentence.
- **Whole sentence** is how spoken commands are transcribed (push-to-talk). **Split at pauses** is how narration is: the audio arrives from the microphone in 100 ms pieces, the voice detector (Silero) cuts it at pauses, and each piece is transcribed.
- **Machine**: a 4-core cloud container, 4 threads, CPU only. Times are per sentence. A recent laptop (Apple Silicon) is faster.

## All results

### Arabic (FLEURS `ar_eg`, real read speech)

| Model | On disk | Words wrong | Characters wrong | Exactly right | Time per sentence |
| --- | --- | --- | --- | --- | --- |
| Cohere Transcribe 2B (as Saywright runs it) | 2.9 GB | **9.1%** | **4.7%** | 35.8% | 3.3–4.6 s |
| Whisper large-v3 turbo *(40 sentences)* | 1.0 GB | 13.1% | 4.9% | 22.5% | 5.5 s |
| Omnilingual ASR 300M | 365 MB | 15.8% | 4.8% | 13.3% | 1.4 s |
| Qwen3-ASR 0.6B | 1.0 GB | 27.0% | 10.3% | 1.7% | 4.4 s |
| Whisper small *(40 sentences)* | 375 MB | 28.9% | 10.1% | 2.5% | 8.0 s |
| Dolphin base | 104 MB | 39.7% | 14.2% | 0% | 0.2 s |
| Moonshine base (Arabic), split at pauses | 141 MB | 33.0% | 24.7% | 13.3% | 1.3 s |

Split at pauses (narration):

| Model | Words wrong | Characters wrong | Exactly right |
| --- | --- | --- | --- |
| Cohere Transcribe 2B | 10.2% | 5.5% | 36.7% |
| Omnilingual ASR 300M | 18.5% | 5.7% | 9.2% |

### English (FLEURS `en_us`, real read speech)

| Model | On disk | Words wrong | Characters wrong | Exactly right | Time per sentence |
| --- | --- | --- | --- | --- | --- |
| Cohere Transcribe 2B *(40 sentences)* | 2.9 GB | 6.0% | 3.0% | 30.0% | 3.4 s |
| Parakeet TDT 0.6B v2 | 661 MB | 6.2% | 3.3% | 33.0% | 0.9 s |
| Qwen3-ASR 0.6B *(40 sentences)* | 1.0 GB | 6.4% | 3.2% | 32.5% | 3.6 s |
| Omnilingual ASR 300M | 365 MB | 20.5% | 8.1% | 9.0% | 1.3 s |
| Moonshine base, split at pauses | 141 MB | 29.3% | 22.5% | 10.0% | 0.5 s |
| Moonshine tiny, split at pauses | 44 MB | 37.3% | 34.5% | 9.0% | 0.3 s |

Parakeet is as accurate as the largest models and three to four times faster, so it is the English default.

### Spoken commands (synthetic voices)

Short commands ("كبّر هذا", "make this bigger", "undo") and narration sentences, read by text-to-speech voices, clean and with background noise. Synthetic Arabic voices are harder to hear than real people (Jordanian voice reading Egyptian and Gulf phrasing, English words inside Arabic sentences), so these numbers are lower than on real speech; they are for comparing models and catching regressions.

| Arabic (196 commands and sentences) | Words wrong | Commands understood | Wrong action | Time |
| --- | --- | --- | --- | --- |
| Cohere Transcribe 2B (as Saywright runs it) | 28.7% | **67%** (51 of 76) | 0 | 1.5 s |
| Cohere Transcribe 2B, without the trailing silence | 33.2% | 63% | 0 | 1.1 s |
| Omnilingual ASR 300M | 50.7% | 38% | 1 | 0.35 s |
| Qwen3-ASR 0.6B | 44.0% | 33% | 1 | 1.1 s |

*Commands understood*: the transcript, passed through the studio's Arabic command parser, gives the same action as what was said (76 of the items are commands the parser knows; the others are questions and requests for Claude). *Wrong action*: it gave a different one. Narration sentences in this set: Cohere 14.4% words wrong (47% exactly right), Omnilingual 39.7%.

In the studio a spoken command is also heard by Chrome's Arabic recogniser at the same time, and whichever transcript the parser understands is used, so commands are recognised more often than with one model alone (Chrome's recogniser can't be run in these tests).

| English (651 commands and sentences) | Words wrong | Exactly right | Time |
| --- | --- | --- | --- |
| Parakeet TDT 0.6B v2 | 11.2% | 79.1% | 0.31 s |
| Moonshine tiny (in the browser) | 18.8% | 69.0% | 0.08 s |
| Moonshine base | 24.5% | 66.2% | 0.12 s |
| Omnilingual ASR 300M | 36.8% | 33.3% | 0.37 s |

On top of the recogniser, the studio corrects its own vocabulary: Arabic command phrasing (`apps/studio/shared/arabic-commands.ts`, 51 tests) and misheard studio words in English ("make this beggar" → "make this bigger").

## Two problems these measurements found, and fixed

1. **Cohere cut the last word of Arabic sentences.** "أهمية كبيرة" came back as "أهمية كب", "النقل الأخرى" as "النقل الأ". It needs about a second of silence after the speech; with it, Arabic word errors went from 11.8% to 9.1% and character errors from 7.4% to 4.7%. The other models don't need it (Omnilingual: 15.8% → 16.4%, Parakeet: 6.2% → 6.3%), so the extra silence is set per model (`tail` in `apps/studio/server/speech/catalog.ts`).
2. **Narration lost soft sentence endings.** The voice detector trims a sentence to where it hears speech, which can cut a quiet last syllable (the "ة" at the end of a word). Each sentence is now transcribed with the real audio just around it (0.2 s before, 0.4 s after). Arabic narration with Cohere went from 15.9% to 10.2% words wrong, with Omnilingual from 19.9% to 18.5%.

Both are covered by `apps/studio/tests/speech/speech-server.test.ts`, which runs the engine on real FLEURS recordings in Arabic and English (`npm run test:speech`, part of `npm run check`; skipped when the models aren't installed).

## Limits

- FLEURS is read speech in Modern Standard Arabic with an Egyptian accent. Spontaneous dialect speech (Egyptian, Gulf, Levantine conversation) will be less accurate, especially with technical English words in it. The command set above covers some of that.
- A headset or a good external microphone in a quiet room makes a large difference. Use **Settings → Voice → Accuracy on your voice** to measure with your own voice: you read six sentences and it shows how many words each recogniser got right.
- Times are on a cloud CPU. The first sentence after starting waits for the model to load (1 to 10 s, depending on the model).

## Measure it yourself

In a checkout of this repository ([CONTRIBUTING.md](../CONTRIBUTING.md)), with the speech models installed:

```bash
npm run eval:speech -- --fetch                     # downloads the FLEURS test sets (about 700 MB, once), then runs
npm run eval:speech -- --lang ar --model cohere-transcribe --limit 40
```

It runs every installed model on both languages, whole and split at pauses, prints the error rates and timing, and writes every sentence with what was heard to `.saywright/speech-eval/`. The suite is `apps/studio/tests/eval/speech.eval.ts`.
