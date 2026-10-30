import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../utils/jwt.js';
import { fail } from '../utils/response.js';
import { getAccountAccess } from '../services/user-status.service.js';

export type Role = 'BUYER' | 'SELLER' | 'ADMIN';

/**
 * BV-039: some routes are genuinely public but still need to know *who's asking*, without
 * making authentication mandatory -- the public bid feed masks every bidder's identity except
 * the caller's own. A missing, malformed or expired token is not an error here, it just means
 * an anonymous view; only a token that verifies gets req.auth populated.
 */
export function optionalAuth() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
      try {
        const payload = verifyAccessToken(token);
        req.auth = { userId: payload.sub, role: payload.role };
      } catch {
        // Anonymous view, same as no token at all.
      }
    }
    next();
  };
}

/**
 * B5: what an account may do is decided here, from the database, not from the `role` claim in the
 * token. Every non-admin account is a BUYER; it is also a SELLER while its isSeller flag is set.
 * That is why `requireAuth(['BUYER'])` accepts a seller (they can buy too) and
 * `requireAuth(['SELLER'])` is the gate for creating inventory. Routes that only look at what the
 * caller already owns (shipping a sale, reading their items) accept `['BUYER', 'SELLER']` so a
 * seller whose capability was withdrawn can still finish what they started. ADMIN stays the token's
 * claim and is never combined with the others.
 */
export function requireAuth(allowedRoles?: Role[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      fail(res, 'Unauthorized', 401);
      return;
    }

    try {
      const payload = verifyAccessToken(token);
      req.auth = { userId: payload.sub, role: payload.role };

      const isAdmin = payload.role === 'ADMIN';
      // An admin-only route needs no lookup to refuse a non-admin, and an admin is never anything
      // but an admin: the cheap synchronous refusals first.
      if (allowedRoles) {
        const wantsAccount = allowedRoles.includes('BUYER') || allowedRoles.includes('SELLER');
        if (isAdmin ? !allowedRoles.includes('ADMIN') : !wantsAccount) {
          fail(res, 'Forbidden', 403);
          return;
        }
      }

      const access = await getAccountAccess(payload.sub);

      if (allowedRoles && !isAdmin) {
        const allowed =
          allowedRoles.includes('BUYER') || (allowedRoles.includes('SELLER') && access.isSeller);
        if (!allowed) {
          fail(res, 'Forbidden', 403);
          return;
        }
      }

      // C2, Phase 7: checked after the role gate but before every route handler -- a suspended
      // account loses every authenticated action, not just the ones a route author remembered to
      // add a check to.
      if (access.suspended) {
        fail(res, 'This account has been suspended.', 403);
        return;
      }

      next();
    } catch {
      fail(res, 'Invalid or expired token', 401);
    }
  };
}
