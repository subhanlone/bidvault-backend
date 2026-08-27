/**
 * `trust proxy`, proved locally because it cannot be proved in production.
 *
 * Express ignores X-Forwarded-For unless told how many proxies to trust, so without this
 * setting `req.ip` on Railway is the edge's address, not the client's. Everything that keys
 * off a client address is then wrong -- RefreshToken.ipAddress records the same handful of
 * infrastructure IPs for every session, and an IP-based rate limit (BV-002) buckets the whole
 * world under one key.
 *
 * The correct hop count depends on the deployed topology, which cannot be measured from here:
 * the Railway subscription has lapsed, so no new build has shipped since 2026-08-21 and there
 * is nothing current to probe. TRUST_PROXY_HOPS exists so the number can be corrected from
 * the dashboard once that changes, without a code change.
 *
 * What these tests establish is the part that *is* knowable locally: the semantics of each
 * value, so that whoever sets it in production knows what they are choosing. Which value
 * Railway needs remains open -- see BV-022.
 *
 * The counting is easy to get wrong, and an earlier draft of this file did: a proxy *appends*
 * the address it received from, so one proxy in front produces a single X-Forwarded-For
 * entry, not two. Express then counts hops from the app outward across
 * `[socket, ...reversed(X-Forwarded-For)]`. Hence: one proxy -> 1, two proxies -> 2.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

/** A minimal app that reports what Express resolved, so nothing else is under test. */
function appWithHops(hops: number) {
  const app = express();
  app.set('trust proxy', hops);
  app.get('/whoami', (req, res) => {
    res.json({ ip: req.ip, ips: req.ips });
  });
  return app;
}

// Reserved documentation ranges, so these can never collide with a real address.
const CLIENT = '203.0.113.7';   // the real caller
const MIDDLE = '198.51.100.2';  // an outer proxy, when there are two

afterEach(() => {
  delete process.env.TRUST_PROXY_HOPS;
});

describe('trust proxy hop counts', () => {
  it('0 hops: X-Forwarded-For is ignored entirely', async () => {
    const res = await request(appWithHops(0))
      .get('/whoami')
      .set('X-Forwarded-For', CLIENT);

    // The socket address, never the header. This is the local default, and it is what makes
    // a spoofed header harmless when there is genuinely no proxy in front.
    expect(res.body.ip).not.toBe(CLIENT);
    expect(res.body.ips).toEqual([]);
  });

  it('1 hop behind one proxy: req.ip is the client', async () => {
    // One proxy in front appends the address it received from, so X-Forwarded-For carries
    // exactly one entry: the client.
    const res = await request(appWithHops(1))
      .get('/whoami')
      .set('X-Forwarded-For', CLIENT);

    expect(res.body.ip).toBe(CLIENT);
  });

  it('1 hop behind TWO proxies resolves the wrong address, silently', async () => {
    // The failure this finding is about. Two proxies produce two entries; a count of 1 reads
    // only the nearest, so req.ip becomes the outer proxy -- a plausible-looking address that
    // is not the client. Nothing errors. The data is just wrong.
    const res = await request(appWithHops(1))
      .get('/whoami')
      .set('X-Forwarded-For', `${CLIENT}, ${MIDDLE}`);

    expect(res.body.ip).toBe(MIDDLE);
    expect(res.body.ip).not.toBe(CLIENT);
  });

  it('2 hops behind two proxies: req.ip is the client', async () => {
    const res = await request(appWithHops(2))
      .get('/whoami')
      .set('X-Forwarded-For', `${CLIENT}, ${MIDDLE}`);

    expect(res.body.ip).toBe(CLIENT);
  });

  it('a client cannot spoof past the trusted count', async () => {
    // The client sends its own X-Forwarded-For; the single real proxy appends the address it
    // actually saw. With 1 hop, Express reads exactly one entry from the right, so the
    // attacker's prepended value can never become req.ip.
    const spoofed = '10.0.0.99';
    const res = await request(appWithHops(1))
      .get('/whoami')
      .set('X-Forwarded-For', `${spoofed}, ${CLIENT}`);

    expect(res.body.ip).toBe(CLIENT);
    expect(res.body.ip).not.toBe(spoofed);
  });

  it('too many hops reads an attacker-supplied entry as the client', async () => {
    // Over-counting is as wrong as under-counting, in the more dangerous direction: with one
    // real proxy but a count of 2, the spoofed entry the client prepended becomes req.ip.
    const spoofed = '10.0.0.99';
    const res = await request(appWithHops(2))
      .get('/whoami')
      .set('X-Forwarded-For', `${spoofed}, ${CLIENT}`);

    expect(res.body.ip).toBe(spoofed);
  });
});

describe('the app reads the hop count from the environment', () => {
  it('defaults to 0 when TRUST_PROXY_HOPS is unset', async () => {
    delete process.env.TRUST_PROXY_HOPS;
    vi.resetModules();
    const { env } = await import('../src/config/env.js');
    expect(env.TRUST_PROXY_HOPS).toBe(0);
  });

  it('createApp applies whatever the environment resolved to', async () => {
    const { createApp } = await import('../src/app.js');
    const { env } = await import('../src/config/env.js');
    const app = createApp();
    // The wiring, not the value: whatever env produced is what Express was given.
    expect(app.get('trust proxy')).toBe(env.TRUST_PROXY_HOPS);
  });
});

/**
 * The 0 default is right locally and catastrophic deployed, so production must state the value.
 *
 * Behind a proxy with a count of 0, `req.ip` is the proxy for every caller — so the IP rate
 * limiters share one counter across the whole user base and the global 300/minute becomes the
 * platform's ceiling. From outside that is indistinguishable from an outage, and nothing in the
 * logs names the cause. Refusing to boot converts a silent platform-wide failure into an
 * immediate one that says what to fix.
 *
 * Run in a child process because the guard calls process.exit, which would end the test run.
 */
describe('production refuses to boot without an explicit hop count', () => {
  function loadEnvIn(overrides: Record<string, string | undefined>) {
    const child = { ...process.env, ...overrides };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete child[key];
    }
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', "void import('./src/config/env.ts');"],
      { env: child, cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' },
    );
  }

  it('exits with an actionable message when TRUST_PROXY_HOPS is unset', () => {
    const res = loadEnvIn({ NODE_ENV: 'production', TRUST_PROXY_HOPS: undefined });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('TRUST_PROXY_HOPS must be set explicitly');
    // The message has to be enough to act on without reading the source.
    expect(res.stderr).toContain('reverse proxies');
  });

  it('boots when the value is stated', () => {
    const res = loadEnvIn({ NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' });

    expect(res.stderr).not.toContain('TRUST_PROXY_HOPS must be set');
    expect(res.status).toBe(0);
  });

  it('does not impose the requirement outside production', () => {
    const res = loadEnvIn({ NODE_ENV: 'development', TRUST_PROXY_HOPS: undefined });

    expect(res.status).toBe(0);
  });
});
