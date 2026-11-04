import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Plugin } from 'vite';
import { AI_TASKS, type AiEffort, type AiTask, type Budget } from '../shared/ai.ts';
import type { Expectation, IntentResult, NextStep, RecordedStep, RefInfo, StatusResponse } from '../shared/api.ts';
import { AppManager } from './apps/manager.ts';
import { envFor } from './apps/registry.ts';
import { appRoutes } from './apps/routes.ts';
import { probeFolder } from './apps/detect.ts';
import { FakeProvider, fakeAutopilotAsk, fakeExpertAsk } from './ai/fake.ts';
import { AiService } from './ai/service.ts';
import { AgentError } from './ai/types.ts';
import { ChangeStore } from './changes.ts';
import { editorRoute } from './editor.ts';
import { keyHint, loadEnvFiles, saveSecret } from './env.ts';
import { readJson, writeFileAtomic, writeJson } from './fsx.ts';
import { speechDir, type StudioLayout } from './layout.ts';
import { EventHub, HttpError, Router, asString } from './http.ts';
import { browserSpeechReady, ensureBrowserSpeech, modelsDir } from './assets.ts';
import { aiHttpError, autopilotRoutes } from './autopilot.ts';
import { inspect } from './inspect.ts';
import { sanitizeRefs } from './refs.ts';
import type { Project } from './project.ts';
import { Metrics } from './metrics.ts';
import { describeOptions, propEdit, quickEdit } from './quick/index.ts';
import { sessionRoutes } from './sessions/routes.ts';
import { Sessions } from './sessions/index.ts';
import { SourceMapper } from './sessions/sourcemap.ts';
import { Tracer, type Traceable } from './trace.ts';
import { ModelReportWriter } from './sessions/report.ts';
import { McpServer, clientToken } from './mcp.ts';
import { mcpTools, type StudioContext } from './mcp-tools.ts';
import { GoogleConnector, type GoogleSettings } from './connectors/google.ts';
import { ReviewStore, aiReview, installSkills, reviewPage } from './experts/index.ts';
import { EXPERTS, skillFile } from './experts/instructions.ts';
import { STUDIO_PORT, STUDIO_URL, type ExpertId, type PageReview } from '@saywright/vite/protocol';
import type { SpeechLang } from './speech/catalog.ts';
import { SpeechService } from './speech/service.ts';
import { sanitizeSteps, writeSpec } from './tests/generate.ts';
import { installBrowser, runSpec } from './tests/run.ts';
import { secretKey, TestSecrets } from './tests/secrets.ts';

/** Connect-style middleware, as Vite and the standalone server mount it. */
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => unknown;

interface StudioSettings {
  /** Speech model chosen per language (null: the best installed). */
  speech?: Partial<Record<SpeechLang, string | null>>;
  /** Before AI connections: the Claude model and effort (moved to ai.json on first start). */
  model?: string;
  effort?: AiEffort;
  /** The quick-start tour was taken or skipped: it doesn't start by itself again, in any browser. */
  tourSeen?: boolean;
}

const DEFAULT_SETTINGS: StudioSettings = {};

