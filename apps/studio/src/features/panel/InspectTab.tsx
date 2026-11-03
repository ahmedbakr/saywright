import { ArrowDownToLine, ArrowUpToLine, Code2, Copy, Component, Layers, ScanSearch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Empty, SectionTitle, Spinner } from '@/components/ui/misc';
import { controller } from '@/core/controller';
import { useHandLab } from '@/core/settings';
import { useStudio, type InspectResult } from '@/core/store';
import { cn } from '@/lib/cn';
import { shortcut } from '@/lib/format';
import { CodeBlock } from './DiffView';

export function InspectTab() {
  const selection = useStudio((s) => s.selection);
  const inspect = useStudio((s) => s.inspect);
  const loading = useStudio((s) => s.inspectLoading);
  const handLab = useHandLab();

  if (!selection)
    return (
      <Empty icon={<ScanSearch />} title="Nothing selected">
        {handLab
          ? `In Edit mode, click an element in your app (or pinch it) to see its component, props and source. Pinch it again to deselect; hold the pinch (or ${shortcut('shift+click')}) to select several.`
          : `In Edit mode, click an element in your app to see its component, props and source. Click it again to deselect; ${shortcut('shift+click')} selects several.`}
      </Empty>
    );

  // Where it is written, once traced (a bundle position from React's dev info means nothing to people).
  const where = inspect ? `${inspect.file}:${inspect.line}` : selection.src && !/^(https?:|\/|webpack-internal:)/.test(selection.src) ? selection.src.replace(/:\d+$/, '') : null;

  return (
    <div className="space-y-4 p-3">
      <div className="rounded-[10px] bg-raised p-3 ring-1 ring-inset ring-line">
        <div className="flex items-start gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-human-soft text-human-fg">
            <Component className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-fg">{inspect?.name ?? selection.name}</span>
              {inspect?.designSystem && <Badge tone="human">Design system</Badge>}
            </div>
            {where ? (
              <button
                data-hand
                onClick={() => void controller.openInEditor(selection)}
                className="mt-0.5 block max-w-full truncate font-mono text-[11.5px] text-fg-3 hover:text-fg-2 hover:underline"
                title="Open in editor"
              >
                {where}
              </button>
            ) : (
              !loading && <div className="mt-0.5 text-[11.5px] text-fg-3">No source location</div>
            )}
            {inspect?.guessed && <div className="mt-1 text-[11.5px] leading-snug text-fg-3">Probably here: found by searching your code for its text, not told by your app.</div>}
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-[12px]">
          {selection.text && (
            <>
              <dt className="text-fg-3">Text</dt>
              <dd className="truncate text-fg-2">“{selection.text}”</dd>
            </>
          )}
          <dt className="text-fg-3">Element</dt>
          <dd className="font-mono text-[11.5px] text-fg-2">
            &lt;{selection.tag}&gt;{selection.role ? ` · ${selection.role}` : ''}
          </dd>
          <dt className="text-fg-3">Size</dt>
          <dd className="tabular font-mono text-[11.5px] text-fg-2">
            {Math.round(selection.rect.w)} × {Math.round(selection.rect.h)}
          </dd>
        </dl>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button size="xs" icon={<ArrowUpToLine />} onClick={() => void controller.step('parent')}>
            Parent
          </Button>
          <Button size="xs" icon={<ArrowDownToLine />} onClick={() => void controller.step('child')}>
            Inside
          </Button>
          <Button size="xs" icon={<Code2 />} onClick={() => void controller.openInEditor(selection)}>
            Open in editor
          </Button>
          <Button size="xs" icon={<Copy />} onClick={() => void controller.copyLocator(selection)}>
            Locator
          </Button>
        </div>
      </div>

      {loading && !inspect && (
        <div className="flex items-center gap-2 px-1 text-[12px] text-fg-3">
          <Spinner className="size-3" /> Reading source…
        </div>
      )}
      {inspect && <Props inspect={inspect} />}
      {inspect && (
        <div>
          <SectionTitle
            action={
              <button data-hand className="text-[11.5px] text-fg-3 hover:text-fg" onClick={() => controller.openFile(inspect.absPath, inspect.line, inspect.col)}>
                {inspect.file.split('/').pop()}:{inspect.line}
              </button>
            }
          >
            Source
          </SectionTitle>
          <CodeBlock code={inspect.snippet.lines.join('\n')} start={inspect.snippet.start} focus={inspect.snippet.focus} />
        </div>
      )}
    </div>
  );
}

function Props({ inspect }: { inspect: InspectResult }) {
  if (!inspect.props.length)
    return (
      <div className="flex items-center gap-2 rounded-[10px] px-1 text-[12px] text-fg-3">
        <Layers className="size-3.5" /> No props set here.
      </div>
    );
  return (
    <div>
      <SectionTitle>Props</SectionTitle>
      <div className="space-y-2.5 rounded-[10px] bg-raised p-3 ring-1 ring-inset ring-line">
        {inspect.props.map((p) => (
          <div key={p.name} className="grid grid-cols-[76px_1fr] items-center gap-2">
            <span className="truncate font-mono text-[11.5px] text-fg-3">{p.name}</span>
            {p.options && !p.dynamic ? (
              <div className="flex flex-wrap gap-1">
                {p.options.map((o) => (
                  <button
                    key={o}
                    data-hand
                    onClick={() => o !== p.value && void controller.setProp(p.name, o)}
                    className={cn(
                      'h-[24px] rounded-[6px] px-2 font-mono text-[11.5px] transition-colors',
                      o === p.value ? 'bg-human text-[#1b1203]' : 'bg-sunken text-fg-2 ring-1 ring-inset ring-line hover:text-fg',
                    )}
                  >
                    {o}
                  </button>
                ))}
              </div>
            ) : (
              <span className={cn('truncate font-mono text-[11.5px]', p.dynamic ? 'text-fg-3' : 'text-fg-2')}>{p.value}</span>
            )}
          </div>
        ))}
        {inspect.designSystem && <p className="pt-0.5 text-[11.5px] text-fg-3">Clicking a value previews the change. Keep or undo it like any other.</p>}
      </div>
    </div>
  );
}
