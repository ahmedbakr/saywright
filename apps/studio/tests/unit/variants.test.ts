import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Project } from '../../server/project';
import { quickEdit } from '../../server/quick';
import { stripJsonc, variantsIn } from '../../server/quick/variants';

/** shadcn/ui's Button, as generated into apps. */
const BUTTON = `import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
const buttonVariants = cva('inline-flex', {
  variants: {
    variant: { default: 'bg-primary', destructive: 'bg-destructive', outline: 'border', secondary: 'bg-secondary', ghost: 'hover:bg-accent', link: 'underline' },
    size: { default: 'h-9 px-4', sm: 'h-8 px-3', lg: 'h-10 px-6', icon: 'size-9' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
})
function Button({ className, variant, size, ...props }) { return <button className={buttonVariants({ variant, size, className })} {...props} /> }
export { Button, buttonVariants }
`;

describe('design-system props read from cva(...) (shadcn/ui and similar)', () => {
  it('reads variants and defaults; sizes step from small to large, the icon size is not a step', () => {
    const spec = variantsIn(BUTTON, 'Button')!;
    expect(spec.props.variant).toEqual({ values: ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'], default: 'default' });
    expect(spec.props.size.default).toBe('default');
    expect(spec.props.size.ladder).toEqual(['sm', 'default', 'lg']);
    expect(spec.props.size.values).toContain('icon');
  });

  it('reads tsconfig with comments, keeping "@/*" inside strings', () => {
    const json = `{\n  // paths\n  "compilerOptions": { /* aliases */ "paths": { "@/*": ["./src/*"], }, },\n}`;
    expect(JSON.parse(stripJsonc(json))).toEqual({ compilerOptions: { paths: { '@/*': ['./src/*'] } } });
  });

  it('makes a shadcn button bigger, and outlined, with no configuration', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-cva-'));
    fs.mkdirSync(path.join(root, 'src/components/ui'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"app"}');
    fs.writeFileSync(path.join(root, 'tsconfig.json'), `{ "compilerOptions": { /* alias */ "paths": { "@/*": ["./src/*"] } } }`);
    fs.writeFileSync(path.join(root, 'src/components/ui/button.tsx'), BUTTON);
    const page = `import { Button } from '@/components/ui/button'\nexport function Page() {\n  return <div>\n    <Button>Download</Button>\n  </div>\n}\n`;
    fs.writeFileSync(path.join(root, 'src/Page.tsx'), page);
    const project = new Project(root, 'http://localhost:5173');
    const ref = { role: 'this', src: 'src/Page.tsx:4:5', name: 'Button', label: 'Button · Download', text: 'Download', tag: 'button' };
    const bigger = quickEdit('make this bigger', [ref], project);
    expect(bigger).toMatchObject({ kind: 'edit', title: '“Download” Button · size default → lg' });
    expect(bigger?.kind === 'edit' && bigger.edits[0].after).toContain('<Button size="lg">Download</Button>');
    const outline = quickEdit('make it outlined', [ref], project);
    expect(outline?.kind === 'edit' && outline.edits[0].after).toContain('<Button variant="outline">Download</Button>');
    const red = quickEdit('make this red', [ref], project);
    expect(red?.kind === 'edit' && red.edits[0].after).toContain('variant="destructive"');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
