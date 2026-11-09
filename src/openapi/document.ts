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

/**
 * Every failure is `{ success: false, error, code? }`. A rule about one request field also names
 * it in `details`, the same field -> messages map validation failures carry.
 */
const ErrorBody = z
  .object({
    success: z.literal(false),
    error: z.string(),
    code: z.string().optional(),
    details: z.record(z.string(), z.array(z.string())).optional(),
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
    //
    // 4.0.0, 2026-08-31, major: BV-047 — the post-payment half of a sale, absent before this
    // (LIFECYCLE-GAPS.md A4/C5/E6). Breaking: POST /payments/create-intent now requires
    // deliveryAddress and deliveryPhone, which did not exist as fields at all before —
    // "request: required property added" is COMPATIBILITY.md's own worked case for a major
    // bump. TransactionStatus gained SHIPPED/DELIVERED/DISPUTED/REFUNDED. Five new /payments
    // operations (ship, confirm-receipt, dispute, connect/onboard, connect/status), a new
    // paginated /payments/my-sales for a seller's own sales, and two new /admin/disputes
    // operations — all additive on their own, bundled into the same bump as the breaking
    // change rather than split out, since they ship in the same deploy.
    //
    // 5.0.0, 2026-09-03, major: Stripe replaced end to end with a self-built, fully-simulated
    // gateway (Stripe is UAE-registered and does not support Pakistan; no real money ever
    // moved through it). Breaking: POST /payments/create-intent removed, replaced by
    // POST /payments/{transactionId}/pay (path-param shape matching ship/confirm-receipt/
    // dispute, request body swaps deliveryAddress/deliveryPhone-only for cardNumber alongside
    // them, response drops clientSecret for a synchronous status). POST /payments/webhook
    // removed outright — nothing external to receive a webhook from any more. GET/POST
    // /payments/connect/onboard and /connect/status removed — no seller onboarding step at
    // all. Additive: GET /payments/earnings (a seller's dummy-ledger balance) and
    // GET /payments/{transactionId}/invoice (LIFECYCLE-GAPS.md E3).
    // BV-015: POST /listings' `category` narrowed from free text to an enum of the seven keys
    // validateCategoryAttributes recognises -- previously an unrecognised category silently
    // discarded every attribute the seller entered instead of being rejected.
    // BV-039: GET /auctions/{id}/bids and GET /reviews/seller/{id} are both unauthenticated and
    // were publishing full bidder/reviewer identity to anonymous visitors. buyerId dropped from
    // the bids response; buyerName on both routes is now a stable pseudonym ("Bidder N" /
    // "Reviewer N") instead of the real name; the bids response gains `isMine`, computed
    // server-side from the caller's own token when one is present. Full identity is unaffected
    // on GET /auctions/mine/bids (the caller's own bids only) and the bid-placement response.
    //
    // 8.0.0, 2026-09-05, major: Phase 6 (LIFECYCLE-IMPLEMENTATION-PLAN.md) state-machine and
    // auction-control work. Breaking: AuctionStatus drops SCHEDULED (D3 -- never reachable,
    // production confirmed empty) and gains CANCELLED (B4/C4). ListingDto gains a required
    // isLive field (A1). Additive: PATCH /listings/{id} (A2, resubmit a REJECTED listing),
    // DELETE /listings/{id} (B4, withdraw a PENDING listing), POST /auctions/{id}/cancel (B4,
    // seller withdraws a bid-free live auction), POST /admin/auctions/{id}/cancel (C4, admin
    // stops any auction), POST /payments/{id}/offer-next-bidder and
    // POST /payments/{id}/relist (A5, non-payment recovery). Also fixed in passing: NotificationType
    // was missing four values fulfillment.service.ts (BV-047) had already been writing since
    // before this phase (ITEM_SHIPPED/PAYOUT_RECEIVED/DISPUTE_RAISED/DISPUTE_RESOLVED) -- a
    // pre-existing contract violation, not something this phase introduced.
    //
    // 8.1.0, 2026-09-05, minor: Phase 7 (LIFECYCLE-IMPLEMENTATION-PLAN.md) governance work.
    // Nothing breaking -- ListingStatus gaining REMOVED (C3) and AdminUserDto gaining a status
    // field (C2) are both enum/field additions, oasdiff reports them as warnings only, not
    // breaking changes (a response gaining a field or an enum gaining a value can't fail an
    // existing client's parse). New: POST /admin/users/{id}/suspend and .../reinstate (C2),
    // POST /admin/listings/{id}/takedown (C3), PATCH/DELETE /reviews/{id} and
    // POST /reviews/{id}/reply (C6). NotificationType gains REVIEW_REPLY and LISTING_REMOVED.
    //
    // 9.0.0, 2026-09-05, major: GET /admin/users became the User Management screen's actual
    // directory instead of a search-only lookup buried in Settings -- a dedicated screen that
    // could only ever show a search result was the wrong shape once it existed. Breaking:
    // response is now PaginatedAdminUsers ({items, nextCursor}), not a bare array (verified via
    // api:compat: response-property-type-changed, array -> object). The `email` query
    // parameter is replaced by `search` (matches name OR email -- an admin acting on a report
    // is more likely to have a name than an email address).
    //
    // 9.1.0, 2026-10-04, minor: GET /listings/limits (seller-only) publishes the two admin-set
    // rules a listing must satisfy, minListingPrice and maxBidIncrement, so the create-listing
    // form no longer has to read them from the unauthenticated /settings/public and no longer
    // needs hard-coded fallback numbers that go stale the moment an admin changes a rule. And
    // ErrorResponse gained an optional `details` (field -> messages), which POST /listings and
    // PATCH /listings/{listingId} now fill for those two rules so the failure can be shown at
    // the field. Purely additive -- oasdiff: new path, optional response property added. The two
    // fields stay on /settings/public for now: removal is frontend first, then a major bump.
    //
    // 10.0.0, 2026-10-04, major: GET /settings/public no longer returns minListingPrice and
    // maxBidIncrement (oasdiff: response-required-property-removed, an error). The last step of an
    // expand/contract move: 9.1.0 added the seller-only GET /listings/limits, the frontend moved to
    // it (frontend #26, deployed to production 2026-10-04) and stopped reading these two fields,
    // and only then were they removed here. Major, not minor, on purpose: the server's response
    // really did change, and any caller still reading them would now get undefined -- there is
    // none (the one consumer is generated from this document and no longer references them, which
    // grep confirmed), but "nobody reads it" is the argument COMPATIBILITY.md warns sounds the
    // same from inside a real break. The reason they left: they are rules for sellers and were
    // being served to every anonymous visitor (OWASP API3).
    //
    // 10.0.1, 2026-10-05, patch: documentation only. Every response under /api/v1 now carries
    // `Cache-Control: no-store` (see middleware/no-store.ts) and the description above says so.
    // Nothing in the wire contract's shapes changed: a header was added to responses and no
    // schema, status or field moved, which is COMPATIBILITY.md's "patch" (docs, descriptions).
    // 11.0.0, 2026-10-14, major: login (Session), POST /auth/refresh (RefreshedTokens) and
    // POST /auth/change-password (PasswordChanged) no longer return `refreshToken` in the body
    // (oasdiff: response-required-property-removed, an error). The refresh token now reaches the
    // client only as the HttpOnly `bv_refresh` cookie set by the same response; see the note on
    // SessionDto in schemas.ts for the standards behind it (ASVS 3.3.4, the OAuth browser-apps
    // draft). The last step of an expand/contract move: the cookie shipped with backend #20
    // (2026-10-04, additive, no version bump), the frontend moved to it and stopped reading the
    // body field (frontend #20, deployed to production 2026-10-04; `grep refreshToken
    // frontend/src` finds only the legacy-session path that SENDS a stored token), and only now
    // is the field removed. Major, not minor, on purpose: the server's
    // responses really changed, and any caller that read the field would now get undefined. None
    // exists -- the one consumer is generated from this document, and scripts/verify-contract.ts,
    // the one other reader, moved to the cookie in the same change -- but "nobody reads it" is
    // the argument COMPATIBILITY.md warns sounds the same from inside a real break.
    // The REQUEST side is unchanged: POST /auth/refresh and /auth/logout still accept
    // `refreshToken` in the body, which is how a session stored by a pre-cookie frontend is moved
    // onto the cookie once. That path is removable separately, later.
    //
    // 11.1.0, 2026-10-14, minor: Phase 8 (LIFECYCLE-IMPLEMENTATION-PLAN.md), the data half of
    // seller visibility. Additive only. New: GET /auctions/mine (B2, the seller's own auctions,
    // cursor-paginated, status defaulting to ACTIVE). B1's auction numbers for the seller are
    // served by this auction endpoint, NOT added to ListingDto: a listing is the submission and
    // review state that exists before any auction, so ListingDto keeps only the link (isLive,
    // auctionId) and the live numbers stay on the auction.
    // AuctionDto gains sellerMemberSince (the seller account's creation date) and watcherCount (how
    // many watchlists hold the auction): trust signals modelled on what eBay shows beside an item.
    // The two new AuctionDto fields are required in responses, which oasdiff reports as a
    // warning, not a break: no existing client can fail to parse a response for gaining a field.
    //
    // 11.2.0, 2026-10-18, minor: the seller's response to a dispute. Additive only. New: POST
    // /payments/{transactionId}/dispute/response (the seller's one response, 10 to 1000
    // characters like the buyer's reason, final once sent, refused when there is no open dispute
    // or one was already sent). AdminDispute (GET /admin/disputes) gains sellerResponse and
    // sellerRespondedAt (both optional) and responseDueAt, createdAt plus a 3 day soft window.
    // responseDueAt is required in responses, which oasdiff reports as a warning, not a break.
    // The window is advice, not a rule: resolving a dispute is never held up by it.
    //
    // 11.3.0, 2026-10-18, minor: the seller's "My Items" read model. Additive only. New: GET
    // /seller/items (cursor-paginated, one row per listing whatever its stage, six tabs, optional
    // search) and GET /seller/items/summary (the tab counts), both SELLER only. A row carries its
    // stage, tab and the actions allowed right now, decided once on the server, so the screen
    // renders and never re-derives a rule. Nothing existing changed: every action a row offers is
    // an endpoint that already exists (plus the client-side "List again", which fills the create
    // form from the row's `listing` block).
    //
    // 11.4.0, 2026-10-19, minor: the seller is told of a bid (Phase 8, B3). Additive only.
    // NotificationType gains BID_RECEIVED: one unread notification per auction, kept up to date as
    // bids arrive, so GET /notifications can now return that type. NotificationType is also now
    // declared `x-extensible-enum` instead of a closed `enum` (oasdiff's own advice for a response
    // enum that keeps growing, and the reason this addition raised a warning): the server still
    // sends only the listed values, but clients are told to expect others, and the generated client
    // type is open (the listed values plus any string). Nothing else changed in any request or
    // response. The real-time half
    // is a Socket.IO event (`bid:received`, to the seller's own room), which is outside this
    // document and carries the auction id, the bid count and the current bid, never a bidder.
    //
    // 11.4.1, 2026-10-19, patch: documentation only. POST /payments/{transactionId}/pay already
    // answered 409 for a sale that was already paid; it now answers the same 409 (a different
    // message) for a sale that was voided, which it used to charge. The response shape is the
    // same, and the 409 was already documented, so only its description changes.
    //
    // 11.5.0, 2026-10-30, minor: one account buys and sells (Phase 8, B5, step 1). Additive only.
    // New: POST /seller/enroll (any signed-in non-admin becomes a seller at once, after accepting
    // the terms, confirming they are 18 or older and giving a city and province; idempotent). User
    // gains isSeller and sellerSince, which the client now shows seller screens from instead of
    // `role`. POST /auth/register: `role` is now optional and deprecated (omitted means a plain
    // account; the legacy SELLER value still makes a seller). Auction gains sellerCity and
    // sellerProvince (null for a seller who gave none). PublicSettings gains sellerTermsVersion, the
    // version the enrolment form must send back. WonTransaction and Invoice gain an optional
    // sellerPhone, present only once the sale is paid. The new response fields are required,
    // which oasdiff reports as a warning, not a break. Behaviour change, not a shape change: a
    // seller can now also bid, pay and review, so routes that used to refuse a SELLER token for
    // being "not a buyer" now accept it, and the seller capability is read from the database on
    // every request, not from the token. The `role` enum is unchanged; its removal is planned for a
    // later major (it was first planned for 12.0.0, which went to the bid-list change below).
    // Also in this release: dependencies were upgraded for security advisories (zod 4.6.7, among
    // others), and zod now writes slightly different `pattern` strings for `format: date-time`
    // (seconds are required, as every value the server sends already has them) and `format: email`.
    // Only the published regex text changed; no field was added, removed or retyped by it, and
    // oasdiff reports no breaking change.
    //
    // 12.0.0, 2026-11-07, major: guest browsing, step 1 (decision D10). GET
    // /auctions/{auctionId}/bids now needs a signed-in caller and answers 401 to everyone else; it
    // used to be public (with masked bidders). oasdiff reports this only as two `info` changes
    // (security added, a 401 added), so no gate forces the bump: major is our own judgement under
    // COMPATIBILITY.md ("the server's behaviour changed in a way that can break a caller"): an
    // anonymous caller that got 200 now gets 401. It is intentional: a guest may see an auction,
    // its price and its bid COUNT, but not who bid or when. Why it is still safe to deploy
    // backend-first: every deployed caller of this route is signed in (the buyer's auction
    // screen) or an admin (the auction monitor), and both always send a token, so no existing
    // caller starts to fail. The generated frontend client is updated in the frontend pull
    // request that follows. The real-time half is outside this document: a signed-in socket
    // still receives `bid:placed` (the masked entry), while an anonymous socket now receives
    // `auction:price` with `{ auctionId, currentBid, bidCount }` only and never a bid entry.
    // The `role` enum removal that the 11.5.0 note planned for "12.0.0" is a later major.
    //
    // 12.1.0, 2026-11-07, minor: guest browsing, step 2 (the data the public auction page quotes).
    // Additive only. AuctionDto gains listingCode, the public item number (BV-year-hex) that the
    // seller's listing already carries; it is on every route that serves an auction (the public
    // list and detail, the seller's own list, my bids, the watchlist). PublicSettings gains
    // paymentDeadlineHours and reviewTimeoutHours (48 and 48 by default), so the buying-rules block
    // quotes the live admin settings instead of hard-coding them. Both new response fields are
    // required, which oasdiff reports as informational, not a break: no existing client can fail to
    // parse a response for gaining a field. reviewTimeoutHours used to be admin-only; it is public
    // now because it is quoted to bidders, and nothing else of the settings row is.
    //
    // 12.2.0,2026-11-07, minor: guest browsing, step 3 (the browse query). Additive only.
    // GET /auctions gains `sort` (ending-soonest, the default and today's order, plus
    // ending-soonest-with-bids, newly-listed, price-asc, price-desc, bids-desc, bids-asc),
    // `minPrice`, `maxPrice`, `condition` (repeatable) and `withBids`; `search` given an exact
    // item number finds that one auction and only it. A call that sends none of them behaves as before, cursor
    // included. New: GET /auctions/facets, the counts beside each filter choice. The one behaviour
    // that can differ is a 400 where a call used to be answered 200: a bad `sort`, price,
    // condition or withBids value, a minimum above the maximum, or a cursor replayed under a
    // different sort. No deployed caller sends any of these, since none of the parameters existed.
    // A cursor made before this version is read as made under the default sort.
    //
    // 12.3.0, 2026-11-07, minor: guest browsing, step 4 (the public seller profile). Additive only.
    // New GET /sellers/{sellerId}: name, member since, city and province, bio, items sold, rating and
    // rating count, public, never a phone number or an e-mail address; 404 for anyone who is not a
    // visible seller. GET /auctions and GET /auctions/facets gain `sellerId`, one seller's auctions
    // (live, or ended with status=CLOSED) in the same sorts. Each item of GET /reviews/seller/{id}
    // gains itemTitle and verifiedPurchase (the writer is the buyer of the sale the review is tied
    // to); both are required response fields, which oasdiff reports as informational.
    //
    // 12.4.0, 2026-11-09, minor: FR-02, a way out of a paid sale the seller never ships. Additive
    // only. A paid sale gets a ship-by time (new setting shipByHours, default 72, also on
    // GET /settings/public). New: POST /payments/{transactionId}/report-not-shipped (the buyer, once
    // the ship-by time has passed), POST /payments/{transactionId}/refund (the seller, before
    // shipping), GET /admin/transactions/unshipped and POST /admin/transactions/{transactionId}/refund.
    // Sale views (WonTransaction, SellerSale, SellerItem.sale) gain optional shipByAt,
    // notShippedReportedAt and autoRefundAt; Invoice gains shipByAt; AdminTransaction gains optional
    // paidAt, shipByAt and notShippedReportedAt. SellerItemAction gains REFUND_BUYER (offered on
    // NEEDS_SHIPPING) and NotificationType gains NOT_SHIPPED_REPORTED and SALE_REFUNDED (an open set).
    // Behaviour change: a takedown now refunds a paid, unshipped sale instead of leaving it to be
    // shipped.
    //
    // 12.5.0, 2026-11-09, minor: FR-15, administrator accounts are protected. AdminUser (GET
    // /admin/users) gains a required `deleted` flag (informational for oasdiff). New 409 cases:
    // POST /admin/users/{userId}/anonymize and /suspend refuse an administrator (the caller
    // included) and an already-deleted account; POST /auth/delete-account refuses the last active
    // administrator. Register refuses an address on the reserved .invalid domain (400).
    //
    // 12.6.0, 2026-11-09, minor: G5, Report listing. Additive only. New: POST
    // /auctions/{auctionId}/report (an account that is not an admin and not the listed seller; one
    // report per person per auction, a repeat returns the existing one with alreadyReported), GET /admin/reports
    // (by status, OPEN by default, oldest first) and PATCH /admin/reports/{reportId} (ACTIONED or
    // DISMISSED, audited). New schemas ListingReport, AdminListingReport, PaginatedAdminReports,
    // ReportReason and ReportStatus.
    //
    // 12.6.1, 2026-11-09, patch: documentation only. GET /auctions with a non-empty `search` and GET
    // /auctions/facets declare 429: without a token that verifies, the two share 60 requests a minute
    // per IP (G6). Signed-in callers, opening an auction and the plain list are not counted by it.
    //
    // 12.7.0, 2026-11-09, minor: B5 PR 3a, the monthly selling limit. Additive. GET
    // /seller/items/summary gains a required `limits` (SellerLimits: items and value used and allowed
    // this month, resetsAt, completedSales, salesToGraduate, standing NEW | ESTABLISHED | RESTRICTED and
    // the 12-month refund figures). PlatformSettings and UpdateSettingsRequest gain
    // newSellerMonthlyItems, newSellerMonthlyValue and sellerGraduationSales. NotificationType gains
    // SELLER_WELCOME, SELLER_LIMIT_NEAR, SELLER_GRADUATED and SELLER_LIMIT_RETURNED (an open set).
    // Behaviour: POST /listings and the resubmit (PATCH /listings/{listingId}) answer 422 with code
    // SELLER_LIMIT_REACHED over the limit; a resubmit counts in the month it is resubmitted.
    //
    // 12.8.0, 2026-11-09, minor: B5 PR 3b, admin control of selling. Additive. New: POST
    // /admin/users/{userId}/revoke-seller (reason, optional endLiveAuctions), POST
    // /admin/users/{userId}/restore-seller, PUT /admin/users/{userId}/seller-limit (items and value,
    // each nullable) and POST /seller/limit-request (one a month). AdminUser gains required
    // sellerStatus (NONE | ACTIVE | REVOKED), sellerLimitOverrideItems and sellerLimitOverrideValue.
    // NotificationType gains SELLER_REVOKED, SELLER_RESTORED, SELLER_LIMIT_CHANGED and
    // SELLER_LIMIT_REQUESTED.
    version: '12.8.0',
    description:
      'Auction platform API. Generated from the Zod schemas the server actually validates ' +
      'and serves — see backend/src/openapi. Do not hand-edit openapi.json.\n\n' +
      'Every route is rate limited to 300 requests per minute per client address and answers ' +
      '429 with the standard `RateLimit` headers (draft-8) once that is exceeded. Routes that ' +
      'carry a tighter limit of their own declare 429 individually.\n\n' +
      'Every response, errors included, carries `Cache-Control: no-store`: what this API returns ' +
      'is about the signed-in caller (and the sign-in routes return the tokens themselves), so ' +
      'it is not meant to be stored by any cache.',
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
        responses: { 200: okBody(S.RefreshedTokensDto, 'New access token; the rotated refresh token is set as the HttpOnly cookie'), 401: unauthorized },
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
          409: errBody('You have an active auction or a pending transaction, or you are the only active administrator'),
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
        summary:
          'Public, cursor-paginated. Defaults to status=ACTIVE, soonest-ending first. Reserve amounts are never included — ' +
          'only reserveMet. `sort` picks the order (ties always break on the auction id, so a page never repeats or skips a row); ' +
          '`minPrice` and `maxPrice` are whole rupees, inclusive, read against the current bid; `condition` is sent once per value; ' +
          '`withBids=true` leaves out auctions with no bid. `search` matches words in the title or description, except that a ' +
          'term that is exactly an item number (BV-year-ten hex digits, any case) matches that one item and nothing else. ' +
          'A cursor belongs to the sort it ' +
          'was made under and is refused under another.',
        requestParams: {
          query: z.object({
            status: S.AuctionStatus.optional(),
            category: z.string().optional(),
            search: z.string().optional(),
          }).extend(R.browseQuerySchema.shape).extend(R.paginationQuerySchema.shape),
        },
        responses: {
          200: okBody(S.PaginatedAuctionsDto, 'A page of matching auctions'),
          400: badRequest,
          // G6: a word search without a signed-in token shares 60 a minute per IP with /auctions/facets.
          429: tooManyRequests,
        },
      },
    },
    '/auctions/facets': {
      get: {
        tags: ['Auctions'],
        summary:
          "Public. How many auctions each browse filter choice would give. Takes the list's filters (not `sort`, `limit` or " +
          '`cursor`); a group of choices counts with every other filter applied but not its own. Price bands are ' +
          'under-5000 (below 5,000), 5000-25000 (5,000 to 25,000) and over-25000 (above 25,000), whole rupees',
        requestParams: {
          query: z.object({
            status: S.AuctionStatus.optional(),
            category: z.string().optional(),
            search: z.string().optional(),
          }).extend(R.browseQuerySchema.omit({ sort: true }).shape),
        },
        responses: {
          200: okBody(S.AuctionFacetsDto, 'Counts per filter choice'),
          400: badRequest,
          // G6: without a signed-in token, shares 60 a minute per IP with a word search on /auctions.
          429: tooManyRequests,
        },
      },
    },
    '/auctions/mine': {
      get: {
        tags: ['Auctions'],
        security: [{ bearerAuth: [] }],
        summary:
          "Cursor-paginated. The signed-in seller's own auctions; status defaults to ACTIVE (soonest-ending first), " +
          'CLOSED and CANCELLED list the most recently ended first',
        requestParams: { query: R.mineAuctionsQuerySchema },
        responses: {
          200: okBody(S.PaginatedAuctionsDto, "A page of the seller's auctions"),
          401: unauthorized,
          403: forbidden,
        },
      },
    },
    '/seller/items': {
      get: {
        tags: ['Seller'],
        security: [{ bearerAuth: [] }],
        summary:
          "Cursor-paginated. The signed-in seller's inventory, one row per listing whatever its stage, split into six tabs " +
          '(a missing or unknown tab means action). Live and action list the soonest-ending first, sold and unsold the most ' +
          'recently ended first, review and closed the most recently submitted first. `search` matches title or listing code ' +
          'inside the tab, with % and _ taken literally',
        requestParams: { query: R.sellerItemsQuerySchema },
        responses: {
          200: okBody(S.PaginatedSellerItemsDto, "A page of the seller's items"),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
        },
      },
    },
    '/seller/items/summary': {
      get: {
        tags: ['Seller'],
        security: [{ bearerAuth: [] }],
        summary: "How many items the signed-in seller has on each tab (the tab badges); never narrowed by a search",
        responses: {
          200: okBody(S.SellerItemsSummaryDto, 'Item counts per tab'),
          401: unauthorized,
          403: forbidden,
        },
      },
    },
    '/seller/limit-request': {
      post: {
        tags: ['Seller'],
        security: [{ bearerAuth: [] }],
        summary:
          'B5 PR 3b, D7: ask the admins for a higher monthly limit. One a month: a repeat answers with the first ' +
          '(alreadyRequested). 409 for a seller who has no limit.',
        requestBody: jsonRequest(R.sellerLimitRequestSchema),
        responses: {
          200: okBody(z.object({ requestedAt: z.iso.datetime(), alreadyRequested: z.boolean() }), 'Recorded'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          409: errBody('No monthly limit applies to this seller'),
        },
      },
    },
    '/seller/enroll': {
      post: {
        tags: ['Seller'],
        security: [{ bearerAuth: [] }],
        summary:
          'Become a seller. Instant, no approval step. Needs the terms accepted (at the version in ' +
          'GET /settings/public), a confirmation of being 18 or older, and a city and province; phone ' +
          'and bio are optional. Idempotent: an account that is already a seller gets its record back unchanged',
        requestBody: jsonRequest(R.enrollSellerSchema),
        responses: {
          200: okBody(z.object({ user: S.UserDto }), 'The account, now a seller'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          409: errBody('The seller terms changed since the form was shown'),
        },
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
        summary: 'Cursor-paginated, newest first. For signed-in members; a guest sees only the bid count on the auction',
        security: [{ bearerAuth: [] }],
        requestParams: {
          path: z.object({ auctionId: z.string() }),
          query: R.paginationQuerySchema,
        },
        responses: { 200: okBody(S.PaginatedBidsDto, 'A page of bid history'), 401: unauthorized },
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
    '/auctions/{auctionId}/report': {
      post: {
        tags: ['Auctions'],
        security: [{ bearerAuth: [] }],
        summary:
          'G5: report a listing as breaking the rules. One report per person per auction: a repeat answers with the ' +
          'report already made and alreadyReported true. Not for admins, and not for the listed seller (403). ' +
          'The listed seller never sees reports or who made them.',
        requestParams: { path: z.object({ auctionId: z.string() }) },
        requestBody: jsonRequest(R.reportListingSchema),
        responses: {
          200: okBody(
            z.object({ report: S.ListingReportDto, alreadyReported: z.boolean() }),
            'The report: just made, or the one this person made before (alreadyReported)',
          ),
          400: badRequest,
          401: unauthorized,
          403: errBody('An admin, or the seller of this auction'),
          404: notFound,
          409: errBody('The auction has already been removed (cancelled)'),
        },
      },
    },
    '/auctions/{auctionId}/cancel': {
      post: {
        tags: ['Auctions'],
        security: [{ bearerAuth: [] }],
        summary: 'B4, Phase 6 — seller withdraws their own bid-free live auction',
        requestParams: { path: z.object({ auctionId: z.string() }) },
        requestBody: jsonRequest(R.cancelAuctionSchema),
        responses: {
          200: okBody(z.object({ auctionId: z.string(), status: z.literal('CANCELLED') }), 'Cancelled'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('Not ACTIVE, or bids already exist (an admin can cancel those instead)'),
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
            'category attributes, or the monthly selling limit (code SELLER_LIMIT_REACHED)',
          ),
        },
      },
    },
    '/listings/{listingId}': {
      patch: {
        tags: ['Listings'],
        security: [{ bearerAuth: [] }],
        summary: 'A2, Phase 6 — edit and resubmit a REJECTED listing, re-validated exactly like a fresh submission',
        requestParams: { path: z.object({ listingId: z.string() }) },
        requestBody: jsonRequest(R.submitListingSchema),
        responses: {
          200: okBody(S.ListingDto, 'Resubmitted for review'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('Only a rejected listing can be edited and resubmitted'),
          422: unprocessable(
            'A business rule was violated: price floor, increment ceiling, image ownership, ' +
            'category attributes, or the monthly selling limit (code SELLER_LIMIT_REACHED)',
          ),
        },
      },
      delete: {
        tags: ['Listings'],
        security: [{ bearerAuth: [] }],
        summary: 'B4, Phase 6 — withdraw a listing before it has ever been auctioned',
        requestParams: { path: z.object({ listingId: z.string() }) },
        responses: {
          200: okBody(z.object({ listingId: z.string(), status: z.literal('WITHDRAWN') }), 'Withdrawn'),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('Only a listing awaiting review can be withdrawn'),
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
    '/listings/limits': {
      get: {
        tags: ['Listings'],
        security: [{ bearerAuth: [] }],
        summary: 'The admin-set minimum starting price and maximum bid increment a listing must satisfy',
        responses: {
          200: okBody(S.ListingLimitsDto, 'The current limits'),
          401: unauthorized,
          403: forbidden,
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
        summary: 'Every paid status except REFUNDED',
        responses: { 200: okBody(S.SellerStatsDto, 'Revenue and items sold'), 401: unauthorized },
      },
    },
    '/payments/my-sales': {
      get: {
        tags: ['Payments'],
        security: [{ bearerAuth: [] }],
        summary: 'Cursor-paginated, newest first — a seller\'s own sales, including the buyer\'s delivery details',
        requestParams: { query: R.paginationQuerySchema },
        responses: { 200: okBody(S.PaginatedSellerSales, 'A page of your sales'), 401: unauthorized },
      },
    },
    '/payments/{transactionId}/pay': {
      post: {
        tags: ['Payments'],
        security: [{ bearerAuth: [] }],
        summary: 'Resolves synchronously against the self-built dummy gateway — see payment-gateway.service.ts for the test-card convention. A decline is a 200 with status PENDING, not an error.',
        requestParams: { path: z.object({ transactionId: z.string() }) },
        requestBody: jsonRequest(R.payTransactionSchema),
        responses: {
          200: okBody(S.PayResultDto, 'Charged, or declined'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('The transaction is already paid, or can no longer be paid (it was voided)'),
        },
      },
    },
    '/payments/earnings': {
      get: {
        tags: ['Payments'],
        security: [{ bearerAuth: [] }],
        summary: 'A seller\'s dummy-ledger balance and the sales that built it',
        responses: { 200: okBody(S.EarningsDto, 'Ledger balance and entries'), 401: unauthorized, 403: forbidden },
      },
    },
    '/payments/{transactionId}/offer-next-bidder': {
      post: {
        tags: ['Payments'],
        security: [{ bearerAuth: [] }],
        summary: 'A5, Phase 6 — re-targets a VOIDED transaction at the next-highest bidder, at their own last bid',
        requestParams: { path: z.object({ transactionId: z.string() }) },
        responses: {
          200: okBody(z.object({ transactionId: z.string(), status: z.literal('PENDING') }), 'Re-offered'),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('Not VOIDED, or there is no other bidder to offer it to'),
        },
      },
    },
    '/payments/{transactionId}/relist': {
      post: {
        tags: ['Payments'],
        security: [{ bearerAuth: [] }],
        summary: 'A5, Phase 6 — creates a fresh Listing + Auction pair for a VOIDED transaction\'s item',
        requestParams: { path: z.object({ transactionId: z.string() }) },
        responses: {
          200: okBody(z.object({ listingId: z.string(), auctionId: z.string() }), 'Relisted'),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('The transaction is not VOIDED'),
        },
      },
    },
    '/payments/{transactionId}/invoice': {
      get: {
        tags: ['Payments'],
        security: [{ bearerAuth: [] }],
        summary: 'The buyer, the seller, or an admin — LIFECYCLE-GAPS.md E3',
        requestParams: { path: z.object({ transactionId: z.string() }) },
        responses: {
          200: okBody(S.InvoiceDto, 'Invoice'),
          401: unauthorized,
          403: forbidden,
          404: notFound,
        },
      },
    },
    '/payments/{transactionId}/ship': {
      patch: {
        tags: ['Payments'],
        security: [{ bearerAuth: [] }],
        summary: 'Seller marks a COMPLETED sale shipped — starts the confirm-or-dispute window',
        requestParams: { path: z.object({ transactionId: z.string() }) },
        responses: {
          200: okBody(z.object({ transactionId: z.string(), status: z.literal('SHIPPED') }), 'Shipped'),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('Not in the COMPLETED state, or no delivery address on file'),
        },
      },
    },
    '/payments/{transactionId}/confirm-receipt': {
      post: {
        tags: ['Payments'],
        security: [{ bearerAuth: [] }],
        summary: 'Buyer confirms receipt — releases the seller\'s payout',
        requestParams: { path: z.object({ transactionId: z.string() }) },
        responses: {
          200: okBody(z.object({ transactionId: z.string(), status: z.literal('DELIVERED') }), 'Delivered'),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('The transaction is not SHIPPED'),
        },
      },
    },
    '/payments/{transactionId}/dispute': {
      post: {
        tags: ['Payments'],
        security: [{ bearerAuth: [] }],
        summary: 'Buyer reports not-received / not-as-described instead of confirming receipt — holds the payout for admin review',
        requestParams: { path: z.object({ transactionId: z.string() }) },
        requestBody: jsonRequest(R.raiseDisputeSchema),
        responses: {
          200: okBody(z.object({ transactionId: z.string(), status: z.literal('DISPUTED') }), 'Disputed'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('The transaction is not SHIPPED'),
        },
      },
    },
    '/payments/{transactionId}/report-not-shipped': {
      post: {
        tags: ['Payments'],
        security: [{ bearerAuth: [] }],
        summary:
          'FR-02: the buyer reports a paid sale not shipped, once its ship-by time has passed. The sale stays paid; the seller has 3 days to ship or refund, or the buyer is refunded automatically',
        requestParams: { path: z.object({ transactionId: z.string() }) },
        requestBody: jsonRequest(R.reportNotShippedSchema),
        responses: {
          200: okBody(
            z.object({
              transactionId: z.string(),
              notShippedReportedAt: z.iso.datetime(),
              autoRefundAt: z.iso.datetime(),
            }),
            'Reported',
          ),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('Not paid-and-unshipped, the ship-by time has not passed, or already reported'),
        },
      },
    },
    '/payments/{transactionId}/refund': {
      post: {
        tags: ['Payments'],
        security: [{ bearerAuth: [] }],
        summary: 'FR-02: the seller refunds a paid sale they cannot send. Only before it has shipped',
        requestParams: { path: z.object({ transactionId: z.string() }) },
        requestBody: jsonRequest(R.refundSaleSchema),
        responses: {
          200: okBody(z.object({ transactionId: z.string(), status: z.literal('REFUNDED') }), 'Refunded'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('The sale is not paid-and-unshipped (COMPLETED)'),
        },
      },
    },
    '/payments/{transactionId}/dispute/response': {
      post: {
        tags: ['Payments'],
        security: [{ bearerAuth: [] }],
        summary:
          "Seller's one response to the buyer's dispute on their own sale — final once sent, informs the admin, gates nothing",
        requestParams: { path: z.object({ transactionId: z.string() }) },
        requestBody: jsonRequest(R.respondToDisputeSchema),
        responses: {
          200: okBody(
            z.object({ transactionId: z.string(), sellerRespondedAt: z.iso.datetime() }),
            'Response recorded',
          ),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('There is no open dispute on this sale, or the seller has already responded'),
        },
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
    '/sellers/{sellerId}': {
      get: {
        tags: ['Sellers'],
        summary:
          'Public. What anyone may read about a seller: name, member since, city and province, bio, sales and rating. ' +
          'Never a phone number or an e-mail address. 404 for anyone who is not a visible seller (never enrolled, an admin, ' +
          "suspended, or deleted). The seller's auctions are GET /auctions?sellerId= and their reviews GET /reviews/seller/{sellerId}.",
        requestParams: { path: z.object({ sellerId: z.string() }) },
        responses: { 200: okBody(S.SellerProfileDto, 'The seller profile'), 404: notFound },
      },
    },
    '/reviews/seller/{sellerId}': {
      get: {
        tags: ['Reviews'],
        requestParams: { path: z.object({ sellerId: z.string() }) },
        responses: { 200: okBody(S.SellerReviewsDto, 'Seller rating and reviews') },
      },
    },
    '/reviews/{reviewId}': {
      patch: {
        tags: ['Reviews'],
        security: [{ bearerAuth: [] }],
        summary: 'C6, Phase 7 — the review author only, within reviewEditWindowHours of posting',
        requestParams: { path: z.object({ reviewId: z.string() }) },
        requestBody: jsonRequest(R.updateReviewSchema),
        responses: {
          200: okBody(S.ReviewDto, 'Updated'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('The edit window for this review has passed'),
        },
      },
      delete: {
        tags: ['Reviews'],
        security: [{ bearerAuth: [] }],
        summary: 'C6, Phase 7 — the review author only, within reviewEditWindowHours of posting',
        requestParams: { path: z.object({ reviewId: z.string() }) },
        responses: {
          200: okBody(z.object({ reviewId: z.string(), status: z.literal('DELETED') }), 'Deleted'),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('The delete window for this review has passed'),
        },
      },
    },
    '/reviews/{reviewId}/reply': {
      post: {
        tags: ['Reviews'],
        security: [{ bearerAuth: [] }],
        summary: 'C6, Phase 7 — the reviewed seller only, one reply per review',
        requestParams: { path: z.object({ reviewId: z.string() }) },
        requestBody: jsonRequest(R.replyToReviewSchema),
        responses: {
          200: okBody(z.object({ reviewId: z.string(), sellerReply: z.string(), sellerReplyAt: z.iso.datetime() }), 'Replied'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('This review already has a reply'),
        },
      },
    },

    // ---- settings ------------------------------------------------------------------
    '/settings/public': {
      get: {
        tags: ['Settings'],
        summary: 'Unauthenticated — the maintenance gate and the support contact',
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
    '/admin/transactions/unshipped': {
      get: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary: 'FR-02: every paid sale past its ship-by time and not yet shipped, oldest payment first',
        responses: {
          200: okBody(z.array(S.AdminTransactionDto), 'Paid sales not shipped in time'),
          401: unauthorized,
          403: forbidden,
        },
      },
    },
    '/admin/transactions/{transactionId}/refund': {
      post: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary: 'FR-02: refunds a paid sale that has not shipped (COMPLETED). A shipped sale goes through a dispute',
        requestParams: { path: z.object({ transactionId: z.string() }) },
        requestBody: jsonRequest(R.refundSaleSchema),
        responses: {
          200: okBody(z.object({ transactionId: z.string(), status: z.literal('REFUNDED') }), 'Refunded'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('The sale is not paid-and-unshipped (COMPLETED)'),
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
    '/admin/auctions/{auctionId}/cancel': {
      post: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary: 'C4, Phase 6 — stops any auction regardless of bid count; notifies every bidder',
        requestParams: { path: z.object({ auctionId: z.string() }) },
        requestBody: jsonRequest(R.cancelAuctionSchema),
        responses: {
          200: okBody(z.object({ auctionId: z.string(), status: z.literal('CANCELLED') }), 'Cancelled'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('The auction is not ACTIVE'),
        },
      },
    },
    '/admin/disputes': {
      get: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary: 'Every OPEN dispute, oldest first',
        responses: {
          200: okBody(z.array(S.AdminDisputeDto), 'Open disputes'),
          401: unauthorized,
          403: forbidden,
        },
      },
    },
    '/admin/disputes/{disputeId}/resolve': {
      post: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary: 'REFUND (buyer) or RELEASE (seller) — the only two outcomes for an open dispute',
        requestParams: { path: z.object({ disputeId: z.string() }) },
        requestBody: jsonRequest(R.resolveDisputeSchema),
        responses: {
          200: okBody(z.object({ disputeId: z.string(), resolution: z.enum(['REFUND', 'RELEASE']) }), 'Resolved'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('This dispute has already been resolved'),
        },
      },
    },
    '/admin/reports': {
      get: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary: 'G5: listing reports with one status (OPEN when omitted), oldest first, cursor-paginated.',
        requestParams: { query: R.adminReportsQuerySchema },
        responses: {
          200: okBody(S.PaginatedAdminReportsDto, 'A page of reports'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
        },
      },
    },
    '/admin/reports/{reportId}': {
      patch: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary:
          'G5: decide an OPEN report, ACTIONED or DISMISSED; audited as LISTING_REPORT_RESOLVED. Repeating the same ' +
          'decision answers 200 and changes nothing. Never changes the auction (use takedown or cancel for that).',
        requestParams: { path: z.object({ reportId: z.string() }) },
        requestBody: jsonRequest(R.resolveReportSchema),
        responses: {
          200: okBody(z.object({ report: S.ListingReportDto }), 'Resolved'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('The report was already decided the other way'),
        },
      },
    },
    '/admin/users': {
      get: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary: 'Cursor-paginated, newest first. Optional search matches name or email.',
        requestParams: {
          query: z.object({ search: z.string().optional() }).extend(R.paginationQuerySchema.shape),
        },
        responses: {
          200: okBody(S.PaginatedAdminUsersDto, 'A page of users'),
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
          409: errBody('The account is an administrator, is already deleted, or has an active auction or a pending transaction'),
        },
      },
    },
    '/admin/users/{userId}/suspend': {
      post: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary: 'C2, Phase 7 — reversible, unlike anonymize; does not touch the account\'s data',
        requestParams: { path: z.object({ userId: z.string() }) },
        requestBody: jsonRequest(R.suspendUserSchema),
        responses: {
          200: okBody(z.object({ userId: z.string(), status: z.literal('SUSPENDED') }), 'Suspended'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('Already suspended or deleted, an administrator account, or the admin tried to suspend their own account'),
        },
      },
    },
    '/admin/users/{userId}/revoke-seller': {
      post: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary:
          'B5 PR 3b: pause selling (D4). Live auctions finish unless endLiveAuctions (bidders told the reason); ' +
          'pending listings are withdrawn (REJECTED with the reason); sales already made continue.',
        requestParams: { path: z.object({ userId: z.string() }) },
        requestBody: jsonRequest(R.revokeSellerSchema),
        responses: {
          200: okBody(
            z.object({
              userId: z.string(),
              sellerStatus: z.literal('REVOKED'),
              withdrawnListings: z.number().int(),
              cancelledAuctions: z.number().int(),
            }),
            'Selling paused',
          ),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('Not selling, already paused, an administrator, or a deleted account'),
        },
      },
    },
    '/admin/users/{userId}/restore-seller': {
      post: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary: 'B5 PR 3b: give back selling that an admin paused.',
        requestParams: { path: z.object({ userId: z.string() }) },
        responses: {
          200: okBody(z.object({ userId: z.string(), sellerStatus: z.literal('ACTIVE') }), 'Selling restored'),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('Already selling, never a seller, or a deleted account'),
        },
      },
    },
    '/admin/users/{userId}/seller-limit': {
      put: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary:
          'B5 PR 3b: a personal monthly limit (items, starting-price value) replacing the platform numbers, ' +
          'whatever the standing; null for either half removes it.',
        requestParams: { path: z.object({ userId: z.string() }) },
        requestBody: jsonRequest(R.setSellerLimitSchema),
        responses: {
          200: okBody(
            z.object({ userId: z.string(), items: z.number().int().nullable(), value: z.number().int().nullable() }),
            'The limit now set',
          ),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('An administrator or a deleted account'),
        },
      },
    },
    '/admin/users/{userId}/reinstate': {
      post: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary: 'C2, Phase 7',
        requestParams: { path: z.object({ userId: z.string() }) },
        responses: {
          200: okBody(z.object({ userId: z.string(), status: z.literal('ACTIVE') }), 'Reinstated'),
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('The account is not suspended'),
        },
      },
    },
    '/admin/listings/{listingId}/takedown': {
      post: {
        tags: ['Admin'],
        security: [{ bearerAuth: [] }],
        summary: 'C3, Phase 7 — cancels the live auction underneath, if any, notifying every bidder',
        requestParams: { path: z.object({ listingId: z.string() }) },
        requestBody: jsonRequest(R.takedownListingSchema),
        responses: {
          200: okBody(z.object({ listingId: z.string(), status: z.literal('REMOVED') }), 'Removed'),
          400: badRequest,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: errBody('Only an approved listing can be taken down'),
        },
      },
    },
  },
} satisfies Parameters<typeof createDocument>[0];

export { documentInput };

export const document = createDocument(documentInput);
