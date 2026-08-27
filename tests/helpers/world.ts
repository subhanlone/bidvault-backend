import { hash } from '@node-rs/bcrypt';
import { prisma } from '../../src/db/prisma.js';
import { signAccessToken, signRefreshToken } from '../../src/utils/jwt.js';
import { invalidateSettingsCache } from '../../src/services/settings.service.js';
import { resetRateLimits } from '../../src/middleware/rate-limit.js';
import { resetDatabase } from './db.js';

/**
 * A small, complete world: one user per role and enough rows that every documented GET
 * returns real content rather than an empty list.
 *
 * Tokens are minted with the app's own signer rather than by driving register → verify →
 * login. That is deliberate: this suite is about whether each route is reachable and
 * answers in its documented shape, and going through the whole auth dance for every test
 * would make an unrelated auth regression fail all 43 of them at once. The auth routes are
 * still exercised directly, as themselves.
 */

export const PASSWORD = 'test-password-123';

export interface World {
  buyer: { id: string; email: string; token: string; refreshToken: string };
  seller: { id: string; email: string; token: string };
  admin: { id: string; email: string; token: string };
  /**
   * A second buyer and seller, each owning their own rows.
   *
   * Without them "can this user reach another user's data" is not expressible: with one user
   * per role, every owner-scoped route trivially passes because the only row belongs to the
   * caller. tests/authz.test.ts uses these for the cross-tenant half of its table.
   */
  otherBuyer: { id: string; email: string; token: string };
  otherSeller: { id: string; email: string; token: string };
  /** Owned by otherBuyer — reading or mutating it as `buyer` must fail. */
  otherBuyerNotificationId: string;
  /** otherBuyer won this; create-intent and reviews on it as `buyer` must be refused. */
  otherBuyerTransactionId: string;
  /** Owned by otherSeller — must not appear in `seller`'s own listings. */
  otherSellerListingId: string;
  /** Watched by otherBuyer only. */
  otherBuyerWatchedAuctionId: string;
  /** PENDING, awaiting moderation — the subject of approve/reject. */
  pendingListingId: string;
  /** APPROVED, with a live auction attached. */
  liveAuctionId: string;
  /** The buyer has one bid on the live auction. */
  bidId: string;
  /** CLOSED above reserve, with a PENDING transaction owed by the buyer. */
  closedAuctionId: string;
  transactionId: string;
  notificationId: string;
}

let cnicCounter = 0;

async function makeUser(name: string, email: string, role: 'BUYER' | 'SELLER' | 'ADMIN') {
  // Unique per *user*, not per role: there are now two buyers and two sellers, and cnic is
  // a unique column. Format-valid; register's own test supplies its own.
  const serial = String(++cnicCounter).padStart(5, '0');
  return prisma.user.create({
    data: {
      name,
      email,
      cnic: `${serial}-1234567-1`,
      // Cost 4 keeps fixture creation fast; production hashing is exercised separately at
      // cost 12 in phase2-security.test.ts. bcrypt hashes carry their own cost, so login
      // verifies both without changing application behaviour.
      passwordHash: await hash(PASSWORD, 4),
      role,
      isEmailVerified: true,
    },
  });
}

