import crypto from 'node:crypto';
import { Router } from 'express';
import type { Request } from 'express';
import type { UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../../utils/password.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../utils/jwt.js';
import { validateBody } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import { OTP_EXPIRY_MS } from '../../config/otp.js';
import type { UserDtoType } from '../../openapi/schemas.js';
import {
  registerSchema,
  verifyEmailSchema,
  loginSchema,
  forgotSchema,
  verifyResetSchema,
  resetSchema,
  refreshSchema,
  resendVerificationSchema,
  changePasswordSchema,
  preferencesSchema,
} from '../../openapi/requests.js';
import { hashToken } from '../../utils/token-hash.js';
import {
  dispatchEmail,
  sendWelcomeEmail,
  sendEmailVerifiedEmail,
  sendPasswordResetEmail,
  sendPasswordResetCompletedEmail,
  sendVerificationResentEmail,
} from '../../services/email.service.js';
import {
  authEmailAddressRateLimit,
  authEmailIpRateLimit,
  loginEmailRateLimit,
  loginIpRateLimit,
} from '../../middleware/rate-limit.js';

const router = Router();
const MAX_OTP_ATTEMPTS = 5;
const INVALID_CODE = 'Invalid or expired code.';

function generateOtp(): string {
  return String(crypto.randomInt(100000, 1000000));
}

function otpMatches(expected: string, received: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function recordVerificationMiss(tokenId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "EmailVerificationToken"
    SET attempts = attempts + 1,
        "consumedAt" = CASE WHEN attempts + 1 >= ${MAX_OTP_ATTEMPTS} THEN NOW() ELSE "consumedAt" END
    WHERE id = ${tokenId} AND "consumedAt" IS NULL
  `;
}

async function recordResetMiss(tokenId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "PasswordResetToken"
    SET attempts = attempts + 1,
        "consumedAt" = CASE WHEN attempts + 1 >= ${MAX_OTP_ATTEMPTS} THEN NOW() ELSE "consumedAt" END
    WHERE id = ${tokenId} AND "consumedAt" IS NULL
  `;
}

// Window length and its rationale live in config/otp.ts, shared with the email templates.

// See toAuctionDto — the return type is the published contract, so drift is a build error.
function sanitizeUser(user: { id: string; name: string; email: string; role: UserRole; isEmailVerified: boolean; createdAt: Date }): UserDtoType {
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isEmailVerified: user.isEmailVerified,
    createdAt: user.createdAt.toISOString(),
  };
}

function getRequestMeta(req: Request): { ipAddress?: string; userAgent?: string } {
  const ipAddress = req.ip || req.socket.remoteAddress || undefined;
  const userAgent = req.headers['user-agent']?.slice(0, 255);
  return { ipAddress, userAgent };
}

async function createSessionTokens(params: {
  userId: string;
  role: 'BUYER' | 'SELLER' | 'ADMIN';
  req: Request;
}): Promise<{ accessToken: string; refreshToken: string }> {
  const refreshTokenId = crypto.randomUUID();
  const refreshToken = signRefreshToken({ sub: params.userId, jti: refreshTokenId });
  const refreshTokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000);
  const meta = getRequestMeta(params.req);

  await prisma.refreshToken.create({
    data: {
      id: refreshTokenId,
      userId: params.userId,
      tokenHash: refreshTokenHash,
      expiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
  });

  const accessToken = signAccessToken({ sub: params.userId, role: params.role });
  return { accessToken, refreshToken };
}

router.post(
  '/register',
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const { name, email, cnic, password, role } = req.body;
    const normalizedEmail = email.toLowerCase();

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      fail(res, 'An account with these details already exists.', 409);
      return;
    }

    const existingCnic = await prisma.user.findUnique({ where: { cnic } });
    if (existingCnic) {
      fail(res, 'An account with these details already exists.', 409);
      return;
    }

    const user = await prisma.user.create({
      data: {
        name,
        email: normalizedEmail,
        cnic,
        passwordHash: await hashPassword(password),
        role,
        isEmailVerified: false,
      },
    });

    const code = generateOtp();
    const codeExpiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        code,
        expiresAt: codeExpiresAt,
      },
    });

    dispatchEmail(sendWelcomeEmail({ email: user.email, name: user.name }, code), 'welcome');

    ok(
      res,
      {
        user: sanitizeUser(user),
        verificationCode: env.NODE_ENV === 'production' ? undefined : code,
        codeExpiresAt: codeExpiresAt.toISOString(),
      },
      201,
    );
  }),
);

