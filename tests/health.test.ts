/**
 * The deep healthcheck.
 *
 * The probe timeout is the load-bearing part and the easiest thing to get wrong: ioredis is
 * built with `maxRetriesPerRequest: null`, so against an unreachable Redis a command never
 * rejects — it queues forever. A probe without a race would hang the health endpoint instead
 * of reporting Redis down, which is the opposite of the point.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { probe } = await import('../src/services/health.service.js');

const app = createApp();

describe('GET /health', () => {
  it('reports both dependencies up, with the build identity', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'ok',
      service: 'bidvault-backend',
      dependencies: {
        database: { state: 'up' },
        redis: { state: 'up' },
      },
    });
    // The contract version, so a deployed build can be identified from outside. Without this
    // the only way to tell which commit is live is to read GitHub's deployment records.
    expect(res.body.data.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(res.body.data.commit).toBeTruthy();
    expect(res.body.data.dependencies.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('stays 200 and reports redis down when redis is unreachable', async () => {
    // Note what this does and does not prove. A disconnected ioredis client rejects
    // immediately ("Connection is closed"), so this exercises the error path, not the
    // timeout — verified by removing the race, after which this still passed. The timeout
    // is covered by its own test below.
    redisConnection.disconnect();
    try {
      const started = Date.now();
      const res = await request(app).get('/api/v1/health');
      const elapsed = Date.now() - started;

      // Liveness is unaffected: the process is alive, so Railway must not restart it.
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ok');
      expect(res.body.data.dependencies.redis.state).toBe('down');
      // Database is independent and should still report up.
      expect(res.body.data.dependencies.database.state).toBe('up');
      // Bounded by the 2s probe timeout rather than hanging.
      expect(elapsed).toBeLessThan(6_000);
    } finally {
      redisConnection.connect().catch(() => undefined);
    }
  }, 20_000);
});

describe('probe timeout', () => {
  it('gives up on a dependency that never answers', async () => {
    // The real hazard: ioredis with maxRetriesPerRequest: null does not reject against an
    // unreachable host, it queues indefinitely. Without the race, /health would hang rather
    // than report the dependency down.
    const started = Date.now();
    const result = await probe(() => new Promise(() => {}));
    const elapsed = Date.now() - started;

    expect(result.state).toBe('down');
    expect(elapsed).toBeGreaterThanOrEqual(1_800);
    expect(elapsed).toBeLessThan(4_000);
  }, 10_000);
});

process.on('beforeExit', () => {
  void prisma.$disconnect();
  redisConnection.disconnect();
});
