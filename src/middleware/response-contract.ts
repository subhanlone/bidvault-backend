import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { documentInput } from '../openapi/document.js';

/**
 * Checks every response against the schema the contract publishes for it.
 *
 * The gap this closes: `ok<T>(res, data)` infers `T` from whatever it is handed, so it
 * accepts anything. Three mappers declare a contract type as their return type and are
 * genuinely bound — the other forty-odd responses had no check at all, and a route could
 * return a shape openapi.json says is impossible with nothing anywhere noticing. That is
 * exactly how `GET /watchlist` came to serve a five-field subset of the auction it
 * documented.
 *
 * The schemas come from `documentInput`, which is the OpenAPI document as authored, before
 * zod-openapi converts it. So this validates against the same Zod objects openapi.json is
 * generated from — not a re-derived copy, and not a JSON Schema translation of one. The
 * published contract and the enforced rule cannot describe different things.
 *
 * Deliberately not express-openapi-validator: that would add 110 packages to the request
 * path to check the converted output, when the authored schemas are already in memory.
 */

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

type ResponseSpec = { content?: Record<string, { schema?: unknown }> };
type OperationSpec = { responses?: Record<string, ResponseSpec> };

/** "POST /auth/register" -> { "201": schema, "400": schema, ... } */
const contract = new Map<string, Map<string, ZodType>>();

for (const [path, operations] of Object.entries(documentInput.paths ?? {})) {
  for (const method of METHODS) {
    const operation = (operations as Record<string, OperationSpec | undefined>)[method];
    if (!operation) continue;

    const byStatus = new Map<string, ZodType>();
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      const schema = response?.content?.['application/json']?.schema;
      // Everything in this document is a Zod schema; the guard is for the shape of the
      // object literal, not a real alternative.
      if (schema && typeof (schema as ZodType).safeParse === 'function') {
        byStatus.set(String(status), schema as ZodType);
      }
    }
    contract.set(`${method.toUpperCase()} ${path}`, byStatus);
  }
}

/**
 * The schema published for one operation and status, or undefined if there is none.
 *
 * Exported so scripts/verify-contract.ts checks a live server against exactly the objects
 * this middleware checks the test suite against. Two lookups built from the same document
 * would still be two lookups, and could disagree.
 */
export function responseSchemaFor(
  method: string,
  path: string,
  status: number | string = 200,
): ZodType | undefined {
  return contract.get(`${method.toUpperCase()} ${path}`)?.get(String(status));
}

/**
 * The OpenAPI key for the route Express actually matched, or null if it matched none.
 *
 * Resolved at response time rather than request time: `req.route` is only populated once
 * routing has picked a handler, which is after this middleware runs but before the handler
 * calls res.json. Mirrors the normalisation in scripts/verify-routes.ts — Express writes
 * `:param` where the contract writes `{param}`, and the /api/v1 base lives in `servers`.
 */
function operationKey(req: Request): string | null {
  const routePath = (req as Request & { route?: { path?: string } }).route?.path;
  if (!routePath) return null;

  const path =
    `${req.baseUrl}${routePath}`
      .replace(/^\/api\/v1/, '')
      .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
      .replace(/\/$/, '') || '/';

  return `${req.method.toUpperCase()} ${path}`;
}

/**
 * Violations are recorded and logged, never thrown.
 *
 * Throwing was the first design and it was wrong twice over. A contract violation is a
 * defect in the contract or the handler, not in the request — failing the response turns a
 * documentation problem into an outage for whoever happened to be calling. And it does not
 * even report cleanly: the throw propagates to errorHandler, whose own res.json re-enters
 * this check, which throws again, and Express gives up with an empty 500 that says nothing
 * about what actually mismatched.
 *
 * So: the response is always served as the handler wrote it. Every environment logs. Tests
 * drain the list after each request and fail on anything in it, which is where enforcement
 * belongs — the message is exact, and the response under test is the real one.
 *
 * Keyed by operation + status rather than pushed onto a plain array (BV-016): a single
 * flapping operation serving one wrong shape on every request used to grow this without
 * bound in a long-running process — nothing but a test's afterEach ever drained it, and
 * production never calls that. A map re-records the same key in place, so the process holds
 * at most one entry per distinct (operation, status) drift, capped at MAX_RECORDED as a
 * backstop — the API has 43 operations and a handful of statuses each, so reaching it
 * organically would itself be its own incident.
 */
const MAX_RECORDED = 100;
const recorded = new Map<string, string>();

function violation(dedupeKey: string, message: string): void {
  console.error(`[contract] ${message}`);
  if (!recorded.has(dedupeKey) && recorded.size >= MAX_RECORDED) return;
  recorded.set(dedupeKey, message);
}

/**
 * Returns everything recorded since the last call, and clears it.
 * Used by the conformance suite's afterEach; not part of the request path.
 */
export function takeViolations(): string[] {
  const values = [...recorded.values()];
  recorded.clear();
  return values;
}

/** Distinct (operation, status) violations currently outstanding — read by GET /health. */
export function violationCount(): number {
  return recorded.size;
}

function check(req: Request, res: Response, body: unknown): void {
  const key = operationKey(req);
  // No route matched: the 404 handler answering, which the contract does not describe.
  if (!key) return;

  const byStatus = contract.get(key);
  if (!byStatus) {
    violation(key, `${key} is served but openapi.json does not document it`);
    return;
  }

  const status = String(res.statusCode);
  const schema = byStatus.get(status);

  if (!schema) {
    // An undocumented success status is drift. An undocumented failure usually is not:
    // errorHandler's 500 is deliberately not in the contract, and neither is every
    // possible 4xx on every route.
    if (res.statusCode < 300) {
      violation(`${key} ${status}`, `${key} answered ${status}, which the contract does not document`);
    }
    return;
  }

  const parsed = schema.safeParse(body);
  if (parsed.success) return;

  const issues = parsed.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  violation(`${key} ${status}`, `${key} ${status} does not match its schema — ${issues}`);
}

export function responseContract() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const original = res.json.bind(res);
    res.json = (body: unknown) => {
      check(req, res, body);
      return original(body);
    };
    next();
  };
}

/** Exposed for the test that asserts this covers every documented operation. */
export const contractSize = contract.size;
