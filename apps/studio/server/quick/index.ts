import { parseSrc } from '@saywright/vite/protocol';
import type { NextStep, RefInfo } from '../../shared/api.ts';
import type { FileEdit } from '../changes.ts';
import type { ComponentProp, ComponentSpec, Project } from '../project.ts';
import { CodemodError, componentAt, ComputedTextError, elementName, MixedTextError, findByWords, findElement, moveElement, parseTsx, readProps, removeElementTidy, setProp, setProps, setText, showsText, type Loc } from './codemods.ts';
import { parseQuick, type QuickIntent } from '../../shared/grammar.ts';

type QuickResult =
  /** `component`: the component its code is part of (`Card`), to say when that is used in more places than this one. */
  | { kind: 'edit'; title: string; summary: string; edits: FileEdit[]; component?: string }
  | { kind: 'message'; text: string; tone: 'info' | 'warn'; next?: NextStep[] }
  /** A quick edit can't do it safely, and why: the AI can (or the person, in the code at `src`). */
  | { kind: 'needs-ai'; why: string; src?: string };

function locOf(ref: RefInfo | undefined): { file: string; loc: Loc } | null {
  if (!ref?.src) return null;
  const p = parseSrc(ref.src);
  return p ? { file: p.file, loc: { line: p.line, col: p.col } } : null;
}

function describeRef(ref: RefInfo): string {
  const text = ref.text?.trim();
  const short = text && text.length <= 24 ? `“${text}”` : '';
  return short ? `${short} ${ref.name}` : ref.name;
}

/** Candidate values for a spoken word, via the project's synonyms. */
function expand(term: string, synonyms: Record<string, string[]>): string[] {
  return [term, ...(synonyms[term] ?? [])];
}

function pickSet(spec: ComponentSpec, terms: string[], synonyms: Record<string, string[]>): { prop: string; value: string } | null {
  for (const term of terms) {
    for (const candidate of expand(term, synonyms)) {
      for (const [prop, def] of Object.entries(spec.props)) {
        if (def.values.includes(candidate)) return { prop, value: candidate };
      }
    }
  }
  return null;
}

function stepProp(spec: ComponentSpec, focus: 'size' | 'spacing'): [string, ComponentProp] | null {
  const entries = Object.entries(spec.props).filter(([, d]) => d.ordered);
  if (!entries.length) return null;
  const prefer = focus === 'spacing' ? ['padding', 'gap', 'spacing'] : ['size', 'scale'];
  return entries.find(([name]) => prefer.includes(name)) ?? entries[0];
}

function current(props: ReturnType<typeof readProps>, prop: string, def: ComponentProp): string | null {
  const v = props[prop];
  if (!v) return def.default ?? null;
  return v.kind === 'literal' ? v.value : null;
}

const valueOrNull = (def: ComponentProp, value: string) => (def.default === value ? null : value);

/**
 * Try to satisfy the request with a precise offline edit. Returns null when the
 * request is outside the quick vocabulary or can't be done safely, so the
 * caller can hand it to the AI.
 */
