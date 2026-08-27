import { z } from 'zod';

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
  .enum(['PENDING', 'COMPLETED', 'FAILED'])
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
    createdAt: isoDateTime,
    reviewed: z.boolean(),
  })
  .meta({ id: 'WonTransaction' });

export const SellerStatsDto = z
  .object({ totalRevenue: z.number().int(), itemsSold: z.number().int() })
  .meta({ id: 'SellerStats' });

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

export const PaymentIntentDto = z
  .object({ clientSecret: z.string().nullable() })
  .meta({ id: 'PaymentIntent' });

export const WebhookAckDto = z.object({ received: z.literal(true) }).meta({ id: 'WebhookAck' });

export type UserDtoType = z.infer<typeof UserDto>;
export type AuctionDtoType = z.infer<typeof AuctionDto>;
export type ListingDtoType = z.infer<typeof ListingDto>;
export type BidDtoType = z.infer<typeof BidDto>;
