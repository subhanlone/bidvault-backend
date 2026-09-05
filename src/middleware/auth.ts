import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../utils/jwt.js';
import { fail } from '../utils/response.js';
import { isSuspended } from '../services/user-status.service.js';

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

      if (allowedRoles && !allowedRoles.includes(payload.role)) {
        fail(res, 'Forbidden', 403);
        return;
      }

      // C2, Phase 7: checked after the role gate (a cheaper, synchronous check first) but
      // before every route handler -- a suspended account loses every authenticated action,
      // not just the ones a route author remembered to add a check to.
      if (await isSuspended(payload.sub)) {
        fail(res, 'This account has been suspended.', 403);
        return;
      }

      next();
    } catch {
      fail(res, 'Invalid or expired token', 401);
    }
  };
}
