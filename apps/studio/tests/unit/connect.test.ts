import { describe, expect, it } from 'vitest';
import { addImport } from '../../cli/source';

const LINE = `import saywright from '@saywright/vite';`;

describe('connecting an app: adding the plugin import', () => {
  it('goes after the imports, so a /// <reference> directive stays first (it only works there)', () => {
    const src = `/// <reference types="vitest/config" />\nimport path from 'path'\nimport { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({ plugins: [react()] })\n`;
    const out = addImport(src, LINE);
    expect(out.startsWith('/// <reference types="vitest/config" />\n')).toBe(true);
    expect(out).toContain(`import react from '@vitejs/plugin-react'\n${LINE}\n`);
  });

  it('handles imports over several lines, and code with no imports', () => {
    const multi = `import {\n  defineConfig,\n  loadEnv,\n} from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default 1;\n`;
    expect(addImport(multi, LINE)).toContain(`import react from '@vitejs/plugin-react';\n${LINE}\nexport default 1;`);
    const none = `// Licence: MIT\n'use client';\nmodule.exports = {};\n`;
    expect(addImport(none, LINE)).toBe(`// Licence: MIT\n'use client';\n${LINE}\nmodule.exports = {};\n`);
  });

  it('ignores a dynamic import() in the code', () => {
    const src = `import a from 'a'\nconst x = 1\nimport('b').then(() => 0)\n`;
    expect(addImport(src, LINE)).toBe(`import a from 'a'\n${LINE}\nconst x = 1\nimport('b').then(() => 0)\n`);
  });
});
