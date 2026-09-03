import { z } from 'zod';
import { strictEmail, lookupEmail } from '../config/email.js';
import { isAcceptablePassword } from '../security/password-policy.js';

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
const OTP_REGEX = /^\d{6}$/;
const MAX_MONEY = 2_000_000_000;

// The strength rule cannot be expressed in JSON Schema, so `.describe` carries it into
// openapi.json instead. Without it the published contract says only "8-128 characters" while
// the API rejects far more than that, and a client has no way to tell a user why.
const strongPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine(isAcceptablePassword, 'Choose a less common password')
  .describe(
    '8-128 characters. Additionally scored with zxcvbn and rejected below score 2, which ' +
      'refuses common passwords, keyboard walks and dictionary words regardless of length.',
  );

// Emoji are measured in graphemes, not UTF-16 code units.
//
// `.max(8)` on the raw string looks equivalent and is not: a ZWJ sequence such as the family
// emoji is eleven code units and would be refused, while eight separate emoji would be allowed
// through as a single "emoji". Segmenting counts what a reader would call a character. The
// length ceiling stays as a cheap guard so a pathological string is rejected before it is
// segmented at all.
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const emojiField = z
  .string()
  .max(64)
  .refine((value) => [...graphemes.segment(value)].length <= 2, 'Use at most two emoji')
  .describe('At most two emoji, measured as grapheme clusters.');

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
    password: strongPassword,
    role: z.enum(['BUYER', 'SELLER']),
  })
  .meta({ id: 'RegisterRequest' });

export const verifyEmailSchema = z
  .object({ email: lookupEmail, otp: z.string().regex(OTP_REGEX) })
  .meta({ id: 'VerifyEmailRequest' });

export const loginSchema = z
  .object({ email: lookupEmail, password: z.string().min(1).max(128) })
  .meta({ id: 'LoginRequest' });

export const forgotSchema = z.object({ email: lookupEmail }).meta({ id: 'ForgotPasswordRequest' });

export const verifyResetSchema = z
  .object({ email: lookupEmail, otp: z.string().regex(OTP_REGEX) })
  .meta({ id: 'VerifyResetOtpRequest' });

export const resetSchema = z
  .object({
    email: lookupEmail,
    otp: z.string().regex(OTP_REGEX),
    password: strongPassword,
  })
  .meta({ id: 'ResetPasswordRequest' });

export const refreshSchema = z
  .object({ refreshToken: z.string().min(1).max(4096) })
  .meta({ id: 'RefreshRequest' });

export const resendVerificationSchema = z
  .object({ email: lookupEmail })
  .meta({ id: 'ResendVerificationRequest' });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: strongPassword,
  })
  .meta({ id: 'ChangePasswordRequest' });

export const preferencesSchema = z
  .object({
    notifyOutbid: z.boolean().optional(),
    notifyWins: z.boolean().optional(),
    notifyNews: z.boolean().optional(),
  })
  .meta({ id: 'NotificationPreferences' });

export const deleteAccountSchema = z
  .object({ password: z.string().min(1).max(128) })
  .meta({ id: 'DeleteAccountRequest' });

// ---- listings ---------------------------------------------------------------------

export const submitListingSchema = z
  .object({
    title: z.string().trim().min(3).max(150),
    category: z.string().trim().min(2).max(100),
    condition: z.enum(['NEW', 'LIKE_NEW', 'USED']),
    description: z.string().trim().min(10).max(5000),
    startPrice: z.coerce.number().int().positive().max(MAX_MONEY),
    reservePrice: z.coerce.number().int().positive().max(MAX_MONEY).optional(),
    minIncrement: z.coerce.number().int().positive().max(MAX_MONEY),
    durationDays: z.coerce.number().int().positive().max(30),
    imageUrl: z
      .url()
      .refine((value) => new URL(value).protocol === 'https:' && new URL(value).hostname === 'res.cloudinary.com', {
        message: 'Image must use the configured Cloudinary host',
      })
      .optional(),
    emoji: emojiField.optional(),
    // Zod 4 requires the key schema explicitly; single-argument z.record is gone.
    // Per-category shape is enforced separately by validateCategoryAttributes.
    attributes: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'SubmitListingRequest' });

export const rejectListingSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .meta({ id: 'RejectListingRequest' });

// ---- auctions ---------------------------------------------------------------------

export const placeBidSchema = z
  .object({ amount: z.coerce.number().int().positive().max(MAX_MONEY) })
  .meta({ id: 'PlaceBidRequest' });

// ---- payments ---------------------------------------------------------------------

export const payTransactionSchema = z
  .object({
    // Never stored — services/payment-gateway.service.ts reads it once to decide success/
    // decline and discards it, the same as a real processor would.
    cardNumber: z.string().trim().min(12).max(24),
    // BV-047 / E4: the platform held no delivery contact data at all before this. Collected
    // alongside payment rather than as a separate step, since the buyer is already filling in
    // the checkout form at that point.
    deliveryAddress: z.string().trim().min(10).max(300),
    deliveryPhone: z.string().trim().min(7).max(20),
  })
  .meta({ id: 'PayTransactionRequest' });

export const raiseDisputeSchema = z
  .object({ reason: z.string().trim().min(10).max(1000) })
  .meta({ id: 'RaiseDisputeRequest' });

// ---- reviews ----------------------------------------------------------------------

export const createReviewSchema = z
  .object({
    transactionId: z.string().min(1).max(128),
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

// ---- admin ------------------------------------------------------------------------

export const voidTransactionSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .meta({ id: 'VoidTransactionRequest' });

export const anonymizeUserSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .meta({ id: 'AnonymizeUserRequest' });

export const resolveDisputeSchema = z
  .object({
    resolution: z.enum(['REFUND', 'RELEASE']),
    note: z.string().trim().min(3).max(500),
  })
  .meta({ id: 'ResolveDisputeRequest' });

// ---- pagination ---------------------------------------------------------------------

// BV-029: query params for every cursor-paginated list endpoint. Both optional -- a caller
// that sends neither gets the first page at the default size. `cursor` is opaque and
// unvalidated here on purpose: a malformed one is treated as "no cursor" by
// utils/pagination.ts's decodeCursor, not rejected, since a stale bookmarked link should
// degrade to page one rather than error.
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().optional(),
});
