/**
 * NotificationType is an open set. New values have been added in almost every phase (and once were
 * missed from the contract for weeks, BV-016), so the contract says so: the schema is
 * `x-extensible-enum`, which is what oasdiff recommends for a response enum that grows, and the
 * generated client type stays open too (the listed values for editor help, plus any other string),
 * so a screen written today still compiles and still works when a value it does not know arrives.
 *
 * The server still checks every notification it sends against the closed list before it leaves.
 */
import { readFileSync, mkdtempSync, readFileSync as read, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotificationType } from '../src/openapi/schemas.js';

const root = resolve(import.meta.dirname, '..');
const spec = JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8')) as {
  components: { schemas: Record<string, Record<string, unknown>> };
};

describe('NotificationType in the contract', () => {
  it('is an extensible enum, not a closed one', () => {
    const schema = spec.components.schemas.NotificationType;
    expect(schema).not.toHaveProperty('enum');
    expect(schema['x-extensible-enum']).toContain('BID_RECEIVED');
    expect(schema['x-extensible-enum']).toContain('BID_OUTBID');
    expect(schema.type).toBe('string');
  });

  it('is still closed on the server: an unknown value fails the response check', () => {
    expect(NotificationType.safeParse('BID_RECEIVED').success).toBe(true);
    expect(NotificationType.safeParse('SOMETHING_NEW').success).toBe(false);
  });

  it('generates an open type for the client', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bv-types-'));
    try {
      const out = join(dir, 'openapi.d.ts');
      const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/generate-client-types.ts'], {
        cwd: root,
        env: { ...process.env, API_TYPES_OUT: out },
        encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(0);
      const line = read(out, 'utf8').split('\n').find((l) => l.startsWith('export type NotificationType'));
      expect(line).toContain('"BID_RECEIVED"');
      expect(line).toContain('(string & Record<never, never>)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
