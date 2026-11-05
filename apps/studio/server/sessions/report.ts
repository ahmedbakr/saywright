/**
 * The written session report: by the AI the person connected (grounded in
 * the session's evidence, screenshots and source code), or on this computer
 * from the analysis alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AiEffort, AiTask } from '../../shared/ai.ts';
import { AR_UNITS, arCount, durationWords, durationWordsAr, type FindingCategory, type ReportFinding, type ReportSuggestion, type ScreenText, type SessionAnalysis, type SessionIssue, type SessionMeta, type SessionReport, type SessionScores, type SessionStep, type Severity } from '../../shared/session.ts';
import type { Part } from '../ai/llm/types.ts';
import type { Project } from '../project.ts';
import { projectImports } from '../quick/variants.ts';
import { balanced, complaintSeverity, nameOf, pathOf, worstOf } from './analyze.ts';
import { changedLines } from './screens.ts';

interface ReportInput {
  meta: SessionMeta;
  analysis: SessionAnalysis;
  project: Project;
  shotPath: (name: string) => string;
  previous: { id: string; name: string; startedAt: number; scores: SessionScores | null } | null;
  /** Findings the tester set aside in an earlier version of this report (titles). */
  dismissed?: string[];
}

export interface ReportWriter {
  write(input: ReportInput): Promise<SessionReport>;
  /** The same report in the other language: same findings, ids and evidence. */
  translate?(report: SessionReport, to: 'en' | 'ar'): Promise<SessionReport>;
}

/** mm:ss from the start of the session. */
/** What a restart of the studio during a recording did to it. */
export function restartWords(r: { resumed: boolean }): { en: string; ar: string } {
  return r.resumed
    ? { en: 'the page recording it went on, and sent what it kept meanwhile, so nothing is missing.', ar: 'واصلت الصفحة التسجيل وأرسلت ما احتفظت به في أثناء ذلك، فلم يضع شيء.' }
    : { en: 'the recording ended there; nothing after it was recorded.', ar: 'انتهى التسجيل عندها، ولم يُسجَّل شيء بعدها.' };
}

