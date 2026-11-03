/** Small, careful edits to an app's own source files (used by `saywright connect`). */

/**
 * Add an import after the file's own imports: what must stay first (`/// <reference types>` directives,
 * 'use client', a licence comment) stays first. Without imports, after those.
 */
export function addImport(src: string, line: string): string {
  const imports = [...src.matchAll(/^import(?!\s*\()[\s\S]*?\bfrom\s*['"][^'"\n]+['"];?[ \t]*$|^import\s*['"][^'"\n]+['"];?[ \t]*$/gm)];
  if (imports.length) {
    const last = imports[imports.length - 1];
    const end = last.index + last[0].length;
    return `${src.slice(0, end)}\n${line}${src.slice(end)}`;
  }
  const lead = /^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/|['"]use [a-z ]+['"];?))*[ \t]*\n?/.exec(src)?.[0] ?? '';
  return `${src.slice(0, lead.length)}${line}\n${src.slice(lead.length)}`;
}
