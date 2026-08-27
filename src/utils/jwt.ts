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

export function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
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