export function quickEdit(text: string, refs: RefInfo[], project: Project): QuickResult | null {
  const intent: QuickIntent | null = parseQuick(text);
  if (!intent) return null;
  if (intent.kind === 'text' && intent.everywhere) return { kind: 'needs-ai', why: 'Changing words everywhere they appear needs an AI: a quick edit changes only what you point at.' };
  // Several picked (“make these smaller”, “remove these”): the same edit on each, once per place in the code.
  const each = refs.filter((r, i) => r.src && refs.findIndex((o) => o.src === r.src) === i);
  if (each.length > 1 && (intent.kind === 'set' || intent.kind === 'step' || intent.kind === 'text' || intent.kind === 'remove')) return quickEditEach(text, each, project);

  // Without a pointed-at element there is nothing precise to edit; Claude may still find it by name. “This” with
  // nothing pointed at names nothing: said, rather than an AI asked (and paid) to guess.
  const a = refs[0];
  if (!a && /\b(?:this|that|these|those|it|them)\b/i.test(text)) return { kind: 'message', tone: 'info', text: 'Point at what you mean (or click it to select it), then say it again.' };
  let where = locOf(a);
  // Quick edits rewrite JSX; other markup (HTML, Vue, Svelte templates) goes to the AI.
  if (!a || !where || !/\.[jt]sx$/.test(where.file)) return null;

  let code: string;
  let ast: ReturnType<typeof parseTsx>;
  try {
    code = project.read(where.file);
  } catch {
    return null;
  }
  try {
    // Parsed once for the whole request (a long component takes a while): every step below uses this tree.
    ast = parseTsx(code);
  } catch {
    // Half-written in an editor, say: a quick edit can't place itself safely, and an AI may not be what was wanted.
    return { kind: 'message', tone: 'warn', text: `${where.file} doesn’t parse right now (a syntax error?), so a quick edit can’t be made in it. Fix it, or ask the AI.`, next: [{ kind: 'ask-ai' }, { kind: 'open', src: a.src ?? `${where.file}:1:1` }] };
  }
  let found = findElement(code, where.loc, ast);
  // The code changed since it was selected (lines added above it in an editor): what is at its place now may be
  // another element. It is found again by its name and words when exactly one near there says them. When none does,
  // what is there is it (the page may just not show an undo yet). Nothing there, or several that could be it: said,
  // never guessed.
  if (!found || !showsText(found.el, a.text)) {
    const moved = findByWords(code, where.loc, found ? elementName(found.el) : a.name, a.text, ast);
    if (moved && moved !== 'many') {
      where = { file: where.file, loc: moved.loc };
      found = moved.found;
    } else if (!found || moved === 'many') {
      return { kind: 'message', tone: 'info', text: `The code changed since you selected ${describeRef(a)}, so it isn’t where it was: select it again.`, next: [{ kind: 'ask-ai' }] };
    }
  }
  const el = found.el;
  const here = where;
  const name = elementName(el);
  const config = project.config;
  const spec = project.componentSpec(name, where.file);
  const props = readProps(el);
  const what = describeRef(a);
  const result = attempt(intent, here);
  if (result?.kind === 'edit') {
    // The code changed draws more than what was pointed at: said where it shows, not found out later.
    if (a.same && a.same > 1) {
      result.title += ` (all ${a.same} on this page)`;
      result.summary += ` Its code draws it ${a.same} times on this page (the rows of a list, or a component used several times): this changes them all.`;
    }
    const component = componentAt(code, here.loc, ast);
    if (component) result.component = component;
  }
  return result;

  function attempt(intent: QuickIntent, where: { file: string; loc: Loc }): QuickResult | null {
    try {
      switch (intent.kind) {
        case 'set': {
          if (!spec) return null;
          const pick = pickSet(spec, intent.terms, config.synonyms);
          if (!pick) return null;
          const def = spec.props[pick.prop];
          if (current(props, pick.prop, def) === pick.value) {
            return { kind: 'message', tone: 'info', text: `${what} already uses ${pick.prop} “${pick.value}”.` };
          }
          const after = setProp(code, where.loc, pick.prop, valueOrNull(def, pick.value), ast);
          const was = current(props, pick.prop, def);
          return edit(`${what} · ${pick.prop} ${was ? `${was} → ` : '→ '}${pick.value}`, `Set ${pick.prop}="${pick.value}" on ${name} in ${where.file}.`, where.file, code, after);
        }

        case 'step': {
          if (!spec) return null;
          const chosen = stepProp(spec, intent.focus);
          if (!chosen) return null;
          const [prop, def] = chosen;
          const now = current(props, prop, def);
          if (now === null) return null; // computed in code
          const steps = def.ladder ?? def.values;
          const i = steps.indexOf(now);
          if (i < 0) return null; // a size off the ladder ("icon"): Claude can judge it
          const next = steps[Math.max(0, Math.min(steps.length - 1, i + intent.dir * intent.amount))];
          if (next === now) {
            // The design system has no bigger (or smaller) size: the AI can still do it another way, or a size can be added.
            const ds: NextStep[] = spec.file ? [{ kind: 'open', src: `${spec.file}:1:1` }] : [];
            return { kind: 'message', tone: 'info', text: `${what} is already the ${intent.dir > 0 ? 'largest' : 'smallest'} ${prop} (“${now}”) in your design system.`, next: [{ kind: 'ask-ai' }, ...ds] };
          }
          const after = setProp(code, where.loc, prop, valueOrNull(def, next), ast);
          return edit(`${what} · ${prop} ${now} → ${next}`, `Changed ${prop} from "${now}" to "${next}" on ${name}.`, where.file, code, after);
        }

        case 'copy': {
          const b = refs[1];
          const bWhere = locOf(b);
          if (!b || !bWhere) {
            return { kind: 'message', tone: 'info', text: 'Point at a second thing for “that”, or select both first (⇧ click each).' };
          }
          if (!spec) return null;
          const bCode = bWhere.file === where.file ? code : project.read(bWhere.file);
          const bFound = findElement(bCode, bWhere.loc, bCode === code ? ast : undefined);
          if (!bFound) return null;
          if (elementName(bFound.el) !== name) return null; // different components: let Claude translate the look
          const bProps = readProps(bFound.el);
          const sets: [string, string | null][] = [];
          const changed: string[] = [];
          for (const [prop, def] of Object.entries(spec.props)) {
            let target = current(bProps, prop, def);
            if (target === null) continue;
            if (intent.adjust && def.ordered) {
              const steps = def.ladder ?? def.values;
              const i = steps.indexOf(target);
              if (i >= 0) target = steps[Math.max(0, Math.min(steps.length - 1, i + intent.adjust))];
            }
            if (current(props, prop, def) === target) continue;
            sets.push([prop, valueOrNull(def, target)]);
            changed.push(`${prop}="${target}"`);
          }
          if (!changed.length) return { kind: 'message', tone: 'info', text: `${what} already looks like ${describeRef(b)}.` };
          const after = setProps(code, where.loc, sets, ast);
          const tail = intent.adjust < 0 ? ', but smaller' : intent.adjust > 0 ? ', but bigger' : '';
          return edit(`${what} looks like ${describeRef(b)}${tail}`, `Copied ${changed.join(', ')} from ${describeRef(b)}.`, where.file, code, after);
        }

        case 'text': {
          const textProp = spec?.text ?? 'children';
          let after: string;
          try {
            after = setText(code, where.loc, intent.value, textProp, ast, a.text);
          } catch (err) {
            if (!(err instanceof ComputedTextError)) throw err;
            const how = err instanceof MixedTextError ? 'is written among other elements' : 'is built from code';
            return { kind: 'needs-ai', why: `${what}’s text ${how} (“${childrenCode(code, el)}”), so changing it needs an AI.`, src: a.src ?? undefined };
          }
          return edit(`Rename ${what} to “${intent.value}”`, `Changed the text of ${name} in ${where.file}.`, where.file, code, after);
        }

        case 'remove': {
          // What only it used goes with it, so the app still builds; what may do more than it needed is named.
          const { code: after, took, unused } = removeElementTidy(code, where.loc, ast);
          const also = took.length ? ` Also took out what only it used: ${andList(took)}.` : '';
          const left = unused.length ? ` Now unused, and left as they are in case they do more: ${andList(unused.map((n) => `\`${n}\``))}.` : '';
          const title = `Remove ${what}${unused.length ? ` · leaves ${unused.slice(0, 2).join(', ')}${unused.length > 2 ? '…' : ''} unused` : ''}`;
          return edit(title, `Removed the ${name} element from ${where.file}.${also}${left}`, where.file, code, after);
        }

        case 'move': {
          const b = refs[1];
          const bWhere = locOf(b);
          if (!b || !bWhere) return { kind: 'message', tone: 'info', text: 'Say where: point at the other element while you say “that”.' };
          if (bWhere.file !== where.file) return null;
          const after = moveElement(code, where.loc, bWhere.loc, intent.where, ast);
          if (after === code) return { kind: 'message', tone: 'info', text: `${what} is already ${intent.where} ${describeRef(b)}.` };
          return edit(`Move ${what} ${intent.where} ${describeRef(b)}`, `Reordered elements in ${where.file}.`, where.file, code, after);
        }
      }
    } catch (err) {
      if (err instanceof CodemodError) return null;
      throw err;
    }
    return null;
  }
}

/**
 * The same quick edit on several elements, together as one change. Each is made on the code as the ones before left
 * it, from the bottom of each file up so the places of the others don't move. One that can't be done stops them all,
 * with why: half of “make these smaller” would be a surprise.
 */
function quickEditEach(text: string, refs: RefInfo[], project: Project): QuickResult | null {
  const overlay = new Map<string, string>();
  const view = Object.create(project) as Project;
  view.read = (rel: string) => overlay.get(rel) ?? project.read(rel);
  const place = (r: RefInfo) => parseSrc(r.src ?? '') ?? { file: '', line: 0, col: 0 };
  const ordered = [...refs].sort((a, b) => {
    const pa = place(a);
    const pb = place(b);
    return pa.file === pb.file ? pb.line - pa.line || pb.col - pa.col : pa.file < pb.file ? -1 : 1;
  });
  const titles: string[] = [];
  const summaries: string[] = [];
  for (const r of ordered) {
    const one = quickEdit(text, [r], view);
    if (!one) return null;
    if (one.kind !== 'edit') return one.kind === 'message' ? { ...one, text: `Not done for any of them: ${describeRef(r)}: ${one.text}` } : one;
    for (const e of one.edits) overlay.set(e.path, e.after);
    titles.unshift(one.title);
    summaries.unshift(one.summary);
  }
  const edits = [...overlay].map(([path, after]) => ({ path, before: project.read(path), after }));
  const title = titles.length <= 2 ? titles.join('; ') : `${titles[0]}; and ${titles.length - 1} more`;
  return { kind: 'edit', title: `${title} (${refs.length} picked)`, summary: summaries.join(' '), edits };
}

/** “a, b and c”. */
function andList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Set one design-system prop on the element at `src`, from the Inspector. */
export function propEdit(project: Project, src: string, prop: string, value: string): Exclude<QuickResult, { kind: 'needs-ai' }> {
  const p = parseSrc(src);
  if (!p) return { kind: 'message', tone: 'warn', text: 'That element has no source location.' };
  let code: string;
  try {
    code = project.read(p.file);
  } catch {
    return { kind: 'message', tone: 'warn', text: `Can’t read ${p.file}.` };
  }
  const loc = { line: p.line, col: p.col };
  let found: ReturnType<typeof findElement>;
  try {
    found = findElement(code, loc);
  } catch {
    return { kind: 'message', tone: 'warn', text: `${p.file} has a syntax error right now. Fix it, then try again.` };
  }
  if (!found) return { kind: 'message', tone: 'warn', text: 'The code moved since you selected this. Select it again.' };
  const name = elementName(found.el);
  const def = project.componentSpec(name, p.file)?.props[prop];
  if (!def || !def.values.includes(value)) return { kind: 'message', tone: 'warn', text: `${name} has no ${prop} “${value}” in your design system.` };
  const now = current(readProps(found.el), prop, def);
  if (now === value) return { kind: 'message', tone: 'info', text: `${name} already uses ${prop} “${value}”.` };
  try {
    const after = setProp(code, loc, prop, valueOrNull(def, value), found.ast);
    return edit(`${name} · ${prop} ${now ? `${now} → ` : '→ '}${value}`, `Set ${prop}="${value}" on ${name} in ${p.file}.`, p.file, code, after);
  } catch (err) {
    if (err instanceof CodemodError) return { kind: 'message', tone: 'warn', text: err.message };
    throw err;
  }
}

/** An element's children as written, on one line ("Pay {money(totals.total)}"). */
function childrenCode(code: string, el: { children: { start: number; end: number }[] }): string {
  const kids = el.children;
  if (!kids.length) return '';
  const text = code.slice(kids[0].start, kids[kids.length - 1].end).replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function edit(title: string, summary: string, file: string, before: string, after: string): Extract<QuickResult, { kind: 'edit' }> {
  return { kind: 'edit', title, summary, edits: [{ path: file, before, after }] };
}

/** Values a component accepts, for helpful messages when no AI is configured. */
export function describeOptions(project: Project, ref: RefInfo | undefined): string | null {
  if (!ref) return null;
  const file = ref.src ? parseSrc(ref.src)?.file : undefined;
  const spec = file ? project.componentSpec(ref.name, file) : project.config.components[ref.name];
  if (!spec) return null;
  const parts = Object.entries(spec.props).map(([p, d]) => `${p}: ${d.values.join(', ')}`);
  return parts.length ? `${ref.name} supports ${parts.join('; ')}.` : null;
}
