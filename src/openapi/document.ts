import { z } from 'zod';
import { createDocument } from 'zod-openapi';
import type { ZodType } from 'zod';
import * as S from './schemas.js';
import * as R from './requests.js';

/**
 * The OpenAPI document. `npm run api:contract` renders this to openapi.json, and the
 * frontend generates src/types/api.d.ts from that file.
 *
 * Imports only side-effect-free modules — see requests.ts for why that matters.
 */

const JSON_CT = 'application/json';

/** Every success response is `{ success: true, data }`; see utils/response.ts. */
const okBody = (data: ZodType, description: string) => ({
  description,
  content: { [JSON_CT]: { schema: z.object({ success: z.literal(true), data }) } },
});

/** Every failure is `{ success: false, error, code? }`. */
const ErrorBody = z
  .object({
    success: z.literal(false),
    error: z.string(),
    code: z.string().optional(),
  })
  .meta({ id: 'ErrorResponse' });

/**
 * Validation failures add `details`, a field -> messages map produced by z.flattenError.
 * The frontend currently ignores it and shows only `error`.
 */
const ValidationErrorBody = z
  .object({
    success: z.literal(false),
    error: z.literal('Validation error'),
    details: z.record(z.string(), z.array(z.string())),
  })
  .meta({ id: 'ValidationError' });

const errBody = (description: string) => ({
  description,
  content: { [JSON_CT]: { schema: ErrorBody } },
});

const badRequest = {
  description: 'Validation failed',
  content: { [JSON_CT]: { schema: ValidationErrorBody } },
};

/**
 * The request was well-formed — `validateBody` already let it through — but a business rule
 * the handler checks itself rejects it: an expired OTP, a bid under the floor, a listing not
 * in the right state. See BV-065: nine operations answered these with 400 alongside
 * validateBody's ValidationErrorBody, so a single status code carried two undiscoverable
 * shapes and the response-contract middleware could only ever be right about one of them.
 * 422 is unused elsewhere in this document, so giving it exclusively to this kind of failure
 * keeps every status meaning exactly one thing: 400 malformed, 401 bad credentials, 404 no
 * such resource, 409 the resource already exists, 422 a business rule rejected an otherwise
 * valid request.
 */
const unprocessable = (description: string) => ({
  description,
  content: { [JSON_CT]: { schema: ErrorBody } },
});

const unauthorized = errBody('Missing, invalid or expired access token');
const forbidden = errBody('Authenticated but the wrong role for this route');
const notFound = errBody('Not found');

/**
 * Declared only on the routes carrying their own limit, not on all forty-odd operations.
 *
 * A global 300/minute per address applies to everything and is described in `info.description`
 * instead — repeating it on every operation would bury the limits that are specific enough to
 * be worth designing a client around.
 */
const tooManyRequests = errBody('Rate limit exceeded; retry after the window resets');

const jsonRequest = (schema: ZodType) => ({
  content: { [JSON_CT]: { schema } },
});

/**
 * The document as authored, with the Zod schemas still in place.
 *
 * createDocument() converts every schema below to JSON Schema, so the converted output is
 * no longer parseable. src/middleware/response-contract.ts validates real responses against
 * these schemas, and reads them from here for that reason — the spec and the runtime check
 * are then the same objects, and cannot describe different things.
 */
