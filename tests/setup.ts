/**
 * Runs before any test file is loaded. Loads the test environment, then refuses to
 * continue if it does not look like a test environment.
 *
 * This file must not import anything from ../src. The first such import evaluates
 * config/env.ts and constructs the ioredis client, which connects eagerly — so by then
 * a misconfigured run has already reached whatever REDIS_URL pointed at. The guards
 * below have to be the thing that happens first.
 *
 * The risk is not hypothetical. Development and production have shared one Redis
 * instance while pointing at different databases, and a locally-run worker consumed a
 * production job, found no matching auction in its own database, returned early, and
 * left BullMQ marking the job completed. That auction never closed and its job was gone
 * permanently. QUEUE_PREFIX exists because of that incident; these assertions exist so a
 * test run cannot repeat it.
 */
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';

// Locally the values come from .env.test, which is gitignored. On CI there is no such
// file and the workflow supplies them directly, so a missing file is not an error.
const envFile = resolve(import.meta.dirname, '..', '.env.test');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const problems: string[] = [];

if (process.env.NODE_ENV !== 'test') {
  problems.push(`NODE_ENV must be "test", got ${JSON.stringify(process.env.NODE_ENV)}`);
}

// --- database -------------------------------------------------------------------------
// The suite truncates every table between files. Requiring the name to end in _test is
// what stops that from landing on the development database, whose name is `bidvault`.
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  problems.push('DATABASE_URL is not set');
} else {
  let dbName: string;
  try {
    dbName = new URL(dbUrl).pathname.replace(/^\//, '');
  } catch {
    dbName = '';
    problems.push(`DATABASE_URL is not a valid URL: ${dbUrl}`);
  }
  if (dbName && !dbName.endsWith('_test')) {
    problems.push(
      `DATABASE_URL points at "${dbName}", which does not end in _test. ` +
        'The suite truncates every table; refusing to run against a database that is not ' +
        'obviously disposable.',
    );
  }
}

// --- redis ----------------------------------------------------------------------------
// Loopback only. A remote host here is the shared-instance failure described above.
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  problems.push('REDIS_URL is not set');
} else {
  let host = '';
  try {
    host = new URL(redisUrl).hostname;
  } catch {
    problems.push(`REDIS_URL is not a valid URL: ${redisUrl}`);
  }
  if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    problems.push(
      `REDIS_URL points at "${host}", which is not loopback. Tests enqueue real BullMQ ` +
        'jobs; a shared or remote instance risks consuming production jobs.',
    );
  }
}

// --- queue namespace --------------------------------------------------------------------
// 'bull' is BullMQ's default and production's actual prefix, so it is the one value that
// must never appear here even against a local Redis.
const prefix = process.env.QUEUE_PREFIX;
if (!prefix) {
  problems.push('QUEUE_PREFIX is not set');
} else if (prefix === 'bull') {
  problems.push('QUEUE_PREFIX is "bull", which is production\'s prefix. Use bull:test.');
}

if (problems.length > 0) {
  throw new Error(
    `Refusing to run the test suite — the environment does not look disposable:\n` +
      problems.map((p) => `  - ${p}`).join('\n') +
      `\n\nCopy .env.test.example to .env.test and fill it in. See that file for why each ` +
      `of these is checked.`,
  );
}

// --- redis reachability ------------------------------------------------------------------
// Checked up front because the failure is otherwise unrecognisable. ioredis is constructed
// with maxRetriesPerRequest: null, so when Redis is down commands queue forever instead of
// erroring — and the symptom is four unrelated-looking route tests timing out (the two that
// read the bid cache and the two that enqueue a close job) while everything else passes.
// Diagnosed the slow way once already; one connect attempt here says it in a line.
{
  const { hostname, port } = new URL(process.env.REDIS_URL!);
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) || 6379 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });

  if (!reachable) {
    throw new Error(
      `Redis is not reachable at ${hostname}:${port}.\n` +
        `  docker start bidvault-test-redis\n` +
        `or, the first time:\n` +
        `  docker run -d --name bidvault-test-redis -p ${port}:6379 redis:8-alpine`,
    );
  }
}
