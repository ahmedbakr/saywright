/**
 * `connect` edits an app's own files: the Vite config's plugins, a Next.js layout's `<body>` or `<Head>`, a page's
 * head. Where to edit is found with the parser, so a list, a tag or a word that only looks right is left alone, and
 * whatever can't be done safely leaves the file as it is.
 */
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { addJsxScript, addPageScript, addVitePlugin } from '../../cli/source';
import { loadsPlugin } from '../../server/apps/vite-config';

const IMPORT = `import saywright from '@saywright/vite';`;
const TAG = `{process.env.NODE_ENV === 'development' && <script src="http://localhost:7357/saywright.js" defer />}`;

/** The config with the plugin added: an edit is expected. */
function added(src: string, file = 'vite.config.ts'): string {
  const r = addVitePlugin(src, file);
  if (r.kind !== 'edit') throw new Error(`no edit: ${JSON.stringify(r)}`);
  expect(loadsPlugin(r.code, file)).toBe(true);
  return r.code;
}

describe('the plugin goes into the config’s own plugins, never into a list that only looks like them', () => {
  it('not into a PostCSS list written above them', () => {
    const src = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport autoprefixer from 'autoprefixer';\n\nexport default defineConfig({\n  css: { postcss: { plugins: [autoprefixer()] } },\n  plugins: [react()],\n});\n`;
    const code = added(src);
    expect(code).toContain('css: { postcss: { plugins: [autoprefixer()] } },');
    expect(code).toContain('  plugins: [saywright(), react()],');
    expect(code).toContain(`import autoprefixer from 'autoprefixer';\n${IMPORT}\n`);
  });

  it('not into a Rollup list', () => {
    const src = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport { visualizer } from 'rollup-plugin-visualizer';\n\nexport default defineConfig({\n  build: {\n    rollupOptions: {\n      plugins: [visualizer()],\n    },\n  },\n  plugins: [react({ babel: { plugins: [['babel-plugin-react-compiler', {}]] } })],\n});\n`;
    const code = added(src);
    expect(code).toContain('      plugins: [visualizer()],');
    expect(code).toContain(`  plugins: [saywright(), react({ babel: { plugins: [['babel-plugin-react-compiler', {}]] } })],`);
  });

  it('not into a comment or a string', () => {
    const comment = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\n// Was: plugins: [react(), legacy()] until we dropped IE.\nexport default defineConfig({\n  plugins: [react()],\n});\n`;
    let code = added(comment);
    expect(code).toContain('// Was: plugins: [react(), legacy()] until we dropped IE.');
    expect(code).toContain('  plugins: [saywright(), react()],');
    const string = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nconst note = 'see plugins: [ in docs';\nexport default defineConfig({\n  define: { __NOTE__: JSON.stringify(note) },\n  plugins: [react()],\n});\n`;
    code = added(string);
    expect(code).toContain(`const note = 'see plugins: [ in docs';`);
    expect(code).toContain('  plugins: [saywright(), react()],');
  });

  it('a mention of the package in a comment isn’t the plugin', () => {
    const src = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\n// TODO: try @saywright/vite one day\nexport default defineConfig({\n  plugins: [react()],\n});\n`;
    expect(loadsPlugin(src, 'vite.config.ts')).toBe(false);
    expect(added(src)).toContain('plugins: [saywright(), react()]');
  });

  it('repairs what an earlier version left: the import, and the call in another list', () => {
    const postcss = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport autoprefixer from 'autoprefixer';\nimport saywright from '@saywright/vite';\n\nexport default defineConfig({\n  css: {\n    postcss: {\n      plugins: [saywright(), autoprefixer()],\n    },\n  },\n  plugins: [react()],\n});\n`;
    expect(loadsPlugin(postcss, 'vite.config.ts')).toBe(false);
    const r = addVitePlugin(postcss, 'vite.config.ts');
    expect(r).toMatchObject({ kind: 'edit', repaired: true });
    const code = (r as { code: string }).code;
    expect(code).toContain('      plugins: [autoprefixer()],');
    expect(code).toContain('  plugins: [saywright(), react()],');
    expect(code.match(/@saywright\/vite/g)).toHaveLength(1);
    // A call in a comment goes out of it, an import with no call gets its call.
    const commented = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport saywright from '@saywright/vite';\n\n// Was: plugins: [saywright(), react(), legacy()] until we dropped IE.\nexport default defineConfig({\n  plugins: [react()],\n});\n`;
    const fixed = added(commented);
    expect(fixed).toContain('// Was: plugins: [react(), legacy()] until we dropped IE.');
    expect(fixed).toContain('  plugins: [saywright(), react()],');
    // Then a second run has nothing to do.
    expect(addVitePlugin(fixed, 'vite.config.ts')).toEqual({ kind: 'present' });
  });

  it('leaves a CommonJS config as it is, and says the plugin needs an ES module config', () => {
    const cjs = `const { defineConfig } = require('vite');\nconst react = require('@vitejs/plugin-react');\n\nmodule.exports = defineConfig({\n  plugins: [react()],\n});\n`;
    expect(addVitePlugin(cjs, 'vite.config.cjs')).toMatchObject({ kind: 'manual', commonjs: true });
    expect(addVitePlugin(cjs, 'vite.config.js')).toMatchObject({ kind: 'manual', commonjs: true });
  });

  it('keeps Windows line endings', () => {
    const src = `import { defineConfig } from 'vite';\r\nimport react from '@vitejs/plugin-react';\r\n\r\nexport default defineConfig({\r\n  plugins: [\r\n    react(),\r\n  ],\r\n});\r\n`;
    const code = added(src);
    expect(code).toBe(`import { defineConfig } from 'vite';\r\nimport react from '@vitejs/plugin-react';\r\n${IMPORT}\r\n\r\nexport default defineConfig({\r\n  plugins: [\r\n    saywright(),\r\n    react(),\r\n  ],\r\n});\r\n`);
  });

  it('stops with the reason where the plugins aren’t a list it can follow', () => {
    const variable = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nconst plugins = [react()];\n\nexport default defineConfig({ plugins });\n`;
    expect(addVitePlugin(variable, 'vite.config.ts').kind).toBe('manual');
    const condition = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig(({ command }) => ({\n  plugins: command === 'serve' ? [react()] : [react()],\n}));\n`;
    expect(addVitePlugin(condition, 'vite.config.ts').kind).toBe('manual');
    expect(addVitePlugin(`export default defineConfig({ plugins: [react( })`, 'vite.config.ts').kind).toBe('manual');
  });
});