router.post(
  '/verify-email',
  validateBody(verifyEmailSchema),
  asyncHandler(async (req, res) => {
    const { email, otp } = req.body;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    if (!user) {
      fail(res, INVALID_CODE, 400);
      return;
    }

    const token = await prisma.emailVerificationToken.findFirst({
      where: {
        userId: user.id,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: MAX_OTP_ATTEMPTS },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!token || !otpMatches(token.code, otp)) {
      if (token) await recordVerificationMiss(token.id);
      fail(res, INVALID_CODE, 400);
      return;
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { isEmailVerified: true },
      }),
      prisma.emailVerificationToken.update({
        where: { id: token.id },
        data: { consumedAt: new Date() },
      }),
    ]);

    dispatchEmail(sendEmailVerifiedEmail({ email: user.email, name: user.name }), 'email verified');

    ok(res, { message: 'Email verified successfully.' });
  }),
);

router.post(
  '/login',
  loginIpRateLimit,
  validateBody(loginSchema),
  loginEmailRateLimit,
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    const matched = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !matched) {
      fail(res, 'Incorrect email or password.', 401);
      return;
    }

    if (!user.isEmailVerified) {
      fail(res, 'Please verify your email first.', 403, 'EMAIL_NOT_VERIFIED');
      return;
    }

    // Re-hash accounts still on the old cost, which is what makes the dummy-hash comparison
    // above actually level the timing.
    //
    // Every account created before the cost went to 12 carries a cost-10 hash, and bcrypt reads
    // the cost from the hash — so those users verify roughly four times faster than the cost-12
    // dummy. The comparison closes the "does this address exist" gap only for accounts hashed at
    // the current cost; until then it leaks the same fact with the sign reversed. Login is the
    // one moment the plaintext is available, so it is the only place the upgrade can happen.
    if (needsRehash(user.passwordHash)) {
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(password) },
      });
    }

    const { accessToken, refreshToken } = await createSessionTokens({
      userId: user.id,
      role: user.role,
      req,
    });

    ok(res, {
      accessToken,
      refreshToken,
      user: sanitizeUser(user),
    });
  }),
);

router.post(
  '/refresh',
  validateBody(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;
    let payload: { sub: string; jti: string };

    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      fail(res, 'Invalid refresh token.', 401);
      return;
    }

    const tokenHash = hashToken(refreshToken);
    const tokenRecord = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!tokenRecord) {
      fail(res, 'Refresh token expired or revoked.', 401);
      return;
    }

    if (tokenRecord.revokedAt) {
      await prisma.refreshToken.updateMany({
        where: { userId: tokenRecord.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      console.warn('[auth] refresh token reuse detected; revoked token family', {
        userId: tokenRecord.userId,
      });
      fail(res, 'Session invalidated. Please sign in again.', 401);
      return;
    }

    if (tokenRecord.expiresAt <= new Date()) {
      fail(res, 'Refresh token expired or revoked.', 401);
      return;
    }

    if (tokenRecord.id !== payload.jti) {
      fail(res, 'Refresh token mismatch.', 401);
      return;
    }

    const newRefreshId = crypto.randomUUID();
    const newRefreshToken = signRefreshToken({ sub: tokenRecord.userId, jti: newRefreshId });
    const newHash = hashToken(newRefreshToken);
    const expiresAt = new Date(Date.now() + env.JWT_REFRESH_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000);
    const meta = getRequestMeta(req);

    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: tokenRecord.id },
        data: {
          revokedAt: new Date(),
          replacedByTokenId: newRefreshId,
        },
      }),
      prisma.refreshToken.create({
        data: {
          id: newRefreshId,
          userId: tokenRecord.userId,
          tokenHash: newHash,
          expiresAt,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      }),
    ]);

    const accessToken = signAccessToken({
      sub: tokenRecord.userId,
      role: tokenRecord.user.role,
    });

    ok(res, {
      accessToken,
      refreshToken: newRefreshToken,
    });
  }),
);