export function clock(t: number, start: number): string {
  const s = Math.max(0, Math.round((t - start) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Every problem found, including those past the first ones of each kind that the analysis lists. */
function totalIssues(analysis: SessionAnalysis): number {
  return analysis.issues.length + Object.values(analysis.more?.issues ?? {}).reduce((a, n) => a + (n ?? 0), 0);
}

/** Arabic when most of what was said is Arabic. */
export function reportLang(meta: SessionMeta, analysis: SessionAnalysis): 'ar' | 'en' {
  if (meta.lang === 'ar') return 'ar';
  if (meta.lang === 'en') return 'en';
  const text = analysis.transcript.map((s) => s.text).join(' ');
  const ar = (text.match(/[\u0600-\u06FF]/g) ?? []).length;
  const en = (text.match(/[a-z]/gi) ?? []).length;
  return ar > en ? 'ar' : 'en';
}

/** A project-relative "file:line" from what the browser reported (relative path, absolute path or URL). */
export function relSrc(project: Project, src: string | null | undefined): { file: string; line: number } | null {
  if (!src) return null;
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(src);
  if (!m) return null;
  let file = m[1];
  if (/^https?:\/\//.test(file)) {
    try {
      file = decodeURIComponent(new URL(file).pathname).replace(/^\/+/, '');
    } catch {
      return null;
    }
  }
  if (path.isAbsolute(file)) {
    const rel = path.relative(project.root, file);
    if (rel.startsWith('..')) return null;
    file = rel.split(path.sep).join('/');
  }
  return project.exists(file) ? { file, line: Number(m[2]) } : null;
}

// ---- the code behind the problems ---------------------------------------------------

/** Lines of related code a report shows: room for the module that computes a total, never a runaway prompt. */
const RELATED_LINES = 160;
const RELATED_FILES = 4;
/** A related file this short goes in whole; a longer one, as excerpts around what the problems are about. */
const RELATED_WHOLE = 60;

/** Words that say nothing about which code a problem is in. */
const STOP = new Set(
  'the and but for with this that these those should would could only not just now then here there what when where which while wait look like seem show shown showing said say saw see seen tester autopilot expected actual page button link field click clicked pointing point wrong right off come came from into onto have has had was were are been being does did done will can cannot don doesn didn isn okay yes let try tried again also very much more less than its you your our they them their how why who one two all any some get got make made still even instead because about after before other another thing something nothing everything'.split(' '),
);

/**
 * What the tester said was wrong, what Autopilot saw (and expected), the marks they left, and what they pointed at
 * then. When nothing was questioned, what changed on screen after the tester's actions: the results to check.
 */
function problemTexts(analysis: SessionAnalysis): string[] {
  const questioned = analysis.issues
    .slice(0, 40)
    .flatMap((g) => (g.kind === 'said' || g.kind === 'mark' ? [g.title, g.el?.label ?? '', g.el?.text ?? ''] : g.kind === 'observed' ? [g.title, g.detail ?? '', g.el?.label ?? ''] : []));
  return questioned.some(Boolean) ? questioned : changedLines(analysis.screens);
}

/** The words a session's problems are about. */
function problemTerms(analysis: SessionAnalysis): string[] {
  const texts = problemTexts(analysis);
  const count = new Map<string, number>();
  for (const w of texts.join(' ').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []) {
    // “totals” is about the same code as “total”.
    const t = w.length > 4 && w.endsWith('s') && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w;
    if (!STOP.has(t) && !STOP.has(w)) count.set(t, (count.get(t) ?? 0) + 1);
  }
  return Array.from(count.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([t]) => t);
}

/** Code that works something out (arithmetic between values, a sum, a rounding), outside its strings and comments. */
const computes = (line: string) =>
  /[\w)\]]\s+[-+]\s+[\w(]|[\w)\]]\s*[*/%]\s*[\w(]|Math\.\w+|\.reduce\(|toFixed\(/.test(
    line.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""').replace(/\/\*.*?\*\/|\/\/.*$/g, ''),
  );
/** The tester or Autopilot questioned a value: a number, a percentage or an amount. */
const NUMBERS = /\d|%|[$€£¥]|دولار|جنيه|ريال|درهم|percent|dollar/i;

/** A file that only passes on what other files export (an index.ts “barrel”). */
const isBarrel = (code: string) =>
  code
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    .split('\n')
    .every((l) => !l.trim() || /^export\s+(type\s+)?(\*|\{[^}]*\})\s+from\s+['"][^'"]+['"];?\s*$/.test(l.trim()));

interface RelatedCode {
  file: string;
  /** How it is related to where the problems showed. */
  why: string;
  /** How much it is about the problems (for ranking). */
  score: number;
  lines: string[];
  ranges: [number, number][];
  whole: boolean;
}

/**
 * The project code one step away from where the problems showed: the modules those files import (through an
 * index that re-exports them, too) and the components that render them. Ranked by how much each is about the
 * problems (the words the tester and Autopilot used, the labels of what they pointed at), with code that computes
 * with those words first, and cut to a few files.
 */
export function relatedCode(project: Project, analysis: SessionAnalysis, shown: string[]): RelatedCode[] {
  const terms = problemTerms(analysis);
  if (!terms.length || !project.hasCode) return [];
  const read = (file: string): string | null => {
    try {
      return project.read(file);
    } catch {
      return null;
    }
  };
  const found = new Map<string, { importedBy: Set<string>; renders: Set<string>; names: string[] }>();
  const note = (file: string, from: string, names: string[], renders = false) => {
    if (shown.includes(file) || !project.exists(file)) return;
    const c = found.get(file) ?? { importedBy: new Set<string>(), renders: new Set<string>(), names: [] };
    (renders ? c.renders : c.importedBy).add(from);
    c.names.push(...names);
    found.set(file, c);
  };
  for (const file of shown) {
    const code = read(file);
    if (code === null) continue;
    for (const imp of projectImports(project.root, file, code)) {
      const inner = read(imp.file);
      const behind = inner !== null && isBarrel(inner) ? projectImports(project.root, imp.file, inner).filter((b) => b.names.some((n) => imp.names.includes(n))) : null;
      if (behind?.length) for (const b of behind) note(b.file, file, b.names);
      else note(imp.file, file, imp.names);
    }
  }
  // The components around what was used (“App › Checkout › LineItems › Card”): one of them often holds the state.
  const byName = new Map<string, string>();
  for (const f of project.listFiles('', 2000)) {
    const m = /([A-Za-z0-9_]+)\.(tsx|jsx|vue|svelte)$/.exec(f);
    if (m && !byName.has(m[1])) byName.set(m[1], f);
  }
  const paths: { path: string; src: string | null | undefined }[] = [
    ...analysis.issues.map((g) => ({ path: g.el?.path ?? '', src: g.src ?? g.el?.src })),
    ...analysis.transcript.map((s) => ({ path: s.el?.path ?? '', src: s.el?.src })),
    ...analysis.timeline.filter((x) => x.kind === 'action' && x.detail?.includes(' › ')).map((x) => ({ path: x.detail ?? '', src: x.src })),
  ];
  for (const p of paths) {
    const from = relSrc(project, p.src)?.file;
    if (!from || !shown.includes(from)) continue;
    for (const name of p.path.split(' › ').slice(1, -1)) {
      const file = byName.get(name);
      if (file) note(file, from, [], true);
    }
  }

  // A questioned value (“this should show $80.80”) is worked out somewhere: code that computes counts for more then.
  const weight = problemTexts(analysis).some((t) => NUMBERS.test(t)) ? 2 : 1;
  const ranked = Array.from(found.entries())
    .map(([file, c]) => {
      const lines = (read(file) ?? '').split('\n');
      const hits = new Map<string, number>();
      const about: number[] = [];
      let working = 0;
      lines.forEach((line, i) => {
        const lower = line.toLowerCase();
        const these = terms.filter((t) => lower.includes(t));
        const works = computes(line);
        if (works) working++;
        if (!these.length && !works) return;
        for (const t of these) hits.set(t, (hits.get(t) ?? 0) + 1);
        about.push(i + 1);
      });
      const named = c.names.some((n) => terms.some((t) => n.toLowerCase().includes(t))) ? 2 : 0;
      const score = Array.from(hits.values()).reduce((a, n) => a + Math.min(4, n), 0) + weight * Math.min(5, working) + named + c.importedBy.size + c.renders.size;
      const why = c.importedBy.size ? `imported by ${Array.from(c.importedBy).join(', ')}` : `renders ${Array.from(c.renders).join(', ')}`;
      return { file, lines, about, score, why, relevant: hits.size > 0 };
    })
    .filter((r) => r.relevant)
    .sort((a, b) => b.score - a.score);

  const out: RelatedCode[] = [];
  let budget = RELATED_LINES;
  for (const r of ranked.slice(0, RELATED_FILES)) {
    if (budget <= 0) break;
    const whole = r.lines.length <= RELATED_WHOLE && r.lines.length <= budget;
    let ranges: [number, number][];
    if (whole) ranges = [[1, r.lines.length]];
    else {
      ranges = [];
      for (const l of r.about) {
        const range: [number, number] = [Math.max(1, l - 4), Math.min(r.lines.length, l + 4)];
        const last = ranges[ranges.length - 1];
        if (last && range[0] <= last[1] + 2) last[1] = range[1];
        else ranges.push(range);
      }
      // Within the budget, and at most 50 lines of any one file.
      let left = Math.min(budget, 50);
      ranges = ranges.flatMap(([a, b]): [number, number][] => {
        if (left <= 0) return [];
        const end = Math.min(b, a + left - 1);
        left -= end - a + 1;
        return [[a, end]];
      });
    }
    budget -= ranges.reduce((n, [a, b]) => n + b - a + 1, 0);
    out.push({ file: r.file, why: r.why, score: r.score, lines: r.lines, ranges, whole });
  }
  return out;
}

// ---- the prompt -----------------------------------------------------------------

export function evidencePack(input: ReportInput): { text: string; images: { id: string; data: string }[] } {
  const { meta, analysis, project } = input;
  const t0 = meta.startedAt;
  const lines: string[] = [];
  const push = (s: string) => lines.push(s);

  push('<session>');
  push(`App: ${project.name} at ${meta.appUrl}`);
  push(`Recorded: ${new Date(meta.startedAt).toISOString()}, ${Math.round(analysis.durationMs / 1000)} s, started from the ${meta.source === 'app' ? 'app’s own tab' : 'studio'}`);
  if (meta.git) push(`Git: ${meta.git.branch} @ ${meta.git.commit}${meta.git.dirty ? ' (uncommitted changes)' : ''}`);
  push(`Pages: ${analysis.pages.map((p) => `${p.url} (${Math.round(p.ms / 1000)} s)`).join(' → ') || 'unknown'}`);
  push(`Narration: ${analysis.transcript.length} sentences, language setting ${meta.lang}`);
  for (const r of meta.restarts ?? []) push(`Studio restart at ${clock(r.at, t0)}: ${restartWords(r).en}`);
  push('</session>');

  const s = analysis.scores;
  push('<scores computed="deterministically">');
  push(`overall ${s.overall}/100`);
  for (const k of ['stability', 'usability', 'performance', 'accessibility'] as const) push(`${k} ${s[k].score}/100: ${s[k].notes.join('; ')}`);
  if (input.previous?.scores) push(`Previous session (${input.previous.name}): overall ${input.previous.scores.overall}, stability ${input.previous.scores.stability.score}, usability ${input.previous.scores.usability.score}, performance ${input.previous.scores.performance.score}, accessibility ${input.previous.scores.accessibility.score}`);
  push('</scores>');

  push('<issues found="automatically">');
  for (const g of analysis.issues.slice(0, 40)) {
    push(`${g.id} [${clock(g.t, t0)}] ${g.severity} ${g.kind}: ${g.title}${g.count > 1 ? ` (×${g.count})` : ''}${g.el ? ` | element: ${nameOf(g.el)}${g.el.path ? ` in ${g.el.path}` : ''}` : ''}${g.src ? ` | source: ${g.src}` : ''} | evidence: ${g.evidence.join(', ')}${g.detail ? `\n    ${g.detail.replace(/\n/g, '\n    ').slice(0, 500)}` : ''}`);
  }
  const unlisted = Object.entries(analysis.more?.issues ?? {}).filter(([, n]) => n);
  if (analysis.issues.length > 40 || unlisted.length) push(`(${totalIssues(analysis) - Math.min(40, analysis.issues.length)} more issues are not listed here)`);
  push('</issues>');

  push('<narration what_the_tester_said_out_loud="true">');
  const speechItems = analysis.timeline.filter((x) => x.kind === 'speech');
  const corrected = new Set(analysis.transcript.filter((s) => s.original !== undefined).map((s) => s.start));
  for (const it of speechItems) push(`${it.id} [${clock(it.t, t0)}]${it.detail ? ` (${it.detail}${it.src ? `, ${it.src}` : ''})` : ''}: “${it.text}”${corrected.has(it.t) ? ' (corrected by the tester: exact)' : ''}`);
  if (!speechItems.length) push('(no narration)');
  push('</narration>');
  if (input.dismissed?.length) {
    push('<dismissed_by_tester>');
    for (const d of input.dismissed.slice(0, 40)) push(`- ${d}`);
    push('</dismissed_by_tester>');
  }

  // The full timeline when it is short; otherwise everything but routine actions, which are sampled.
  push('<timeline>');
  const items = analysis.timeline.filter((x) => x.kind !== 'speech' && x.kind !== 'shot');
  const budget = 350;
  const keep = items.length <= budget ? items : items.filter((x, i) => x.kind !== 'action' || i % Math.ceil(items.length / budget) === 0 || x.issue);
  // Autopilot's steps come with what it saw and meant (“it said the code is invalid, so…”): what was on screen.
  const note = (it: (typeof keep)[number]) => (it.kind === 'command' && it.text.startsWith('Autopilot: ') && it.detail ? ` (Autopilot: “${it.detail}”)` : '');
  for (const it of keep) push(`${it.id} [${clock(it.t, t0)}] ${it.kind}: ${it.text}${it.src ? ` (${it.src})` : ''}${note(it)}${it.issue ? ` → ${it.issue}` : ''}`);
  if (keep.length < items.length) push(`(${items.length - keep.length} routine actions omitted)`);
  push('</timeline>');

  const net = analysis.network;
  push('<network>');
  push(`${net.total} requests, ${net.failed} failed, ${net.slow} slow`);
  for (const e of net.endpoints.slice(0, 15)) push(`${e.method} ${e.url}: ${e.count}× avg ${e.avgMs} ms, statuses ${e.statuses.join('/')}${e.failed ? `, ${e.failed} failed` : ''}`);
  push('</network>');

  const p = analysis.perf;
  push(`<performance>FCP ${p.fcp ?? '?'} ms, LCP ${p.lcp ?? '?'} ms, CLS ${p.cls}, slowest response to input ${p.slowestInteraction ?? 'none over 200'} ms; the app’s own long tasks: ${p.longTasks} (${p.longTaskMs} ms in total, background work, not a finding by itself)</performance>`);

  // Source code around the places the session points at, then the code it uses that the problems are most about:
  // a wrong total shows in one component and is computed in another.
  const wanted = new Map<string, Set<number>>();
  const want = (src: string | null | undefined) => {
    const r = relSrc(project, src);
    if (!r) return;
    const set = wanted.get(r.file) ?? new Set<number>();
    set.add(r.line);
    wanted.set(r.file, set);
  };
  for (const g of analysis.issues.slice(0, 20)) want(g.src ?? g.el?.src);
  for (const sgm of analysis.transcript) want(sgm.el?.src);
  // The code behind actions whose results showed on screen: a wrong total is checked against the code that made it.
  for (const src of resultSources(analysis)) want(src);
  push('<code where="the problems showed">');
  let budgetLines = 420;
  for (const [file, lineSet] of Array.from(wanted.entries()).slice(0, 10)) {
    if (budgetLines <= 0) break;
    let text: string;
    try {
      text = project.read(file);
    } catch {
      continue;
    }
    const all = text.split('\n');
    const ranges = Array.from(lineSet)
      .sort((a, b) => a - b)
      .map((l) => [Math.max(1, l - 10), Math.min(all.length, l + 14)] as [number, number]);
    const merged: [number, number][] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + 3) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    // Small files go in whole: the bug is often a few lines away from where it shows.
    const whole = all.length <= 80;
    push(`--- ${file}${whole ? '' : ` (excerpts)`}`);
    for (const [a, b] of whole ? [[1, all.length] as [number, number]] : merged) {
      for (let i = a; i <= b && budgetLines > 0; i++, budgetLines--) push(`${String(i).padStart(4)}| ${all[i - 1]}`);
      if (!whole) push('     …');
    }
  }
  push('</code>');
  const related = relatedCode(project, analysis, Array.from(wanted.keys()).slice(0, 10));
  if (related.length) {
    push('<code where="what that code imports or is rendered by, most related to the problems first">');
    for (const r of related) {
      push(`--- ${r.file} (${r.why})${r.whole ? '' : ' (excerpts)'}`);
      for (const [a, b] of r.ranges) {
        for (let i = a; i <= b; i++) push(`${String(i).padStart(4)}| ${r.lines[i - 1]}`);
        if (!r.whole) push('     …');
      }
    }
    push('</code>');
  }

  // What the screen said: each page as it first showed, then what changed once it settled after each action.
  const screens = screenEvidence(analysis, t0);
  push(screens.length ? '<screen_text what="the page’s text (its main region, dialogs and messages) as it first showed, then what changed once it settled after each action" format="diff: + appeared, - went away, two spaces unchanged, … unchanged lines left out">' : '<screen_text>');
  if (screens.length) for (const l of screens) push(l);
  else for (const d of analysis.timeline.filter((x) => x.kind === 'navigation').slice(0, 8)) push(`[${clock(d.t, t0)}] ${d.text}`);
  push('</screen_text>');

  // Screenshots: the ones nearest the most important issues, then marks and errors.
  const shotIds = new Map(analysis.timeline.filter((x) => x.kind === 'shot').map((x) => [x.shot!, x.id]));
  const chosen: string[] = [];
  for (const g of analysis.issues) if (g.shot && !chosen.includes(g.shot) && chosen.length < 6) chosen.push(g.shot);
  for (const sh of analysis.shots) if (chosen.length < 3 && !chosen.includes(sh.name)) chosen.push(sh.name);
  const images: { id: string; data: string }[] = [];
  for (const name of chosen) {
    try {
      images.push({ id: shotIds.get(name) ?? name, data: fs.readFileSync(input.shotPath(name)).toString('base64') });
    } catch {
      /* missing file */
    }
  }
  return { text: lines.join('\n'), images };
}

/** The screen's text in the evidence, at most (characters). */
const SCREEN_EVIDENCE = 7000;

/** Where in the code the actions are whose results changed the screen, those that changed numbers first: three at most. */
function resultSources(analysis: SessionAnalysis): string[] {
  const byId = new Map(analysis.timeline.map((x) => [x.id, x]));
  const found: { src: string; numbers: boolean }[] = [];
  for (const s of analysis.screens ?? []) {
    const src = s.diff && s.after?.id ? byId.get(s.after.id)?.src : null;
    if (!src || found.some((f) => f.src === src)) continue;
    found.push({ src, numbers: s.lines.some((l) => (l[0] === '+' || l[0] === '-') && NUMBERS.test(l)) });
  }
  return found
    .sort((a, b) => Number(b.numbers) - Number(a.numbers))
    .slice(0, 3)
    .map((f) => f.src);
}

/**
 * The screen's text for the evidence, in time order, within SCREEN_EVIDENCE: the first page, then the changes just
 * before a problem, a sentence or a mark, then those that changed numbers, then the rest.
 */
function screenEvidence(analysis: SessionAnalysis, t0: number): string[] {
  const screens = analysis.screens ?? [];
  if (!screens.length) return [];
  const flagged = [...analysis.issues.map((g) => g.t), ...analysis.transcript.map((s) => s.start), ...analysis.timeline.filter((x) => x.kind === 'mark').map((x) => x.t)];
  const rank = (s: ScreenText, i: number) =>
    i === 0 ? 0 : flagged.some((t) => t >= s.t - 3000 && t <= s.t + 20_000) ? 1 : s.lines.some((l) => (l[0] === '+' || l[0] === '-') && NUMBERS.test(l)) ? 2 : 3;
  const chosen = new Set<number>();
  let room = SCREEN_EVIDENCE;
  for (const { i, cost } of screens.map((s, i) => ({ i, r: rank(s, i), cost: s.lines.reduce((n, l) => n + l.length + 3, 60) })).sort((a, b) => a.r - b.r || a.i - b.i)) {
    if (cost > room) continue;
    chosen.add(i);
    room -= cost;
  }
  const out: string[] = [];
  screens.forEach((s, i) => {
    if (!chosen.has(i)) return;
    out.push(`[${clock(s.t, t0)}] ${screenMoment(s)}:`);
    for (const l of s.lines) out.push(`  ${l}`);
    if (s.more) out.push(`  (${s.more} more lines)`);
  });
  if (chosen.size < screens.length) out.push(`(${screens.length - chosen.size} more screen changes are not listed here)`);
  return out;
}

const MOMENTS: Record<string, string> = { start: 'when recording started', reload: 'after a reload', navigation: 'as it opened', error: 'after an error', mark: 'at a mark', after: 'after an action' };

/** When the screen was read: after which action, or at which moment; a page shown in full says which page. */
function screenMoment(s: ScreenText): string {
  const when = s.after ? `after ${s.after.id ? `${s.after.id} ` : ''}${s.after.text}` : (MOMENTS[s.moment] ?? '');
  return s.diff ? when : `${pathOf(s.url)} ${when} (in full)`.replace(/\s+/g, ' ');
}

const SYSTEM = `You are a senior QA engineer and UX researcher reviewing a recorded test session of a web app that is under development. The tester used the app while talking out loud; the studio recorded every action, error, request and performance signal, transcribed the narration on-device, linked each sentence to what was being pointed at, and grouped issues automatically.

Write the report the team will act on:
- Ground every finding in evidence ids from the input (E… events, S… sentences, P… screenshots, I… issues). Never invent events, files or numbers. If something is uncertain, say so and lower the confidence.
- Treat the narration as the tester's intent and expectations: when they say what should happen, that is the expected behaviour. Narration is machine-transcribed and may contain small recognition errors; read it charitably.
- Look for the root cause in the code: first where the problems showed, then the code that code imports or is rendered by (a wrong total often shows in one component and is computed in another module). For each finding give where it showed (shown) and the cause's file:line (location) when the code shows it, and say exactly what to change there. When the cause is in code you can't see, give the file most likely to hold it, without a line, and lower the confidence.
- Sentences marked "corrected by the tester" are exactly what was said. Findings under <dismissed_by_tester> were judged not worth fixing: don't report them again unless the evidence shows something clearly different.
- <screen_text> is what the page said: in full as each page first showed, then what changed once the screen settled after each action. Check every result against what the action should do: amounts, totals, discounts, taxes, counts, dates, messages and states. A wrong result on screen is a finding even when nobody said anything: cite the action's E id, quote the screen and work out the expected value from what the screen showed before. When the result of the session's main task isn't in the evidence, say it is unverified rather than calling it correct.
- A click that "did nothing" only means the screen didn't change: it may already have shown the result (the same message again). Check what the tester or Autopilot said the page showed before calling a feature broken.
- Pauses are normal. The tester may wait, read, think, rest the pointer on something or stay silent before and between sentences: never report that as a finding, and never report the page being busy while nobody was using it. Slowness is a finding only when something the tester did was slow to respond (a slow response or slow request in the evidence) or they said so.
- A finding is what happened in this session. A risk the session never triggered (code that could fail, a path nobody took) is not a finding, however serious: suggest a test for it instead ("add").
- Work out amounts step by step from the numbers on screen (items, discount, shipping, tax), and put the calculation in "expected": "20% of the $98.00 items is $19.60, so the total is $98.00 − $19.60 + $5.00 = $83.40". Check the arithmetic before writing it.
- Merge duplicates. Order findings by impact on the user. Severity: critical (data loss, money, blocks the main task), high (main task is wrong or broken), medium (friction, confusing, workaround exists), low (polish).
- Suggestions: "fix" for defects, "improve" for UX or performance improvements, "add" for missing features or tests worth adding.
- Be concrete and brief. No filler, no praise inflation; positives only when the evidence shows them.
- The verdict is ship (no high or critical findings), fix-first (high findings), or blocked (critical findings).`;

export const Finding = z.object({
  category: z.enum(['bug', 'usability', 'performance', 'accessibility', 'content', 'reliability']),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string().describe('At most 80 characters.'),
  what: z.string().describe('What happened, in one to three sentences.'),
  expected: z.string().describe('What should have happened (from the narration or common sense). Empty if unclear.'),
  quote: z.string().describe('The tester’s exact words about it, copied from the narration. Empty if none.'),
  evidence: z.array(z.string()).describe('Evidence ids, e.g. ["E12","S3","P2"].'),
  shown: z.string().describe('Where it showed: the file:line of what was on screen, from the evidence, e.g. src/components/OrderSummary.tsx:24. Empty if unknown.'),
  location: z.string().describe('The cause: the file:line to fix, when the code shows it, e.g. src/lib/pricing.ts:32; otherwise the file most likely to hold it. Empty if unknown.'),
  fix: z.string().describe('The concrete change to make.'),
  steps: z.array(z.string()).describe('Steps to reproduce, short.'),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const ReportSchema = z.object({
  title: z.string().describe('A headline for the session, at most 70 characters.'),
  summary: z.string().describe('Two to four sentences: what was tested and the most important outcome.'),
  verdict: z.enum(['ship', 'fix-first', 'blocked']),
  scoreNotes: z.object({ stability: z.string(), usability: z.string(), performance: z.string(), accessibility: z.string() }).describe('One sentence each explaining the score.'),
  findings: z.array(Finding),
  suggestions: z.array(z.object({ kind: z.enum(['fix', 'improve', 'add']), title: z.string(), why: z.string(), effort: z.enum(['small', 'medium', 'large']) })),
  positives: z.array(z.string()),
  journey: z.array(z.string()).describe('What the tester did, as 3 to 8 short steps.'),
  nextSteps: z.array(z.string()).describe('The 2 to 5 most useful next actions.'),
});

/** The report's words, for translating: ids and order are kept so it lines up with the original. */
export const TranslationSchema = z.object({
  title: z.string(),
  summary: z.string(),
  scoreNotes: z.object({ stability: z.string(), usability: z.string(), performance: z.string(), accessibility: z.string() }),
  findings: z.array(z.object({ id: z.string(), title: z.string(), what: z.string(), expected: z.string(), fix: z.string(), steps: z.array(z.string()) })),
  suggestions: z.array(z.object({ title: z.string(), why: z.string() })),
  positives: z.array(z.string()),
  journey: z.array(z.string()),
  nextSteps: z.array(z.string()),
});
type TranslatedText = z.infer<typeof TranslationSchema>;

const TRANSLATE = `You translate a software test report between English and Arabic for the team that will act on it. Translate the prose so it reads as if written in that language: clear, concise Modern Standard Arabic, or plain English. Keep exactly as written: ids, code, file paths with line numbers, URLs, numbers and units, error messages, stack traces, and UI labels shown in quotes. Keep every item, in the same order, with the same ids.`;

/** The report's words, to translate. */
export function textOf(r: SessionReport): TranslatedText {
  return {
    title: r.title,
    summary: r.summary,
    scoreNotes: r.scoreNotes,
    findings: r.findings.map((f) => ({ id: f.id, title: f.title, what: f.what, expected: f.expected, fix: f.fix, steps: f.steps })),
    suggestions: r.suggestions.map((x) => ({ title: x.title, why: x.why })),
    positives: r.positives,
    journey: r.journey,
    nextSteps: r.nextSteps,
  };
}

/** The original with its words replaced by the translation (findings matched by id, the rest by position). */
export function withTranslation(r: SessionReport, t: TranslatedText, lang: 'en' | 'ar'): SessionReport {
  const byId = new Map(t.findings.map((f) => [f.id, f]));
  return {
    ...r,
    lang,
    translatedFrom: r.lang,
    title: t.title || r.title,
    summary: t.summary || r.summary,
    scoreNotes: { ...r.scoreNotes, ...t.scoreNotes },
    findings: r.findings.map((f) => {
      const x = byId.get(f.id);
      return x ? { ...f, title: x.title || f.title, what: x.what || f.what, expected: x.expected, fix: x.fix || f.fix, steps: x.steps.length ? x.steps : f.steps } : f;
    }),
    suggestions: r.suggestions.map((x, i) => (t.suggestions[i] ? { ...x, title: t.suggestions[i].title || x.title, why: t.suggestions[i].why || x.why } : x)),
    positives: t.positives.length ? t.positives : r.positives,
    journey: t.journey.length ? t.journey : r.journey,
    nextSteps: t.nextSteps.length ? t.nextSteps : r.nextSteps,
    at: Date.now(),
  };
}

/**
 * Said of a problem the session didn't show: “not triggered in this session”, “never exercised during the recording”.
 * Only words for the problem itself happening: “the message was not seen during the session” is a problem seen.
 */
const UNSEEN = [
  /\b(?:not|never|wasn['’]t|was not|weren['’]t|didn['’]t|did not)\s+(?:been\s+|get\s+|got\s+)?(?:triggered|reproduced|exercised|encountered|happen(?:ed)?|occur(?:red)?|tested)\b[^.]{0,60}?\b(?:in|during|by)\s+(?:this|the)\s+(?:session|recording|run|replay|test)\b/i,
  /لم\s+(?:يحدث|تحدث|يُختبر|تُختبر|يختبر|تختبر)[^.]{0,60}?(?:هذه\s+الجلسة|الجلسة|التسجيل)/,
];

/**
 * The model's findings, kept to what the session showed: evidence ids it doesn't have are dropped; a finding that says
 * the session didn't show it is a test worth adding, not a bug seen; and one without a place in the code gets where its
 * evidence showed, so it can be opened and fixed.
 */
export function settleFindings(raw: z.infer<typeof Finding>[], a: SessionAnalysis): { findings: ReportFinding[]; unseen: ReportSuggestion[] } {
  const items = new Map(a.timeline.map((x) => [x.id, x]));
  const issues = new Map(a.issues.map((g) => [g.id, g]));
  const srcOf = (id: string) => items.get(id)?.src ?? issues.get(id)?.src ?? null;
  const findings: ReportFinding[] = [];
  const unseen: ReportSuggestion[] = [];
  for (const f of raw) {
    if (UNSEEN.some((re) => re.test(`${f.title}. ${f.what}`))) {
      unseen.push({ kind: 'add', title: f.title, why: f.what, effort: 'small' });
      continue;
    }
    const evidence = f.evidence.filter((e) => items.has(e) || issues.has(e));
    const cited = evidence.map(srcOf).find((x): x is string => !!x)?.replace(/:(\d+):\d+$/, ':$1');
    const shown = f.shown || cited || '';
    findings.push({ ...f, id: `F${findings.length + 1}`, evidence, shown, location: f.location || shown });
  }
  return { findings, unseen };
}

/** Asks whatever model does a task for JSON matching a schema (the studio's AI service, or a test's stand-in). */
export type AskJson = <T>(req: { task: AiTask; feature: string; system: string; parts: Part[]; schema: z.ZodType<T>; name: string; maxTokens: number; effort?: AiEffort; cwd?: string }) => Promise<{ value: T; model: string }>;

/** The report, by the model the person chose for reports (any provider, or their plan through its app). */
export class ModelReportWriter implements ReportWriter {
  constructor(
    private ask: AskJson,
    private effort: AiEffort = 'medium',
  ) {}

  async write(input: ReportInput): Promise<SessionReport> {
    const started = Date.now();
    const lang = reportLang(input.meta, input.analysis);
    const pack = evidencePack(input);
    const parts: Part[] = [{ type: 'text', text: pack.text }];
    for (const img of pack.images) {
      parts.push({ type: 'text', text: `Screenshot ${img.id}:` });
      parts.push({ type: 'image', mime: 'image/jpeg', data: img.data });
    }
    parts.push({
      type: 'text',
      text: `Write the session report.${lang === 'ar' ? ' The tester spoke Arabic: write every text field in clear Modern Standard Arabic (keep code, file names, URLs and UI labels as they are).' : ' Write in English.'}`,
    });
    const { value: out, model } = await this.ask({ task: 'report', feature: 'report', system: SYSTEM, parts, schema: ReportSchema, name: 'session_report', maxTokens: 24000, effort: this.effort, cwd: input.project.root });
    const { findings, unseen } = settleFindings(out.findings, input.analysis);
    // The verdict never reads lighter than the findings: a high one is “fix first”, a critical one “blocked”.
    const worst = worstOf(findings.map((f) => f.severity));
    let verdict = worst === 'critical' ? 'blocked' : worst === 'high' && out.verdict === 'ship' ? 'fix-first' : out.verdict;
    // With what the session didn't show set aside, nothing seen that holds it back: the verdict follows what was seen.
    if (unseen.length && worst !== 'critical' && worst !== 'high') verdict = 'ship';
    return {
      lang,
      title: out.title,
      summary: out.summary,
      verdict,
      scoreNotes: out.scoreNotes,
      findings,
      suggestions: [...out.suggestions, ...unseen],
      positives: out.positives,
      journey: out.journey,
      nextSteps: out.nextSteps,
      source: 'ai',
      model,
      at: Date.now(),
      ms: Date.now() - started,
    };
  }

  async translate(report: SessionReport, to: 'en' | 'ar'): Promise<SessionReport> {
    const { value, model } = await this.ask({
      task: 'light',
      feature: 'translate',
      system: TRANSLATE,
      parts: [{ type: 'text', text: `Translate this report into ${to === 'ar' ? 'Arabic' : 'English'}:\n\n${JSON.stringify(textOf(report))}` }],
      schema: TranslationSchema,
      name: 'report_translation',
      maxTokens: 16000,
      effort: 'low',
    });
    // The findings are the writer's; the words are the translator's: both are named.
    return { ...withTranslation(report, value, to), translatedBy: model };
  }
}

// ---- without AI -------------------------------------------------------------------

const CATEGORY: Record<SessionIssue['kind'], FindingCategory> = {
  error: 'bug',
  network: 'reliability',
  console: 'bug',
  frustration: 'usability',
  performance: 'performance',
  said: 'usability',
  observed: 'bug',
  mark: 'usability',
  accessibility: 'accessibility',
};

function fixFor(g: SessionIssue, lang: 'en' | 'ar' = 'en'): string {
  const ar = lang === 'ar';
  switch (g.kind) {
    case 'error':
      if (ar) return g.src ? `راجع ${g.src}: من هناك يُرمى الخطأ. عالج الحالة التي تفشل وأضف اختبارًا لها.` : 'حدّد مكان رمي الخطأ (انظر تتبّع الاستدعاءات) وعالج الحالة التي تفشل.';
      return g.src ? `Look at ${g.src}: the error is thrown there. Guard the failing case and add a test for it.` : 'Find where it is thrown (see the stack) and handle the failing case.';
    case 'network':
      if (ar) return g.title.includes('5') ? 'راجع معالج هذا المسار في الخادم وسجلاته، واعرض للمستخدم رسالة واضحة عند الفشل.' : 'راجع الطلب الذي يرسله التطبيق وعالج هذه الاستجابة في الواجهة.';
      return g.title.includes('5') ? 'Check the server handler and its logs for this endpoint; show the user a clear message when it fails.' : 'Check the request the app sends and handle this response in the UI.';
    case 'frustration':
      return ar ? 'اجعل نتيجة هذا الإجراء ظاهرة: حالة تحميل، أو حالة تعطيل مع سببها، أو رسالة خطأ.' : 'Make the result of this action visible: loading state, disabled state with a reason, or an error message.';
    case 'performance':
      return ar ? 'حلّل أداء هذا التفاعل: أجّل العمل الثقيل، أو خزّن نتيجة الطلب مؤقتًا، أو احجز مساحة في التخطيط.' : 'Profile this interaction; defer heavy work, cache the request, or reserve layout space.';
    case 'said':
      return ar ? 'راجع ما توقّعه المختبِر هنا وعدّل السلوك أو الصياغة.' : 'Review what the tester expected here and adjust the behaviour or the wording.';
    case 'accessibility':
      return ar ? 'أعطه اسمًا تقرؤه التقنيات المساعدة، وهدفًا لا يقل عن 24×24 بكسل.' : 'Give it an accessible name and a target of at least 24×24 px.';
    case 'console':
      return ar ? 'أصلح التحذير من مصدره: كثيرًا ما يخفي خللًا حقيقيًا.' : 'Fix the warning at its source; it often hides a real bug.';
    case 'mark':
      return ar ? 'راجع هذه اللحظة في الخط الزمني ولقطة الشاشة.' : 'Review this moment in the timeline and screenshot.';
    case 'observed':
      return ar ? 'قارن ما ظهر بما كان متوقَّعًا وأصلح السلوك، ثم أعد تشغيل الجلسة للتحقق.' : 'Compare what showed with what was expected and fix the behaviour, then replay the session to check.';
  }
}

/** The issue's detail, and how often it happened (after its first line, so a stack trace stays last). */
function withCount(detail: string, count: number, lang: 'en' | 'ar' = 'en'): string {
  if (count <= 1) return detail;
  const times = lang === 'ar' ? `تكرّر ${count} مرات.` : `Happened ${count} times.`;
  const lines = detail.split('\n');
  lines[0] = lines[0] ? `${lines[0].replace(/[.!?]?\s*$/, '.')} ${times}` : times;
  return lines.join('\n');
}

/** Shortened at a word, with an ellipsis. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return balanced(`${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,:;–-]+$/, '')}…`);
}

/** What the tester did: the pages they opened and what they did there, in order, in at most 8 lines. */
function journey(a: SessionAnalysis, ar: boolean): string[] {
  const did = (s: SessionStep) => {
    const what = ar ? (s.descriptionAr ?? s.description) : s.description;
    return s.kind === 'fill' && s.value && s.checked === undefined ? (ar ? `${what} بـ «${s.value.slice(0, 40)}»` : `${what} with “${s.value.slice(0, 40)}”`) : what;
  };
  const lines = [
    ...a.pages.map((p) => ({ t: p.t, text: ar ? `زار ${p.title || p.url}` : `Visited ${p.title || p.url}` })),
    ...a.steps.filter((s) => s.kind !== 'navigate').map((s) => ({ t: s.t, text: did(s) })),
  ]
    .sort((x, y) => x.t - y.t)
    .map((x) => x.text)
    .filter((text, i, all) => text !== all[i - 1]);
  if (lines.length <= 8) return lines;
  const more = lines.length - 7;
  return [...lines.slice(0, 7), ar ? `و${arCount(more, AR_UNITS.step)} بعد ذلك` : `…and ${more} more steps`];
}

/**
 * The report written on this computer from the analysis alone, in English or
 * Arabic. `note`: why the AI didn't write it, when it should have.
 */
export function localReport(meta: SessionMeta, analysis: SessionAnalysis, note?: { en: string; ar: string }, lang: 'en' | 'ar' = 'en'): SessionReport {
  const ar = lang === 'ar';
  const s = analysis.scores;
  const top = analysis.issues.slice(0, 12);
  const title = (g: SessionIssue) => (ar ? (g.titleAr ?? g.title) : g.title);
  const detail = (g: SessionIssue) => (ar ? (g.detailAr ?? g.detail) : g.detail);
  const findings: ReportFinding[] = top.map((g, i) => {
    // The tester's words about it: the sentence itself for something said, else what they said around that moment about that element.
    const said =
      g.kind === 'said'
        ? analysis.transcript.find((t) => t.start === g.t)
        : analysis.transcript.find((t) => Math.abs(t.start - g.t) < 6000 && !!g.el?.src && g.el.src === t.el?.src && complaintSeverity(t.text) !== null);
    return {
      id: `F${i + 1}`,
      category: CATEGORY[g.kind],
      severity: g.severity,
      title: balanced(title(g).slice(0, 100)),
      what: withCount(detail(g), g.count, lang) || title(g),
      expected: '',
      quote: said?.text ?? '',
      evidence: g.evidence,
      location: g.src ?? g.el?.src ?? '',
      fix: fixFor(g, lang),
      steps: analysis.steps.filter((st) => st.t <= g.t).slice(-6).map((st) => (ar ? (st.descriptionAr ?? st.description) : st.description)),
      confidence: g.kind === 'said' || g.kind === 'mark' || g.kind === 'observed' ? 'medium' : 'high',
    };
  });
  const worst: Severity | null = top[0]?.severity ?? null;
  const counts = meta.counts;
  const positives: string[] = [];
  if (!analysis.issues.some((g) => g.kind === 'error')) positives.push(ar ? 'لا أخطاء JavaScript أثناء الجلسة.' : 'No JavaScript errors during the session.');
  if (!analysis.network.failed && analysis.network.total) positives.push(ar ? `نجحت كل الطلبات (${analysis.network.total}).` : `All ${analysis.network.total} requests succeeded.`);
  if (analysis.perf.lcp != null && analysis.perf.lcp <= 2500) positives.push(ar ? `ظهر المحتوى الرئيسي خلال ${(analysis.perf.lcp / 1000).toFixed(1)} ثانية.` : `Main content appeared in ${(analysis.perf.lcp / 1000).toFixed(1)} s.`);
  if (!analysis.issues.some((g) => g.kind === 'frustration')) positives.push(ar ? 'لا نقرات غاضبة ولا نقرات بلا استجابة.' : 'No rage or dead clicks.');
  const suggestions: ReportSuggestion[] = top.slice(0, 5).map((g) => ({ kind: g.kind === 'performance' || g.kind === 'accessibility' ? 'improve' : 'fix', title: balanced(title(g).slice(0, 90)), why: detail(g).split('\n')[0] || (ar ? 'رُصد في هذه الجلسة.' : 'Found in this session.'), effort: 'small' }));
  if (analysis.steps.length > 2)
    suggestions.push(
      ar
        ? { kind: 'add', title: 'حوّل هذه الجلسة إلى اختبار شامل (end-to-end)', why: `${arCount(analysis.steps.length, AR_UNITS.step)} مسجّلة يمكنها إعادة هذا المسار في CI.`, effort: 'small' }
        : { kind: 'add', title: 'Turn this session into an end-to-end test', why: `${analysis.steps.length} recorded steps can replay this flow in CI.`, effort: 'small' },
    );
  const pages = analysis.pages.length;
  const restarted = (meta.restarts ?? []).map((r) => (ar ? `أُعيد تشغيل الاستوديو عند ${clock(r.at, meta.startedAt)}: ${restartWords(r).ar}` : `The studio restarted at ${clock(r.at, meta.startedAt)}: ${restartWords(r).en}`)).join(' ');
  if (restarted) note = note ? { en: `${note.en} ${restarted}`, ar: `${note.ar} ${restarted}` } : { en: restarted, ar: restarted };
  const summary = ar
    ? `اختبار لمدة ${durationWordsAr(analysis.durationMs)} على ${arCount(pages, AR_UNITS.page)}. النقرات: ${counts.clicks}، الإدخالات: ${counts.inputs}، الجمل المنطوقة: ${analysis.transcript.length}. ${top.length ? `أهم مشكلة: ${title(top[0])}.` : 'لم تُسجَّل أخطاء ولا طلبات فاشلة ولا علامات تعثّر.'}${note ? ` ${note.ar}` : ''}`
    : `${durationWords(analysis.durationMs)} of testing across ${pages} page${pages === 1 ? '' : 's'}: ${counts.clicks} click${counts.clicks === 1 ? '' : 's'}, ${counts.inputs} input${counts.inputs === 1 ? '' : 's'} and ${analysis.transcript.length} spoken comment${analysis.transcript.length === 1 ? '' : 's'}. ${top.length ? `The most important problem: ${top[0].title}.` : 'No errors, failed requests or signs of frustration were recorded.'}${note ? ` ${note.en}` : ''}`;
  const notes = (k: 'stability' | 'usability' | 'performance' | 'accessibility') => (ar ? (s[k].notesAr?.[0] ?? s[k].notes[0]) : s[k].notes[0]) ?? '';
  return {
    lang,
    title: top[0]
      ? ar
        ? `${arCount(totalIssues(analysis), AR_UNITS.issue)}: ${clip(title(top[0]), 64)}`
        : `${totalIssues(analysis).toLocaleString('en-US')} issue${totalIssues(analysis) > 1 ? 's' : ''} found: ${clip(top[0].title, 64)}`
      : ar
        ? `لم تُرصد مشكلات تقنية في ${analysis.pages[0]?.title || 'التطبيق'}`
        : `No technical problems found on ${analysis.pages[0]?.title || 'the app'}`,
    summary,
    verdict: worst === 'critical' ? 'blocked' : worst === 'high' ? 'fix-first' : 'ship',
    scoreNotes: { stability: notes('stability'), usability: notes('usability'), performance: notes('performance'), accessibility: notes('accessibility') },
    findings,
    suggestions,
    positives,
    journey: journey(analysis, ar),
    nextSteps: [
      ...(top.length ? [ar ? `ابدأ بإصلاح «${clip(title(top[0]), 60)}».` : `Fix “${top[0].title.slice(0, 60)}” first.`] : []),
      // A recording can't tell a wrong value from a right one: a check can.
      ...(top.length ? [] : [ar ? 'أضف فحصًا لكل قيمة يجب أن تكون صحيحة، كالإجمالي: لا يستطيع الاستوديو أن يعرف ذلك وحده.' : 'Add a check for each value that must be right, like a total: the studio can’t tell on its own.']),
      ar ? 'اربط ذكاءً اصطناعيًا في الإعدادات ← الذكاء الاصطناعي (مفتاح API، أو اشتراكك في Claude أو ChatGPT أو Gemini) لتحليل مكتوب يحدّد الأسباب الجذرية.' : 'Connect an AI in Settings → AI (an API key, or your Claude, ChatGPT or Gemini plan) for a written analysis with root causes.',
    ],
    source: 'local',
    at: Date.now(),
  };
}
