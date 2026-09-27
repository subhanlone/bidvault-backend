import type { Request, Response, NextFunction } from 'express';

// Express 5's own types widened every route param to `string | string[]`, to cover the
// general case of a wildcard route capturing more than one segment (`/*splat`). This app has
// no wildcard routes -- every `:param` matches exactly one segment -- so that width is never
// real here, only noise at every one of the dozens of call sites that read one. Every route
// handler in this codebase is wrapped in asyncHandler, so narrowing the Request type here
// once fixes every one of them instead of casting at each site.
//
// `ReqBody` defaults to `unknown`, not `any`: a route with no body schema still reads
// `req.body` legitimately (e.g. to check it's empty), and `unknown` forces that read through a
// real type guard instead of quietly staying `any`. A route that does validate its body with
// `validateBody(schema)` passes that schema's inferred type here, which is accurate because
// validateBody replaces `req.body` with `parsed.data` before `next()` ever reaches this handler.
type Req<ReqBody = unknown> = Request<Record<string, string>, unknown, ReqBody>;

type AsyncHandler<ReqBody = unknown> = (
  req: Req<ReqBody>,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

export function asyncHandler<ReqBody = unknown>(handler: AsyncHandler<ReqBody>) {
  return (req: Req<ReqBody>, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}
