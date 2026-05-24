import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../utils/jwt.js';
import { fail } from '../utils/response.js';

export type Role = 'BUYER' | 'SELLER' | 'ADMIN';

export function requireAuth(allowedRoles?: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
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

      next();
    } catch {
      fail(res, 'Invalid or expired token', 401);
    }
  };
}
