import { z } from 'zod';
import { strictEmail, lookupEmail } from '../config/email.js';

/**
 * Every request body the API accepts.
 *
 * These live here rather than beside their routes for one concrete reason: the OpenAPI
 * generator has to import them, and importing a route module drags in Prisma, Redis,
 * Cloudinary and `config/env.ts` — which calls `process.exit(1)` when a variable is
 * missing. Codegen would then need a full production environment to run, and would die in
 * CI. This module imports nothing with side effects, so `npm run api:contract` works on a
 * bare checkout.
 *
 * Route files import from here and pass these to `validateBody`, so there is still exactly
 * one definition per request — the published contract and the enforced rule cannot drift.
 */

// Letters (incl. accented), spaces, hyphens, and apostrophes only — no digits or other symbols.
const NAME_REGEX = /^[\p{L}\s'-]+$/u;
// Pakistani CNIC: 5 digits - 7 digits - 1 digit
const CNIC_REGEX = /^\d{5}-\d{7}-\d{1}$/;
const OTP_REGEX = /^\d{6}$/;

// ---- auth -------------------------------------------------------------------------

// Register creates the stored address, so it takes the strict rule; every other route here
// only looks an existing address up. See config/email.ts.
export const registerSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .regex(NAME_REGEX, 'Name can only contain letters, spaces, hyphens, and apostrophes'),
    email: strictEmail,
    cnic: z.string().trim().regex(CNIC_REGEX, 'CNIC must be in the format 12345-1234567-1'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    role: z.enum(['BUYER', 'SELLER']),
  })
  .meta({ id: 'RegisterRequest' });

export const verifyEmailSchema = z
  .object({ email: lookupEmail, otp: z.string().regex(OTP_REGEX) })
  .meta({ id: 'VerifyEmailRequest' });

export const loginSchema = z
  .object({ email: lookupEmail, password: z.string().min(1) })
  .meta({ id: 'LoginRequest' });

export const forgotSchema = z.object({ email: lookupEmail }).meta({ id: 'ForgotPasswordRequest' });

export const verifyResetSchema = z
  .object({ email: lookupEmail, otp: z.string().regex(OTP_REGEX) })
  .meta({ id: 'VerifyResetOtpRequest' });

export const resetSchema = z
  .object({
    email: lookupEmail,
    otp: z.string().regex(OTP_REGEX),
    password: z.string().min(8, 'Password must be at least 8 characters'),
  })
  .meta({ id: 'ResetPasswordRequest' });

export const refreshSchema = z
  .object({ refreshToken: z.string().min(1) })
  .meta({ id: 'RefreshRequest' });

export const resendVerificationSchema = z
  .object({ email: lookupEmail })
  .meta({ id: 'ResendVerificationRequest' });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8, 'Password must be at least 8 characters'),
  })
  .meta({ id: 'ChangePasswordRequest' });

export const preferencesSchema = z
  .object({
    notifyOutbid: z.boolean().optional(),
    notifyWins: z.boolean().optional(),
    notifyNews: z.boolean().optional(),
  })
  .meta({ id: 'NotificationPreferences' });

// ---- listings ---------------------------------------------------------------------

export const submitListingSchema = z
  .object({
    title: z.string().trim().min(3).max(150),
    category: z.string().trim().min(2),
    condition: z.enum(['NEW', 'LIKE_NEW', 'USED']),
    description: z.string().trim().min(10).max(5000),
    startPrice: z.coerce.number().int().positive(),
    reservePrice: z.coerce.number().int().positive().optional(),
    minIncrement: z.coerce.number().int().positive(),
    durationDays: z.coerce.number().int().positive().max(30),
    imageUrl: z.url().optional(),
    emoji: z.string().optional(),
    // Zod 4 requires the key schema explicitly; single-argument z.record is gone.
    // Per-category shape is enforced separately by validateCategoryAttributes.
    attributes: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'SubmitListingRequest' });

export const rejectListingSchema = z
  .object({ reason: z.string().trim().min(3) })
  .meta({ id: 'RejectListingRequest' });

// ---- auctions ---------------------------------------------------------------------

export const placeBidSchema = z
  .object({ amount: z.coerce.number().int().positive() })
  .meta({ id: 'PlaceBidRequest' });

// ---- payments ---------------------------------------------------------------------

export const createIntentSchema = z
  .object({ transactionId: z.string().min(1) })
  .meta({ id: 'CreateIntentRequest' });

// ---- reviews ----------------------------------------------------------------------

export const createReviewSchema = z
  .object({
    transactionId: z.string().min(1),
    stars: z.coerce.number().int().min(1).max(5),
    comment: z.string().max(500).optional(),
  })
  .meta({ id: 'CreateReviewRequest' });

// ---- settings ---------------------------------------------------------------------

export const updateSettingsSchema = z
  .object({
    emailNotifsEnabled: z.boolean().optional(),
    maintenanceMode: z.boolean().optional(),
    maxBidIncrement: z.coerce.number().int().positive().optional(),
    minListingPrice: z.coerce.number().int().positive().optional(),
    reviewTimeoutHours: z.coerce.number().int().positive().optional(),
    // Stores an address, so it gets the strict rule — same one register uses.
    supportEmail: strictEmail.optional(),
  })
  .meta({ id: 'UpdateSettingsRequest' });