const documentInput = {
  openapi: '3.1.0',
  info: {
    title: 'BidVault API',
    // Bumped 2026-08-27, major. See COMPATIBILITY.md — a bump is how a change oasdiff calls
    // breaking is declared deliberate, and the level is a judgment the tool cannot make.
    //
    // This one: every money field gained a ceiling of 2,000,000,000 — bid `amount`, and
    // `startPrice`, `reservePrice` and `minIncrement` on a listing. Previously they were
    // bounded only by JavaScript's safe-integer range, while the columns behind them are
    // int32; a value above 2,147,483,647 reached Postgres and failed there as a 500 instead
    // of a validation error.
    //
    // Major rather than minor, deliberately. The band between 2,000,000,001 and 2,147,483,647
    // did fit in the column and did succeed, so this is not the document catching up with the
    // server — it is the server accepting strictly less than it used to. No real listing is
    // priced at two billion rupees and the practical risk is nil, but "no caller would do
    // that" is not the same claim as "no caller could", and COMPATIBILITY.md is explicit that
    // the second is what minor asserts.
    //
    // Also in 2.0.0, all additive: 429 declared on the four rate-limited operations,
    // 403 on login (EMAIL_NOT_VERIFIED, previously served but undocumented), the dead 404 on
    // verify-email removed now that an unknown address answers the same neutral 400 as a
    // wrong code, maxLength on password/token/text fields, and UploadSignature gaining
    // publicId and allowedFormats.
    //
    // 2.1.0, 2026-08-28, minor: change-password answers PasswordChanged rather than Message,
    // adding accessToken and refreshToken beside the existing message. Strictly additive —
    // the field a 2.0.0 caller reads is still there and still means the same thing — so minor
    // is what COMPATIBILITY.md asks for. A caller that ignores the new fields behaves exactly
    // as before, including being signed out when its access token expires; that is the bug
    // the fields exist to let a caller fix, not a promise the document had made.
    //
    // 2.2.0, 2026-08-30, minor: nine operations gained a 409 or 422 for a business-rule
    // rejection their handler always made and this document never declared — an expired OTP,
    // a bid below the floor, a listing not pending, and six more. Every one of those requests
    // used to arrive at a caller as an undeclared 400 whose body (ErrorResponse) did not match
    // the only 400 shape published (ValidationErrorBody). Purely additive: no status a caller
    // already handled changed meaning or disappeared, this only names ones it was silently
    // receiving. See BV-065. Also removed a 409 on POST /auctions/{auctionId}/bids that had
    // been declared but was never reachable — SELECT ... FOR UPDATE serialises concurrent
    // bids rather than racing them, so nothing in the handler could ever produce it.
    //
    // 2.3.0, 2026-08-30, minor: GET /health gained contractViolations, a live count of
    // (operation, status) pairs currently answering a shape their own schema forbids. Purely
    // additive — every existing field is unchanged. See BV-016.
    //
    // 2.4.0, 2026-08-30, minor: GET /health documents 503 during graceful shutdown, so a load
    // balancer stops routing new traffic to an instance that is draining. See BV-052.
    //
    // 2.5.0, 2026-08-30, minor: GET /health gained workerHeartbeatAgeSeconds, so a dead
    // lifecycle worker is externally observable instead of silent. See BV-012.
    version: '3.0.0',
    description:
      'Auction platform API. Generated from the Zod schemas the server actually validates ' +
      'and serves — see backend/src/openapi. Do not hand-edit openapi.json.\n\n' +
      'Every route is rate limited to 300 requests per minute per client address and answers ' +
      '429 with the standard `RateLimit` headers (draft-8) once that is exceeded. Routes that ' +
      'carry a tighter limit of their own declare 429 individually.',
  },
  servers: [
    { url: 'https://bidvault-backend-production.up.railway.app/api/v1', description: 'Production' },
    { url: 'http://localhost:4000/api/v1', description: 'Local' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
  paths: {
    // ---- platform ------------------------------------------------------------------
    '/health': {
      get: {
        tags: ['Platform'],
        summary: 'Liveness only — does not check the database or Redis',
        responses: {
          200: okBody(S.HealthDto, 'Service is up'),
          503: errBody('Shutting down — stop routing new traffic here (BV-052)'),
        },
      },
    },
    '/stats': {
      get: {
        tags: ['Platform'],
        summary: 'Public counters for the landing page',
        responses: { 200: okBody(S.PlatformStatsDto, 'Platform counters') },
      },
    },

    // ---- auth ----------------------------------------------------------------------
    '/auth/register': {
      post: {
        tags: ['Auth'],
        requestBody: jsonRequest(R.registerSchema),
        responses: {
          201: okBody(S.RegistrationDto, 'Account created; verification code sent'),
          400: badRequest,
          409: errBody('Email already registered'),
        },
      },
    },
    '/auth/verify-email': {
      post: {
        tags: ['Auth'],
        requestBody: jsonRequest(R.verifyEmailSchema),
        responses: {
          // No 404: an unknown address answers the same neutral 400 as a wrong code, so that
          // the response cannot be used to test whether an account exists.
          200: okBody(S.MessageDto, 'Email verified'),
          400: badRequest,
          422: unprocessable('The code is invalid or expired'),
        },
      },
    },
    '/auth/resend-verification': {
      post: {
        tags: ['Auth'],
        summary: 'Neutral response — does not reveal whether the address exists',
        description: 'Limited to 3 per hour per address and 10 per hour per client address, ' +
          'shared with /auth/forgot-password.',
        requestBody: jsonRequest(R.resendVerificationSchema),
        responses: {
          200: okBody(S.OtpIssuedDto, 'Code resent if applicable'),
          400: badRequest,
          429: tooManyRequests,
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        description: 'Limited to 10 attempts per 15 minutes, per client address and per address.',
        requestBody: jsonRequest(R.loginSchema),
        responses: {
          200: okBody(S.SessionDto, 'Signed in'),
          400: badRequest,
          401: errBody('Incorrect email or password'),
          403: errBody('Email not verified (code EMAIL_NOT_VERIFIED)'),
          429: tooManyRequests,
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotates the refresh token',
        requestBody: jsonRequest(R.refreshSchema),
        responses: { 200: okBody(S.RefreshedTokensDto, 'New token pair'), 401: unauthorized },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        requestBody: jsonRequest(R.refreshSchema),
        responses: { 200: okBody(S.MessageDto, 'Signed out') },
      },
    },
    '/auth/forgot-password': {
      post: {
        tags: ['Auth'],
        summary: 'Neutral response — does not reveal whether the address exists',
        description: 'Limited to 3 per hour per address and 10 per hour per client address, ' +
          'shared with /auth/resend-verification.',
        requestBody: jsonRequest(R.forgotSchema),
        responses: {
          200: okBody(S.OtpIssuedDto, 'Reset code sent if applicable'),
          400: badRequest,
          429: tooManyRequests,
        },
      },
    },
    '/auth/verify-reset-otp': {
      post: {
        tags: ['Auth'],
        requestBody: jsonRequest(R.verifyResetSchema),
        responses: {
          200: okBody(S.MessageDto, 'Code accepted'),
          400: badRequest,
          422: unprocessable('The code is invalid or expired'),
        },
      },
    },
    '/auth/reset-password': {
      post: {
        tags: ['Auth'],
        requestBody: jsonRequest(R.resetSchema),
        responses: {
          200: okBody(S.MessageDto, 'Password reset'),
          400: badRequest,
          422: unprocessable('The code is invalid or expired'),
        },
      },
    },
    '/auth/change-password': {
      post: {
        tags: ['Auth'],
        security: [{ bearerAuth: [] }],
        requestBody: jsonRequest(R.changePasswordSchema),
        responses: {
          200: okBody(S.PasswordChangedDto, 'Password changed; a replacement session is issued'),
          400: badRequest,
          401: unauthorized,
          422: unprocessable('The current password is incorrect'),
        },
      },
    },
    '/auth/delete-account': {
      post: {
        tags: ['Auth'],
        security: [{ bearerAuth: [] }],
        summary: 'Anonymise-in-place (BV-018) — refused while you have an active auction or a pending transaction',
        requestBody: jsonRequest(R.deleteAccountSchema),
        responses: {
          200: okBody(z.object({ message: z.string() }), 'Account deleted'),
          400: badRequest,
          401: unauthorized,
          409: errBody('You have an active auction or a pending transaction'),
          422: unprocessable('The password is incorrect'),
        },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: okBody(z.object({ user: S.UserDto }), 'The signed-in user'),
          401: unauthorized,
        },
      },
    },
    '/auth/me/preferences': {
      get: {
        tags: ['Auth'],
        security: [{ bearerAuth: [] }],
        responses: { 200: okBody(S.NotificationPrefsDto, 'Email preferences'), 401: unauthorized },
      },
      patch: {
        tags: ['Auth'],
        security: [{ bearerAuth: [] }],
        requestBody: jsonRequest(R.preferencesSchema),
        responses: {
          200: okBody(S.NotificationPrefsDto, 'Updated preferences'),
          400: badRequest,
          401: unauthorized,
        },
      },
    },

    // ---- auctions ------------------------------------------------------------------
    '/auctions': {
      get: {
        tags: ['Auctions'],
        summary: 'Public, cursor-paginated. Defaults to status=ACTIVE. Reserve amounts are never included — only reserveMet.',
        requestParams: {
          query: z.object({
            status: S.AuctionStatus.optional(),
            category: z.string().optional(),
            search: z.string().optional(),
          }).extend(R.paginationQuerySchema.shape),
        },
        responses: { 200: okBody(S.PaginatedAuctionsDto, 'A page of matching auctions') },
      },
    },
    '/auctions/mine/bids': {
      get: {
        tags: ['Auctions'],
        security: [{ bearerAuth: [] }],
        summary: "Cursor-paginated. The signed-in buyer's bids, each with its auction",
        requestParams: { query: R.paginationQuerySchema },
        responses: { 200: okBody(S.PaginatedBidsWithAuctionDto, 'A page of your bids'), 401: unauthorized },
      },
    },
    '/auctions/{auctionId}': {
      get: {
        tags: ['Auctions'],
        requestParams: { path: z.object({ auctionId: z.string() }) },
        summary: 'currentBid and bidCount are read straight from the row — see BV-010',
        responses: { 200: okBody(S.AuctionDto, 'The auction'), 404: notFound },
      },
    },
    '/auctions/{auctionId}/bids': {
      get: {
        tags: ['Auctions'],
        summary: 'Cursor-paginated, newest first',
        requestParams: {
          path: z.object({ auctionId: z.string() }),
          query: R.paginationQuerySchema,
        },
        responses: { 200: okBody(S.PaginatedBidsDto, 'A page of bid history') },
      },
      post: {
        tags: ['Auctions'],
        security: [{ bearerAuth: [] }],
        requestParams: { path: z.object({ auctionId: z.string() }) },
        requestBody: jsonRequest(R.placeBidSchema),
        responses: {
          201: okBody(S.BidDto, 'Bid accepted'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          // No 409: the row is locked with SELECT ... FOR UPDATE before any of these checks
          // run, so a concurrent bid is serialised behind the lock and re-evaluated against
          // the state that won, not raced against it. A prior version of this document
          // declared 409 here for that race — it never fired; nothing in this handler has
          // ever returned it.
          422: unprocessable(
            'The bid violates an auction rule: closed, ended, below the floor, or above the ' +
            'ceiling',
          ),
        },
      },
    },

    // ---- listings ------------------------------------------------------------------
    '/listings': {
      post: {
        tags: ['Listings'],
        security: [{ bearerAuth: [] }],
        requestBody: jsonRequest(R.submitListingSchema),
        responses: {
          201: okBody(S.ListingDto, 'Listing submitted for review'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          422: unprocessable(
            'A business rule was violated: price floor, increment ceiling, image ownership, ' +
            'or category attributes',
          ),
        },
      },
    },
    '/listings/upload-signature': {
      post: {
        tags: ['Listings'],
        security: [{ bearerAuth: [] }],
        summary: 'Signed Cloudinary upload params; forces JPEG so HEIC uploads stay viewable',
        description:
          'Limited to 10 per hour per seller. Post exactly the returned `signature`, ' +
          '`timestamp`, `apiKey`, `folder`, `format`, `publicId` and `allowedFormats` to ' +
          'Cloudinary — any additional parameter changes the string Cloudinary signs and the ' +
          'upload is refused with 401.',
        responses: {
          200: okBody(S.UploadSignatureDto, 'Upload params'),
          401: unauthorized,
          403: forbidden,
          429: tooManyRequests,
        },
      },
    },
    '/listings/mine': {
      get: {
        tags: ['Listings'],
        security: [{ bearerAuth: [] }],
        summary: 'Cursor-paginated, newest first',
        requestParams: { query: R.paginationQuerySchema },
        responses: { 200: okBody(S.PaginatedListingsDto, 'A page of your listings'), 401: unauthorized },
      },
    },
    '/listings/pending': {
      get: {
        tags: ['Listings'],
        security: [{ bearerAuth: [] }],
        summary: 'Cursor-paginated, oldest first',
        requestParams: { query: R.paginationQuerySchema },
        responses: {
          200: okBody(S.PaginatedListingsDto, 'A page of listings awaiting review'),
          401: unauthorized,
          403: forbidden,
        },
      },
    },
    '/listings/{listingId}/approve': {
      post: {
        tags: ['Listings'],
        security: [{ bearerAuth: [] }],
        summary: 'Creates the auction and schedules its close',
        requestParams: { path: z.object({ listingId: z.string() }) },
        responses: {
          200: okBody(S.ApprovalDto, 'Approved'),
          400: errBody('Only pending listings can be approved'),
          401: unauthorized,
          403: forbidden,
          404: notFound,
        },
      },
    },
    '/listings/approve-all': {
      post: {
        tags: ['Listings'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: okBody(S.BulkApprovalDto, 'Per-listing outcome'),
          401: unauthorized,
          403: forbidden,
        },
      },
    },
    '/listings/{listingId}/reject': {
      post: {
        tags: ['Listings'],
        security: [{ bearerAuth: [] }],
        summary: 'PENDING listings only — there is no takedown route for approved ones',
        requestParams: { path: z.object({ listingId: z.string() }) },
        requestBody: jsonRequest(R.rejectListingSchema),
        responses: {
          200: okBody(S.RejectionDto, 'Rejected'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('The listing is not pending'),
        },
      },
    },

    // ---- watchlist -----------------------------------------------------------------
    '/watchlist': {
      get: {
        tags: ['Watchlist'],
        security: [{ bearerAuth: [] }],
        summary: 'Cursor-paginated, most recently watched first',
        requestParams: { query: R.paginationQuerySchema },
        responses: { 200: okBody(S.PaginatedAuctionsDto, 'A page of watched auctions'), 401: unauthorized },
      },
    },
    '/watchlist/{auctionId}': {
      post: {
        tags: ['Watchlist'],
        security: [{ bearerAuth: [] }],
        requestParams: { path: z.object({ auctionId: z.string() }) },
        responses: { 201: okBody(S.WatchToggleDto, 'Added'), 401: unauthorized },
      },
      delete: {
        tags: ['Watchlist'],
        security: [{ bearerAuth: [] }],
        requestParams: { path: z.object({ auctionId: z.string() }) },
        responses: { 200: okBody(S.WatchToggleDto, 'Removed'), 401: unauthorized },
      },
    },

    // ---- payments ------------------------------------------------------------------
    '/payments/my-wins': {
      get: {
        tags: ['Payments'],
        security: [{ bearerAuth: [] }],
        responses: { 200: okBody(z.array(S.WonTransactionDto), 'Auctions you won'), 401: unauthorized },
      },
    },
    '/payments/seller-stats': {
      get: {
        tags: ['Payments'],
        security: [{ bearerAuth: [] }],
        summary: 'COMPLETED transactions only',
        responses: { 200: okBody(S.SellerStatsDto, 'Revenue and items sold'), 401: unauthorized },
      },
    },
    '/payments/create-intent': {
      post: {
        tags: ['Payments'],
        security: [{ bearerAuth: [] }],
        summary: 'PKR is zero-decimal, so amounts are not multiplied by 100',
        requestBody: jsonRequest(R.createIntentSchema),
        responses: {
          200: okBody(S.PaymentIntentDto, 'Stripe client secret'),
          400: badRequest,
          401: unauthorized,
          404: notFound,
          409: errBody('The transaction is already paid'),
        },
      },
    },
    '/payments/webhook': {
      post: {
        tags: ['Payments'],
        summary: 'Stripe webhook. Needs the raw body, so it is mounted before express.json.',
        responses: { 200: okBody(S.WebhookAckDto, 'Acknowledged'), 400: errBody('Bad signature') },
      },
    },

    // ---- notifications -------------------------------------------------------------
    '/notifications': {
      get: {
        tags: ['Notifications'],
        security: [{ bearerAuth: [] }],
        summary: 'Unread first, newest first, capped at 50',
        responses: { 200: okBody(z.array(S.NotificationDto), 'Your notifications'), 401: unauthorized },
      },
    },
    '/notifications/{notificationId}/read': {
      post: {
        tags: ['Notifications'],
        security: [{ bearerAuth: [] }],
        requestParams: { path: z.object({ notificationId: z.string() }) },
        responses: { 200: okBody(S.NotificationReadDto, 'Marked read'), 401: unauthorized },
      },
    },
    '/notifications/read-all': {
      post: {
        tags: ['Notifications'],
        security: [{ bearerAuth: [] }],
        responses: { 200: okBody(S.MessageDto, 'All marked read'), 401: unauthorized },
      },
    },

    // ---- reviews -------------------------------------------------------------------
    '/reviews': {
      post: {
        tags: ['Reviews'],
        security: [{ bearerAuth: [] }],
        requestBody: jsonRequest(R.createReviewSchema),
        responses: {
          201: okBody(S.ReviewDto, 'Review created'),
          400: badRequest,
          401: unauthorized,
          404: notFound,
          409: errBody('This transaction has already been reviewed'),
          422: unprocessable('Payment has not completed yet'),
        },
      },
    },
    '/reviews/seller/{sellerId}': {
      get: {
        tags: ['Reviews'],
        requestParams: { path: z.object({ sellerId: z.string() }) },
        responses: { 200: okBody(S.SellerReviewsDto, 'Seller rating and reviews') },
      },
    },

    // ---- settings ------------------------------------------------------------------
    '/settings/public': {
      get: {
        tags: ['Settings'],
        summary: 'Unauthenticated — the maintenance gate and listing limits the UI needs',
        responses: { 200: okBody(S.PublicSettingsDto, 'Public settings') },
      },
    },
    '/settings': {
      get: {
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: okBody(S.PlatformSettingsDto, 'All settings'),
          401: unauthorized,
          403: forbidden,
        },
      },
      put: {
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
        requestBody: jsonRequest(R.updateSettingsSchema),
        responses: {
          200: okBody(S.PlatformSettingsDto, 'Updated settings'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
        },
      },
    },

    // ---- admin ---------------------------------------------------------------------
    '/admin/analytics': {
      get: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        responses: {
          200: okBody(S.AnalyticsDto, 'Platform analytics'),
          401: unauthorized,
          403: forbidden,
        },
      },
    },
    '/admin/transactions': {
      get: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary: 'Every PENDING transaction, oldest first — the ones a void might apply to',
        responses: {
          200: okBody(z.array(S.AdminTransactionDto), 'Pending transactions'),
          401: unauthorized,
          403: forbidden,
        },
      },
    },
    '/admin/transactions/{transactionId}/void': {
      post: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary: 'PENDING transactions only — a COMPLETED sale needs a refund, not a void',
        requestParams: { path: z.object({ transactionId: z.string() }) },
        requestBody: jsonRequest(R.voidTransactionSchema),
        responses: {
          200: okBody(z.object({ transactionId: z.string(), status: z.literal('VOIDED') }), 'Voided'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('The transaction is not pending'),
        },
      },
    },
    '/admin/users': {
      get: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary: 'Search by email — finds the account an anonymize request targets',
        requestParams: { query: z.object({ email: z.string() }) },
        responses: {
          200: okBody(z.array(S.AdminUserDto), 'Matching users'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
        },
      },
    },
    '/admin/users/{userId}/anonymize': {
      post: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary: 'Anonymise-in-place (BV-018) — refused while the user has an active auction or a pending transaction',
        requestParams: { path: z.object({ userId: z.string() }) },
        requestBody: jsonRequest(R.anonymizeUserSchema),
        responses: {
          200: okBody(z.object({ userId: z.string(), status: z.literal('ANONYMIZED') }), 'Anonymized'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('The user has an active auction or a pending transaction'),
        },
      },
    },
  },
} satisfies Parameters<typeof createDocument>[0];

export { documentInput };

export const document = createDocument(documentInput);
