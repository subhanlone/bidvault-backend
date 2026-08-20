import { prisma } from '../../src/db/prisma.js';

/**
 * Empties every table in the public schema.
 *
 * The table list is read from the catalogue rather than written out here: a hand-kept
 * list silently stops covering a new model, and a suite that leaves rows behind fails in
 * whichever file happens to run next, which is a miserable thing to debug.
 *
 * `_prisma_migrations` is excluded — dropping it would make the next `migrate deploy`
 * replay everything against a schema that already exists.
 *
 * TRUNCATE with CASCADE in one statement sidesteps foreign-key ordering entirely, and
 * RESTART IDENTITY resets any sequences so ids do not creep across files.
 */
export async function resetDatabase(): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;

  if (rows.length === 0) {
    throw new Error(
      'No tables found in the test database. Run `npm run test:db:push` (or apply the ' +
        'migrations) before running the suite.',
    );
  }

  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
