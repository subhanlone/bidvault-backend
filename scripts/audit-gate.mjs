// Fails the build on any npm advisory that has not been explicitly, deliberately accepted.
//
//   npm run audit:gate
//
// Two failure modes, and the second is the point:
//
//   1. An advisory appears that audit-allowlist.json does not mention  -> fail.
//   2. An entry in audit-allowlist.json no longer matches any advisory -> fail.
//
// (2) is what stops an accepted exception outliving its reason. When upstream ships the
// fix, this build breaks and tells you to delete the entry, rather than leaving a stale
// "we looked at this once" note in the repo forever.
//
// Plain .mjs with no dependencies so both repos run the identical file — the frontend has
// no TypeScript runner for scripts, and adding one to check dependencies would be its own
// small joke.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// import.meta.dirname rather than picking apart import.meta.url, which needs a Windows
// drive-letter fixup to survive URL.pathname.
const root = resolve(import.meta.dirname, '..');
const allowlistPath = resolve(root, 'audit-allowlist.json');

// npm on Windows is a .cmd, which Node will not spawn without a shell; npm_execpath is the
// CLI's own JavaScript entry and is set for every npm script. Avoids shell: true entirely.
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('audit-gate must be run through npm (npm run audit:gate) — npm_execpath is unset.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [npmCli, 'audit', '--json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});

// A non-zero exit just means advisories were found; only a missing/unparseable report is
// fatal. Failing open on a network error would defeat the whole gate.
if (!result.stdout) {
  console.error('npm audit produced no output — cannot verify the dependency tree.');
  if (result.stderr) console.error(result.stderr.trim());
  process.exit(1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error('npm audit did not return JSON:');
  console.error(result.stdout.slice(0, 500));
  process.exit(1);
}

/** Every distinct advisory in the tree. Only object `via` entries carry one; strings are
 *  just the path it propagated along. */
const found = new Map();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== 'object' || !via.url) continue;
    const id = via.url.split('/').pop();
    if (!found.has(id)) {
      found.set(id, { id, package: via.name, severity: via.severity, title: via.title });
    }
  }
}

const allowlist = existsSync(allowlistPath)
  ? JSON.parse(readFileSync(allowlistPath, 'utf8')).accepted ?? []
  : [];
const allowed = new Map(allowlist.map((e) => [e.id, e]));

const unexpected = [...found.values()].filter((a) => !allowed.has(a.id));
const stale = allowlist.filter((e) => !found.has(e.id));

for (const a of found.values()) {
  if (allowed.has(a.id)) console.log(`accepted  ${a.severity.padEnd(8)} ${a.id}  ${a.package}`);
}

if (unexpected.length) {
  console.error(`\n${unexpected.length} advisory/advisories not accepted:\n`);
  for (const a of unexpected) {
    console.error(`  ${a.severity.toUpperCase()} ${a.id}  ${a.package}`);
    console.error(`    ${a.title}`);
    console.error(`    https://github.com/advisories/${a.id}`);
  }
  console.error(
    `\nFix it at the root — upgrade, or remove the dependency. If neither is possible, add ` +
      `an entry to audit-allowlist.json with the reachability analysis and an upstream link. ` +
      `Do not add an npm override.`,
  );
}

if (stale.length) {
  console.error(`\n${stale.length} allowlist entry/entries no longer apply — delete them:\n`);
  for (const e of stale) {
    console.error(`  ${e.id}  ${e.package}`);
    console.error(`    accepted because: ${e.reason}`);
    console.error(`    tracking: ${e.tracking}`);
  }
  console.error('\nThe advisory is gone, so the exception is obsolete. Removing it is the fix.');
}

if (unexpected.length || stale.length) process.exit(1);

// Counted as distinct advisories, not npm's `metadata.total` — that counts every affected
// package, so one advisory reached through two wrappers reads as three.
const packages = report.metadata?.vulnerabilities?.total ?? 0;
console.log(
  found.size === 0
    ? '\nno advisories'
    : `\n${found.size} advisory accepted and still current (${packages} affected packages)`,
);
