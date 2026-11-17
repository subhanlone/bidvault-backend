/**
 * Refuses to seed a database that does not look disposable, and refuses to invent passwords.
 *
 * The seed scripts previously carried working credentials in source — including an ADMIN
 * account, `admin@bidvault.com` / `admin123`, in a public repository — and `prisma/seed.ts`
 * wrote `passwordHash` in the *update* branch of its upsert, so re-running it against a
 * database where those addresses already existed silently reset a live account's password.
 *
 * The pattern here is deliberately the same one `tests/setup.ts` uses, for the same reason:
 * the Prisma CLI reads DATABASE_URL from the environment and auto-loads `.env`, so running a
 * seed on a developer machine or through `railway run` points it at whatever is configured
 * without saying so. `scripts/test-db.ts` already exists purely to stop that happening to the
 * migration command; the seeds had no equivalent.
 *
 * Production seeding is still possible — `scripts/seed-demo-auctions.ts` is designed for it —
 * but it now has to be asked for by name.
 */

/** Database names that are obviously safe to overwrite. */
const DISPOSABLE = /(_test|_dev|^bidvault$|^postgres$)/;

export interface SeedGuardResult {
  databaseName: string;
  isProduction: boolean;
}

export function assertSeedTarget(scriptName: string): SeedGuardResult {
  const url = process.env.DATABASE_URL;
  if (!url) {
    fail(scriptName, ['DATABASE_URL is not set.']);
  }

  let databaseName: string;
  try {
    databaseName = new URL(url).pathname.replace(/^\//, '');
  } catch {
    fail(scriptName, [`DATABASE_URL is not a valid URL: ${url}`]);
  }

  const looksDisposable = DISPOSABLE.test(databaseName);
  const override = process.env.ALLOW_PRODUCTION_SEED === '1';

  if (!looksDisposable && !override) {
    fail(scriptName, [
      `DATABASE_URL points at "${databaseName}", which does not look like a local or test database.`,
      '',
      'Seeding writes users, listings and auctions, and can overwrite existing rows.',
      'If you genuinely mean to seed this database, re-run with:',
      '',
      '    ALLOW_PRODUCTION_SEED=1 npm run <script>',
      '',
      'Set it deliberately, in the command — not in .env.',
    ]);
  }

  const isProduction = !looksDisposable;
  console.log(
    isProduction
      ? `[seed-guard] ${scriptName}: seeding "${databaseName}" with ALLOW_PRODUCTION_SEED=1.`
      : `[seed-guard] ${scriptName}: seeding "${databaseName}".`,
  );
  return { databaseName, isProduction };
}

/**
 * A password from the environment, or a hard stop. There is deliberately no default: a
 * default is how a known credential ends up in a database nobody meant to put it in.
 */
/**
 * A seeded account's password. On a local or test database the account's first name followed by
 * 12345 (e.g. "Sawera12345"), so a developer can sign in as anyone without looking it up; the
 * variable, when set, wins. On production there is no such default: the variable is required,
 * because a password derivable from a public repository must never reach a real database (BV-062).
 */
export function seedPassword(variable: string, firstName: string, target: SeedGuardResult): string {
  if (process.env[variable] || target.isProduction) return requiredPassword(variable);
  return `${firstName}12345`;
}

export function requiredPassword(variable: string): string {
  const value = process.env[variable];
  if (!value || value.length < 8) {
    fail('seed', [
      `${variable} is not set, or is shorter than the platform's own 8-character minimum.`,
      '',
      'Seed passwords come from the environment so that no working credential lives in source.',
      'Example:',
      '',
      `    ${variable}='<a password you choose>' npm run prisma:seed`,
    ]);
  }
  return value;
}

function fail(scriptName: string, lines: string[]): never {
  console.error(`\n[seed-guard] Refusing to run ${scriptName}.\n`);
  for (const line of lines) console.error(`  ${line}`);
  console.error('');
  process.exit(1);
}
