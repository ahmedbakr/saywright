/**
 * What AI apps connected to Saywright over MCP can do: see the app and what
 * the person is pointing at (with where it was written and the code around
 * it), read and search the code, propose a change the person keeps or undoes
 * in the studio, and read the reports of test sessions.
 */
import { maskSecrets, parseSrc, redactUrl } from '@saywright/vite/protocol';
import type { RefInfo } from '../shared/api.ts';
import { ProposeChange } from './ai/agent.ts';
import { jsonSchemaOf } from './ai/llm/types.ts';
import { applyEditSpecs, listFilesTool, readFileTool, searchTool } from './ai/tools.ts';
import { appAddress, type AppManager } from './apps/manager.ts';
import { HttpError } from './http.ts';
import type { McpTool } from './mcp.ts';

export interface StudioContext {
  /** The app it was for (the context is cleared when another app opens). */
  app: string | null;
  pageUrl: string | null;
  selection: RefInfo[];
  pins: RefInfo[];
  /** The person's last request in the studio (not one the studio wrote for a report or a review), for which app, and when. */
  said: string | null;
  saidApp?: string | null;
  saidAt?: number;
  at: number;
}

interface Deps {
  apps: AppManager;
  context: StudioContext;
  mapRefs: (raw: unknown, pageUrl?: string) => Promise<RefInfo[]>;
  emit: (event: string, data: unknown) => void;
}

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

