import type { NextFunction, Request, Response } from 'express';

/**
 * `Cache-Control: no-store` on every API response.
 *
 * Almost everything this API returns is about one signed-in person -- their bids, their wins,
 * their listings, an admin's user directory -- and the sign-in routes return the tokens
 * themselves. None of it should end up in any cache, ours or anyone else's. Before this the API
 * sent no Cache-Control at all, which leaves the decision to whatever sits between the server and
 * the browser and to default heuristics; OWASP's advice is to avoid relying on default caching
 * behaviour for sensitive content, and to put `no-store` on responses that carry session
 * identifiers.
 *
 * Why `no-store` and not `private`: RFC 9111 5.2.2.5 has `no-store` bind both private and shared
 * caches, so `private` would add nothing next to it, and `no-cache` is the wrong tool (it allows
 * storing and only requires revalidating before reuse). `Pragma` is not added: RFC 9111 5.4
 * deprecates it and says its meaning in a response was never specified.
 *
 * It is a default for the whole /api/v1 surface rather than a list of routes, deliberately: a new
 * route is protected without anyone remembering to opt in. A handler that has a real reason to be
 * cacheable can still set its own Cache-Control after this runs.
 *
 * Mounted before everything else, CORS included, so the responses that never reach a route -- a
 * refused origin, a 429, a 404 -- carry it too. RFC 9111 itself calls `no-store` "not a reliable
 * or sufficient mechanism for ensuring privacy": it is one layer, next to the Authorization-bearing
 * requests a compliant shared cache already will not reuse (RFC 9111 3.5) and TLS.
 */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
