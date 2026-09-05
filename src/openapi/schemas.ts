import { z } from 'zod';

/**
 * BV-029: the envelope every cursor-paginated list endpoint answers with. `nextCursor` is
 * `null`, not omitted, when the caller has reached the end -- the field always exists, so
 * callers can check it directly rather than distinguishing "absent" from "null".
 */
function paginated<T extends z.ZodTypeAny>(id: string, item: T) {
  return z
    .object({ items: z.array(item), nextCursor: z.string().nullable() })
    .meta({ id });
}

/**
 * The response contract. This is the source of truth for what the API sends, and the
 * frontend's `src/types/api.d.ts` is generated from it — so a change here shows up as a
 * type error in the client rather than as a runtime surprise.
 *
 * These are not documentation. Each DTO mapper declares its return type as
 * `z.infer<typeof SomeDto>`, so if a mapper stops matching its published shape the backend
 * build fails. That is the whole point: this codebase's recurring defect has been the UI
 * asserting things the data does not support, and a contract nothing checks would be one
 * more place for that to happen.
 *
 * Enum values mirror prisma/schema.prisma.
 */

export const UserRole = z.enum(['BUYER', 'SELLER', 'ADMIN']).meta({ id: 'UserRole' });
export const ItemCondition = z.enum(['NEW', 'LIKE_NEW', 'USED']).meta({ id: 'ItemCondition' });
export const ListingStatus = z
  .enum(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED'])
  .meta({ id: 'ListingStatus' });
// SCHEDULED is retained in the database enum but no longer reachable: auctions go straight
// to ACTIVE on approval and the auction:start job was removed.
export const AuctionStatus = z
  .enum(['SCHEDULED', 'ACTIVE', 'CLOSED'])
  .meta({ id: 'AuctionStatus' });
export const TransactionStatus = z
  .enum(['PENDING', 'COMPLETED', 'FAILED', 'VOIDED', 'SHIPPED', 'DELIVERED', 'DISPUTED', 'REFUNDED'])
  .meta({ id: 'TransactionStatus' });
export const NotificationType = z
  .enum([
    'BID_OUTBID',
    'AUCTION_WON',
    'RESERVE_NOT_MET',
    'LISTING_APPROVED',
    'LISTING_REJECTED',
    'NEW_REVIEW',
  ])
  .meta({ id: 'NotificationType' });

/**
 * Category-specific listing attributes.
 *
 * Values are narrowed to string | number rather than unknown. Every schema in
 * category-attributes.ts produces only those two, and `validateCategoryAttributes` gates
 * every write, so a wider type would make consumers handle cases the write path cannot
 * create. Confirmed against production: 11 auctions carry attributes, all values string or
 * number, no nested objects or arrays.
 *
 * If a future category introduces a boolean or nested value, widen this — the DTO mappers'
 * casts are bound to it and will fail the build.
 */
export const CategoryAttributes = z
  .record(z.string(), z.union([z.string(), z.number()]))
  .meta({ id: 'CategoryAttributes', description: 'Category-specific fields; keys vary by category.' });

const isoDateTime = z.iso.datetime();

export const UserDto = z
  .object({
    userId: z.string(),
    name: z.string(),
    email: z.email(),
    role: UserRole,
    isEmailVerified: z.boolean(),
    createdAt: isoDateTime,
  })
  .meta({ id: 'User' });

export const AuctionDto = z
  .object({
    auctionId: z.string(),
    listingId: z.string(),
    title: z.string(),
    category: z.string(),
    condition: ItemCondition,
    description: z.string(),
    emoji: z.string(),
    sellerId: z.string(),
    sellerName: z.string(),
    /** null until the seller has a rating. */
    sellerRating: z.number().nullable(),
    sellerSales: z.number().int().nullable(),
    startPrice: z.number().int(),
    currentBid: z.number().int(),
    minIncrement: z.number().int(),
    /**
     * The reserve *amount* is never published — see toAuctionDto for why. Only the verdict:
     * null = no reserve set, false = not reached, true = reached.
     */
    reserveMet: z.boolean().nullable(),
    bidCount: z.number().int(),
    startTime: isoDateTime,
    endTime: isoDateTime,
    status: AuctionStatus,
    /** Empty string rather than null when the listing has no image. */
    imageUrl: z.string(),
    images: z.array(z.string()),
    attributes: CategoryAttributes.optional(),
  })
  .meta({ id: 'Auction' });

export const ListingDto = z
  .object({
    listingId: z.string(),
    listingCode: z.string(),
    sellerId: z.string(),
    sellerName: z.string(),
    title: z.string(),
    category: z.string(),
    condition: ItemCondition,
    description: z.string(),
    startPrice: z.number().int(),
    /** Role-gated: this DTO is only served to the owning seller and to admins. */
    reservePrice: z.number().int().optional(),
    minIncrement: z.number().int(),
    durationDays: z.number().int(),
    status: ListingStatus,
    rejectionReason: z.string().optional(),
    submittedAt: isoDateTime,
    emoji: z.string(),
    imageUrl: z.string().optional(),
    sellerEmail: z.email(),
    attributes: CategoryAttributes.optional(),
  })
  .meta({ id: 'Listing' });

export const BidDto = z
  .object({
    bidId: z.string(),
    auctionId: z.string(),
    buyerId: z.string(),
    buyerName: z.string(),
    amount: z.number().int(),
    timestamp: isoDateTime,
  })
  .meta({ id: 'Bid' });

// BV-039: GET /:auctionId/bids is unauthenticated and reaches anonymous visitors, who could
// otherwise enumerate exactly who bid, how much and when, and correlate one person's bidding
// across the whole platform via buyerId. Unlike BidDto (used by the bidder's own POST response
// and by GET /auctions/mine/bids, both already scoped to the caller's own identity), the public
// feed carries no buyerId at all and masks the name to a stable per-auction pseudonym --
// `isMine` is computed server-side from the caller's own token, when one is present, so the
// live-bidding screen can still tell the viewer's own bids apart without needing their real id.
export const PublicBidDto = z
  .object({
    bidId: z.string(),
    auctionId: z.string(),
    isMine: z.boolean(),
    buyerName: z.string(),
    amount: z.number().int(),
    timestamp: isoDateTime,
  })
  .meta({ id: 'PublicBid' });

export const PlatformStatsDto = z
  .object({
    userCount: z.number().int(),
    activeAuctionCount: z.number().int(),
    /** COMPLETED transactions only — a row exists from auction close, whether or not paid. */
    transactionTotal: z.number().int(),
    listingCount: z.number().int(),
    completedSalesCount: z.number().int(),
  })
  .meta({ id: 'PlatformStats' });

export const PublicSettingsDto = z
  .object({
    maintenanceMode: z.boolean(),
    supportEmail: z.email(),
    minListingPrice: z.number().int(),
    maxBidIncrement: z.number().int(),
  })
  .meta({ id: 'PublicSettings' });

const ProbeDto = z.object({
  state: z.enum(['up', 'down']),
  latencyMs: z.number().int().nonnegative(),
});

export const HealthDto = z
  .object({
    // Always 'ok' when the process is answering at all. Dependency trouble is reported in
    // `dependencies`, not by this field or the status code — see the handler for why.
    status: z.literal('ok'),
    service: z.string(),
    /** The contract version from openapi.json — what this build believes it serves. */
    version: z.string(),
    /** Short commit SHA on Railway, 'local' elsewhere. */
    commit: z.string(),
    dependencies: z.object({ database: ProbeDto, redis: ProbeDto }),
    /**
     * Distinct (operation, status) pairs currently serving a response that does not match
     * their published schema — see middleware/response-contract.ts. Zero in a healthy
     * deployment; anything else is drift nothing else surfaces outside this process's own
     * logs. See BV-016.
     */
    contractViolations: z.number().int().nonnegative(),
    /**
     * Seconds since the lifecycle worker last wrote its heartbeat, or null when that cannot
     * be determined — the worker has never run against this Redis, or the read itself timed
     * out. A crashed worker leaves every ACTIVE auction open past its end time with nothing
     * else in the system saying why; this is what makes that externally observable. See
     * BV-012.
     */
    workerHeartbeatAgeSeconds: z.number().int().nonnegative().nullable(),
  })
  .meta({ id: 'Health' });

/** GET /auctions/mine/bids — a bid with the auction it was placed on. */
export const BidWithAuctionDto = BidDto.extend({ auction: AuctionDto }).meta({
  id: 'BidWithAuction',
});

// GET /watchlist returns full AuctionDto objects (see watchlist.routes.ts). It previously
// had its own five-field shape, which is why WatchlistEntry no longer exists as a schema.

export const NotificationDto = z
  .object({
    id: z.string(),
    type: NotificationType,
    title: z.string(),
    message: z.string(),
    isRead: z.boolean(),
    createdAt: isoDateTime,
  })
  .meta({ id: 'Notification' });

export const NotificationPrefsDto = z
  .object({
    notifyOutbid: z.boolean(),
    notifyWins: z.boolean(),
    notifyNews: z.boolean(),
  })
  .meta({ id: 'NotificationPrefs' });

export const ReviewDto = z
  .object({
    reviewId: z.string(),
    stars: z.number().int(),
    comment: z.string().nullable(),
    createdAt: isoDateTime,
  })
  .meta({ id: 'Review' });

export const SellerReviewsDto = z
  .object({
    sellerId: z.string(),
    /** Mean stars to one decimal, or null when the seller has no reviews. */
    average: z.number().nullable(),
    count: z.number().int(),
    // BV-039: this route is unauthenticated too — buyerName is a stable per-seller pseudonym
    // ("Reviewer N"), not the reviewer's real name.
    reviews: z.array(ReviewDto.extend({ buyerName: z.string() })),
  })
  .meta({ id: 'SellerReviews' });

export const WonTransactionDto = z
  .object({
    transactionId: z.string(),
    auctionId: z.string(),
    auctionTitle: z.string(),
    auctionEmoji: z.string(),
    auctionImageUrl: z.string(),
    sellerName: z.string(),
    finalAmount: z.number().int(),
    status: TransactionStatus,
    /**
     * Why the most recent payment attempt failed, absent when none has.
     *
     * A declined card no longer moves `status` to FAILED — that made one decline permanent,
     * since create-intent refused anything that was not PENDING. The transaction stays
     * PENDING and retryable, and this carries the explanation the buyer needs to act on.
     * Cleared when a fresh attempt starts.
     */
    lastPaymentError: z.string().optional(),
    // BV-047: present once the seller has marked the item shipped. reviewDeadlineAt is
    // computed server-side (shippedAt + reviewTimeoutHours) so the frontend never needs the
    // platform setting itself just to render a countdown.
    shippedAt: isoDateTime.optional(),
    reviewDeadlineAt: isoDateTime.optional(),
    disputeReason: z.string().optional(),
    createdAt: isoDateTime,
    reviewed: z.boolean(),
  })
  .meta({ id: 'WonTransaction' });

export const SellerStatsDto = z
  .object({ totalRevenue: z.number().int(), itemsSold: z.number().int() })
  .meta({ id: 'SellerStats' });

/** A seller's own sale — GET /payments/my-sales. Carries what BV-047 added: the buyer's
 * delivery details and the fulfilment state, neither of which existed before. */
export const SellerSaleDto = z
  .object({
    transactionId: z.string(),
    auctionId: z.string(),
    auctionTitle: z.string(),
    auctionEmoji: z.string(),
    auctionImageUrl: z.string(),
    buyerName: z.string(),
    finalAmount: z.number().int(),
    status: TransactionStatus,
    deliveryAddress: z.string().optional(),
    deliveryPhone: z.string().optional(),
    shippedAt: isoDateTime.optional(),
    reviewDeadlineAt: isoDateTime.optional(),
    disputeReason: z.string().optional(),
    createdAt: isoDateTime,
  })
  .meta({ id: 'SellerSale' });

export const PaginatedSellerSales = z
  .object({ items: z.array(SellerSaleDto), nextCursor: z.string().nullable() })
  .meta({ id: 'PaginatedSellerSales' });

/** GET /payments/earnings — a seller's dummy-ledger balance and the sales that built it. */
export const EarningsDto = z
  .object({
    ledgerBalance: z.number().int(),
    entries: z.array(
      z.object({
        transactionId: z.string(),
        auctionTitle: z.string(),
        amount: z.number().int(),
        createdAt: isoDateTime,
      }),
    ),
  })
  .meta({ id: 'Earnings' });

/** LIFECYCLE-GAPS.md E3 — GET /payments/{transactionId}/invoice, derived from the transaction
 * row rather than a separately stored document. */
export const InvoiceDto = z
  .object({
    transactionId: z.string(),
    invoiceNumber: z.string(),
    auctionTitle: z.string(),
    category: z.string(),
    buyerName: z.string(),
    buyerEmail: z.string(),
    sellerName: z.string(),
    sellerEmail: z.string(),
    amount: z.number().int(),
    status: TransactionStatus,
    paymentReference: z.string().optional(),
    deliveryAddress: z.string().optional(),
    deliveryPhone: z.string().optional(),
    createdAt: isoDateTime,
    shippedAt: isoDateTime.optional(),
    disputeStatus: z.enum(['OPEN', 'RESOLVED_REFUNDED', 'RESOLVED_RELEASED']).optional(),
    disputeReason: z.string().optional(),
    disputeResolutionNote: z.string().optional(),
  })
  .meta({ id: 'Invoice' });

/** GET /admin/disputes — one open dispute a buyer has raised, awaiting resolution. */
export const AdminDisputeDto = z
  .object({
    disputeId: z.string(),
    transactionId: z.string(),
    auctionTitle: z.string(),
    buyerId: z.string(),
    buyerName: z.string(),
    sellerId: z.string(),
    sellerName: z.string(),
    finalAmount: z.number().int(),
    reason: z.string(),
    createdAt: isoDateTime,
  })
  .meta({ id: 'AdminDispute' });

/** A PENDING transaction an admin can void — see POST /admin/transactions/{transactionId}/void. */
export const AdminTransactionDto = z
  .object({
    transactionId: z.string(),
    auctionId: z.string(),
    auctionTitle: z.string(),
    buyerId: z.string(),
    buyerName: z.string(),
    sellerId: z.string(),
    sellerName: z.string(),
    finalAmount: z.number().int(),
    status: TransactionStatus,
    lastPaymentError: z.string().optional(),
    createdAt: isoDateTime,
  })
  .meta({ id: 'AdminTransaction' });

/** A search result for GET /admin/users — used to find the account BV-018's anonymize route targets. */
export const AdminUserDto = z
  .object({
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    role: UserRole,
    createdAt: isoDateTime,
  })
  .meta({ id: 'AdminUser' });

export const AnalyticsDto = z
  .object({
    totalRevenue: z.number().int(),
    totalBids: z.number().int(),
    avgBidValue: z.number().int(),
    sellerConversionRate: z.number().int(),
    monthlyRevenue: z.array(
      z.object({ month: z.string(), value: z.number(), bids: z.number().int() }),
    ),
    /** Percentages are apportioned by largest remainder, so they total exactly 100. */
    categoryBreakdown: z.array(
      z.object({ name: z.string(), count: z.number().int(), pct: z.number().int() }),
    ),
    topSellers: z.array(
      z.object({
        sellerId: z.string(),
        sellerName: z.string(),
        sales: z.number().int(),
        revenue: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'Analytics' });

/** Admin view — the public one omits the settings only admins need. */
export const PlatformSettingsDto = z
  .object({
    emailNotifsEnabled: z.boolean(),
    maintenanceMode: z.boolean(),
    maxBidIncrement: z.number().int(),
    minListingPrice: z.number().int(),
    reviewTimeoutHours: z.number().int(),
    supportEmail: z.string(),
  })
  .meta({ id: 'PlatformSettings' });

export const SessionDto = z
  .object({ accessToken: z.string(), refreshToken: z.string(), user: UserDto })
  .meta({ id: 'Session' });

export const RefreshedTokensDto = z
  .object({ accessToken: z.string(), refreshToken: z.string() })
  .meta({ id: 'RefreshedTokens' });

/**
 * Changing a password revokes every session the account has, including the one that asked, so a
 * replacement pair is handed back with the confirmation. Without it the caller keeps working
 * until its access token expires and is then signed out mid-task by its own successful request.
 */
export const PasswordChangedDto = z
  .object({ message: z.string(), accessToken: z.string(), refreshToken: z.string() })
  .meta({ id: 'PasswordChanged' });

/**
 * OTPs come back in the response outside production, for local testing — hence optional.
 * In production these fields are absent.
 */
export const RegistrationDto = z
  .object({
    user: UserDto,
    verificationCode: z.string().optional(),
    codeExpiresAt: isoDateTime,
  })
  .meta({ id: 'Registration' });

export const OtpIssuedDto = z
  .object({
    message: z.string(),
    resetCode: z.string().optional(),
    verificationCode: z.string().optional(),
    // Optional because both routes that return this have a neutral early exit — an
    // unknown address on forgot-password, an already-verified one on resend-verification.
    // Those answer with a message and nothing else, deliberately: an expiry timestamp
    // would confirm the account exists, which is the enumeration leak the neutral
    // response is there to prevent. Declaring it required made the contract describe a
    // response the server has never sent. Found by the response-contract middleware.
    codeExpiresAt: isoDateTime.optional(),
  })
  .meta({ id: 'OtpIssued' });

export const MessageDto = z.object({ message: z.string() }).meta({ id: 'Message' });

export const UploadSignatureDto = z
  .object({
    signature: z.string(),
    timestamp: z.number().int(),
    apiKey: z.string(),
    cloudName: z.string(),
    folder: z.string(),
    format: z.string(),
    publicId: z.string(),
    allowedFormats: z.string(),
  })
  .meta({ id: 'UploadSignature' });

export const ApprovalDto = z
  .object({
    listingId: z.string(),
    status: z.literal('APPROVED'),
    auctionId: z.string().optional(),
    /** Present when the auction was created but its close job could not be scheduled. */
    warning: z.string().optional(),
  })
  .meta({ id: 'Approval' });

export const BulkApprovalDto = z
  .object({
    approved: z.number().int(),
    failed: z.number().int(),
    failures: z.array(z.object({ listingId: z.string(), error: z.string() })),
    // BV-049: one call processes at most 50 -- still-PENDING count after this batch, so the
    // caller knows whether to loop again rather than guessing from a cut-off connection.
    remaining: z.number().int(),
  })
  .meta({ id: 'BulkApproval' });

export const RejectionDto = z
  .object({
    listingId: z.string(),
    status: ListingStatus,
    rejectionReason: z.string().nullable(),
  })
  .meta({ id: 'Rejection' });

export const WatchToggleDto = z
  .object({ auctionId: z.string(), watched: z.boolean() })
  .meta({ id: 'WatchToggle' });

export const NotificationReadDto = z
  .object({ id: z.string(), isRead: z.literal(true) })
  .meta({ id: 'NotificationRead' });

/** POST /payments/{transactionId}/pay — resolves synchronously; a decline is an ordinary
 * outcome (BV-006), not a request error, so it is a 200 with status PENDING, not a 4xx. */
export const PayResultDto = z
  .object({
    transactionId: z.string(),
    status: z.enum(['COMPLETED', 'PENDING']),
    lastPaymentError: z.string().optional(),
  })
  .meta({ id: 'PayResult' });

// BV-029: cursor-paginated list responses. One per endpoint's item shape, not one shared
// generic $ref -- zod-openapi needs a distinct schema id per named type, and each of these
// really is a different item shape.
export const PaginatedAuctionsDto = paginated('PaginatedAuctions', AuctionDto);
export const PaginatedBidsWithAuctionDto = paginated('PaginatedBidsWithAuction', BidWithAuctionDto);
export const PaginatedBidsDto = paginated('PaginatedBids', PublicBidDto);
export const PaginatedListingsDto = paginated('PaginatedListings', ListingDto);

export type UserDtoType = z.infer<typeof UserDto>;
export type AuctionDtoType = z.infer<typeof AuctionDto>;
export type ListingDtoType = z.infer<typeof ListingDto>;
export type BidDtoType = z.infer<typeof BidDto>;