export function mcpTools(deps: Deps): McpTool[] {
  const open = () => {
    const w = deps.apps.active();
    if (!w) throw new Error('No app is open in Saywright. Open one there first.');
    return w;
  };
  const withCode = () => {
    const w = open();
    if (!w.project.hasCode) throw new Error(`${w.app.name} is linked by its address only, so its code isn’t on this computer. Link its folder in Saywright to read or change it.`);
    return w;
  };
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined);

  return [
    {
      name: 'get_context',
      title: 'What the person is pointing at',
      description:
        'The app open in Saywright, the page, and the elements the person selected or pinned there (by hand, voice or mouse), each with where it was written (file:line) and the code around it. Call this first when they say "this", "that" or "here".',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async () => {
        const w = open();
        const c = deps.context.app === w.app.id ? deps.context : null;
        const lines = [`App: ${w.app.name} (${w.env.label}: ${w.env.url})`, w.project.hasCode ? `Code: ${w.project.root}` : 'Code: not on this computer (linked by address only)'];
        if (c?.pageUrl) lines.push(`Page: ${redactUrl(appAddress(w, c.pageUrl))}`);
        // What is selected is often pinned too (the last of several picked): named once.
        const key = (r: RefInfo) => `${r.src ?? ''}|${r.label}|${r.text}`;
        const selected = new Set(c?.selection.map(key) ?? []);
        const refs = c ? [...c.selection.map((r) => ({ ...r, role: 'selected' })), ...c.pins.filter((r) => !selected.has(key(r))).map((r) => ({ ...r, role: 'pinned' }))] : [];
        if (!refs.length) {
          lines.push('', 'Nothing is selected in the studio right now. Ask the person to point at what they mean (or select it), then call get_context again.');
          return lines.join('\n');
        }
        lines.push('', `Pointed at (${ago(c!.at)}):`);
        const mapped = await deps.mapRefs(refs, c?.pageUrl ?? undefined);
        mapped.forEach((r, i) => {
          const where = r.src ? ` at ${r.src}${r.guessed ? ' (a guess: found by searching the code for its text, not reported by the app; check it)' : ''}` : ' (not traced to a file)';
          lines.push(`${i + 1}. ${refs[i].role}: ${maskSecrets(r.label || r.name)}${r.text ? ` showing “${maskSecrets(r.text).slice(0, 80)}”` : ''}${where}`);
          const at = r.src ? parseSrc(r.src) : null;
          if (at && w.project.hasCode && w.project.exists(at.file)) {
            const text = w.project.read(at.file).split('\n');
            const from = Math.max(1, at.line - 12);
            const to = Math.min(text.length, at.line + 12);
            lines.push('```', ...text.slice(from - 1, to).map((l, k) => `${String(from + k).padStart(4)}${from + k === at.line ? '>' : ' '} ${l}`), '```');
          }
        });
        const said = deps.context;
        if (said.said && said.saidApp === w.app.id) lines.push('', `Last said in the studio (${ago(said.saidAt ?? said.at)}): “${maskSecrets(said.said)}”`);
        return lines.join('\n');
      },
    },
    {
      name: 'propose_change',
      title: 'Show a change in Saywright',
      description:
        'Apply a code change as a live preview in Saywright: the person sees it in their running app and keeps or undoes it there. Give every edit at once. Each old_string must be copied exactly from the current file and match exactly once (an empty old_string creates a new file).',
      inputSchema: jsonSchemaOf(ProposeChange),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: async (args, caller) => {
        const w = withCode();
        const parsed = ProposeChange.safeParse(args);
        if (!parsed.success) throw new Error(`The change didn’t match the expected shape: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        const edits = applyEditSpecs(w.project, parsed.data.edits);
        const change = await w.changes.preview({ title: parsed.data.title.slice(0, 80), summary: parsed.data.summary, said: `From ${caller.name}`, source: 'ai', model: caller.name, edits, latencyMs: 0 }).catch((err: unknown) => {
          // A file saved meanwhile: never written over, and the caller is told to start from it as it is now.
          if (err instanceof HttpError && err.code === 'stale') throw new Error(`${err.message.replace(/ Ask again.*$/, '')} Read the file again and propose the change on it as it is now.`);
          throw err;
        });
        deps.emit('change', { change, via: caller.name });
        return { text: `The change is live in Saywright (${change.files.map((f) => f.path).join(', ')}). The person will keep or undo it there.`, data: { id: change.id, files: change.files.map((f) => f.path) } };
      },
    },
    {
      name: 'read_file',
      title: 'Read a file of the app',
      description: 'Read a file of the open app with line numbers (up to 400 lines at a time).',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relative to the app’s folder' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (a) => readFileTool(withCode().project, str(a.path), int(a.start_line), int(a.end_line)),
    },
    {
      name: 'search_code',
      title: 'Search the app’s code',
      description: 'Search the open app’s files for text (case-insensitive), or a regular expression. When the answer says it searched only some of the files, search a folder (dir) to cover the rest.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, regex: { type: 'boolean' }, dir: { type: 'string', description: 'Only this folder, relative to the app’s folder' } }, required: ['query'], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (a) => searchTool(withCode().project, str(a.query), a.regex === true, str(a.dir)),
    },
    {
      name: 'list_files',
      title: 'List the app’s files',
      description: 'List the open app’s source files under a folder.',
      inputSchema: { type: 'object', properties: { dir: { type: 'string' } }, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (a) => listFilesTool(withCode().project, str(a.dir)),
    },
    {
      name: 'list_sessions',
      title: 'Test sessions',
      description: 'The recorded test sessions of the open app, newest first: when, scores, and the report’s title and findings count.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: () => {
        const w = open();
        const list = w.sessions.store.list().filter((m) => m.source !== 'replay').slice(0, 20);
        if (!list.length) return `No test sessions for ${w.app.name} yet.`;
        return list
          .map((m) => {
            const r = m.status === 'ready' ? w.sessions.store.report(m.id) : null;
            return `- ${m.id} · ${m.name} · ${new Date(m.startedAt).toISOString().slice(0, 16).replace('T', ' ')} · ${m.status}${m.report ? ` · score ${m.report.overall}` : ''}${r ? ` · “${r.title}” (${r.findings.length} findings)` : ''}`;
          })
          .join('\n');
      },
    },
    {
      name: 'get_session_report',
      title: 'A test session’s report',
      description: 'The report of one test session: summary, findings (with where to fix them and the evidence), and suggestions.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'From list_sessions' } }, required: ['id'], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (a) => {
        const w = open();
        const id = str(a.id);
        if (!w.sessions.store.has(id)) throw new Error(`No session ${id} in ${w.app.name}. Call list_sessions for the ids.`);
        const r = w.sessions.store.report(id);
        if (!r) return 'That session has no report yet.';
        const skipped = new Set(w.sessions.store.decisions(id).skipped);
        const out = [`# ${r.title}`, '', r.summary, '', `Verdict: ${r.verdict}`, '', '## Findings'];
        for (const f of r.findings) {
          if (skipped.has(f.id)) continue;
          out.push(`### ${f.id} · ${f.severity} · ${f.category}: ${f.title}`, `What happened: ${f.what}`);
          if (f.expected) out.push(`Expected: ${f.expected}`);
          if (f.quote) out.push(`The tester said: “${f.quote}”`);
          if (f.shown && f.shown !== f.location) out.push(`Showed in: ${f.shown}`);
          if (f.location) out.push(`Where: ${f.location}`);
          out.push(`Fix: ${f.fix}`);
          if (f.steps.length) out.push('Steps:', ...f.steps.map((s, i) => `${i + 1}. ${s}`));
          out.push('');
        }
        if (r.suggestions.length) out.push('## Suggestions', ...r.suggestions.map((s) => `- (${s.kind}) ${s.title}: ${s.why}`));
        return out.join('\n');
      },
    },
  ];
}
