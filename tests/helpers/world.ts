import bcrypt from 'bcryptjs';
import { prisma } from '../../src/db/prisma.js';
import { signAccessToken, signRefreshToken } from '../../src/utils/jwt.js';
import { invalidateSettingsCache } from '../../src/services/settings.service.js';
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

async function makeUser(name: string, email: string, role: 'BUYER' | 'SELLER' | 'ADMIN') {
  return prisma.user.create({
    data: {
      name,
      email,
      // Unique per role and format-valid; register's own test supplies its own.
      cnic: `${role === 'BUYER' ? '11111' : role === 'SELLER' ? '22222' : '33333'}-1234567-1`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      role,
      isEmailVerified: true,
    },
  });
}

export async function seedWorld(): Promise<World> {
  await resetDatabase();

  // settings.service caches the singleton row in module scope for 10 seconds, and the
  // suite runs longer than that. Without this, a test that writes settings leaves values
  // cached in a process whose database has since been truncated — and the next test to
  // read minListingPrice gets a figure that is no longer stored anywhere.
  invalidateSettingsCache();

  const [buyer, seller, admin] = await Promise.all([
    makeUser('Test Buyer', 'buyer@test.local', 'BUYER'),
    makeUser('Test Seller', 'seller@test.local', 'SELLER'),
    makeUser('Test Admin', 'admin@test.local', 'ADMIN'),
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
    pendingListingId: pending.id,
    liveAuctionId: live.id,
    bidId: bid.id,
    closedAuctionId: closed.id,
    transactionId: transaction.id,
    notificationId: notification.id,
  };
}
