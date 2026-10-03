import crypto from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { Prisma } from '@prisma/client';
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
  deleteAccountSchema,
} from '../../openapi/requests.js';
import { hashToken } from '../../utils/token-hash.js';
import { cameFromTrustedOrigin, clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refresh-cookie.js';
import {
  dispatchEmail,
  sendWelcomeEmail,
  sendEmailVerifiedEmail,
  sendPasswordResetEmail,
  sendPasswordResetCompletedEmail,
  sendSessionsRevokedSecurityAlertEmail,
  sendAccountDeletedEmail,
  sendVerificationResentEmail,
} from '../../services/email.service.js';
import {
  authEmailAddressRateLimit,
  authEmailIpRateLimit,
  loginEmailRateLimit,
  loginIpRateLimit,
} from '../../middleware/rate-limit.js';
import { checkAccountDeletable, anonymizeUser } from '../../services/account.service.js';

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

/**
 * The successor to hand a repeat of a token that was spent moments ago, or null when the repeat
 * is a real replay.
 *
 * Only the token's immediate parent qualifies, and only while that successor is still unused: a
 * token two generations back, or one spent longer ago than the interval, stays theft. The
 * successor is signed again rather than read back -- only hashes are stored -- and the hash check
 * refuses to hand out anything that is not exactly the token that was issued (tokens created
 * before `iat` was pinned to `createdAt` cannot be reproduced, and simply fall back to replay).
 */
async function successorWithinReuseInterval(
  spent: { userId: string; revokedAt: Date | null; replacedByTokenId: string | null },
  remember: boolean,
): Promise<string | null> {
  const intervalMs = env.REFRESH_REUSE_INTERVAL_SECONDS * 1000;
  if (intervalMs === 0 || !spent.revokedAt || !spent.replacedByTokenId) return null;
  if (Date.now() - spent.revokedAt.getTime() > intervalMs) return null;

  const successor = await prisma.refreshToken.findUnique({ where: { id: spent.replacedByTokenId } });
  if (!successor || successor.userId !== spent.userId) return null;
  if (successor.revokedAt || successor.expiresAt <= new Date()) return null;

  const candidate = signRefreshToken({ sub: successor.userId, jti: successor.id, remember }, successor.createdAt);
  return hashToken(candidate) === successor.tokenHash ? candidate : null;
}

/** Whether the session making this request was a remembered one, read from its own refresh
 * cookie; true when there is none or it cannot be read, which is what an unmarked token means. */
function sessionIsRemembered(req: Request): boolean {
  const cookie = readRefreshCookie(req);
  if (!cookie) return true;
  try {
    return verifyRefreshToken(cookie).remember;
  } catch {
    return true;
  }
}

/** Starts a session: the token pair in the body (still read by existing clients) and the refresh
 * token as an HttpOnly cookie, which is what the frontend will rely on instead of storage. */
async function createSessionTokens(params: {
  userId: string;
  role: 'BUYER' | 'SELLER' | 'ADMIN';
  req: Request;
  res: Response;
  remember: boolean;
}): Promise<{ accessToken: string; refreshToken: string }> {
  const refreshTokenId = crypto.randomUUID();
  const issuedAt = new Date();
  const refreshToken = signRefreshToken(
    { sub: params.userId, jti: refreshTokenId, remember: params.remember },
    issuedAt,
  );
  const refreshTokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000);
  const meta = getRequestMeta(params.req);

  await prisma.refreshToken.create({
    data: {
      id: refreshTokenId,
      userId: params.userId,
      tokenHash: refreshTokenHash,
      createdAt: issuedAt,
      expiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
  });

  setRefreshCookie(params.res, refreshToken, params.remember);
  const accessToken = signAccessToken({ sub: params.userId, role: params.role });
  return { accessToken, refreshToken };
}

router.post(
  '/register',
  validateBody(registerSchema),
  asyncHandler<z.infer<typeof registerSchema>>(async (req, res) => {
    const { name, email, password, role } = req.body;
    const normalizedEmail = email.toLowerCase();

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      fail(res, 'An account with this email already exists.', 409);
      return;
    }

    // BV-043: the pre-check above gives the good message on the common path, but a concurrent
    // identical request can still win the race between that read and this write -- the loser
    // hit the shared P2002 handler's generic "A record with these details already exists."
    // instead of this route's own wording. This is the authoritative fallback for that race.
    let user;
    try {
      user = await prisma.user.create({
        data: {
          name,
          email: normalizedEmail,
          passwordHash: await hashPassword(password),
          role,
          isEmailVerified: false,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        fail(res, 'An account with this email already exists.', 409);
        return;
      }
      throw err;
    }

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
  asyncHandler<z.infer<typeof verifyEmailSchema>>(async (req, res) => {
    const { email, otp } = req.body;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    if (!user) {
      fail(res, INVALID_CODE, 422);
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
      fail(res, INVALID_CODE, 422);
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
  asyncHandler<z.infer<typeof loginSchema>>(async (req, res) => {
    const { email, password, remember = true } = req.body;
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

    // C2, Phase 7: requireAuth blocks every subsequent request for a suspended account, but
    // login itself never checked -- a suspended user still walked away with a fresh, valid
    // token pair and only discovered the lockout on their next call. Checked here off the row
    // already loaded above, not isSuspended()'s cache: that cache exists to save a DB round
    // trip on every authenticated request, but login already did the round trip for this row.
    if (user.status === 'SUSPENDED') {
      fail(res, 'This account has been suspended.', 403);
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
      res,
      remember,
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
  asyncHandler<z.infer<typeof refreshSchema>>(async (req, res) => {
    // The token comes from the body (existing clients, and a one-time migration of a session that
    // still lives in localStorage) or, failing that, from the HttpOnly cookie. Only the cookie
    // path is something a browser attaches by itself, so only that path has to prove the request
    // came from the app.
    const fromBody = req.body.refreshToken;
    const refreshToken = fromBody ?? readRefreshCookie(req);
    const viaCookie = fromBody === undefined;

    if (!refreshToken) {
      fail(res, 'Invalid refresh token.', 401);
      return;
    }
    if (viaCookie && !cameFromTrustedOrigin(req)) {
      fail(res, 'Request origin not allowed.', 403, 'ORIGIN_NOT_ALLOWED');
      return;
    }

    // A refusal on the cookie path also drops the cookie: it is dead, and the browser would
    // otherwise keep sending it on every refresh attempt.
    const deny = (message: string) => {
      if (viaCookie) clearRefreshCookie(res);
      fail(res, message, 401);
    };

    let payload: { sub: string; jti: string; remember: boolean };

    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      deny('Invalid refresh token.');
      return;
    }

    const tokenHash = hashToken(refreshToken);
    const tokenRecord = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!tokenRecord) {
      deny('Refresh token expired or revoked.');
      return;
    }

    // A spent token coming back is a replay: the family is revoked, and the owner is told -- once,
    // and only if this actually signed something out (every request that loses a race for the same
    // token lands here, and a replay against an already-dead family has nothing new to report).
    const rejectReplay = async () => {
      const revoked = await prisma.refreshToken.updateMany({
        where: { userId: tokenRecord.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      console.warn('[auth] refresh token reuse detected; revoked token family', {
        userId: tokenRecord.userId,
        sessionsRevoked: revoked.count,
      });
      if (revoked.count > 0) {
        dispatchEmail(
          sendSessionsRevokedSecurityAlertEmail({ email: tokenRecord.user.email, name: tokenRecord.user.name }),
          'refresh token reuse detected',
        );
      }
      deny('Session invalidated. Please sign in again.');
    };

    // A token spent a moment ago is usually not theft but a second tab that asked at the same
    // instant as the first (see REFRESH_REUSE_INTERVAL_SECONDS). It gets the successor that already
    // exists, so both tabs end up holding the same token whichever response lands last.
    const answerRepeat = async (spent: {
      userId: string;
      revokedAt: Date | null;
      replacedByTokenId: string | null;
    }): Promise<boolean> => {
      const successor = await successorWithinReuseInterval(spent, payload.remember);
      if (!successor) return false;
      setRefreshCookie(res, successor, payload.remember);
      ok(res, {
        accessToken: signAccessToken({ sub: tokenRecord.userId, role: tokenRecord.user.role }),
        refreshToken: successor,
      });
      return true;
    };

    if (tokenRecord.revokedAt) {
      if (!(await answerRepeat(tokenRecord))) await rejectReplay();
      return;
    }

    if (tokenRecord.expiresAt <= new Date()) {
      deny('Refresh token expired or revoked.');
      return;
    }

    if (tokenRecord.id !== payload.jti) {
      deny('Refresh token mismatch.');
      return;
    }

    const newRefreshId = crypto.randomUUID();
    const issuedAt = new Date();
    const newRefreshToken = signRefreshToken(
      { sub: tokenRecord.userId, jti: newRefreshId, remember: payload.remember },
      issuedAt,
    );
    const newHash = hashToken(newRefreshToken);
    const expiresAt = new Date(Date.now() + env.JWT_REFRESH_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000);
    const meta = getRequestMeta(req);

    // Spending the token is the check. The revokedAt test above is only a fast path: two requests
    // in flight together both pass it, and an unconditional update let each mint a successor --
    // one token, two live sessions, nothing for reuse detection to see. Here the update only
    // matches while the token is still unspent, so Postgres lets exactly one request through
    // (a second waits on the row, then finds it already spent) and the rest are repeats.
    const rotated = await prisma.$transaction(async (tx) => {
      const spent = await tx.refreshToken.updateMany({
        where: { id: tokenRecord.id, revokedAt: null },
        data: { revokedAt: new Date(), replacedByTokenId: newRefreshId },
      });
      if (spent.count !== 1) return false;

      await tx.refreshToken.create({
        data: {
          id: newRefreshId,
          userId: tokenRecord.userId,
          tokenHash: newHash,
          createdAt: issuedAt,
          expiresAt,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      });
      return true;
    });

    if (!rotated) {
      // Lost the race: the winner has committed by now, so the row shows it spent and by whom.
      const spent = await prisma.refreshToken.findUnique({ where: { id: tokenRecord.id } });
      if (!spent || !(await answerRepeat(spent))) await rejectReplay();
      return;
    }

    const accessToken = signAccessToken({
      sub: tokenRecord.userId,
      role: tokenRecord.user.role,
    });

    setRefreshCookie(res, newRefreshToken, payload.remember);
    ok(res, {
      accessToken,
      refreshToken: newRefreshToken,
    });
  }),
);

router.post(
  '/logout',
  validateBody(refreshSchema),
  asyncHandler<z.infer<typeof refreshSchema>>(async (req, res) => {
    const fromBody = req.body.refreshToken;
    const refreshToken = fromBody ?? readRefreshCookie(req);

    // Signing someone out is a nuisance rather than a theft, but a cookie request still has to
    // come from the app (see /refresh).
    if (fromBody === undefined && refreshToken && !cameFromTrustedOrigin(req)) {
      fail(res, 'Request origin not allowed.', 403, 'ORIGIN_NOT_ALLOWED');
      return;
    }

    if (refreshToken) {
      await prisma.refreshToken.updateMany({
        where: {
          tokenHash: hashToken(refreshToken),
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
    }

    // Always, and also when there was nothing to revoke: the point is that the browser stops
    // holding a session.
    clearRefreshCookie(res);
    ok(res, { message: 'Logged out successfully.' });
  }),
);

router.post(
  '/forgot-password',
  authEmailIpRateLimit,
  validateBody(forgotSchema),
  authEmailAddressRateLimit,
  asyncHandler<z.infer<typeof forgotSchema>>(async (req, res) => {
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
  asyncHandler<z.infer<typeof verifyResetSchema>>(async (req, res) => {
    const { email, otp } = req.body;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    if (!user) {
      fail(res, INVALID_CODE, 422);
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
      fail(res, INVALID_CODE, 422);
      return;
    }

    ok(res, { message: 'Reset code verified.' });
  }),
);

router.post(
  '/reset-password',
  validateBody(resetSchema),
  asyncHandler<z.infer<typeof resetSchema>>(async (req, res) => {
    const { email, otp, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    if (!user) {
      fail(res, INVALID_CODE, 422);
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
      fail(res, INVALID_CODE, 422);
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
  asyncHandler<z.infer<typeof resendVerificationSchema>>(async (req, res) => {
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
  asyncHandler<z.infer<typeof changePasswordSchema>>(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });

    if (!user) {
      fail(res, 'User not found.', 404);
      return;
    }

    const matched = await verifyPassword(currentPassword, user.passwordHash);
    if (!matched) {
      fail(res, 'Current password is incorrect.', 422);
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

    // Revoking every session is the point -- a stolen one must not outlive the password. But that
    // sweep also kills the session doing the asking, and until this was added the effect was that
    // changing your own password signed you out of the device in front of you: the request
    // succeeded, the screen looked fine, and some minutes later the next token refresh returned
    // "Session invalidated. Please sign in again." mid-task, for no reason the user could see.
    //
    // Issued after the transaction, never inside it, so the sweep above cannot revoke the very
    // token being handed back. Re-authenticating instead would cost a second bcrypt verify and
    // spend from the login rate limiter, which is the wrong thing to charge someone for
    // rotating their own password.
    const tokens = await createSessionTokens({
      userId: user.id,
      role: user.role,
      req,
      res,
      remember: sessionIsRemembered(req),
    });

    dispatchEmail(
      sendPasswordResetCompletedEmail({ email: user.email, name: user.name }),
      'password changed',
    );

    ok(res, { message: 'Password changed successfully.', ...tokens });
  }),
);

// BV-018: anonymise-in-place, not DELETE -- see services/account.service.ts. Self-service
// mirrors how eBay actually gates account closure: no active listing, nothing unpaid or
// still in progress. Requires the current password for the same reason change-password does
// -- a session left open on a shared device should not be able to do this with one click.
router.post(
  '/delete-account',
  requireAuth(),
  validateBody(deleteAccountSchema),
  asyncHandler<z.infer<typeof deleteAccountSchema>>(async (req, res) => {
    const { password } = req.body;
    const userId = req.auth!.userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      fail(res, 'User not found.', 404);
      return;
    }

    const matched = await verifyPassword(password, user.passwordHash);
    if (!matched) {
      fail(res, 'Password is incorrect.', 422);
      return;
    }

    const guard = await checkAccountDeletable(userId);
    if (!guard.allowed) {
      fail(res, guard.reason!, 409);
      return;
    }

    // Sent to the real address before anonymizeUser replaces it -- there is nothing left to
    // deliver to afterward.
    dispatchEmail(sendAccountDeletedEmail({ email: user.email, name: user.name }), 'account deleted');

    await anonymizeUser(userId);
    clearRefreshCookie(res);
    ok(res, { message: 'Your account has been deleted.' });
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
  asyncHandler<z.infer<typeof preferencesSchema>>(async (req, res) => {
    const updated = await prisma.user.update({
      where: { id: req.auth!.userId },
      data: req.body,
      select: { notifyOutbid: true, notifyWins: true, notifyNews: true },
    });
    ok(res, updated);
  }),
);

export default router;