async function discoverRoot(url: string): Promise<string | null> {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(new URL('/__saywright/info', url), { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const info = (await res.json()) as { root?: string };
        if (info.root && fs.existsSync(info.root)) return info.root;
      }
    } catch {
      /* app not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

export async function createStudioApi(layout: StudioLayout) {
  loadEnvFiles(layout.envDir);
  const { dataDir } = layout;
  fs.mkdirSync(dataDir, { recursive: true });
  const hub = new EventHub();
  const inflight = new Map<string, AbortController>();
  let studioOrigin = STUDIO_URL;

  const settingsFile = path.join(dataDir, 'studio.json');
  const settings: StudioSettings = { ...DEFAULT_SETTINGS, ...readJson<StudioSettings>(settingsFile) };
  const saveSettings = () => writeJson(settingsFile, settings);

  const fake = process.env.SAYWRIGHT_AI === 'fake';
  // What the person is pointing at, as the studio last said: for AI apps connected over MCP.
  const context: StudioContext = { app: null, pageUrl: null, selection: [], pins: [], said: null, at: 0 };

  // Saywright as an MCP server: AI apps the person uses see what they point at and propose changes here.
  const mcp = new McpServer({
    name: 'saywright',
    version: layout.version,
    instructions:
      'Saywright shows the person’s running web app. Call get_context to see the app, the page and the elements the person is pointing at (with their source location and code). Propose changes with propose_change: the person sees them live in the app and keeps or undoes them. Read code with read_file and search_code.',
    token: () => clientToken(dataDir),
    tools: () => mcpTools({ apps, context, mapRefs: (raw, pageUrl) => mapRefs(raw, pageUrl), emit: (event, data) => hub.emit(event, data) }),
  });

  const ai = new AiService({
    dataDir,
    envDir: layout.envDir,
    mcp,
    origin: () => studioOrigin,
    app: () => {
      const w = apps.active();
      return w ? { id: w.app.id, name: w.app.name } : null;
    },
    appNames: () => Object.fromEntries(apps.registry.list().map((a) => [a.id, a.name])),
    fake: fake ? () => new FakeProvider() : undefined,
  });
  ai.onUsage = () => hub.emit('usage', usagePill());
  // Settings from before AI connections: the chosen Claude model becomes the route for code.
  if (settings.model || settings.effort) {
    if (settings.model && !ai.connections.config.routes.code) ai.connections.setRoute('code', { connection: 'anthropic', model: settings.model });
    if (settings.effort) ai.connections.setEffort(settings.effort);
    delete settings.model;
    delete settings.effort;
    saveSettings();
  }
  const model = process.env.SAYWRIGHT_MODEL;
  if (model) ai.connections.config.routes.code = { connection: 'anthropic', model };
  void ai.connections.refresh(true);

  const usagePill = () => {
    const sum = ai.usage.totals();
    const status = ai.usage.status();
    return { usd: sum.today.usd, planUsd: sum.today.planUsd, tokens: sum.today.input + sum.today.output + sum.today.cacheRead + sum.today.cacheWrite, calls: sum.today.calls, level: status.level, message: status.message };
  };
  /** Who answers, for changes and answers ("Claude Opus 5.5", "Sonnet (your plan)"). */
  const aiLabel = () => {
    const w = ai.who('code');
    return w ? (w.plan ? `${w.model} · ${w.label.replace(/ \(.*$/, '')} plan` : w.model) : undefined;
  };
  const noAi = 'That request needs an AI. Connect one in Settings → AI: your Claude, ChatGPT or Gemini plan, an API key, or a model on this computer.';
  /** An app linked by its address alone: the studio can test and review it, but has no code to change. */
  const addressOnly = (name: string): IntentResult => ({ kind: 'message', text: `${name} is linked by its address only, so the studio can’t see its code. Link its code folder to make changes.`, tone: 'info', next: [{ kind: 'link-folder' }] });

  const speech = new SpeechService(
    speechDir(layout),
    layout.speechWorker,
    (event, data) => hub.emit(event, data),
    () => settings.speech ?? {},
  );

  // Each linked app gets its own workspace: its code, previews, sessions and metrics.
  const apps = new AppManager({
    dataDir,
    emit: (event, data) => hub.emit(event, data),
    studio: () => studioOrigin,
    proxyPort: Number(process.env.SAYWRIGHT_PROXY_PORT) || undefined,
    build: (project) => ({
      changes: new ChangeStore(project),
      metrics: new Metrics(project),
      mapper: new SourceMapper(project),
      sessions: new Sessions({
        project,
        speech,
        emit: (event, data) => hub.emit(event, data),
        // Fake AI (tests) writes reports locally, like having no AI connected.
        writer: () => (!fake && ai.connections.route('report') ? new ModelReportWriter((r) => ai.json(r), ai.effort) : null),
      }),
    }),
  });
  const ws = () => apps.require();

  // An app connected with `npm run connect` (it leaves target.json in the data folder): linked, or brought up to date
  // when it already is, and opened first. Then the file has done its job.
  const connected = path.join(dataDir, 'target.json');
  if (fs.existsSync(connected)) {
    try {
      const t = JSON.parse(fs.readFileSync(connected, 'utf8')) as { url: string; root: string; start?: string | null };
      const known = apps.registry.find(t.root);
      let app = known ?? apps.link(probeFolder(t.root), { url: t.url, start: t.start ?? null });
      if (known) {
        const env = known.envs.find((e) => new URL(e.url).origin === new URL(t.url).origin);
        if (!env) app = apps.registry.setEnv(known.id, envFor(t.url, known.envs[0]?.connection ?? 'plugin'));
        app = apps.registry.update(app.id, { start: t.start ?? null, env: (env ?? app.envs[app.envs.length - 1]).id });
      }
      apps.registry.touch(app.id);
      fs.rmSync(connected, { force: true });
      // Not waited for: its dev server may take a while, and the studio shows it opening (or why it can't).
      if (!process.env.SAYWRIGHT_TARGET_URL) void apps.open(app.id).catch(() => undefined);
    } catch (err) {
      console.warn('[saywright] couldn’t link the connected app:', err instanceof Error ? err.message : err);
    }
  }

  // Started for a given app (npm run dev -- --target, the tests): open it straight away.
  const targetUrl = process.env.SAYWRIGHT_TARGET_URL;
  if (targetUrl) {
    const root = process.env.SAYWRIGHT_TARGET_ROOT || (await discoverRoot(targetUrl));
    try {
      await apps.openTarget(targetUrl, root);
    } catch (err) {
      console.warn(`[saywright] ${targetUrl}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // A recording the studio was making when it stopped goes on, if its page comes back (see Sessions.recover).
  apps.restoreRecordings();

  const status = (): StatusResponse => {
    const w = apps.active();
    const project = w?.project;
    return {
      version: layout.version,
      app: w ? { id: w.app.id, name: w.app.name, env: w.env, envs: w.app.envs, framework: w.app.framework ?? null, icon: w.app.icon ?? null, sample: !!w.app.sample } : null,
      target: {
        root: project?.hasCode ? project.root : null,
        url: project?.url ?? '',
        frameUrl: w?.frameUrl ?? '',
        name: w?.app.name ?? '',
        hasConfig: !!project?.hasCode && project.hasConfig,
        components: project?.hasCode ? Object.keys(project.config.components) : [],
        git: !!project?.isGit,
        hasCode: !!project?.hasCode,
      },
      ai: {
        ready: fake || !!ai.connections.route('code'),
        source: fake ? 'fake' : (ai.who('code')?.connection ?? null),
        who: fake ? { connection: 'fake', label: 'Test stand-in', model: 'fake', plan: false } : ai.who('code'),
        effort: ai.effort,
        usage: usagePill(),
      },
      tests: { playwright: !!project?.hasPlaywright },
      launcher: apps.launcher,
      tourSeen: settings.tourSeen === true,
      opening: apps.opening,
    };
  };

  const router = new Router();

  // Apps without the Vite plugin report where elements come from as bundle positions: map them to source.
  const tracer = () => {
    const w = apps.active();
    return w ? new Tracer(w.project, w.mapper) : null;
  };
  const toSource = async (src: unknown): Promise<string | null> => (await tracer()?.toSource(src)) ?? null;
  /** Where a component is used in the app's code (`<Card …`), its tests and stories left out; a quick look, at most USES_LIMIT. */
  const USES_LIMIT = 20;
  const usesOf = async (project: Project, component: string): Promise<number> => {
    try {
      const found = await project.search(`<${component.replace(/\$/g, '\\$')}[\\s/>]`, { regex: true, limit: USES_LIMIT * 2, budgetMs: 400 });
      return Math.min(USES_LIMIT, found.hits.filter((h) => !/\.(test|spec|stories)\.[jt]sx?$/.test(h.path)).length);
    } catch {
      return 0;
    }
  };

  /** Each ref's source location: as the page said (mapped from bundles), or found in the code by what identifies it (a guess). */
  const mapRefs = async (raw: unknown, pageUrl?: string): Promise<RefInfo[]> => {
    const list = Array.isArray(raw) ? raw.slice(0, 6) : [];
    const t = tracer();
    const traced = await Promise.all(list.map((r) => (t && r && typeof r === 'object' ? t.trace(r as Traceable, pageUrl).catch(() => null) : null)));
    const refs = sanitizeRefs(list.map((r, i) => (r && typeof r === 'object' ? { ...(r as object), src: traced[i]?.src ?? null } : r)));
    refs.forEach((r, i) => {
      if (r.src && traced[i]?.guessed) r.guessed = true;
    });
    return refs;
  };

  router.get('/status', () => status());
  router.put('/tour', (req) => {
    settings.tourSeen = (req.body as { seen?: unknown } | undefined)?.seen !== false;
    saveSettings();
    return { seen: settings.tourSeen };
  });
  // The studio's own page only: changes carry code, app logs can carry secrets.
  router.get('/events', (_req, res) => hub.attach(res));
  autopilotRoutes(router, {
    sessions: (id) => apps.forSession(id).sessions,
    ask: (input) => (fake ? fakeAutopilotAsk(input) : ai.connections.route('report') ? (r) => ai.json(r) : null),
    gate: () => ai.gate(),
  });
  sessionRoutes(router, {
    active: () => apps.active(),
    forSession: (id) => apps.forSession(id),
    speech,
    saveSpeechChoice: (lang, id) => {
      settings.speech = { ...settings.speech, [lang]: id };
      saveSettings();
    },
    live: (res, id) => hub.attach(res, (event, data) => event === 'session' && (data as { id?: unknown }).id === id),
  });
  appRoutes(router, { apps, emit: (event, data) => hub.emit(event, data), sample: layout.sample });
  router.post('/apps/close', () => {
    apps.deactivate();
    return apps.state();
  });

  router.post('/intent', async (req): Promise<IntentResult> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = asString(body.text, 'text', 2000).trim();
    if (!text) throw new HttpError(400, 'Say or type something first');
    const requestId = typeof body.requestId === 'string' ? body.requestId.slice(0, 40) : String(Date.now());
    const pageUrl = typeof body.pageUrl === 'string' ? body.pageUrl.slice(0, 500) : undefined;
    const refs = await mapRefs(body.refs, pageUrl);
    // Several findings or suggestions from a session report, with their evidence.
    const brief = typeof body.brief === 'string' && body.brief.trim() ? body.brief.slice(0, 16_000) : undefined;
    const started = Date.now();
    const base = {
      type: 'command',
      text,
      words: text.split(/\s+/).length,
      input: body.input === 'voice' ? 'voice' : 'typed',
      pointer: body.pointer === 'hand' || body.pointer === 'mouse' ? body.pointer : 'none',
      refs: refs.length,
    };
    const progress = (step: string, detail?: string) => hub.emit('progress', { requestId, step, detail });
    const current = ws();
    const { project, changes, metrics } = current;
    // What the person asked, for MCP's get_context: not the studio's own brief for a report's or a review's findings.
    if (!brief) Object.assign(context, { said: text, saidApp: current.app.id, saidAt: Date.now() });
    if (!project.hasCode) return addressOnly(current.app.name);

    // "Ask the AI anyway" skips the quick edits.
    const quick = brief || body.ai === true ? null : quickEdit(text, refs, project);
    if (quick?.kind === 'edit') {
      // A component used in other places changes there too: said before it is kept.
      const uses = quick.component ? await usesOf(project, quick.component) : 0;
      if (uses > 1) {
        if (!refs[0]?.same) quick.title += ` · ${quick.component} is used in ${uses}${uses >= USES_LIMIT ? '+' : ''} places`;
        quick.summary += ` ${quick.component} is used in ${uses}${uses >= USES_LIMIT ? ' or more' : ''} places in your code: it changes in all of them.`;
      }
      const change = await changes.preview({ title: quick.title, summary: quick.summary, said: text, refs, source: 'quick', edits: quick.edits, latencyMs: Date.now() - started });
      metrics.record({ ...base, result: 'change', source: 'quick', latencyMs: change.latencyMs, changeId: change.id });
      return { kind: 'change', change };
    }
    if (quick?.kind === 'message') {
      metrics.record({ ...base, result: 'message', source: 'quick' });
      // Asking the AI is a way forward only with one connected; otherwise connecting one is.
      const ready = fake || !!ai.connections.route('code');
      const next = quick.next?.map((n): NextStep => (n.kind === 'ask-ai' && !ready ? { kind: 'connect-ai' } : n));
      return { kind: 'message', text: quick.text, tone: quick.tone === 'warn' ? 'warn' : 'info', ...(next?.length ? { next } : {}) };
    }

    const agent = ai.agent(/^\s*(why|what|where|how|which|when|is|are|does|do|can)\b/i.test(text) ? 'answer' : 'edit');
    if (!agent) {
      metrics.record({ ...base, result: 'needs-key' });
      // Why the quick edit couldn't, and the code to change by hand meanwhile.
      if (quick?.kind === 'needs-ai') return { kind: 'needs-key', text: quick.why, next: [{ kind: 'connect-ai' }, ...(quick.src ? [{ kind: 'open' as const, src: quick.src }] : [])] };
      const options = describeOptions(project, refs[0]);
      return { kind: 'needs-key', text: `${noAi}${options ? ` Without one, quick edits still work: ${options}` : ''}` };
    }
    const model = fake ? agent.model : aiLabel();

    const ctl = new AbortController();
    inflight.set(requestId, ctl);
    try {
      const out = await agent.run({ text, refs, mode: 'edit', pageUrl, brief }, { project, progress, signal: ctl.signal });
      const latencyMs = Date.now() - started;
      if (out.kind === 'change') {
        const change = await changes.preview({ title: out.title, summary: out.summary, said: text, refs, source: agent.source, model, edits: out.edits, latencyMs });
        metrics.record({ ...base, result: 'change', source: agent.source, model, latencyMs, changeId: change.id });
        return { kind: 'change', change };
      }
      metrics.record({ ...base, result: 'answer', source: agent.source, model, latencyMs });
      return { kind: 'answer', text: out.text, source: agent.source, model, latencyMs };
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) return { kind: 'message', text: 'The change didn’t modify anything. Try rephrasing.', tone: 'info' };
      const e = err instanceof AgentError ? err : new AgentError(err instanceof Error ? err.message : String(err), 'other');
      metrics.record({ ...base, result: 'error', code: e.code });
      if (e.code === 'no-key' || e.code === 'auth') return { kind: 'needs-key', text: e.message };
      return { kind: 'message', text: e.message, tone: e.code === 'aborted' ? 'info' : e.code === 'budget' ? 'warn' : 'error' };
    } finally {
      inflight.delete(requestId);
    }
  });

  router.post('/props', async (req): Promise<IntentResult> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const src = asString(body.src, 'src', 300);
    const prop = asString(body.prop, 'prop', 60);
    const value = asString(body.value, 'value', 60);
    const started = Date.now();
    const { project, changes, metrics } = ws();
    const r = propEdit(project, src, prop, value);
    if (r.kind === 'message') return { kind: 'message', text: r.text, tone: r.tone };
    const change = await changes.preview({ title: r.title, summary: r.summary, said: `${prop}: ${value}`, source: 'quick', edits: r.edits, latencyMs: Date.now() - started });
    metrics.record({ type: 'command', text: `${prop}=${value}`, words: 1, input: 'inspector', pointer: 'none', refs: 1, result: 'change', source: 'quick', latencyMs: change.latencyMs, changeId: change.id });
    return { kind: 'change', change };
  });

  router.post('/cancel', (req) => {
    const id = (req.body as { requestId?: string } | undefined)?.requestId;
    if (id) inflight.get(id)?.abort();
    return { ok: true };
  });

  router.get('/changes', () => ({ changes: apps.active()?.changes.list() ?? [] }));

  router.post('/changes/keep', async (req) => {
    const body = (req.body ?? {}) as { id?: string; commit?: boolean; via?: string };
    const { changes, metrics } = ws();
    const { kept } = changes.keep(body.id);
    for (const c of kept) metrics.record({ type: 'decision', changeId: c.id, decision: 'kept', via: body.via, decisionMs: (c.decidedAt ?? 0) - c.createdAt });
    const commit = body.commit ? await changes.commit(kept) : null;
    return { kept, committed: !!commit?.committed, ...(commit?.error ? { commitError: commit.error } : {}) };
  });

  router.post('/changes/undo', async (req) => {
    const body = (req.body ?? {}) as { id?: string; force?: boolean; via?: string };
    const { changes, metrics } = ws();
    const undone = await changes.undo(body.id, { force: !!body.force });
    for (const c of undone) metrics.record({ type: 'decision', changeId: c.id, decision: 'undone', via: body.via, decisionMs: (c.decidedAt ?? 0) - c.createdAt });
    return { undone };
  });

  router.get('/inspect', async (req) => {
    const raw = req.query.get('src');
    if (!raw) throw new HttpError(400, 'src is required');
    const src = await toSource(raw);
    if (!src) throw new HttpError(404, 'Couldn’t trace this element to a source file');
    return { result: inspect(ws().project, src) };
  });

  /** The Inspector for an element as the page described it: traced through its frames, or found by its text (then `guessed`). */
  router.post('/inspect', async (req) => {
    const body = (req.body ?? {}) as { ref?: unknown; pageUrl?: unknown };
    const { project } = ws();
    const ref = body.ref && typeof body.ref === 'object' ? (body.ref as Traceable) : {};
    const pageUrl = typeof body.pageUrl === 'string' ? body.pageUrl.slice(0, 500) : undefined;
    const traced = (await tracer()?.trace(ref, pageUrl)) ?? { src: null, guessed: false };
    const result = traced.src ? inspect(project, traced.src) : null;
    return { result: result && traced.guessed ? { ...result, guessed: true } : result };
  });

  /** The secrets this app's tests type, saved on this computer for runs and replays (with the studio's data, outside the app). */
  const secretsOf = (w: { app: { id: string } }) => new TestSecrets(path.join(dataDir, 'secrets', `${w.app.id}.json`));
  /** Where a test run's configuration and report go: the studio's data, never the app's code. */
  const runsDir = (w: { app: { id: string } }) => path.join(dataDir, 'test-runs', w.app.id);

  router.post('/tests/generate', (req) => {
    const body = (req.body ?? {}) as { name?: string; startUrl?: string; steps?: RecordedStep[]; expectations?: Expectation[]; replace?: { path?: unknown; code?: unknown } };
    if (!Array.isArray(body.expectations) || !body.expectations.length) throw new HttpError(400, 'Say what you expected first');
    const { project, metrics } = ws();
    if (!project.hasCode) throw new HttpError(409, 'A test is saved with your app’s code, and this app has none on this computer: link its folder to write tests.', 'no-code');
    const spec = writeSpec(project, {
      name: body.name,
      startUrl: typeof body.startUrl === 'string' ? body.startUrl : project.url,
      // Whatever sent them, secrets go in as names only.
      steps: sanitizeSteps(Array.isArray(body.steps) ? body.steps.slice(0, 100) : []),
      expectations: body.expectations.slice(0, 20),
    }, typeof body.replace?.path === 'string' && typeof body.replace.code === 'string' ? { path: body.replace.path, code: body.replace.code } : undefined);
    metrics.record({ type: 'test-generated', path: spec.path, steps: body.steps?.length ?? 0 });
    return spec;
  });

  router.post('/tests/run', async (req) => {
    const body = (req.body ?? {}) as { path?: unknown; baseline?: unknown };
    const rel = asString(body.path, 'path', 300);
    const baseline = typeof body.baseline === 'string' ? body.baseline.slice(0, 64) : undefined;
    const current = ws();
    const { project, metrics } = current;
    const result = await runSpec(project, rel, { baseUrl: project.url, workDir: runsDir(current), secrets: secretsOf(current).all(), baseline });
    metrics.record({ type: 'test', path: rel, status: result.status, durationMs: result.durationMs, verified: result.verified ?? false });
    return result;
  });

  // Which secrets are set, never their values; saving one; and the values a replay types (for the studio's own page only).
  router.get('/tests/secrets', () => secretsOf(ws()).names());
  router.put('/tests/secrets', (req) => {
    const body = (req.body ?? {}) as { name?: unknown; value?: unknown };
    const name = secretKey(asString(body.name, 'name', 60));
    const value = body.value === undefined ? '' : asString(body.value, 'value', 4000);
    const store = secretsOf(ws());
    store.set(name, value);
    return store.names();
  });
  router.post('/tests/secrets/values', (req) => {
    const names = (req.body as { names?: unknown } | undefined)?.names;
    if (!Array.isArray(names)) throw new HttpError(400, 'Expected { names }');
    const store = secretsOf(ws());
    const out: Record<string, string> = {};
    for (const n of names.slice(0, 20)) {
      if (typeof n !== 'string') continue;
      const v = store.get(n);
      if (v) out[secretKey(n)] = v;
    }
    return { values: out };
  });

  router.post('/tests/install', async () => {
    const ok = await installBrowser(ws().project, (line) => hub.emit('install', { line }));
    return { ok };
  });

  router.post('/fix', async (req): Promise<IntentResult> => {
    const body = (req.body ?? {}) as { path?: unknown; failure?: unknown; refs?: unknown; requestId?: unknown; text?: unknown; input?: unknown };
    const rel = asString(body.path, 'path', 300);
    const failure = asString(body.failure ?? '', 'failure', 4000);
    const text = body.text === undefined ? '' : asString(body.text, 'text', 2000).trim();
    // Asked for by voice, typed in the command bar, or with a button (Fix it, the palette).
    const input = body.input === 'voice' || body.input === 'typed' ? body.input : 'button';
    const current = ws();
    const { project, changes, metrics } = current;
    if (!project.hasCode) return addressOnly(current.app.name);
    const agent = ai.agent('fix');
    if (!agent) return { kind: 'needs-key', text: noAi };
    const model = fake ? agent.model : aiLabel();
    const requestId = typeof body.requestId === 'string' ? body.requestId.slice(0, 40) : String(Date.now());
    const progress = (step: string, detail?: string) => hub.emit('progress', { requestId, step, detail });
    const ctl = new AbortController();
    inflight.set(requestId, ctl);
    const started = Date.now();
    try {
      const testCode = project.read(rel);
      const out = await agent.run(
        { text: text || 'Fix the bug this test shows.', refs: await mapRefs(body.refs), mode: 'fix', test: { path: rel, code: testCode, failure } },
        { project, progress, signal: ctl.signal },
      );
      const latencyMs = Date.now() - started;
      if (out.kind === 'change') {
        // A fix is checked against the test as it was recorded: a change to that test is left out, or the test would prove nothing.
        const normalized = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
        const kept = out.edits.filter((e) => normalized(e.path) !== normalized(rel));
        const dropped = out.edits.length - kept.length;
        if (!kept.length) {
          metrics.record({ type: 'command', text: text || 'fix it', input, result: 'refused', source: agent.source, latencyMs, fix: true });
          return { kind: 'message', tone: 'warn', text: `${aiLabel()} only changed the test, not your app. A fix is checked against the test as you recorded it, so that change was left out. If the test itself is wrong, record it again or edit it yourself.` };
        }
        const summary = dropped ? `${out.summary}\n\nIt also changed the test it is checked against; that part was left out, so the test still checks what you recorded.` : out.summary;
        const change = await changes.preview({ title: out.title, summary, said: text || 'fix it', source: agent.source, model, edits: kept, latencyMs });
        metrics.record({ type: 'command', text: text || 'fix it', input, result: 'change', source: agent.source, latencyMs, fix: true, changeId: change.id });
        return { kind: 'change', change };
      }
      return { kind: 'answer', text: out.text, source: agent.source, model, latencyMs };
    } catch (err) {
      const e = err instanceof AgentError ? err : new AgentError(err instanceof Error ? err.message : String(err), 'other');
      if (e.code === 'no-key' || e.code === 'auth') return { kind: 'needs-key', text: e.message };
      return { kind: 'message', text: e.message, tone: e.code === 'aborted' ? 'info' : e.code === 'budget' ? 'warn' : 'error' };
    } finally {
      inflight.delete(requestId);
    }
  });

  // The on-device voice model the studio's page runs (28 MB), downloaded once from Settings → Voice.
  let voiceDownload: Promise<void> | null = null;
  router.get('/voice-model', () => ({ ready: browserSpeechReady(dataDir), mb: 28, setup: layout.setupCommand }));
  router.post('/voice-model', async () => {
    voiceDownload ??= ensureBrowserSpeech(dataDir).finally(() => (voiceDownload = null));
    try {
      await voiceDownload;
    } catch (err) {
      throw new HttpError(502, `The voice model didn’t download (${err instanceof Error ? err.message : err}). Try again, or run ${layout.setupCommand}.`);
    }
    return { ready: true, mb: 28, setup: layout.setupCommand };
  });

  // ── AI connections, models, usage and budget ──
  // Where keys saved from Settings go, as the person would find it (~/.saywright/.env.local).
  const envFile = path.join(layout.envDir, '.env.local');
  const keysFile = envFile.startsWith(os.homedir() + path.sep) ? `~${envFile.slice(os.homedir().length)}` : envFile;
  const aiState = async (refresh = false) => ({ ...(await ai.state(refresh)), mcp: { url: `${studioOrigin}/api/mcp`, token: clientToken(dataDir), stdio: layout.mcpCommand }, keysFile });
  router.get('/ai', (req) => aiState(req.query.get('refresh') === '1'));
  router.put('/ai/key', async (req) => {
    const body = (req.body ?? {}) as { connection?: unknown; key?: unknown };
    const id = asString(body.connection, 'connection', 60);
    const key = body.key === null ? null : asString(body.key, 'key', 400).trim();
    if (key !== null) {
      if (key.length < 8 || /\s/.test(key)) throw new HttpError(400, 'That doesn’t look like an API key.');
      if (id === 'anthropic' && !/^sk-ant-/.test(key)) throw new HttpError(400, 'That doesn’t look like an Anthropic API key (it starts with sk-ant-).');
      if (id === 'openai' && !/^sk-/.test(key)) throw new HttpError(400, 'That doesn’t look like an OpenAI API key (it starts with sk-).');
    }
    ai.connections.setKey(id, key);
    return aiState(true);
  });
  // The studio's first key screen, before connections: an Anthropic key.
  router.post('/ai/key', (req) => {
    const key = asString((req.body as { apiKey?: unknown } | undefined)?.apiKey, 'apiKey', 400).trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) throw new HttpError(400, 'That doesn’t look like an Anthropic API key (it starts with sk-ant-).');
    ai.connections.setKey('anthropic', key);
    return status();
  });
  router.post('/ai/connections', async (req) => {
    const body = (req.body ?? {}) as { preset?: unknown; label?: unknown; baseUrl?: unknown; key?: unknown; models?: unknown };
    try {
      ai.connections.addCustom({
        preset: asString(body.preset, 'preset', 40),
        label: typeof body.label === 'string' ? body.label.slice(0, 60) : undefined,
        baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.slice(0, 300) : undefined,
        key: typeof body.key === 'string' && body.key.trim() ? body.key.trim().slice(0, 400) : undefined,
        models: Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === 'string').map((m) => m.slice(0, 120)) : undefined,
      });
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    return aiState(true);
  });
  router.delete('/ai/connections/:id', async (req) => {
    ai.connections.removeCustom(req.params.id);
    return aiState();
  });
  router.put('/ai/connections/:id', async (req) => {
    const body = (req.body ?? {}) as { off?: unknown; model?: unknown };
    if (typeof body.off === 'boolean') ai.connections.setOff(req.params.id, body.off);
    if (typeof body.model === 'string' && body.model.trim()) ai.connections.addModel(req.params.id, body.model.trim().slice(0, 120));
    return aiState(typeof body.model === 'string');
  });
  router.put('/ai/routes', async (req) => {
    const body = (req.body ?? {}) as { task?: unknown; connection?: unknown; model?: unknown };
    const task = asString(body.task, 'task', 20) as AiTask;
    if (!AI_TASKS.some((t) => t.id === task)) throw new HttpError(400, 'Unknown task');
    ai.connections.setRoute(task, typeof body.connection === 'string' && typeof body.model === 'string' ? { connection: body.connection, model: body.model.slice(0, 120) } : null);
    return aiState();
  });
  router.put('/ai/effort', async (req) => {
    const effort = (req.body as { effort?: unknown } | undefined)?.effort;
    if (effort !== 'low' && effort !== 'medium' && effort !== 'high') throw new HttpError(400, 'effort is low, medium or high');
    ai.connections.setEffort(effort);
    return aiState();
  });
  router.post('/ai/test', async (req) => {
    if (fake) return { ok: true, message: 'Fake AI is on (tests).' };
    const id = (req.body as { connection?: unknown } | undefined)?.connection;
    const route = ai.connections.route('code');
    return ai.test(typeof id === 'string' ? id : (route?.connection.id ?? 'anthropic'));
  });
  router.get('/ai/usage', () => ai.usage.summary(Date.now(), Object.fromEntries(apps.registry.list().map((a) => [a.id, a.name]))));
  router.put('/ai/budget', (req) => {
    const body = (req.body ?? {}) as Partial<Budget>;
    ai.usage.setBudget(body);
    hub.emit('usage', usagePill());
    return ai.usage.summary();
  });
  router.post('/ai/usage/reset', (req) => {
    const scope = (req.body as { scope?: unknown } | undefined)?.scope;
    if (scope !== 'today' && scope !== 'month' && scope !== 'all') throw new HttpError(400, 'scope is today, month or all');
    ai.usage.reset(scope);
    hub.emit('usage', usagePill());
    return ai.usage.summary();
  });

  // What the person points at, from the studio: for AI apps connected over MCP. Elements are traced to source here as
  // the Inspector traces them (React's frames, bundle positions, a search as a guess). A newer context wins over a
  // slower older one.
  let contextSeq = 0;
  router.put('/context', async (req) => {
    const body = (req.body ?? {}) as { pageUrl?: unknown; selection?: unknown; pins?: unknown; said?: unknown };
    const seq = ++contextSeq;
    const pageUrl = typeof body.pageUrl === 'string' ? body.pageUrl.slice(0, 500) : null;
    const [selection, pins] = await Promise.all([mapRefs(body.selection, pageUrl ?? undefined), mapRefs(body.pins, pageUrl ?? undefined)]);
    if (seq !== contextSeq) return { ok: true };
    context.app = apps.active()?.app.id ?? null;
    context.pageUrl = pageUrl;
    context.selection = selection;
    context.pins = pins;
    if (typeof body.said === 'string') Object.assign(context, { said: body.said.slice(0, 500), saidApp: context.app, saidAt: Date.now() });
    context.at = Date.now();
    return { ok: true };
  });

  // The MCP endpoint (POST; GET and DELETE answer 405 as the protocol expects of a server without streams).
  router.post('/mcp', (req, res) => mcp.handle(req.raw, res, req.body));
  router.get('/mcp', (req, res) => mcp.handle(req.raw, res, null));
  router.delete('/mcp', (req, res) => mcp.handle(req.raw, res, null));

  // ── Experts: SEO, content, UI/UX and accessibility reviews of a page ──
  const google = new GoogleConnector(dataDir, () => process.env.PAGESPEED_API_KEY);
  const reviews = () => new ReviewStore(path.join(ws().project.stateDir(), 'reviews'));
  const googleSettingsFile = () => path.join(ws().project.stateDir(), 'google.json');
  const googleSettings = (): GoogleSettings => readJson<GoogleSettings>(googleSettingsFile()) ?? {};
  /** A page's own address: through the proxy, the site behind it. */
  const realUrl = (url: string) => apps.proxy.upstreamFor(url) ?? url;
  /** Its public address, for Google's data: the page itself, or the same path on the app's production address. */
  const publicUrl = (url: string): string | null => {
    try {
      const u = new URL(url);
      if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return url;
      const prod = ws().app.envs.find((e) => e.kind === 'remote');
      return prod ? new URL(u.pathname + u.search, prod.url).href : null;
    } catch {
      return null;
    }
  };
  const EXPERT_IDS = new Set<ExpertId>(['seo', 'content', 'ux', 'a11y']);
  const expertsOf = (v: unknown): ExpertId[] => (Array.isArray(v) ? v.filter((x): x is ExpertId => EXPERT_IDS.has(x as ExpertId)) : []);

  router.post('/experts/review', async (req) => {
    const body = (req.body ?? {}) as { review?: PageReview; experts?: unknown };
    const review = body.review;
    if (!review || typeof review !== 'object' || !Array.isArray(review.checks) || !review.facts) throw new HttpError(400, 'review is required');
    const experts = expertsOf(body.experts);
    if (!experts.length) throw new HttpError(400, 'Pick at least one expert');
    const url = realUrl(String(review.facts.url ?? ''));
    const store = reviews();
    let record = await reviewPage(store, review, experts, url);
    const pub = publicUrl(url);
    if (pub && (process.env.PAGESPEED_API_KEY || google.account())) {
      record = { ...record, field: await google.field(pub, googleSettings()) };
      store.save(record);
    }
    ws().metrics.record({ type: 'review', experts, checks: record.checks.length });
    return { review: record };
  });
  router.get('/experts/review', (req) => ({ review: reviews().get(realUrl(req.query.get('url') ?? '')) }));
  router.get('/experts/reviews', () => ({ reviews: reviews().list() }));
  router.post('/experts/ai', async (req) => {
    const body = (req.body ?? {}) as { url?: unknown; expert?: unknown };
    const expert = expertsOf([body.expert])[0];
    if (!expert) throw new HttpError(400, 'Unknown expert');
    const store = reviews();
    const record = store.get(realUrl(asString(body.url, 'url', 2000)));
    if (!record) throw new HttpError(404, 'Review the page first.');
    if (fake) return { review: await aiReview(store, record, expert, fakeExpertAsk(record, expert)) };
    if (!ai.connections.route('report')) throw new HttpError(409, noAi, 'no-ai');
    try {
      return { review: await aiReview(store, record, expert, (r) => ai.json(r), ws().project.hasCode ? ws().project.root : undefined) };
    } catch (err) {
      throw aiHttpError(err);
    }
  });
  router.post('/experts/skills', (req) => {
    const project = ws().project;
    if (!project.hasCode) throw new HttpError(409, 'This app has no code on this computer to add the experts to.', 'no-code');
    const experts = expertsOf((req.body as { experts?: unknown } | undefined)?.experts);
    const list = (experts.length ? experts : (['seo', 'content', 'ux', 'a11y'] as ExpertId[])).map((id) => ({ id, text: skillFile(id) }));
    return { written: installSkills(project.root, list), skills: list.map((s) => EXPERTS[s.id].skill) };
  });

  // ── Google: Chrome UX Report (API key), Search Console and Analytics (service account) ──
  const googleState = () => {
    const a = google.account();
    return { apiKey: keyHint(process.env.PAGESPEED_API_KEY) ?? null, account: a ? { email: a.client_email, project: a.project_id ?? null } : null, settings: apps.active() ? googleSettings() : {}, publicUrl: apps.active() ? publicUrl(apps.active()!.app.envs.find((e) => e.kind === 'remote')?.url ?? apps.active()!.env.url) : null };
  };
  router.get('/connectors/google', () => googleState());
  router.put('/connectors/google', (req) => {
    const body = (req.body ?? {}) as { apiKey?: unknown; account?: unknown; settings?: unknown };
    if (body.apiKey === null) saveSecret(layout.envDir, 'PAGESPEED_API_KEY', null);
    else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      const k = body.apiKey.trim();
      if (!/^[A-Za-z0-9_-]{20,}$/.test(k)) throw new HttpError(400, 'That doesn’t look like a Google API key.');
      saveSecret(layout.envDir, 'PAGESPEED_API_KEY', k);
    }
    if (body.account === null) google.setAccount(null);
    else if (typeof body.account === 'string' && body.account.trim()) {
      try {
        google.setAccount(body.account);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }
    if (body.settings && typeof body.settings === 'object' && apps.active()) {
      const s = body.settings as Record<string, unknown>;
      const site = typeof s.searchConsoleSite === 'string' ? s.searchConsoleSite.trim() : '';
      const property = typeof s.ga4Property === 'string' ? s.ga4Property.trim() : '';
      if (site && !/^(sc-domain:[a-z0-9.-]+\.[a-z]{2,}|https?:\/\/[^\s/]+\/.*)$/i.test(site)) throw new HttpError(400, 'A Search Console property is “sc-domain:example.com” or a URL prefix like “https://www.example.com/”.');
      if (property && !/^\d{4,15}$/.test(property)) throw new HttpError(400, 'A GA4 property ID is only numbers (Admin → Property details), not the G-… measurement ID.');
      const next: GoogleSettings = { searchConsoleSite: site.slice(0, 300) || undefined, ga4Property: property || undefined };
      writeJson(googleSettingsFile(), next);
    }
    return googleState();
  });
  router.post('/connectors/google/test', async () => {
    const pub = publicUrl(ws().app.envs.find((e) => e.kind === 'remote')?.url ?? ws().env.url);
    if (!pub) return { ok: false, message: 'This app has no public address. Add its production address to the app (it’s where Google’s data comes from).' };
    const field = await google.field(pub, googleSettings());
    const got = [field.crux && 'Chrome UX Report', field.search && 'Search Console', field.analytics && 'Analytics'].filter(Boolean);
    return { ok: !field.errors?.length, message: [got.length ? `Connected: ${got.join(', ')} for ${pub}.` : `No data for ${pub} yet.`, ...(field.errors ?? [])].join(' '), field };
  });

  // What the studio records itself (commands, decisions, tests): nothing from outside is added to it.
  router.get('/metrics/summary', () => ws().metrics.summary());
  router.get('/metrics/export', (_req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', 'attachment; filename="saywright-metrics.jsonl"');
    res.end(ws().metrics.exportAll());
  });

  /** Release the speech engine's process and the session timers. Safe to call more than once. */
  const close = () => {
    speech.stop();
    apps.close();
  };

  /** The studio's own address, once it listens (the proxy adds the bridge from there). */
  const setOrigin = (origin: string) => {
    studioOrigin = origin;
    apps.announceActive();
  };

  return { router, apps, ai, hub, status, speech, close, setOrigin };
}

export type Studio = Awaited<ReturnType<typeof createStudioApi>>;

/**
 * Everything the studio serves besides its interface: the API, the script that makes apps pointable, the
 * accessibility checks, and the WebAssembly runtime for on-device speech. Vite (`npm run dev`) and the
 * standalone server (`npx @saywright/studio`) mount the same list.
 */
export function studioRoutes(studio: Studio, layout: StudioLayout): Array<[route: string, handler: Middleware]> {
  const require = createRequire(import.meta.url);
  /** One folder's .wasm and .js files, by name only (nothing outside it can be named). */
  const files =
    (dir: string): Middleware =>
    (req, res, next) => {
      const name = path.basename(new URL(req.url ?? '/', 'http://localhost').pathname);
      const file = path.join(dir, name);
      if (!name || !/\.(wasm|m?js)$/.test(name) || !fs.existsSync(file)) return next();
      res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(file).pipe(res);
    };

  // For React apps not built with Vite (Next.js, Create React App, webpack): one script tag connects them.
  //   <script src="http://localhost:7357/saywright.js" defer></script>
  // Script tags an earlier version added load it from their old address.
  let bridge: { mtime: number; code: string } | null = null;
  const bridgeScript: Middleware = (req, res) => {
    const host = req.headers.host ?? `localhost:${STUDIO_PORT}`;
    const prelude = `window.__SAYWRIGHT__=Object.assign({studio:${JSON.stringify(`http://${host}`)},widget:true},window.__SAYWRIGHT__||{});\n`;
    const mtime = fs.statSync(layout.bridgeFile, { throwIfNoEntry: false })?.mtimeMs;
    // Read again when it is rebuilt.
    if (mtime && bridge?.mtime !== mtime) bridge = { mtime, code: fs.readFileSync(layout.bridgeFile, 'utf8') };
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(prelude + (mtime && bridge ? bridge.code : 'console.warn("[saywright] bridge not built: run npm run build:plugin")'));
  };

  // Accessibility checks: axe-core (MPL-2.0, unmodified), loaded into the app's page only when a review asks for it.
  const axe: Middleware = (_req, res) => {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    fs.createReadStream(layout.axeFile).pipe(res);
  };
  /** A package's folder, in development only: the built studio carries what it needs, or loads it from a CDN. */
  const devDir = (pkg: string, ...sub: string[]): string | null => {
    try {
      return path.join(path.dirname(require.resolve(pkg)), ...sub);
    } catch {
      return null;
    }
  };
  const ort = devDir('onnxruntime-web/wasm');

  // The models the page runs itself (on-device speech), from the data folder.
  const models = modelsDir(layout.dataDir);
  const modelFiles: Middleware = (req, res, next) => {
    // Under Vite the route is cut from req.url; the full address is kept in originalUrl.
    const address = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '/';
    let file: string;
    try {
      file = path.resolve(models, decodeURIComponent(new URL(address, 'http://localhost').pathname).replace(/^\/models\//, ''));
    } catch {
      return next();
    }
    const stat = file.startsWith(models + path.sep) && /\.onnx$/.test(file) ? fs.statSync(file, { throwIfNoEntry: false }) : undefined;
    if (!stat?.isFile()) return next();
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  };

  return [
    // Mounted at the root: the router checks its own prefix (a route mounted under Vite is cut from the address).
    ['/', studio.router.middleware('/api')],
    ['/models', modelFiles],
    ['/saywright.js', bridgeScript],
    ['/axe.min.js', axe],
    // Vite's dev server has a route of this name too: this one, mounted first, works the same in both.
    ['/__open-in-editor', editorRoute(() => studio.apps.active()?.project ?? null)],
    // On-device speech runs on onnxruntime's WebAssembly.
    ...(ort ? [['/ort', files(ort)] as [string, Middleware]] : []),
  ];
}

/** Once the studio listens: where it is, for the proxy, the open app's plugin and AI apps started as programs. */
export function announce(studio: Studio, layout: StudioLayout, port: number, log: (line: string) => void = console.log): void {
  const url = `http://localhost:${port}`;
  studio.setOrigin(url);
  // AI apps started as programs (Claude Desktop, through the MCP command) find the studio here, and its token.
  try {
    writeFileAtomic(path.join(layout.dataDir, 'server.json'), JSON.stringify({ url, pid: process.pid }));
    clientToken(layout.dataDir);
  } catch {
    /* read-only data folder: they fall back to the default address */
  }
  const app = studio.apps.active();
  void studio.ai.connections.refresh(true).then(() => {
    const { ai } = studio.status();
    const who = ai.source === 'fake' ? 'test stand-in (SAYWRIGHT_AI=fake)' : ai.who ? `${ai.who.label} · ${ai.who.model}` : 'not connected (quick edits only). Connect one in Settings → AI.';
    log(`  ${app ? `App: ${app.app.name} (${app.project.url})` : 'No app open yet: pick or link one in the studio.'}\n  AI: ${who}`);
  });
}

/**
 * The studio's page asks for an agent cluster of its own, and Chromium gives it a process of its own. The app in its
 * frame is the same site (localhost), so it would otherwise share the studio's one thread: the studio's work made the
 * app's typing look slow in session reports, and the app's long tasks (an expert review of a big page) froze the
 * studio. The site stays the same, so the app's cookies work in the frame as they do in its own tab.
 */
export const PAGE_HEADERS: Record<string, string> = { 'Origin-Agent-Cluster': '?1' };

/** The studio in Vite's dev server (`npm run dev`, in this repository). */
export function studioApi(layout: StudioLayout): Plugin {
  let api: Studio | null = null;
  return {
    name: 'saywright-api',
    apply: 'serve',
    config: () => ({ server: { headers: PAGE_HEADERS } }),
    // Vite calls this when the dev server closes or restarts: don't leave the speech engine running behind.
    closeBundle() {
      api?.close();
    },
    async configureServer(server) {
      const studio = await createStudioApi(layout);
      api = studio;
      for (const [route, handler] of studioRoutes(studio, layout)) server.middlewares.use(route, handler);
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address();
        announce(studio, layout, typeof address === 'object' && address ? address.port : STUDIO_PORT, (line) => server.config.logger.info(line));
      });
    },
  };
}
