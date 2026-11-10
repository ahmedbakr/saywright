/**
 * Keys written in code are not sent to a provider. Before code goes out (the first message's file context,
 * read_file, search_code, MCP's tools), each key-shaped literal is replaced by a numbered placeholder; the studio
 * keeps what each one stands for, and puts the value back in an edit that quotes it, so a change around a key
 * still applies and keeps the key as it was. A placeholder the studio didn't make is left alone.
 */
import type { Project } from '../project.ts';

/** Literals that are keys by their shape: well-known prefixes, private key blocks, passwords in connection URLs. */
const KEY_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[^-'"`\n]|\\n)+-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
/** The password in a connection URL (`postgres://user:password@host`): only the password is a secret. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:)([^\s@'"`/]{3,})(@)/gi;
const PLACEHOLDER = /SAYWRIGHT_SECRET_(\d+)/g;

class SecretMask {
  private byValue = new Map<string, string>();
  private byName = new Map<string, string>();

  private name(value: string): string {
    let n = this.byValue.get(value);
    if (!n) {
      n = `SAYWRIGHT_SECRET_${this.byValue.size + 1}`;
      this.byValue.set(value, n);
      this.byName.set(n, value);
    }
    return n;
  }

  mask(text: string): string {
    let out = text;
    for (const re of KEY_SHAPES) out = out.replace(re, (m) => this.name(m));
    return out.replace(URL_PASSWORD, (_m, head: string, pw: string, at: string) => `${head}${this.name(pw)}${at}`);
  }

  unmask(text: string): string {
    return text.replace(PLACEHOLDER, (m) => this.byName.get(m) ?? m);
  }
}

const masks = new WeakMap<Project, SecretMask>();
const of = (project: Project) => {
  let m = masks.get(project);
  if (!m) masks.set(project, (m = new SecretMask()));
  return m;
};

/** Code as it may be sent: every key-shaped literal replaced by its placeholder. */
export const maskCode = (project: Project, text: string): string => of(project).mask(text);
/** Text from a model (an edit's old and new strings): each placeholder the studio made, back to its value. */
export const unmaskCode = (project: Project, text: string): string => of(project).unmask(text);