export async function seedWorld(): Promise<World> {
  await resetDatabase();

  // Rate-limit counters are process-global and survive a truncate, so without this a test's
  // result depends on how many requests ran before it. That is not hypothetical: three
  // forgot-password calls earlier in the conformance file spent the per-address hourly budget,
  // and the resend-verification case after them failed with 429 while asserting 200 — a real
  // failure with a cause several tests away from the assertion that reported it.
  await resetRateLimits();

  // settings.service caches the singleton row in module scope for 10 seconds, and the
  // suite runs longer than that. Without this, a test that writes settings leaves values
  // cached in a process whose database has since been truncated — and the next test to
  // read minListingPrice gets a figure that is no longer stored anywhere.
  invalidateSettingsCache();

  cnicCounter = 0;
  const [buyer, seller, admin, otherBuyer, otherSeller] = await Promise.all([
    makeUser('Test Buyer', 'buyer@test.local', 'BUYER'),
    makeUser('Test Seller', 'seller@test.local', 'SELLER'),
    makeUser('Test Admin', 'admin@test.local', 'ADMIN'),
    makeUser('Other Buyer', 'other-buyer@test.local', 'BUYER'),
    makeUser('Other Seller', 'other-seller@test.local', 'SELLER'),
  ]);

  const pending = await prisma.listing.create({
    data: {
      listingCode: 'TEST-PENDING-1',
      sellerId: seller.id,
      title: 'Pending Test Listing',
      category: 'Electronics & Gadgets',
      condition: 'NEW',
      description: 'A listing awaiting moderation, used by the approve and reject tests.',
      startPrice: 10_000,
      minIncrement: 500,
      durationDays: 3,
      status: 'PENDING',
    },
  });

  const approved = await prisma.listing.create({
    data: {
      listingCode: 'TEST-LIVE-1',
      sellerId: seller.id,
      title: 'Live Test Auction',
      category: 'Electronics & Gadgets',
      condition: 'LIKE_NEW',
      description: 'An approved listing whose auction is currently running.',
      startPrice: 20_000,
      reservePrice: 25_000,
      minIncrement: 1_000,
      durationDays: 7,
      status: 'APPROVED',
    },
  });

  const now = Date.now();
  const live = await prisma.auction.create({
    data: {
      listingId: approved.id,
      sellerId: seller.id,
      title: approved.title,
      category: approved.category,
      condition: approved.condition,
      description: approved.description,
      startPrice: approved.startPrice,
      reservePrice: approved.reservePrice,
      minIncrement: approved.minIncrement,
      currentBid: 21_000,
      bidCount: 1,
      status: 'ACTIVE',
      startTime: new Date(now - 60 * 60 * 1000),
      endTime: new Date(now + 7 * 24 * 60 * 60 * 1000),
    },
  });

  const bid = await prisma.bid.create({
    data: { auctionId: live.id, buyerId: buyer.id, amount: 21_000 },
  });

  // A finished auction the buyer won, so my-wins, create-intent and reviews have a subject.
  const closedListing = await prisma.listing.create({
    data: {
      listingCode: 'TEST-CLOSED-1',
      sellerId: seller.id,
      title: 'Closed Test Auction',
      category: 'Home & Furniture',
      condition: 'USED',
      description: 'An auction that has already closed above its reserve.',
      startPrice: 5_000,
      reservePrice: 6_000,
      minIncrement: 500,
      durationDays: 1,
      status: 'APPROVED',
    },
  });

  const closed = await prisma.auction.create({
    data: {
      listingId: closedListing.id,
      sellerId: seller.id,
      title: closedListing.title,
      category: closedListing.category,
      condition: closedListing.condition,
      description: closedListing.description,
      startPrice: closedListing.startPrice,
      reservePrice: closedListing.reservePrice,
      reserveMet: true,
      minIncrement: closedListing.minIncrement,
      currentBid: 8_000,
      bidCount: 1,
      status: 'CLOSED',
      startTime: new Date(now - 48 * 60 * 60 * 1000),
      endTime: new Date(now - 60 * 60 * 1000),
    },
  });

  await prisma.bid.create({
    data: { auctionId: closed.id, buyerId: buyer.id, amount: 8_000 },
  });

  const transaction = await prisma.auctionTransaction.create({
    data: {
      auctionId: closed.id,
      winnerId: buyer.id,
      sellerId: seller.id,
      finalAmount: 8_000,
      status: 'PENDING',
    },
  });

  const notification = await prisma.notification.create({
    data: {
      userId: buyer.id,
      type: 'AUCTION_WON',
      title: 'You won an auction',
      message: 'Closed Test Auction is yours.',
    },
  });

  await prisma.watchlist.create({ data: { userId: buyer.id, auctionId: live.id } });

  // ---- rows owned by the second buyer/seller, for the cross-tenant tests ----------------

  const otherSellerListing = await prisma.listing.create({
    data: {
      listingCode: 'TEST-OTHER-1',
      sellerId: otherSeller.id,
      title: 'Another Seller Listing',
      category: 'Books & Education',
      condition: 'USED',
      description: 'Owned by a different seller; must not appear in the first seller list.',
      startPrice: 3_000,
      minIncrement: 100,
      durationDays: 2,
      status: 'PENDING',
    },
  });

  const otherClosedListing = await prisma.listing.create({
    data: {
      listingCode: 'TEST-OTHER-2',
      sellerId: otherSeller.id,
      title: 'Another Closed Auction',
      category: 'Sports & Fitness',
      condition: 'NEW',
      description: 'Closed and won by the second buyer.',
      startPrice: 4_000,
      minIncrement: 200,
      durationDays: 1,
      status: 'APPROVED',
    },
  });

  const otherClosed = await prisma.auction.create({
    data: {
      listingId: otherClosedListing.id,
      sellerId: otherSeller.id,
      title: otherClosedListing.title,
      category: otherClosedListing.category,
      condition: otherClosedListing.condition,
      description: otherClosedListing.description,
      startPrice: otherClosedListing.startPrice,
      minIncrement: otherClosedListing.minIncrement,
      currentBid: 9_000,
      bidCount: 1,
      status: 'CLOSED',
      startTime: new Date(now - 48 * 60 * 60 * 1000),
      endTime: new Date(now - 30 * 60 * 1000),
    },
  });

  await prisma.bid.create({
    data: { auctionId: otherClosed.id, buyerId: otherBuyer.id, amount: 9_000 },
  });

  // COMPLETED so that a review attempt on it reaches the ownership check rather than
  // stopping at "complete payment first".
  const otherTransaction = await prisma.auctionTransaction.create({
    data: {
      auctionId: otherClosed.id,
      winnerId: otherBuyer.id,
      sellerId: otherSeller.id,
      finalAmount: 9_000,
      status: 'COMPLETED',
    },
  });

  const otherNotification = await prisma.notification.create({
    data: {
      userId: otherBuyer.id,
      type: 'AUCTION_WON',
      title: 'You won an auction',
      message: 'Belongs to the second buyer.',
    },
  });

  await prisma.watchlist.create({ data: { userId: otherBuyer.id, auctionId: otherClosed.id } });

  const token = (u: { id: string; role: string }) =>
    signAccessToken({ sub: u.id, role: u.role as 'BUYER' | 'SELLER' | 'ADMIN' });

  return {
    buyer: {
      id: buyer.id,
      email: buyer.email,
      token: token(buyer),
      refreshToken: signRefreshToken({ sub: buyer.id, jti: 'seeded' }),
    },
    seller: { id: seller.id, email: seller.email, token: token(seller) },
    admin: { id: admin.id, email: admin.email, token: token(admin) },
    otherBuyer: { id: otherBuyer.id, email: otherBuyer.email, token: token(otherBuyer) },
    otherSeller: { id: otherSeller.id, email: otherSeller.email, token: token(otherSeller) },
    otherBuyerNotificationId: otherNotification.id,
    otherBuyerTransactionId: otherTransaction.id,
    otherSellerListingId: otherSellerListing.id,
    otherBuyerWatchedAuctionId: otherClosed.id,
    pendingListingId: pending.id,
    liveAuctionId: live.id,
    bidId: bid.id,
    closedAuctionId: closed.id,
    transactionId: transaction.id,
    notificationId: notification.id,
  };
}
