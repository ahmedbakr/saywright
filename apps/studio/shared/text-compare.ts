/**
 * Comparing what was said with what was heard, in Arabic and English: the
 * normalisation used by speech accuracy checks and by command matching.
 */

/** Spelling differences that don't change what an Arabic word is. */
export function foldArabic(s: string): string {
  return s
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g, '') // diacritics (tashkeel)
    .replace(/ـ/g, '') // tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660));
}

/** Lower case, no punctuation, Arabic spelling folded, single spaces. */
export function normalizeSpeech(text: string): string {
  return foldArabic(text.normalize('NFKC'))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/'(?!\w)|(?<!\w)'/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function editDistance<T>(a: ArrayLike<T>, b: ArrayLike<T>): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** Word error rate (0..1+) of `heard` against `said`. */
export function wordErrorRate(said: string, heard: string): number {
  const a = normalizeSpeech(said).split(' ').filter(Boolean);
  const b = normalizeSpeech(heard).split(' ').filter(Boolean);
  return a.length ? editDistance(a, b) / a.length : b.length ? 1 : 0;
}

/** Character error rate, ignoring spaces: forgiving of words run together or split. */
export function charErrorRate(said: string, heard: string): number {
  const a = [...normalizeSpeech(said).replace(/ /g, '')];
  const b = [...normalizeSpeech(heard).replace(/ /g, '')];
  return a.length ? editDistance(a, b) / a.length : b.length ? 1 : 0;
}
