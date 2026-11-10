import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Project } from '../../server/project';
import { inspect } from '../../server/inspect';
import { propEdit, quickEdit } from '../../server/quick';
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

/** shadcn/ui's Alert: one cva, used by Alert only; AlertTitle and AlertDescription take no variant. */
const ALERT = `import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const alertVariants = cva("relative w-full rounded-lg border", {
  variants: {
    variant: { default: "bg-card", destructive: "text-destructive" },
  },
  defaultVariants: { variant: "default" },
})

function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("font-medium", className)} {...props} />
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("text-sm", className)} {...props} />
}

export { Alert, AlertTitle, AlertDescription }
`;

/** A button whose props interface names the cva, with a boolean and a number variant. */
const WIDE = `import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

const styles = cva("btn", {
  variants: {
    fullWidth: { true: "w-full", false: "" },
    level: { 1: "z-1", 2: "z-2", 3: "z-3" },
  },
  defaultVariants: { fullWidth: false, level: 1 },
})

export interface WideProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof styles> {}

export const Wide = React.forwardRef<HTMLButtonElement, WideProps>(({ className, fullWidth, level, ...props }, ref) => (
  <button ref={ref} className={styles({ fullWidth, level, className })} {...props} />
))

export function Label(props: React.ComponentProps<"span">) {
  return <span {...props} />
}
`;

describe('a component’s own variants only', () => {
  it('gives a cva’s variants only to the component that uses it', () => {
    expect(variantsIn(ALERT, 'Alert')?.props.variant.values).toEqual(['default', 'destructive']);
    expect(variantsIn(ALERT, 'AlertTitle')).toBeNull();
    expect(variantsIn(ALERT, 'AlertDescription')).toBeNull();
    expect(Object.keys(variantsIn(WIDE, 'Wide')!.props)).toEqual(['fullWidth', 'level']);
    expect(variantsIn(WIDE, 'Label')).toBeNull();
  });

  const app = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-cva-'));
    fs.mkdirSync(path.join(root, 'src/components/ui'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"app"}');
    fs.writeFileSync(path.join(root, 'src/components/ui/alert.tsx'), ALERT);
    fs.writeFileSync(path.join(root, 'src/components/ui/wide.tsx'), WIDE);
    const page = `import { Alert, AlertTitle } from '@/components/ui/alert'\nimport { Wide } from '@/components/ui/wide'\nexport function Page() {\n  return <Alert>\n    <AlertTitle>Heads up!</AlertTitle>\n    <Wide>Plain</Wide>\n  </Alert>\n}\n`;
    fs.writeFileSync(path.join(root, 'src/Page.tsx'), page);
    return new Project(root, 'http://localhost:5173');
  };

  it('makes no variant edit on AlertTitle, in quick edits and in the Inspector', () => {
    const project = app();
    const title = { role: 'this', src: 'src/Page.tsx:5:5', name: 'AlertTitle', label: 'AlertTitle', text: 'Heads up!' };
    expect(quickEdit('make this red', [title], project)).toBeNull();
    expect(quickEdit('make it destructive', [title], project)).toBeNull();
    const seen = inspect(project, 'src/Page.tsx:5:5')!;
    expect(seen.designSystem).toBe(false);
    expect(seen.props.find((p) => p.name === 'variant')).toBeUndefined();
    const alert = inspect(project, 'src/Page.tsx:4:10')!;
    expect(alert.props.find((p) => p.name === 'variant')?.options).toEqual(['default', 'destructive']);
  });

  it('writes a boolean variant as a JSX boolean and a number as a number, and reads them back', () => {
    const project = app();
    const on = propEdit(project, 'src/Page.tsx:6:5', 'fullWidth', 'true');
    expect(on.kind === 'edit' && on.edits[0].after).toContain('<Wide fullWidth>Plain</Wide>');
    const level = propEdit(project, 'src/Page.tsx:6:5', 'level', '3');
    expect(level.kind === 'edit' && level.edits[0].after).toContain('<Wide level={3}>Plain</Wide>');
    fs.writeFileSync(path.join(project.root, 'src/Page.tsx'), project.read('src/Page.tsx').replace('<Wide>', '<Wide fullWidth level={2}>'));
    expect(propEdit(project, 'src/Page.tsx:6:5', 'fullWidth', 'true')).toMatchObject({ kind: 'message', text: expect.stringMatching(/already uses fullWidth/) });
    const off = propEdit(project, 'src/Page.tsx:6:5', 'fullWidth', 'false');
    expect(off.kind === 'edit' && off.edits[0].after).toContain('<Wide level={2}>Plain</Wide>');
    const ref = { role: 'this', src: 'src/Page.tsx:6:5', name: 'Wide', label: 'Wide', text: 'Plain' };
    const seen = inspect(project, 'src/Page.tsx:6:5')!;
    expect(seen.props.find((p) => p.name === 'level')).toMatchObject({ value: '2', dynamic: false });
    expect(quickEdit('make this bigger', [ref], project)).toBeNull();
  });

  it('writes {false} when false is not the default', () => {
    const project = app();
    fs.writeFileSync(path.join(project.root, 'src/components/ui/wide.tsx'), WIDE.replace('fullWidth: false, level: 1', 'fullWidth: true, level: 1'));
    const off = propEdit(project, 'src/Page.tsx:6:5', 'fullWidth', 'false');
    expect(off.kind === 'edit' && off.edits[0].after).toContain('<Wide fullWidth={false}>Plain</Wide>');
  });
});
