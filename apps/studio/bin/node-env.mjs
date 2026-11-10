// What the command needs of Node, shared by bin/saywright.mjs, scripts/dev.mjs and `saywright doctor`: the versions
// Saywright runs on, and how the command that starts the studio sends AI requests through a company proxy. Plain
// JavaScript, so the launcher can use it before anything else is loaded.
import { spawn } from 'node:child_process';
import os from 'node:os';

const parts = (version) => version.split('.').map(Number);

/** The package's engines (^22.18.0 || >=24.11.0): Babel, which reads the app's code, needs them. */
export function nodeSupported(version = process.versions.node) {
  const [major, minor] = parts(version);
  return (major === 22 && minor >= 18) || (major === 24 && minor >= 11) || major > 24;
}

/** Why this Node won't do, said as the engines field means it. */
export const nodeMessage = (version = process.versions.node) => `Saywright needs Node.js 22 (22.18 or newer) or Node.js 24 and later (24.11 or newer); this is ${version}.`;

/** The proxy variables that are set (their names: a value can hold a password). */
export const proxyVariables = (env = process.env) => ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].filter((name) => env[name]);

/** Node's fetch follows the proxy variables when NODE_USE_ENV_PROXY is set, from 22.21 and from 24.5. */
export function envProxySupported(version = process.versions.node) {
  const [major, minor] = parts(version);
  return (major === 22 && minor >= 21) || (major === 24 && minor >= 5) || major > 24;
}

/** This computer, reached directly: the app's dev server, the studio's proxy, Ollama, LM Studio. */
const LOCAL = ['localhost', '127.0.0.1', '::1'];

/** NO_PROXY as it is, with this computer added. */
export function noProxyWithLocal(env = process.env) {
  const listed = (env.NO_PROXY ?? env.no_proxy ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  return [...listed, ...LOCAL.filter((h) => !listed.includes(h))].join(',');
}

/**
 * Behind a company proxy, run this command again, once, with Node's own proxy support on: Node reads
 * NODE_USE_ENV_PROXY only as it starts. The AI providers are then reached through the proxy, and this computer
 * directly. `args` are the script and its arguments. Resolves with null when there is nothing to do (the command goes
 * on in this process), else with the exit code of the command run again.
 *
 * The command runs in a session of its own, so a signal reaches it once: the terminal's Ctrl+C or hang-up comes here,
 * and is passed on. On Windows the console gives Ctrl+C to both, so it isn't passed on there.
 */
export function withEnvProxy(args, log = (line) => console.log(line)) {
  const env = process.env;
  const names = proxyVariables(env);
  if (!names.length || env.NODE_USE_ENV_PROXY !== undefined) return Promise.resolve(null);
  if (!envProxySupported()) {
    log(`  ${names[0]} is set, but Node.js ${process.versions.node} can’t send requests through a proxy: AI requests go out directly. Node.js 22.21 or newer, or 24.11 or newer, can.`);
    return Promise.resolve(null);
  }
  const noProxy = noProxyWithLocal(env);
  return new Promise((resolve) => {
    let child;
    try {
      // Node warns that its proxy agent is experimental, on every start: the line above says what matters.
      child = spawn(process.execPath, [...process.execArgv, '--disable-warning=UNDICI-EHPA', ...args], {
        stdio: 'inherit',
        env: { ...env, NODE_USE_ENV_PROXY: '1', NO_PROXY: noProxy, no_proxy: noProxy },
        detached: process.platform !== 'win32',
      });
    } catch {
      resolve(null);
      return;
    }
    log(`  AI requests go through the proxy in ${names[0]}; this computer (your app, Ollama, LM Studio) is reached directly.`);
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const pass = (signal) => () => {
      if (process.platform !== 'win32' || signal !== 'SIGINT') child.kill(signal);
    };
    const handlers = signals.map((signal) => [signal, pass(signal)]);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    child.on('error', () => resolve(null));
    child.on('exit', (code, signal) => {
      for (const [s, handler] of handlers) process.off(s, handler);
      resolve(code ?? 128 + (os.constants.signals[signal] ?? 0));
    });
  });
}