describe('the configs connect has always handled', () => {
  it('a function form, a .mjs file in double quotes with no semicolons, a spread, tabs, an empty list, an async function', () => {
    const fn = `import { defineConfig, loadEnv } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig(({ mode }) => {\n  const env = loadEnv(mode, process.cwd(), '');\n  return {\n    plugins: [\n      react(),\n    ],\n    server: { port: Number(env.PORT) || 5173 },\n  };\n});\n`;
    expect(added(fn, 'vite.config.js')).toContain('    plugins: [\n      saywright(),\n      react(),\n    ],');
    const mjs = `import { defineConfig } from "vite"\nimport react from "@vitejs/plugin-react"\n\nexport default defineConfig({\n  plugins: [\n    react(),\n  ],\n})\n`;
    expect(added(mjs, 'vite.config.mjs')).toContain(`import react from "@vitejs/plugin-react"\nimport saywright from "@saywright/vite"\n`);
    const spread = `import { defineConfig, type PluginOption } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nconst base: PluginOption[] = [react()];\n\nexport default defineConfig({\n  plugins: [...base],\n});\n`;
    expect(added(spread)).toContain('plugins: [saywright(), ...base]');
    const tabs = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n\tplugins: [ // keep react first\n\t\treact(),\n\t],\n});\n`;
    expect(added(tabs)).toContain('\tplugins: [ // keep react first\n\t\tsaywright(),\n\t\treact(),\n\t],');
    expect(added(`import { defineConfig } from 'vite';\n\nexport default defineConfig({\n  plugins: [],\n});\n`)).toContain('plugins: [saywright()]');
    const asyncFn = `import react from '@vitejs/plugin-react';\nimport {\n  defineConfig,\n  loadEnv,\n} from 'vite';\n\nexport default defineConfig(async () => {\n  const { default: extra } = await import('./extra.js');\n  return { plugins: [react(), extra()] };\n});\n`;
    expect(added(asyncFn)).toContain(`} from 'vite';\n${IMPORT}\n`);
    // A worker's plugins aren't the app's.
    const worker = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  worker: { plugins: () => [react()] },\n  plugins: [react()],\n});\n`;
    expect(added(worker)).toContain('worker: { plugins: () => [react()] },\n  plugins: [saywright(), react()],');
    // A config with no plugins at all gets them.
    expect(added(`export default { server: { port: 3000 } };\n`, 'vite.config.js')).toContain('plugins: [saywright()]');
  });
});

describe('the script tag in a Next.js file goes where the parser finds the element', () => {
  const jsx = (code: string) => parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] });

  it('after a <body> whose attributes hold an arrow function', () => {
    const src = `import { fonts } from './fonts';\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body className={fonts.map((f) => f.variable).join(' ')}>\n        {children}\n      </body>\n    </html>\n  );\n}\n`;
    const r = addJsxScript(src, 'body', TAG);
    expect('code' in r).toBe(true);
    const code = (r as { code: string }).code;
    expect(() => jsx(code)).not.toThrow();
    expect(code).toContain(`      <body className={fonts.map((f) => f.variable).join(' ')}>\n        ${TAG}\n        {children}\n`);
  });

  it('in a Head imported under another name, and nothing claimed where there is none', () => {
    const src = `import Document, { Html, Head as NextHead, Main, NextScript } from 'next/document';\n\nexport default class MyDocument extends Document {\n  render() {\n    return (\n      <Html>\n        <NextHead />\n        <body>\n          <Main />\n          <NextScript />\n        </body>\n      </Html>\n    );\n  }\n}\n`;
    const r = addJsxScript(src, 'head', TAG);
    const code = (r as { code: string }).code;
    expect(() => jsx(code)).not.toThrow();
    expect(code).toContain(`        <NextHead>\n          ${TAG}\n        </NextHead>\n`);
    expect(addJsxScript(`export default function Doc() { return <html><body /></html>; }\n`, 'head', TAG)).toHaveProperty('refused');
  });
});

describe('the script tag in a page', () => {
  it('goes first in the head, in the page’s line endings, and not into a head in a comment', () => {
    const lines = ['<!-- Saywright (development): remove before you deploy -->', '<script src="http://localhost:7357/saywright.js"></script>'];
    const page = `<!doctype html>\r\n<!-- <head> was here -->\r\n<html>\r\n  <head>\r\n    <title>App</title>\r\n  </head>\r\n</html>\r\n`;
    const r = addPageScript(page, lines) as { code: string };
    expect(r.code).toBe(`<!doctype html>\r\n<!-- <head> was here -->\r\n<html>\r\n  <head>\r\n    ${lines[0]}\r\n    ${lines[1]}\r\n    <title>App</title>\r\n  </head>\r\n</html>\r\n`);
  });
});
