/**
 * BV-016: the violation tracker dedupes by (operation, status) and never grows without
 * bound. Exercised directly against the middleware with hand-built req/res rather than a
 * full app + database — the thing under test is bookkeeping, not routing, and the app is
 * currently violation-free, so there is no real endpoint left to misbehave on demand.
 *
 * The 100-entry cap itself is not exercised here: the API publishes 43 operations with a
 * handful of statuses each, so reaching 100 *distinct* (operation, status) violations
 * simultaneously is not reachable through this API's real surface — it is a backstop against
 * a future with more operations, not a limit this suite can trigger honestly.
 */
import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { responseContract, takeViolations, violationCount } from '../src/middleware/response-contract.js';

function fakeExchange(statusCode: number) {
  const req = { method: 'GET', baseUrl: '/api/v1', route: { path: '/health' } } as unknown as Request;
  const res = { statusCode, json: () => res } as unknown as Response;
  return { req, res };
}

describe('response-contract violation tracking', () => {
  it('dedupes repeated drift on the same (operation, status) and drains on takeViolations', () => {
    takeViolations(); // leftover from another test file importing the same module singleton
    const middleware = responseContract();
    // Missing every field HealthDto requires -- guaranteed to fail its schema regardless of
    // what the real handler happens to serve today.
    const badBody = { nothing: 'here' };

    for (let i = 0; i < 3; i++) {
      const { req, res } = fakeExchange(200);
      middleware(req, res, () => {});
      res.json(badBody);
    }

    expect(violationCount()).toBe(1);

    const drained = takeViolations();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain('GET /health 200 does not match its schema');
    expect(violationCount()).toBe(0);
  });

  it('tracks two different statuses on the same operation as two entries', () => {
    takeViolations();
    const middleware = responseContract();
    const badBody = { nothing: 'here' };

    // 200 fails HealthDto's schema; 201 is a success status GET /health does not document at
    // all -- two different violation branches in check(), and two different dedupe keys.
    for (const statusCode of [200, 201]) {
      const { req, res } = fakeExchange(statusCode);
      middleware(req, res, () => {});
      res.json(badBody);
    }

    expect(violationCount()).toBe(2);
    takeViolations();
  });
});
