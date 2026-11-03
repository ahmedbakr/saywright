/** Terminal colours: off for NO_COLOR, and when the output isn't a terminal. */
const on = !!process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open: string, close: string) => (s: unknown) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  cyan: wrap('36', '39'),
  amber: wrap('38;5;215', '39'),
};

export const ok = (msg: string) => console.log(`${c.green('✓')} ${msg}`);
export const warn = (msg: string, fix?: string) => console.log(`${c.yellow('!')} ${msg}${fix ? `\n  ${c.dim(fix)}` : ''}`);
export const fail = (msg: string, fix?: string) => console.error(`${c.red('✗')} ${msg}${fix ? `\n  ${c.dim(fix)}` : ''}`);
