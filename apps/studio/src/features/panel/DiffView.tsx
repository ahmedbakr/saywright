/**
 * A file's diff and a block of code, with syntax colours. The highlighter is a
 * large part of the studio's code and the first screen never shows a diff: it
 * loads the first time one is shown, with the plain text in its place meanwhile.
 */
import { lazy, Suspense } from 'react';
import type { DiffFile } from '@shared/api';

const views = () => import('./CodeViews');
const Diff = lazy(() => views().then((m) => ({ default: m.DiffView })));
const Code = lazy(() => views().then((m) => ({ default: m.CodeBlock })));

/** A compact unified diff: syntax colours, wrapped lines, and the changed words marked. */
export function DiffView({ file }: { file: DiffFile }) {
  const plain = (
    <pre className="overflow-hidden whitespace-pre-wrap break-all rounded-[8px] bg-sunken py-1 pl-[44px] pr-2 font-mono text-[11.5px] leading-[18px] ring-1 ring-inset ring-line">
      {file.hunks.flatMap((h) => h.lines.map((l) => l.text)).join('\n')}
    </pre>
  );
  return (
    <Suspense fallback={plain}>
      <Diff file={file} />
    </Suspense>
  );
}

export function CodeBlock(props: { code: string; language?: string; focus?: number; start?: number }) {
  const plain = (
    <pre tabIndex={0} role="region" aria-label="Source code" className="overflow-x-auto rounded-[8px] bg-sunken py-2 pl-[46px] pr-3 font-mono text-[11.5px] leading-[19px] ring-1 ring-inset ring-line">
      {props.code.replace(/\n$/, '')}
    </pre>
  );
  return (
    <Suspense fallback={plain}>
      <Code {...props} />
    </Suspense>
  );
}