router.post(
  '/logout',
  validateBody(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;
    const tokenHash = hashToken(refreshToken);

    await prisma.refreshToken.updateMany({
      where: {
        tokenHash,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    ok(res, { message: 'Logged out successfully.' });
  }),
);

router.post(
  '/forgot-password',
  authEmailIpRateLimit,
  validateBody(forgotSchema),
  authEmailAddressRateLimit,
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    // FP-01: return generic 200 regardless — prevents email enumeration
    if (!user) {
      ok(res, { message: 'If that email is registered, a reset code was sent.' });
      return;
    }

    // FP-03: revoke all unconsumed reset tokens before issuing a new one
    await prisma.passwordResetToken.deleteMany({
      where: { userId: user.id, consumedAt: null },
    });

    const code = generateOtp();
    const codeExpiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        code,
        expiresAt: codeExpiresAt,
      },
    });

    dispatchEmail(sendPasswordResetEmail({ email: user.email, name: user.name }, code), 'password reset');

    ok(res, {
      message: 'Reset code sent.',
      resetCode: env.NODE_ENV === 'production' ? undefined : code,
      codeExpiresAt: codeExpiresAt.toISOString(),
    });
  }),
);

router.post(
  '/verify-reset-otp',
  validateBody(verifyResetSchema),
  asyncHandler(async (req, res) => {
    const { email, otp } = req.body;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    if (!user) {
      fail(res, INVALID_CODE, 400);
      return;
    }

    const token = await prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: MAX_OTP_ATTEMPTS },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!token || !otpMatches(token.code, otp)) {
      if (token) await recordResetMiss(token.id);
      fail(res, INVALID_CODE, 400);
      return;
    }

    ok(res, { message: 'Reset code verified.' });
  }),
);

router.post(
  '/reset-password',
  validateBody(resetSchema),
  asyncHandler(async (req, res) => {
    const { email, otp, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    if (!user) {
      fail(res, INVALID_CODE, 400);
      return;
    }

    const token = await prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: MAX_OTP_ATTEMPTS },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!token || !otpMatches(token.code, otp)) {
      if (token) await recordResetMiss(token.id);
      fail(res, INVALID_CODE, 400);
      return;
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(password) },
      }),
      prisma.passwordResetToken.update({
        where: { id: token.id },
        data: { consumedAt: new Date() },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    dispatchEmail(sendPasswordResetCompletedEmail({ email: user.email, name: user.name }), 'password reset completed');

    ok(res, { message: 'Password reset successfully.' });
  }),
);

router.post(
  '/resend-verification',
  authEmailIpRateLimit,
  validateBody(resendVerificationSchema),
  authEmailAddressRateLimit,
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    if (!user || user.isEmailVerified) {
      ok(res, { message: 'If that email exists and is unverified, a new code was sent.' });
      return;
    }

    // EV-02: revoke all unconsumed tokens before issuing a new one
    await prisma.emailVerificationToken.deleteMany({
      where: { userId: user.id, consumedAt: null },
    });

    const code = generateOtp();
    const codeExpiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        code,
        expiresAt: codeExpiresAt,
      },
    });

    dispatchEmail(sendVerificationResentEmail({ email: user.email, name: user.name }, code), 'verification resent');

    ok(res, {
      message: 'Verification code resent.',
      verificationCode: env.NODE_ENV === 'production' ? undefined : code,
      codeExpiresAt: codeExpiresAt.toISOString(),
    });
  }),
);

router.post(
  '/change-password',
  requireAuth(),
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });

    if (!user) {
      fail(res, 'User not found.', 404);
      return;
    }

    const matched = await verifyPassword(currentPassword, user.passwordHash);
    if (!matched) {
      fail(res, 'Current password is incorrect.', 400);
      return;
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    dispatchEmail(
      sendPasswordResetCompletedEmail({ email: user.email, name: user.name }),
      'password changed',
    );

    ok(res, { message: 'Password changed successfully.' });
  }),
);

router.get(
  '/me',
  requireAuth(),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    if (!user) {
      fail(res, 'User not found.', 404);
      return;
    }
    ok(res, { user: sanitizeUser(user) });
  }),
);

router.get(
  '/me/preferences',
  requireAuth(),
  asyncHandler(async (req, res) => {
    const prefs = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { notifyOutbid: true, notifyWins: true, notifyNews: true },
    });
    if (!prefs) {
      fail(res, 'User not found.', 404);
      return;
    }
    ok(res, prefs);
  }),
);

router.patch(
  '/me/preferences',
  requireAuth(),
  validateBody(preferencesSchema),
  asyncHandler(async (req, res) => {
    const updated = await prisma.user.update({
      where: { id: req.auth!.userId },
      data: req.body,
      select: { notifyOutbid: true, notifyWins: true, notifyNews: true },
    });
    ok(res, updated);
  }),
);

export default router;
