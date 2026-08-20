import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],

    // Every file shares one Postgres database and truncates it between runs, so files
    // cannot overlap. Sequential execution is the honest fix; isolating per file would
    // mean a database per worker, which is more machinery than this suite needs.
    fileParallelism: false,

    // Booting the app opens a Prisma pool and an ioredis connection, and the first
    // migration-checked query against a cold local Postgres is not fast.
    testTimeout: 30_000,
    hookTimeout: 60_000,

    // ioredis keeps a socket open and BullMQ keeps a blocking client; without this the
    // process lingers after the last assertion instead of reporting and exiting.
    teardownTimeout: 10_000,
  },
});
