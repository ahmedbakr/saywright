import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packageLayout, repoLayout } from '../../server/layout';

const STUDIO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('where the studio runs from', () => {
  it('names the command that downloads the extras as this install runs it', () => {
    // `npm run setup` is this repository's script: in someone's app folder it runs theirs, or fails.
    expect(repoLayout(path.resolve(STUDIO, '../..')).setupCommand).toBe('npm run setup');
    expect(packageLayout(STUDIO).setupCommand).toBe('npx saywright setup');
  });
});
