import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findWritten, locateElement, projectFiles, type Findable } from '../../server/locate';
import { Project } from '../../server/project';

function site(files: Record<string, string>): Project {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-locate-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return new Project(dir, 'http://localhost:5300', undefined, true);
}

const find = (p: Project, el: Findable, pageUrl?: string) => locateElement(projectFiles(p), el, { pageUrl, root: p.root });

const INDEX = `<!doctype html>
<html>
  <body>
    <h1>Your notes</h1>
    <section class="notes">
      <button id="add" class="primary big" data-testid="add-note">Add a note</button>
      <a href="about.html">About</a>
      <p class="hint">Notes stay on this computer &amp; nowhere else.</p>
    </section>
  </body>
</html>
`;

describe('locateElement: finding an element in code the page did not name', () => {
  it('goes by id or test id first, at the start of its tag', async () => {
    const p = site({ 'index.html': INDEX, 'about.html': '<h1>About</h1>' });
    expect(await find(p, { tag: 'button', text: 'Add a note', hint: { attrs: { id: 'add' } } })).toBe('index.html:6:7');
    expect(await find(p, { tag: 'button', text: 'Add a note', hint: { attrs: { 'data-testid': 'add-note' } } })).toBe('index.html:6:7');
  });

  it('then by a link or its text, entities and all', async () => {
    const p = site({ 'index.html': INDEX });
    expect(await find(p, { tag: 'a', text: 'About', hint: { attrs: { href: 'about.html' } } })).toBe('index.html:7:7');
    expect(await find(p, { tag: 'p', text: 'Notes stay on this computer & nowhere else.', hint: { attrs: {} } })).toBe('index.html:8:7');
  });

  it("prefers the page's own file when the same text is in several", async () => {
    const p = site({
      'index.html': '<main>\n  <button>Save</button>\n</main>\n',
      'settings/index.html': '<main>\n\n  <button>Save</button>\n</main>\n',
    });
    expect(await find(p, { tag: 'button', text: 'Save', hint: { attrs: {} } }, 'http://localhost:5281/settings/')).toBe('settings/index.html:3:3');
    expect(await find(p, { tag: 'button', text: 'Save', hint: { attrs: {} } }, 'http://localhost:5281/')).toBe('index.html:2:3');
  });

  it("searches the component file a framework named first (Vue's __file, absolute)", async () => {
    const p = site({
      'src/components/Cart.vue': '<template>\n  <div>\n    <button class="pay">Pay</button>\n  </div>\n</template>\n',
      'src/components/Other.vue': '<template>\n  <button class="pay">Pay</button>\n</template>\n',
    });
    const file = path.join(p.root, 'src/components/Cart.vue');
    expect(await find(p, { tag: 'button', text: 'Pay', hint: { attrs: { class: 'pay' }, file } })).toBe('src/components/Cart.vue:3:5');
  });

  it('finds text a script writes into a node it made, after the templates', async () => {
    const p = site({ 'index.html': '<div id="list"></div>\n', 'app.js': "const n = document.createElement('li');\nn.textContent = 'A new note';\n" });
    expect(await find(p, { tag: 'li', text: 'A new note', hint: { attrs: {} } })).toBe('app.js:2:18');
  });

  it('finds Markdown content: a paragraph by its words, an image by its alt text', async () => {
    const p = site({ 'src/content/about.md': '---\ntitle: About\n---\n\nNotes is a **small** app for notes.\n\n![Notes on a phone](./phone.png)\n' });
    expect(await find(p, { tag: 'p', text: 'Notes is a small app for notes.', hint: { attrs: {} } })).toBe('src/content/about.md:5:1');
    expect(await find(p, { tag: 'img', text: '', hint: { attrs: { alt: 'Notes on a phone' } } })).toBe('src/content/about.md:7:1');
  });

  it('finds JSX by its text and the component that renders the tag, at the start of the element', async () => {
    const p = site({
      'src/Welcome.tsx': 'export function Welcome() {\n  return (\n    <Menu.ItemLink href="/plus" shortcut={null}>\n      Sign up\n    </Menu.ItemLink>\n  );\n}\n',
    });
    expect(await find(p, { tag: 'a', text: 'Sign up', hint: { attrs: { class: 'welcome-screen-menu-item' } } })).toBe('src/Welcome.tsx:3:5');
  });

  it('says nothing when nothing matches, or the app has no code here', async () => {
    const p = site({ 'index.html': INDEX });
    expect(await find(p, { tag: 'button', text: 'Checkout', hint: { attrs: { id: 'checkout' } } })).toBeNull();
    const none = new Project(p.root, 'https://example.com', undefined, false);
    expect(await find(none, { tag: 'button', text: 'Add a note', hint: { attrs: { id: 'add' } } })).toBeNull();
  });
});

