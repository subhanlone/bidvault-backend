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
  const claims = issuedAt ? { ...payload, iat: Math.floor(issuedAt.getTime() / 1000) } : payload;
  return jwt.sign(claims, env.JWT_REFRESH_SECRET, {
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: REFRESH_AUDIENCE,
    expiresIn: `${env.JWT_REFRESH_EXPIRES_IN_DAYS}d`,
  });
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: REFRESH_AUDIENCE,
  });
  return refreshPayloadSchema.parse(decoded);
}
