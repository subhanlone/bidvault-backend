/**
 * Typed access to a supertest response body.
 *
 * supertest's own `Response.body` is `any` -- there is no way around that, since the wire
 * format is JSON and TypeScript cannot see across an HTTP round trip. But this app's shape at
 * that boundary is not actually unknown: every response is either `{success:true,data}` or
 * `{success:false,error,code?,details?}` (src/utils/response.ts's `ok`/`fail`), and
 * src/middleware/response-contract.ts validates every one of them against the same Zod schema
 * openapi.json publishes for that route and status, in every environment including tests --
 * tests/routes.conformance.test.ts drains and fails on any violation. So by the time a test
 * reads `res.body`, its shape is a verified fact, not a guess, and typing it here is the same
 * boundary-cast `req.body` gets from `validateBody` (src/middleware/validate.ts) and
 * `asyncHandler<ReqBody>` (src/utils/async-handler.ts) on the request side.
 *
 * `res` only needs a `.body` -- accepting the structural shape rather than importing
 * supertest's own Response type sidesteps its `export =` interop and works identically for
 * supertest, superagent, or a hand-built fixture.
 */

interface SuccessEnvelope<T> {
  success: true;
  data: T;
}

interface FailureEnvelope {
  success: false;
  error: string;
  code?: string;
  details?: Record<string, string[]>;
  /** Only errorHandler's own uncaught-exception 500 sets this (src/middleware/error-handler.ts) --
   * absent on every `fail()`-built response. */
  requestId?: string;
}

/** The cursor-pagination envelope every listing route returns (utils/pagination.ts). */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

/** `res.body.data`, typed as `T` -- the shape the caller already knows the route documents. */
export function resData<T>(res: { body: unknown }): T {
  return (res.body as SuccessEnvelope<T>).data;
}

/** The failure envelope, for a response already known (by status code) to be an error. */
export function resError(res: { body: unknown }): FailureEnvelope {
  return res.body as FailureEnvelope;
}
