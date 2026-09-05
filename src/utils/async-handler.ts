import type { Request, Response, NextFunction } from 'express';

// Express 5's own types widened every route param to `string | string[]`, to cover the
// general case of a wildcard route capturing more than one segment (`/*splat`). This app has
// no wildcard routes -- every `:param` matches exactly one segment -- so that width is never
// real here, only noise at every one of the dozens of call sites that read one. Every route
// handler in this codebase is wrapped in asyncHandler, so narrowing the Request type here
// once fixes every one of them instead of casting at each site.
type Req = Request<Record<string, string>>;

type AsyncHandler = (req: Req, res: Response, next: NextFunction) => Promise<unknown>;

export function asyncHandler(handler: AsyncHandler) {
  return (req: Req, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}
