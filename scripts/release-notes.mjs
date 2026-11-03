#!/usr/bin/env node
// A GitHub release's notes: how to start, then this version's section of CHANGELOG.md, with links to the
// repository's files made absolute (a release page doesn't resolve relative ones). Used by the release workflow.
//
//   node scripts/release-notes.mjs 0.1.0 > notes.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/release-notes.mjs <version>');
  process.exit(1);
}
const repo = process.env.GITHUB_REPOSITORY ?? 'ahmedbakr/saywright';
const files = `https://github.com/${repo}/blob/v${version}/`;

const lines = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split('\n');
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}.`);
  process.exit(1);
}
// Up to the next version, or the link definitions at the end.
let end = lines.findIndex((l, i) => i > start && (/^## \[/.test(l) || /^\[[^\]]+\]: /.test(l)));
if (end < 0) end = lines.length;
const absolute = (text) => text.replace(/\]\((?!https?:|#|mailto:)\.?\/?([^)]+)\)/g, (_, p) => `](${files}${p})`);
const changes = absolute(lines.slice(start + 1, end).join('\n').trim());

const start_ = absolute(`## Start

\`\`\`bash
npx saywright
\`\`\`

The studio opens at \`http://localhost:7357\`. Link your app (a folder, an address or a GitHub repository), or try the sample shop: [Getting started](docs/getting-started.md) walks through every feature on it. For the exact file and line of every element in a React app on Vite, \`npx saywright connect ./my-app\` adds the [\`@saywright/vite\`](packages/vite/README.md) plugin.`);

process.stdout.write(`${start_}\n\n${changes}\n`);
