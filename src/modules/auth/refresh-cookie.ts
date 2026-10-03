import type { Request, Response } from 'express';
import { clientOrigins, cookieSecure, env } from '../../config/env.js';

/**
 * The refresh token as an HttpOnly cookie, so page script can never read it.
 *
 * OWASP: "Do not store authentication tokens, session IDs, JWTs, refresh tokens, or any
 * credential in localStorage or sessionStorage." Anything in there is one XSS away from being
 * copied out and used for the token's whole 14 days. A cookie the browser sends but script cannot
 * see is what that guidance points to.
 *
 * Attributes, and why:
 *  - HttpOnly: the point of all this.
 *  - Secure (outside local dev): never sent over plain HTTP.
 *  - SameSite=Strict: the browser will not attach it to any request that starts on another site.
 *    That is the CSRF defence; the frontend (www.) and the API (api.) are the same site, so
 *    ordinary use is unaffected. A different *site* hosting the frontend would silently lose the
 *    cookie, which is why the deployment keeps both under one registrable domain.
 *  - Path=/api/v1/auth: only the auth routes (refresh, logout, change-password) ever see it, not
 *    every API call.
 *  - no Domain: host-only, so a sibling subdomain cannot receive or overwrite it.
 *  - Max-Age only for a remembered session; otherwise a browser-session cookie.
 */
export const REFRESH_COOKIE = 'bv_refresh';
const COOKIE_PATH = '/api/v1/auth';

const baseOptions = () => ({
  httpOnly: true,
  secure: cookieSecure,
  sameSite: 'strict' as const,
  path: COOKIE_PATH,
});

export function setRefreshCookie(res: Response, token: string, remember: boolean): void {
  res.cookie(REFRESH_COOKIE, token, {
    ...baseOptions(),
    ...(remember ? { maxAge: env.JWT_REFRESH_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000 } : {}),
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, baseOptions());
}

/** The refresh cookie's value, or undefined. One named cookie is all this reads, so there is no
 * cookie-parsing dependency: the value is a JWT and never contains `;` or `=` that matter here. */
export function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== REFRESH_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value || undefined;
  }
  return undefined;
}

/**
 * Whether a request that arrived carrying only the cookie really came from the app.
 *
 * SameSite=Strict already keeps the browser from sending the cookie cross-site; this is the
 * second layer, for the day a cookie attribute is loosened or a browser misbehaves. Browsers
 * always send `Origin` on a cross-origin fetch and on every POST, so a request with the cookie
 * and no (or a foreign) Origin is not the frontend. A caller that holds the token itself and
 * sends it in the body needs none of this -- an attacker cannot put it there.
 */
export function cameFromTrustedOrigin(req: Request): boolean {
  const origin = req.get('origin');
  return origin !== undefined && clientOrigins.includes(origin);
}
