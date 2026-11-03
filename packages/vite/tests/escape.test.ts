/**
 * Page text inside the code Saywright writes (locators, tests): whatever it
 * holds, it stays inside its string or comment, and a replay reads the same
 * text back.
 */
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { jsComment, jsString } from '../src/protocol';
import { parseLocator } from '../src/bridge/replay';

/** Text a page can hold: every kind of line break, quotes, backslashes, comment and template endings. */
const HOSTILE = [
  'plain',
  'Email\nrequire(`fs`)',
  'a\rprocess.exit(3)',
  'line\u2028separator',
  'para\u2029graph',
  "it's ' quoted",
  'back\\slash \\',
  'end */ comment',
  '${template} `tick`',
  'tab\there',
];

describe('a string in written code', () => {
  it('holds any text, on one line, and reads back the same', () => {
    for (const text of HOSTILE) {
      const code = jsString(text);
      expect(code).not.toMatch(/[\r\n\u2028\u2029]/);
      const ast = parse(`const x = ${code};`, { sourceType: 'module' });
      const decl = ast.program.body[0] as unknown as { declarations: { init: { value: string } }[] };
      expect(decl.declarations[0].init.value).toBe(text);
    }
  });

  it('in a locator, is what a replay looks for', () => {
    for (const text of HOSTILE) expect(parseLocator(`page.getByPlaceholder(${jsString(text)})`)?.[0].args[0]).toBe(text);
  });
});

describe('a comment in written code', () => {
  it('stays one line, so nothing in it becomes code', () => {
    for (const text of HOSTILE) {
      const ast = parse(`// ${jsComment(text)}\nconst after = 1;`, { sourceType: 'module' });
      expect(ast.program.body).toHaveLength(1);
    }
  });
});
