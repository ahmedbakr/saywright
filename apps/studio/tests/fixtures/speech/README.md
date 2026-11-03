# Speech recordings for tests

Synthesised with [Piper](https://github.com/rhasspy/piper) voices (via sherpa-onnx), 16 kHz mono:

| File | Words | Voice |
| --- | --- | --- |
| `make-this-bigger.wav`, `e2e-make-this-bigger.wav` | make this bigger | en_GB-alba-medium |
| `why.wav` | why is the total wrong | en_GB-alba-medium |
| `undo.wav` | undo | en_GB-alba-medium |
| `keep-it.wav` | keep it | en_GB-northern_english_male-medium |
| `expect.wav` | this should show eighty dollars eighty | en_GB-northern_english_male-medium |
| `e2e-undo.wav` | undo | en_GB-northern_english_male-medium |
| `silence.wav` | (one second of silence: the default fake microphone in E2E tests) | |

Real recordings of people reading, from Google's [FLEURS](https://huggingface.co/datasets/google/fleurs) test set ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)), normalised to 16-bit:

| File | Words | Speaker |
| --- | --- | --- |
| `ar-fleurs-train.wav` | لقد جلب لنا القطار والسيارة والعديد من أجهزة النقل الأخرى | ar_eg |
| `ar-fleurs-farewell.wav` | هذا لن يكون وداعاً هذا هو إغلاق فصل وبداية فصل جديد | ar_eg |
| `ar-fleurs-climate.wav` | في مناخ الشرق الأوسط الدافئ لم يكن للمنزل أهميّة كبيرة | ar_eg |
| `en-fleurs-smoke.wav` | television reports show white smoke coming from the plant | en_us |

The `e2e-` files start with 1.2 s of quiet and end with 2 s of it, so a test can press Space before the words begin.

Voice data: alba from the Edinburgh "Scottish English" corpus ([CC BY 4.0](https://datashare.ed.ac.uk/handle/10283/3270)); northern_english_male from [OpenSLR 83](http://www.openslr.org/83/) (CC BY-SA 4.0).
