import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Request } from 'express';
import type { UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../utils/jwt.js';
import { validateBody } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import { OTP_EXPIRY_MS } from '../../config/otp.js';
import { hashToken } from '../../utils/token-hash.js';
import {
  sendWelcomeEmail,
  sendEmailVerifiedEmail,
  sendPasswordResetEmail,
  sendPasswordResetCompletedEmail,
  sendVerificationResentEmail,
} from '../../services/email.service.js';

const router = Router();

// Letters (incl. accented), spaces, hyphens, and apostrophes only — no digits or other symbols.
const NAME_REGEX = /^[\p{L}\s'-]+$/u;
// Stricter than zod's built-in .email(): requires a real TLD-shaped domain, rejects
// consecutive/leading/trailing dots and hyphens in domain labels.
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
// Pakistani CNIC: 5 digits - 7 digits - 1 digit
const CNIC_REGEX = /^\d{5}-\d{7}-\d{1}$/;

const registerSchema = z.object({
  name: z.string().trim().min(2).max(100).regex(NAME_REGEX, 'Name can only contain letters, spaces, hyphens, and apostrophes'),
  email: z.string().trim().regex(EMAIL_REGEX, 'Enter a valid email address'),
  cnic: z.string().trim().regex(CNIC_REGEX, 'CNIC must be in the format 12345-1234567-1'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['BUYER', 'SELLER']),
});

const verifyEmailSchema = z.object({
  email: z.string().trim().email(),
  otp: z.string().regex(/^\d{6}$/),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const forgotSchema = z.object({
  email: z.string().trim().email(),
});

const verifyResetSchema = z.object({
  email: z.string().trim().email(),
  otp: z.string().regex(/^\d{6}$/),
});

const resetSchema = z.object({
  email: z.string().trim().email(),
  otp: z.string().regex(/^\d{6}$/),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const resendVerificationSchema = z.object({
  email: z.string().trim().email(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

const preferencesSchema = z.object({
  notifyOutbid: z.boolean().optional(),
  notifyWins: z.boolean().optional(),
  notifyNews: z.boolean().optional(),
});

function generateOtp(): string {
  return String(crypto.randomInt(100000, 1000000));
}

// Window length and its rationale live in config/otp.ts, shared with the email templates.

function sanitizeUser(user: { id: string; name: string; email: string; role: UserRole; isEmailVerified: boolean; createdAt: Date }) {
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
      fail(res, 'An account with this email already exists.', 409);
      return;
    }

    const existingCnic = await prisma.user.findUnique({ where: { cnic } });
    if (existingCnic) {
      fail(res, 'An account with this CNIC already exists.', 409);
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

    await sendWelcomeEmail({ email: user.email, name: user.name }, code);

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
      fail(res, 'Account not found.', 404);
      return;
    }

    const token = await prisma.emailVerificationToken.findFirst({
      where: {
        userId: user.id,
        code: otp,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!token) {
      fail(res, 'Invalid or expired verification code.', 400);
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

    await sendEmailVerifiedEmail({ email: user.email, name: user.name });

    ok(res, { message: 'Email verified successfully.' });
  }),
);

router.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    if (!user) {
      fail(res, 'Incorrect email or password.', 401);
      return;
    }

    const matched = await verifyPassword(password, user.passwordHash);
    if (!matched) {
      fail(res, 'Incorrect email or password.', 401);
      return;
    }

    if (!user.isEmailVerified) {
      fail(res, 'Please verify your email first.', 403, 'EMAIL_NOT_VERIFIED');
      return;
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

    if (!tokenRecord || tokenRecord.revokedAt || tokenRecord.expiresAt <= new Date()) {
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
  validateBody(forgotSchema),
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

    await sendPasswordResetEmail({ email: user.email, name: user.name }, code);

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
      fail(res, 'No account found with this email address.', 404);
      return;
    }

    const token = await prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        code: otp,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!token) {
      fail(res, 'Invalid or expired reset code.', 400);
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
      fail(res, 'No account found with this email address.', 404);
      return;
    }

    const token = await prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        code: otp,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!token) {
      fail(res, 'Invalid or expired reset code.', 400);
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

    await sendPasswordResetCompletedEmail({ email: user.email, name: user.name });

    ok(res, { message: 'Password reset successfully.' });
  }),
);

router.post(
  '/resend-verification',
  validateBody(resendVerificationSchema),
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

    await sendVerificationResentEmail({ email: user.email, name: user.name }, code);

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

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword) },
    });

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
