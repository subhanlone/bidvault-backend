// Fails when the contract gains a breaking change nobody acknowledged.
//
//   npm run api:compat            compare against HEAD~1
//   npm run api:compat <ref>      compare against any ref (CI passes the pushed-from commit)
//
// Every other gate in this repo answers "do the contract and the code agree?". None of them
// can answer "did you mean to change the contract?" — by construction, since they all derive
// the contract from the code. This is the one that asks.
//
// See COMPATIBILITY.md for what counts as breaking and why oasdiff's default severities are
// used unmodified. The acknowledgement is a bump to `info.version` in
// src/openapi/document.ts: an unbumped version reads as an accident, a bumped one as a
// decision. The gate does not judge whether the change is wise, only whether it was chosen.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Pinned rather than :latest — a severity reclassification upstream would otherwise change
// what this build permits without anything in this repo changing.
const OASDIFF = 'tufin/oasdiff:v1.29.1';

const root = resolve(import.meta.dirname, '..');
const baseRef = process.argv[2] || 'HEAD~1';

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
};

let baseSpec;
try {
  baseSpec = git('show', `${baseRef}:openapi.json`);
} catch (err) {
  // A first commit, a shallow clone, or a ref that predates the contract. Nothing to compare
  // against is not a failure — but say so rather than passing silently.
  console.log(`No contract at ${baseRef} to compare against — skipping.`);
  console.log(`  (${err.message})`);
  process.exit(0);
}

const headSpec = readFileSync(join(root, 'openapi.json'), 'utf8');

const dir = mkdtempSync(join(tmpdir(), 'oasdiff-'));
try {
  writeFileSync(join(dir, 'base.json'), baseSpec);
  writeFileSync(join(dir, 'head.json'), headSpec);

  const run = spawnSync(
    'docker',
    ['run', '--rm', '-v', `${dir}:/specs`, OASDIFF, 'breaking', '/specs/base.json', '/specs/head.json'],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );

  if (run.error || run.status === null) {
    console.error(`Could not run ${OASDIFF}. Is Docker running?`);
    if (run.error) console.error(`  ${run.error.message}`);
    process.exit(1);
  }

  const report = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();

  // oasdiff prints "N changes: X error, Y warning, Z info", or "No breaking changes".
  const errors = Number(/(\d+) error/.exec(report)?.[1] ?? 0);

  if (errors === 0) {
    console.log(report || 'No breaking changes.');
    process.exit(0);
  }

  console.log(report);

  const versionOf = (spec) => {
    try {
      return JSON.parse(spec).info?.version ?? null;
    } catch {
      return null;
    }
  };
  const before = versionOf(baseSpec);
  const after = versionOf(headSpec);

  if (before !== null && after !== null && before !== after) {
    console.log(
      `\n${errors} breaking change(s), acknowledged: info.version ${before} -> ${after}.`,
    );
    process.exit(0);
  }

  console.error(
    `\n${errors} breaking change(s) and info.version is unchanged (${after ?? 'unreadable'}).\n\n` +
      `If the change is wrong, fix the schema. If it is intended, bump info.version in\n` +
      `src/openapi/document.ts and regenerate — that is how a breaking change is declared\n` +
      `deliberate. See COMPATIBILITY.md.\n\n` +
      `Bear in mind the deploy order: additions go backend-first, removals frontend-first.`,
  );
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
