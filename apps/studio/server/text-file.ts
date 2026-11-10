/**
 * A project file as text, without losing a byte of it.
 *
 * Most code is UTF-8, and read as that. A file that isn't (a legacy page in ISO-8859-1 or Windows-1252, Shift-JIS…)
 * is read as Latin-1, where every byte is one character and writing the characters back gives the same bytes: an
 * edit changes the bytes of what it replaces and leaves every other byte as it was. Such a file can only take
 * characters Latin-1 has; anything else is refused rather than written as something the file can't say. A binary
 * file (an image, a font, anything with a NUL byte) is no text at all: it is never read as text and never edited.
 *
 * Line ends: code is shown to a model with LF only, an edit is matched with line ends left aside, and what it adds is
 * written with the line ends the file has, so a CRLF file stays one.
 */
import { isUtf8 } from 'node:buffer';

export type TextEncoding = 'utf8' | 'latin1';

/** Files that are never text, whatever their bytes: pictures, fonts, archives, media, compiled code, documents. */
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|heic|psd|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|tar|jar|war|woff2?|ttf|otf|eot|mp[34]|m4[av]|mov|avi|mkv|webm|ogg|wav|flac|wasm|exe|dll|so|dylib|bin|class|pyc|o|a|node|sqlite3?|db|docx?|xlsx?|pptx?|onnx|lockb)$/i;

/** Why a file can't be read as text, in words for whoever asked for it. */
export class NotTextError extends Error {}

/** A character a file's encoding can't hold. */
export class EncodingError extends Error {
  constructor(
    public char: string,
    public encoding: TextEncoding,
  ) {
    super(`“${char}” (U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}) can’t be written in Latin-1`);
  }
}

export const isBinaryName = (name: string): boolean => BINARY_EXT.test(name);

/**
 * A file's bytes as text, and the encoding that gives the same bytes back. Throws NotTextError for a file that isn't
 * text (`name` is for the sentence).
 */
export function decodeText(bytes: Uint8Array, name: string): { text: string; encoding: TextEncoding } {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const utf16 = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
  if (utf16 && !isBinaryName(name)) throw new NotTextError(`${name} is saved as UTF-16, which can’t be read or changed here. Save it as UTF-8 first.`);
  if (isBinaryName(name) || buf.includes(0)) throw new NotTextError(`${name} is a binary file, not text: it can’t be read or changed here.`);
  return isUtf8(buf) ? { text: buf.toString('utf8'), encoding: 'utf8' } : { text: buf.toString('latin1'), encoding: 'latin1' };
}

/** Whether these bytes read as text at all (no sentence needed). */
export function isText(bytes: Uint8Array, name: string): boolean {
  try {
    decodeText(bytes, name);
    return true;
  } catch {
    return false;
  }
}

/** The first character of `text` that `encoding` can't hold, or null. */
export function unwritable(text: string, encoding: TextEncoding): string | null {
  if (encoding === 'utf8') return null;
  for (const ch of text) if (ch.codePointAt(0)! > 0xff) return ch;
  return null;
}

/** Text as the bytes of a file in `encoding`. Throws EncodingError for a character it can't hold. */
export function encodeText(text: string, encoding: TextEncoding): Buffer {
  const bad = unwritable(text, encoding);
  if (bad) throw new EncodingError(bad, encoding);
  return Buffer.from(text, encoding);
}

/** Text with every line end as LF: what a model is shown, and what its edits are matched against. */
export const toLf = (text: string): string => (text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text);

/** The line end a file uses: CRLF when most of its lines end with it. */
export function eolOf(text: string): '\r\n' | '\n' {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text[i - 1] === '\r') crlf++;
    else lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

/** Text written with one kind of line end. */
export const withEol = (text: string, eol: '\r\n' | '\n'): string => (eol === '\n' ? toLf(text) : toLf(text).replace(/\n/g, '\r\n'));

/**
 * A text as it reads with LF line ends, and where each of those characters sits in the text itself (a line end
 * written CRLF sits at its CR), so a match found in the one can be replaced in the other without touching any other
 * line's end.
 */
export function lfView(text: string): { lf: string; at: (i: number) => number } {
  if (!text.includes('\r\n')) return { lf: text, at: (i) => i };
  const lf = toLf(text);
  // The places where a CR was dropped, in the LF text: each later character sits one further on.
  const dropped: number[] = [];
  for (let i = text.indexOf('\r\n'), n = 0; i !== -1; i = text.indexOf('\r\n', i + 2), n++) dropped.push(i - n);
  return {
    lf,
    at: (i) => {
      // How many dropped CRs lie before character i (those at an index below i).
      let lo = 0;
      let hi = dropped.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (dropped[mid] < i) lo = mid + 1;
        else hi = mid;
      }
      return i + lo;
    },
  };
}
