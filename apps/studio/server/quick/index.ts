import { parseSrc } from '@saywright/vite/protocol';
import type { NextStep, RefInfo } from '../../shared/api.ts';
import type { FileEdit } from '../changes.ts';
import type { ComponentProp, ComponentSpec, Project } from '../project.ts';
import { CodemodError, ComputedTextError, elementName, findElement, moveElement, parseTsx, readProps, removeElement, setProp, setProps, setText, type Loc } from './codemods.ts';
import { parseQuick, type QuickIntent } from '../../shared/grammar.ts';

type QuickResult =
  | { kind: 'edit'; title: string; summary: string; edits: FileEdit[] }
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

  // Without a pointed-at element there is nothing precise to edit; Claude may still find it by name.
  const a = refs[0];
  const where = locOf(a);
  // Quick edits rewrite JSX; other markup (HTML, Vue, Svelte templates) goes to the AI.
  if (!a || !where || !/\.[jt]sx$/.test(where.file)) return null;

  let code: string;
  let ast: ReturnType<typeof parseTsx>;
  try {
    code = project.read(where.file);
    // Parsed once for the whole request (a long component takes a while): every step below uses this tree.
    ast = parseTsx(code);
  } catch {
    return null;
  }
  const found = findElement(code, where.loc, ast);
  if (!found) return null; // stale location (file changed); Claude can find it from the text
  const name = elementName(found.el);
  const config = project.config;
  const spec = project.componentSpec(name, where.file);
  const props = readProps(found.el);
  const what = describeRef(a);

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
          after = setText(code, where.loc, intent.value, textProp, ast);
        } catch (err) {
          if (!(err instanceof ComputedTextError)) throw err;
          return { kind: 'needs-ai', why: `${what}’s text is built from code (“${childrenCode(code, found.el)}”), so changing it needs an AI.`, src: a.src ?? undefined };
        }
        return edit(`Rename ${what} to “${intent.value}”`, `Changed the text of ${name} in ${where.file}.`, where.file, code, after);
      }

      case 'remove': {
        const after = removeElement(code, where.loc, ast);
        return edit(`Remove ${what}`, `Removed the ${name} element from ${where.file}.`, where.file, code, after);
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
