import type { NextFunction, Request, Response } from 'express';
import { getPlatformSettings } from '../services/settings.service.js';
import { verifyAccessToken } from '../utils/jwt.js';

// Paths that must stay reachable while maintenance mode is on.
const EXEMPT_PREFIXES = [
  '/api/v1/health',
  '/api/v1/settings/public',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/payments/webhook',
];

/**
 * When maintenanceMode is enabled, non-admin requests receive 503 (code MAINTENANCE),
 * except for the exempt paths above. Admins (valid ADMIN access token) always pass.
 * Fails open if settings can't be read, so a settings outage never locks everyone out.
 */
export async function maintenanceGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const settings = await getPlatformSettings();
    if (!settings.maintenanceMode) {
      next();
      return;
    }

    if (EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
      try {
        const payload = verifyAccessToken(token);
        if (payload.role === 'ADMIN') {
          next();
          return;
        }
      } catch {
        // invalid token during maintenance → treated as non-admin
      }
    }

    res.status(503).json({
      success: false,
      error: 'BidVault is currently under maintenance. Please check back shortly.',
      code: 'MAINTENANCE',
    });
  } catch {
    next();
  }
}
