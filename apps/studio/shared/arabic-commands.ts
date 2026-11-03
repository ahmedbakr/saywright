/**
 * Spoken Arabic (Modern Standard, Egyptian, Levantine, Gulf) to the studio's
 * commands. The rest of the studio understands a small English vocabulary
 * instantly and offline ("undo", "make this bigger", "this should show $80.80");
 * this maps what people actually say in Arabic onto it. Anything else is sent
 * to the AI as said, in Arabic.
 *
 * Recognisers misspell Arabic in predictable ways (hamza, ta marbuta, a letter
 * dropped or doubled), so matching is on folded spelling and tolerates one
 * wrong letter in longer words.
 */
import { editDistance, foldArabic } from './text-compare.ts';

interface ArabicCommand {
  /** The studio command or request, in the studio's English vocabulary. */
  text: string;
  /** What kind of thing it is, for display. */
  kind: 'control' | 'edit' | 'check' | 'session';
}

/** Words that point: "this", "that", "here". Bound to what you point at while saying them. */
export const ARABIC_DEICTIC = /^(?:و)?(?:هذا|هذه|هذي|هاذا|هاذي|ده|دي|دا|ديه|دى|ذا|ذلك|ذاك|تلك|هذاك|هذيك|دول|دولا|هدول|هؤلاء|هيدا|هيدي|هاد|هادا|هادي|هنا|هناك|هون|هنيه|هنيك|هيك)$/;

