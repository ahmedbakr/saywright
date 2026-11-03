/**
 * Starting other programs: on Windows an app npm installed is a .cmd file, whose script is run with Node directly so
 * cmd.exe never reads its arguments; anything else is started as on every system.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { npmShimScript, programExists, runQuiet } from '../../server/program';

// What npm writes today (cmd-shim), and what it wrote before.
const SHIM = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`;
const OLD_SHIM = `@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\node_modules\\@google\\gemini-cli\\dist\\index.js" %*\r\n)\r\n`;
// An editor's own .cmd: not npm's, so it is started through cmd.exe.
const CODE_CMD = `@echo off\r\nsetlocal\r\nset VSCODE_DEV=\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*\r\nIF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%\r\nendlocal\r\n`;

describe('an app npm installed on Windows', () => {
  it('is its script, run with Node', () => {
    expect(npmShimScript('C:\\Users\\Ana\\AppData\\Roaming\\npm\\codex.cmd', SHIM)).toBe('C:\\Users\\Ana\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js');
    expect(npmShimScript('C:\\nvm\\v22.18.0\\gemini.cmd', OLD_SHIM)).toBe('C:\\nvm\\v22.18.0\\node_modules\\@google\\gemini-cli\\dist\\index.js');
  });

  it('isn’t any other .cmd file', () => {
    expect(npmShimScript('C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd', CODE_CMD)).toBeNull();
    expect(npmShimScript('C:\\tools\\build.cmd', '@echo off\r\nmsbuild %*\r\n')).toBeNull();
  });
});

describe('running a program briefly', () => {
  it('gives what it printed and how it ended, and an unknown program as not run', async () => {
    const ok = await runQuiet(process.execPath, ['-e', 'console.log("hi"); console.error("there"); process.exit(3)']);
    expect(ok).toEqual({ code: 3, stdout: 'hi\n', stderr: 'there\n' });
    expect((await runQuiet('saywright-no-such-program', [])).code).toBeNull();
  });

  it('stops one that takes too long', async () => {
    const started = Date.now();
    const slow = await runQuiet(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], 300);
    expect(slow.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('whether a program exists', () => {
  it('is a file found by its path, or by its name on PATH, with Windows’ endings there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saywright-program-'));
    fs.writeFileSync(path.join(dir, 'tool'), '');
    fs.writeFileSync(path.join(dir, 'editor.CMD'), '');
    const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
    expect(programExists(path.join(dir, 'tool'), env, false)).toBe(true);
    expect(programExists('tool', env, false)).toBe(true);
    // Elsewhere a name is the whole file name.
    expect(programExists('editor', env, false)).toBe(false);
    expect(programExists('editor', env, true)).toBe(true);
    expect(programExists(path.join(dir, 'editor'), env, true)).toBe(true);
    expect(programExists(path.join(dir, 'no-such-editor'), env, true)).toBe(false);
    expect(programExists('no-such-editor', env, true)).toBe(false);
    // A path in quotes, as Windows writes one with spaces.
    expect(programExists(`"${path.join(dir, 'editor')}"`, env, true)).toBe(true);
    // A folder isn't one.
    expect(programExists(dir, env, false)).toBe(false);
  });
});
