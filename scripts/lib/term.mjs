// Tiny ANSI helpers. Respects NO_COLOR and non-TTY output.
const on = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open, close) => (s) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  amber: (s) => (on ? `\x1b[38;5;215m${s}\x1b[39m` : String(s)),
};
