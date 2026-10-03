import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env.js';

export interface AccessTokenPayload {
  sub: string;
  role: 'BUYER' | 'SELLER' | 'ADMIN';
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  /**
   * false for a session the user asked not to keep ("Keep me signed in" unticked): its cookie is
   * a browser-session cookie rather than a 14-day one. It rides in the token because rotation has
   * to hand it on to every successor, and a claim is the one place that needs no database column.
   * Absent means true, which is also what every token issued before this existed means.
   */
  remember?: boolean;
}

const ISSUER = 'bidvault';
const ACCESS_AUDIENCE = 'bidvault-api';
const REFRESH_AUDIENCE = 'bidvault-refresh';

const accessPayloadSchema = z.object({
  sub: z.string().min(1),
  role: z.enum(['BUYER', 'SELLER', 'ADMIN']),
});

const refreshPayloadSchema = z.object({
  sub: z.string().min(1),
  jti: z.string().min(1),
  rem: z.boolean().optional(),
});

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: ACCESS_AUDIENCE,
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: ACCESS_AUDIENCE,
  });
  return accessPayloadSchema.parse(decoded);
}

/**
 * `issuedAt` pins the token's `iat` (and so its `exp`). The database keeps only a hash of each
 * refresh token, never the token, so a duplicate request inside the reuse interval can only be
 * given the successor it raced with by signing it again -- and that comes out byte-for-byte the
 * same only if the second signature carries the same timestamp as the first. Callers store the
 * same instant as the row's `createdAt`.
 */
export function signRefreshToken(payload: RefreshTokenPayload, issuedAt?: Date): string {
  // Built here, in one fixed order, because the reuse interval re-signs a successor and needs
  // the same bytes: `rem` is written only when it is false, so a normal token is exactly what it
  // always was.
  const claims = {
    sub: payload.sub,
    jti: payload.jti,
    ...(payload.remember === false ? { rem: false } : {}),
    ...(issuedAt ? { iat: Math.floor(issuedAt.getTime() / 1000) } : {}),
  };
  return jwt.sign(claims, env.JWT_REFRESH_SECRET, {
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: REFRESH_AUDIENCE,
    expiresIn: `${env.JWT_REFRESH_EXPIRES_IN_DAYS}d`,
  });
}

export function verifyRefreshToken(token: string): { sub: string; jti: string; remember: boolean } {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: REFRESH_AUDIENCE,
  });
  const { sub, jti, rem } = refreshPayloadSchema.parse(decoded);
  return { sub, jti, remember: rem !== false };
}