function norm(text: string): string {
  return foldArabic(text.normalize('NFKC'))
    // Decimals written the Arabic way (٨٠٫٨٠) or with a comma (80,80) keep their point; thousands separators go.
    .replace(/(\d)\s?[٫,]\s?(\d)/g, '$1.$2')
    .replace(/(\d)٬(\d)/g, '$1$2')
    .replace(/[^\p{L}\p{N}\s$.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip the article and common attached prepositions: الأحمر → احمر, للأزرق → ازرق. */
function stem(word: string): string {
  return word.replace(/^(?:و|ف)?(?:بال|لل|ال|بل|كال)(?=..)/, '');
}

/** A word that is (nearly) one of these, allowing one wrong letter in words of five letters or more. */
function like(word: string, forms: string[]): boolean {
  const w = stem(word);
  return forms.some((f) => w === f || word === f || (f.length >= 5 && Math.abs(w.length - f.length) <= 1 && editDistance([...w], [...f]) <= 1));
}

function has(words: string[], forms: string[]): boolean {
  return words.some((w) => like(w, forms));
}

const COLORS: Record<string, string[]> = {
  // Recognisers writing formal Arabic add the accusative ending: احمرا.
  red: ['احمر', 'حمرا', 'حمراء', 'الحمر', 'احمرا'],
  green: ['اخضر', 'خضرا', 'خضراء', 'اخضرا'],
  blue: ['ازرق', 'زرقا', 'زرقاء', 'كحلي', 'ازرقا'],
  yellow: ['اصفر', 'صفرا', 'صفراء', 'اصفرا'],
  orange: ['برتقالي', 'برتقاني', 'اورنج'],
  purple: ['بنفسجي', 'موف', 'ليلكي'],
  pink: ['وردي', 'بمبي', 'زهري', 'بينك'],
  black: ['اسود', 'سودا', 'سوداء', 'اسودا'],
  white: ['ابيض', 'بيضا', 'بيضاء', 'ابيضا'],
  gray: ['رمادي', 'رصاصي', 'سكني'],
};

const BIGGER = ['كبر', 'كبره', 'كبرها', 'كبري', 'اكبر', 'كبير', 'كبيره', 'كبيرة', 'تكبير', 'وسع', 'وسعه', 'اوسع', 'طول', 'اطول', 'زود'];
const SMALLER = ['صغر', 'صغره', 'صغرها', 'صغري', 'اصغر', 'صغير', 'صغيره', 'تصغير', 'قلل', 'قصر', 'اقصر', 'ضيق', 'نقص'];
const SPACING = ['مسافه', 'مسافات', 'المسافه', 'فراغ', 'بادينج', 'هوامش', 'هامش', 'تباعد'];
// Commands said to a woman or to several people count too (غيري، اجعلوه).
const MAKE = ['خلي', 'خليه', 'خليها', 'خلّي', 'اجعل', 'اجعله', 'اجعلها', 'اجعلي', 'اجعلوه', 'خلو', 'خلوه', 'غير', 'غيره', 'غيرها', 'غيّر', 'غيري', 'غيروه', 'لون', 'لونه', 'لونها', 'حول', 'حوله', 'حولها', 'اعمل', 'اعمله', 'اعملها', 'خليلي', 'سوي', 'سويه', 'خلّيه'];
const REMOVE = ['احذف', 'احذفه', 'احذفها', 'احذفي', 'امسح', 'امسحه', 'امسحها', 'امسحي', 'شيل', 'شيله', 'شيلها', 'شيلي', 'اخفي', 'اخفيه', 'اخفيها', 'حذف', 'ازل', 'ازله', 'الغي ده'];
const MOVE = ['انقل', 'انقله', 'انقلها', 'حرك', 'حركه', 'حركها', 'حط', 'حطه', 'حطها', 'ضع', 'ضعه', 'نقل'];
const ABOVE = ['فوق', 'اعلي', 'قبل'];
const BELOW = ['تحت', 'اسفل', 'بعد'];

/** Whole-utterance commands. Checked first, on the folded text. */
const CONTROL: [RegExp, string][] = [
  [/^(?:تراجع|تراجع عن (?:ده|هذا|ذلك|التغيير)|ارجع|رجع|رجعها|رجعه|ارجعها|الغي التغيير|الغي التعديل|رجعه زي ما كان|ارجع زي ما كان|بلاش التغيير|بلاش ده|undo)$/, 'undo'],
  [/^(?:احتفظ(?: به| بها| بالتغيير)?|احفظ(?:ه|ها| التغيير)?|اعتمد(?:ه|ها)?|تمام|تمام كده|تمام كدا|ممتاز|حلو|حلو كده|كويس|موافق|خليه كده|خليها كده|ابقيه|ابقيها|keep it|keep)$/, 'keep it'],
  [/^(?:الغاء|الغ|الغي|إلغاء|بطل|وقف|توقف|خلاص|لا خلاص|اسكت|سيبك|cancel|stop)$/, 'cancel'],
  [/^(?:(?:ا?نزل|نزل|انزلي)(?: لتحت| تحت| شويه| لأسفل| للاسفل)?|سكرول (?:لتحت|تحت|داون)|scroll down)$/, 'scroll down'],
  [/^(?:(?:ا?طلع|اطلعي|اصعد)(?: لفوق| فوق| شويه| لأعلي| للاعلي)?|سكرول (?:لفوق|فوق|اب)|scroll up)$/, 'scroll up'],
  [/^(?:شغل|جرب|نفذ|اعمل رن ل|ران)(?: ال)?(?:اختبار|تيست|تست|test)$/, 'run the test'],
  [/^(?:اكتب|اعمل|انشئ|ولد|سوي|جهز)(?: لي)? (?:ال)?(?:اختبار|تيست|تست|test)(?: ل(?:ده|هذا|ها|ه))?$/, 'generate a test'],
  [/^(?:اصلح(?:ه|ها)?|صلح(?:ه|ها)?|صلح المشكله|اصلح المشكله|صلح الغلط|اصلح الخطا|fix it)$/, 'fix it'],
  [/^(?:اختار|حدد)(?: ال)?(?:اب|الاب|الحاويه|الكونتينر|اللي فوقه|العنصر الاكبر)$/, 'select parent'],
  [/^(?:(?:اختار|حدد|اختر) )?(?:اللي (?:جواه|جواها|جوه|جوا|داخله|داخلها|بداخله)|العنصر اللي (?:جواه|جوه|جوا|داخله)|الابن|ادخل(?: جواه| جوه| جوا| جواها)?)$/, 'select the child'],
  [/^(?:(?:اختار|حدد|اختر) )?(?:التالي|اللي بعده|اللي بعدها|اللي بعد كده|اللي بعد كدا|الجاي|اللي جنبه)$/, 'select next'],
  [/^(?:(?:اختار|حدد|اختر) )?(?:السابق|اللي قبله|اللي قبلها|اللي قبل كده|اللي قبل كدا)$/, 'select previous'],
  [/^(?:الغي التحديد|الغ التحديد|شيل التحديد|بلاش تحديد|امسح التحديد|الغاء التحديد|مش عايز اختار حاجه)$/, 'deselect'],
  [/^(?:و?(?:ده|دي|هذا|هذه|هذي|ذا|هاد|هيدا) (?:كمان|ايضا|برضه|برضو)|ضيف (?:ده|دي|هذا|هذه)|اضف (?:هذا|هذه|ده|دي)|وده|ودي|وهذا|وهذه)$/, 'add this'],
  [/^(?:امسح(?: الكل| كله)?|نظف|clear)$/, 'clear'],
  [/^(?:مساعده|ساعدني|help)$/, 'help'],
];

/** Short commands as recognisers tend to hear them: matched with one or two wrong letters. */
const CONTROL_WORDS: [string, string][] = [
  ['تراجع', 'undo'],
  ['ارجع', 'undo'],
  ['احتفظ به', 'keep it'],
  ['احتفظ', 'keep it'],
  ['احفظ', 'keep it'],
  ['اعتمد', 'keep it'],
  ['الغاء', 'cancel'],
  ['انزل لتحت', 'scroll down'],
  ['اطلع لفوق', 'scroll up'],
  ['اصلحه', 'fix it'],
  ['شغل الاختبار', 'run the test'],
];

/** Things on a page, as people name them: "اختار الزرار" → "select the button". */
const NOUNS: [string[], string][] = [
  [['زر', 'زرار', 'بوتون', 'بتن'], 'button'],
  [['كارت', 'كرت', 'بطاقه', 'كارد'], 'card'],
  [['صوره', 'صور', 'ايقونه', 'لوجو', 'شعار'], 'image'],
  [['عنوان', 'تايتل', 'هيدنج'], 'heading'],
  [['لينك', 'رابط'], 'link'],
  [['قائمه', 'قايمه', 'ليسته', 'لسته', 'منيو'], 'list'],
  [['خانه', 'حقل', 'مربع', 'انبوت'], 'field'],
  [['نص', 'كلام', 'سطر', 'جمله'], 'text'],
  [['فورم', 'نموذج', 'استماره'], 'form'],
  [['جدول'], 'table'],
  [['هيدر', 'راس الصفحه'], 'header'],
  [['فوتر', 'تذييل'], 'footer'],
  [['قسم', 'سكشن', 'جزء'], 'section'],
  [['سعر', 'السعر'], 'price'],
];

function selectNoun(t: string): string | null {
  const m = /^(?:اختار|اختر|حدد|اختاري|حددي) (.+?)(?: (اللي جواه|اللي جوه|جواه|جوه|اللي حواليه|اللي فوقه|حواليه))?$/.exec(t);
  if (!m) return null;
  const word = stem(m[1]);
  const noun = NOUNS.find(([forms]) => forms.some((f) => stem(f) === word || (f.length >= 4 && editDistance([...word], [...stem(f)]) <= 1)))?.[1];
  if (!noun) return null;
  const where = !m[2] ? '' : /جو/.test(m[2]) ? ' inside' : ' outside';
  return `select the ${noun}${where}`;
}

const SESSION: [RegExp, string][] = [
  [/^(?:علم|علّم|ضع علامه|حط علامه|حط عليها علامه|سجل(?: ملاحظه| ده| هنا)?|مارك|mark)(?: هنا| ده| هذا| اللحظه دي)?$/, 'mark'],
];

// ---- numbers, for "it should show 80.80" ----

const UNITS: Record<string, number> = {
  صفر: 0, واحد: 1, واحده: 1, اثنين: 2, اتنين: 2, اثنان: 2, ثلاثه: 3, تلاته: 3, ثلاث: 3, تلات: 3, اربعه: 4, اربع: 4, خمسه: 5, خمس: 5, سته: 6, ست: 6,
  سبعه: 7, سبع: 7, ثمانيه: 8, تمانيه: 8, ثماني: 8, ثمان: 8, تمن: 8, تسعه: 9, تسع: 9, عشره: 10, عشر: 10, حداشر: 11, احدعشر: 11, اتناشر: 12,
  عشرين: 20, عشرون: 20, ثلاثين: 30, تلاتين: 30, ثلاثون: 30, اربعين: 40, اربعون: 40, خمسين: 50, خمسون: 50, ستين: 60, ستون: 60, سبعين: 70, سبعون: 70,
  ثمانين: 80, تمانين: 80, ثمانون: 80, تسعين: 90, تسعون: 90, ميه: 100, مائه: 100, مية: 100, مئه: 100, ميتين: 200, مئتين: 200, الف: 1000,
};

/** "ثمانين دولار وثمانين سنت" → 80.8, "خمسه وسبعين" → 75, "80.80" → 80.8. */
export function arabicAmount(text: string): { value: number; currency: string | null } | null {
  const t = norm(text);
  const digits = /(\d+(?:[.,]\d+)?)\s*(دولار|\$|جنيه|ريال|درهم|يورو)?/.exec(t);
  if (digits) return { value: Number(digits[1].replace(',', '.')), currency: digits[2] ?? null };
  const words = t.split(' ');
  let whole = 0;
  let cents = 0;
  let current = 0;
  let found = false;
  let inCents = false;
  let currency: string | null = null;
  for (const raw of words) {
    const w = raw.replace(/^و(?=.)/, '');
    if (/^(دولار|دولارات|جنيه|جنيهات|ريال|درهم|يورو)$/.test(w)) {
      currency = w;
      whole += current;
      current = 0;
      inCents = true;
      continue;
    }
    if (/^(سنت|سنتات|قرش|قروش|هلله|فلس)$/.test(w)) {
      cents += current;
      current = 0;
      continue;
    }
    const n = UNITS[w];
    if (n === undefined) continue;
    found = true;
    if (n === 100 || n === 1000) current = (current || 1) * n;
    else current += n;
  }
  if (!found) return null;
  if (inCents) cents += current;
  else whole += current;
  return { value: whole + Math.min(99, cents) / 100, currency };
}

function money(v: number, currency: string | null): string {
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return currency && /دولار|\$/.test(currency) ? `$${s}` : currency ? s : `$${s}`;
}

/**
 * The studio command for something said in Arabic, or null to send it to
 * Claude as it is. Deictic words keep their place in the sentence, so what you
 * pointed at while saying "هذا" is still what the command acts on.
 */
export function arabicCommand(said: string): ArabicCommand | null {
  const t = norm(said);
  if (!t || !/[؀-ۿ]/.test(t)) return null;
  for (const [re, text] of CONTROL) if (re.test(t)) return { text, kind: 'control' };
  for (const [re, text] of SESSION) if (re.test(t)) return { text, kind: 'session' };
  const pick = selectNoun(t);
  if (pick) return { text: pick, kind: 'control' };
  const words = t.split(' ');
  if (words.length <= 2) {
    const compact = [...t.replace(/ /g, '')];
    for (const [phrase, text] of CONTROL_WORDS) {
      const target = [...phrase.replace(/ /g, '')];
      const allowed = target.length >= 7 ? 2 : target.length >= 4 ? 1 : 0;
      if (editDistance(compact, target) <= allowed) return { text, kind: 'control' };
    }
  }
  const pointing = words.some((w) => ARABIC_DEICTIC.test(w)) ? 'this' : 'it';

  // "It should be/show …": a check on what you point at.
  if (/(?:المفروض|المفروض انه|من المفروض|يفترض|لازم|يجب ان|ينبغي ان|المتوقع)\s/.test(t + ' ') || /^(?:يكون|تكون|يبقي|تبقي)\s/.test(t)) {
    const amount = arabicAmount(t);
    if (amount) return { text: `${pointing} should show ${money(amount.value, amount.currency)}`, kind: 'check' };
  }

  const color = Object.entries(COLORS).find(([, forms]) => has(words, forms))?.[0];
  const spacing = has(words, SPACING);
  const bigger = has(words, BIGGER);
  const smaller = has(words, SMALLER);
  if (color && (has(words, MAKE) || words.length <= 3)) return { text: `make ${pointing} ${color}`, kind: 'edit' };
  if (spacing && (bigger || smaller || has(words, ['زود', 'زوّد', 'قلل', 'كتر', 'اكتر', 'اقل']))) {
    const more = bigger || has(words, ['زود', 'زوّد', 'كتر', 'اكتر']);
    return { text: `${more ? 'more' : 'less'} space between these`, kind: 'edit' };
  }
  if (bigger && !smaller) return { text: `make ${pointing} bigger`, kind: 'edit' };
  if (smaller && !bigger) return { text: `make ${pointing} smaller`, kind: 'edit' };
  if (has(words, REMOVE)) return { text: `remove ${pointing}`, kind: 'edit' };
  if (has(words, MOVE) && (has(words, ABOVE) || has(words, BELOW))) {
    return { text: `move this ${has(words, ABOVE) ? 'above' : 'below'} that`, kind: 'edit' };
  }
  if (/(?:اجعل|خلي|خليه|خليها|اعمل)\s+(?:\S+\s+)?(?:زي|مثل|شبه|نفس شكل)\s/.test(t + ' ')) return { text: 'make this look like that', kind: 'edit' };
  return null;
}