describe('locateElement: what never counts as the place', () => {
  it('ignores comments, scripts in a page, imports and plain data', async () => {
    const p = site({
      'index.html': '<html>\n<head>\n  <!-- Sign up for Excalidraw+ -->\n  <script>\n    // Sign up users of Excalidraw+ are redirected\n  </script>\n</head>\n<body><div id="root"></div></body>\n</html>\n',
      'src/App.tsx': 'import type { Theme } from "./types";\nconst commands = [{ label: "Sign up", href: "/plus" }, { label: "Theme" }];\n/* <a>Sign up</a> */\nexport const App = () => <div id="app" />;\n',
    });
    expect(await find(p, { tag: 'a', text: 'Sign up', hint: { attrs: {} } })).toBeNull();
    expect(await find(p, { tag: 'label', text: 'Theme', hint: { attrs: {} } })).toBeNull();
  });

  it('turns down an element whose own label or text says something else', async () => {
    const p = site({
      'src/Debug.tsx': 'export const Debug = () => (\n  <button className="ToolIcon_type_button" aria-label="Move forward" type="button">\n    <span>Next</span>\n  </button>\n);\n',
    });
    // Undo shares the class with a debug button: that is not it.
    expect(await find(p, { tag: 'button', text: '', hint: { attrs: { class: 'ToolIcon_type_button ToolIcon_size_medium', 'aria-label': 'Undo', title: 'Undo' } } })).toBeNull();
    expect(await find(p, { tag: 'span', text: 'Back', hint: { attrs: {} } })).toBeNull();
  });

  it('skips values that say nothing (a checkbox’s “on”) and a tag of another kind', async () => {
    const p = site({ 'index.html': '<label><input type="radio" value="on"> on</label>\n<p>Help</p>\n' });
    expect(await find(p, { tag: 'input', text: 'on', hint: { attrs: {} } })).toBeNull();
    expect(await find(p, { tag: 'h2', text: 'Help', hint: { attrs: {} } })).toBeNull();
  });

  it('needs two things to agree: a tag alone, or a class shared by several, is not enough', async () => {
    const p = site({ 'src/List.tsx': 'export const List = () => (\n  <ul>\n    <li className="row">One</li>\n    <li className="row">Two</li>\n  </ul>\n);\n' });
    expect(await find(p, { tag: 'li', text: '', hint: { attrs: { class: 'row' } } })).toBeNull();
    // A class written in one place only, on the same tag, will do.
    const q = site({ 'src/Dialog.tsx': 'export const Title = ({ title }) => <h2 className="Dialog__title">{title}</h2>;\n' });
    expect(await find(q, { tag: 'h2', text: 'Help', hint: { attrs: { class: 'Dialog__title' } } })).toBe('src/Dialog.tsx:1:37');
  });

  it('a common word decides nothing, and two equally good places are not a guess it makes', async () => {
    const buttons = Array.from({ length: 5 }, (_, i) => `export const B${i} = () => <button type="button">Help</button>;`).join('\n');
    const p = site({ 'src/Buttons.tsx': `${buttons}\n` });
    expect(await find(p, { tag: 'button', text: 'Help', hint: { attrs: {} } })).toBeNull();
    const q = site({ 'src/A.tsx': 'export const A = () => <button>Save draft</button>;\n', 'src/B.tsx': 'export const B = () => <button>Save draft</button>;\n' });
    expect(await find(q, { tag: 'button', text: 'Save draft', hint: { attrs: {} } })).toBeNull();
  });

  it('leaves out tests, stories and the repository’s own documents', async () => {
    const p = site({
      'README.md': '# Lantern\n\nClick **Add a note** to start.\n',
      'src/Note.test.tsx': 'render(<button>Add a note</button>);\n',
      'src/Note.tsx': 'export const Note = () => <button className="add">Add a note</button>;\n',
    });
    expect(await find(p, { tag: 'button', text: 'Add a note', hint: { attrs: {} } })).toBe('src/Note.tsx:1:27');
  });
});

describe('projectFiles: the code a search reads', () => {
  it('lists every file, past any count, and searches them all', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 3200; i++) files[`src/g${String(Math.floor(i / 100)).padStart(2, '0')}/C${i}.tsx`] = `export const C${i} = () => <p data-testid="c-${i}">Label ${i}</p>;\n`;
    const p = site(files);
    expect((await projectFiles(p).list()).length).toBe(3200);
    expect(await find(p, { tag: 'p', text: 'Label 3199', hint: { attrs: { 'data-testid': 'c-3199' } } })).toBe('src/g31/C3199.tsx:1:28');
  });
});

describe('findWritten: the line of an element when React named only its file or component', () => {
  const code = [
    'export function Toolbar() {',
    '  const [on] = useState(false);',
    '  return <div><IconButton title="Lock" /><button className="extra">More</button></div>;',
    '}',
    'export function IconButton(props) {',
    '  const { title } = props;',
    '  return <button className="ToolIcon" title={title} />;',
    '}',
  ].join('\n');

  it('inside the component React said it is in: the one it wrote', async () => {
    const files = projectFiles(site({ 'src/Toolbar.tsx': code }));
    expect(await findWritten(files, 'src/Toolbar.tsx', 'button', {}, { line: 6, col: 11 })).toEqual({ src: 'src/Toolbar.tsx:7:10', sure: true });
    expect(await findWritten(files, 'src/Toolbar.tsx', 'IconButton', {}, { line: 2, col: 16 })).toEqual({ src: 'src/Toolbar.tsx:3:15', sure: true });
  });

  it('anywhere in the file when the line is unknown, picking by what the page shows (then not sure)', async () => {
    const files = projectFiles(site({ 'src/Toolbar.tsx': code }));
    expect(await findWritten(files, 'src/Toolbar.tsx', 'button', { text: 'More', hint: { attrs: { class: 'extra' } } })).toEqual({ src: 'src/Toolbar.tsx:3:42', sure: false });
    expect(await findWritten(files, 'src/Toolbar.tsx', 'button', {})).toBeNull();
    expect(await findWritten(files, 'src/Toolbar.tsx', 'select', {})).toBeNull();
  });
});
