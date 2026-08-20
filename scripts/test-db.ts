/**
 * Applies the migrations to the test database.
 *
 *   npm run test:db
 *
 * Prisma's CLI reads DATABASE_URL from the environment and auto-loads `.env`, with no way
 * to point it at a different file. Running it directly would therefore migrate the
 * development database. This loads `.env.test` first and hands the CLI that environment.
 *
 * The CLI is invoked through its JavaScript entry point rather than the `prisma` shim in
 * .bin: on Windows that shim is a .cmd, which Node refuses to spawn without a shell, and
 * reaching for `shell: true` would put the connection string through a command line.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const envFile = resolve(import.meta.dirname, '..', '.env.test');
if (!existsSync(envFile)) {
  console.error(
    `.env.test not found.\nCopy .env.test.example to .env.test and fill in the local ` +
      `Postgres password — see that file for the rest of the setup.`,
  );
  process.exit(1);
}
process.loadEnvFile(envFile);

const url = process.env.DATABASE_URL ?? '';
const name = (() => {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();

// The same check tests/setup.ts makes, repeated here because this script writes schema
// rather than reading it — the wrong value would migrate a database someone is using.
if (!name.endsWith('_test')) {
  console.error(
    `Refusing to migrate: DATABASE_URL in .env.test points at "${name || url}", which does ` +
      `not end in _test.`,
  );
  process.exit(1);
}

const prismaCli = createRequire(import.meta.url).resolve('prisma');
const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`\nmigrations applied to "${name}"`);
