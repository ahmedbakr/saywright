/**
 * The `saywright` command. Installed from npm it runs the built studio (bin/saywright.mjs); in this repository the
 * same commands run through scripts/saywright.mjs, and `npm run dev` serves the studio through Vite instead.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageLayout, type StudioLayout } from '../server/layout.ts';
import { connect } from './connect.ts';
import { dataDirProblem } from './data-dir.ts';
import { doctor } from './doctor.ts';
import { mcp } from './mcp.ts';
import { setup } from './setup.ts';
import { start } from './start.ts';
import { c } from './term.ts';

/** For scripts/saywright.mjs, which runs the commands from the repository. */
export { repoLayout } from '../server/layout.ts';

export interface CliContext {
  layout: StudioLayout;
  /** The built interface; null in the repository, where Vite serves it. */
  clientDir: string | null;
  /** What `connect` installs for the Vite plugin: the published package, or the repository's folder. */
  pluginSpec: string;
  /** How a person starts the studio, for messages: "npx @saywright/studio", "npm run dev". */
  startCommand: string;
}

const HELP = `
${c.bold('saywright')} ${c.dim('— point at your running app, say what to change')}

  ${c.cyan('saywright')} [--port 7357] [--no-open]     start the studio and open it in your browser
  ${c.cyan('saywright connect')} <app folder>          connect an app once (the Vite plugin or a script tag, where they help)
  ${c.cyan('saywright setup')}                         download the optional extras: voice and speech models
  ${c.cyan('saywright doctor')}                        check what the studio needs, and how to fix what's missing
  ${c.cyan('saywright mcp')}                           for AI apps that start MCP servers as programs (Claude Desktop)

  Each command takes --help. Your data: ~/.saywright (SAYWRIGHT_HOME moves it). Docs: https://github.com/ahmedbakr/saywright
`;

/** Installed from npm: this file is the package's dist/cli.mjs. */
function installed(): CliContext {
  const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const layout = packageLayout(pkg);
  return { layout, clientDir: path.join(pkg, 'dist', 'client'), pluginSpec: `@saywright/vite@^${layout.version}`, startCommand: 'npx @saywright/studio' };
}

/** Run a command; resolves with the exit code (`start` resolves once the studio stops). */
export async function main(argv: string[], ctx: CliContext = installed()): Promise<number> {
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(ctx.layout.version);
    return 0;
  }
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    console.log(HELP);
    return 0;
  }
  const [command, ...rest] = argv.length && !argv[0].startsWith('-') ? argv : ['start', ...argv];
  // The data folder first, for the commands that write it: a sentence that says what is wrong and how to fix it,
  // rather than a raw system error half-way through. doctor reports it among its checks; mcp writes nothing there.
  if (['start', 'connect', 'setup'].includes(command) && !rest.some((a) => a === '--help' || a === '-h')) {
    const problem = dataDirProblem(ctx.layout.dataDir);
    if (problem) {
      console.error(`${c.red('✗')} ${problem}`);
      return 1;
    }
  }
  try {
    switch (command) {
      case 'start':
        return await start(rest, ctx);
      case 'connect':
        return await connect(rest, ctx);
      case 'setup':
        return await setup(rest, ctx);
      case 'doctor':
        return await doctor(rest, ctx);
      case 'mcp':
        return await mcp(rest, ctx);
      default:
        console.error(`${c.red('✗')} No command “${command}”.`);
        console.log(HELP);
        return 1;
    }
  } catch (err) {
    // parseArgs explains unknown or malformed options itself.
    console.error(`${c.red('✗')} ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}
