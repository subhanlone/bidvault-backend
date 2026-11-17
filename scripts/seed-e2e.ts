/**
 * Seeds the local *_test database for the frontend's Playwright suite (frontend/e2e).
 *
 *   cd backend
 *   node --env-file=.env.test --env-file=../frontend/.env.test --import tsx scripts/seed-e2e.ts
 *
 * What it writes, after seedWorld() has TRUNCATED every table (so it refuses any database whose
 * name does not end in _test, as seedWorld does itself):
 *   - the backend test world (tests/helpers/world.ts): buyer, seller, admin and their auctions;
 *   - the guest specs' fixtures: a seller with a public profile and a review, live, ended and
 *     cancelled auctions, and the six "Browse Spec" auctions the browse specs search for;
 *   - the three accounts the buyer, seller and admin projects sign in as, from frontend/.env.test
 *     (TEST_BUYER_EMAIL / _PASSWORD, TEST_SELLER_..., TEST_ADMIN_...). A pair that is not set is
 *     skipped with a note; no password is ever invented or printed.
 *
 * Every spec that needs more makes its own data through the API (a throwaway account, a listing).
 */
import { prisma } from '../src/db/prisma.js';
import { hashPassword } from '../src/utils/password.js';
import { enrolledSellerFields } from './seed-seller.js';
import { seedWorld } from '../tests/helpers/world.js';

const url = process.env.DATABASE_URL ?? '';
const databaseName = new URL(url.replace(/^postgres(ql)?:/, 'http:')).pathname.replace(/^\//, '');
if (!databaseName.endsWith('_test')) {
  throw new Error(`seed-e2e: refusing "${databaseName}". It truncates every table, so it only runs on a *_test database.`);
}

const w = await seedWorld();
const HOUR = 60 * 60 * 1000;
const now = Date.now();

// ---- the guest specs (guest*.spec.ts) -------------------------------------------------------

// The seller gives a city and province, as the Become a seller form asks, and a phone the
// public profile must never show (F3).
await prisma.user.update({
  where: { id: w.seller.id },
  data: { sellerCity: 'Lahore', sellerProvince: 'Punjab', sellerBio: 'I sell cameras and furniture.', sellerPhone: '0300-7654321' },
});

// The buyer received the Closed Test Auction and reviewed it, so the seller profile has a review
// with the reviewer's name and "Verified purchase".
await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { status: 'DELIVERED' } });
await prisma.sellerReview.create({
  data: {
    transactionId: w.transactionId, auctionId: w.closedAuctionId, buyerId: w.buyer.id, sellerId: w.seller.id,
    stars: 5, comment: 'Exactly as described and well packed.',
  },
});

async function makeAuction(opts: {
  code: string;
  title: string;
  category: string;
  status: 'ACTIVE' | 'CLOSED' | 'CANCELLED';
  startPrice: number;
  reservePrice?: number;
  reserveMet?: boolean;
  currentBid: number;
  /** One bid each, in ascending amounts from the start price. */
  bidders: string[];
  condition?: 'NEW' | 'LIKE_NEW' | 'USED';
  endsInMs: number;
}) {
  const listing = await prisma.listing.create({
    data: {
      listingCode: opts.code, sellerId: w.seller.id, title: opts.title, category: opts.category,
      condition: opts.condition ?? 'USED', description: `${opts.title}, seeded for the browser specs.`,
      startPrice: opts.startPrice, reservePrice: opts.reservePrice, minIncrement: 500, durationDays: 3, status: 'APPROVED',
    },
  });
  const auction = await prisma.auction.create({
    data: {
      listingId: listing.id, sellerId: w.seller.id, title: listing.title, category: listing.category,
      condition: listing.condition, description: listing.description, startPrice: listing.startPrice,
      reservePrice: listing.reservePrice, reserveMet: opts.reserveMet, minIncrement: 500,
      currentBid: opts.currentBid, bidCount: opts.bidders.length, status: opts.status,
      startTime: new Date(now - 72 * HOUR), endTime: new Date(now + opts.endsInMs),
    },
  });
  let amount = opts.startPrice;
  for (const buyerId of opts.bidders) {
    await prisma.bid.create({ data: { auctionId: auction.id, buyerId, amount } });
    amount += 500;
  }
  return auction.id;
}

await makeAuction({
  code: 'TEST-GUEST-CAM', title: 'Guest Spec Vintage Camera', category: 'Electronics & Gadgets',
  status: 'ACTIVE', startPrice: 12_000, currentBid: 12_000, bidders: [], endsInMs: 5 * HOUR,
});
await makeAuction({
  code: 'TEST-GUEST-DESK', title: 'Guest Spec Study Desk', category: 'Home & Furniture',
  status: 'CLOSED', startPrice: 13_000, reservePrice: 50_000, reserveMet: false, currentBid: 14_000,
  bidders: [w.buyer.id, w.otherBuyer.id], endsInMs: -2 * HOUR,
});
await makeAuction({
  code: 'TEST-GUEST-LAMP', title: 'Guest Spec Unsold Lamp', category: 'Home & Furniture',
  status: 'CLOSED', startPrice: 3_000, currentBid: 3_000, bidders: [], endsInMs: -3 * HOUR,
});
await makeAuction({
  code: 'TEST-GUEST-VASE', title: 'Guest Spec Ceramic Vase', category: 'Art & Collectibles',
  status: 'CANCELLED', startPrice: 4_000, currentBid: 4_000, bidders: [], endsInMs: 20 * HOUR,
});

// guest-browse.spec.ts searches for "Browse Spec": six live auctions that differ in category,
// condition, price and bids, each with a real-shaped item number. All end later than the 7-day
// Live Test Auction, so the home page's "Ending soon" is unchanged.
const bidders = [w.buyer.id, w.otherBuyer.id, w.buyer.id, w.otherBuyer.id];
const browse = [
  ['B200000001', 'Browse Spec Alpha Camera', 'Electronics & Gadgets', 'NEW', 3_000, 0, 6],
  ['B200000002', 'Browse Spec Beta Camera', 'Electronics & Gadgets', 'USED', 8_000, 2, 2],
  ['B200000003', 'Browse Spec Gamma Desk', 'Home & Furniture', 'USED', 30_000, 4, 30],
  ['B200000004', 'Browse Spec Delta Lamp', 'Home & Furniture', 'NEW', 12_000, 0, 10],
  ['B200000005', 'Browse Spec Epsilon Book', 'Books & Education', 'LIKE_NEW', 5_000, 1, 48],
  ['B200000006', 'Browse Spec Zeta Bike', 'Sports & Fitness', 'USED', 25_000, 0, 20],
] as const;
for (const [code, title, category, condition, price, bids, hours] of browse) {
  await makeAuction({
    code: `BV-2026-${code}`, title, category, condition, status: 'ACTIVE', startPrice: price - bids * 500,
    currentBid: price, bidders: bidders.slice(0, bids), endsInMs: (200 + hours) * HOUR,
  });
}

// ---- the signed-in projects (buyer, seller, admin) ------------------------------------------

const roles = [
  { key: 'BUYER', name: 'E2E Buyer', data: { role: 'BUYER' as const } },
  // The legacy SELLER role makes the account open on the seller side, where seller.setup.ts expects it.
  { key: 'SELLER', name: 'E2E Seller', data: { role: 'SELLER' as const, ...enrolledSellerFields('Lahore', 'Punjab') } },
  { key: 'ADMIN', name: 'E2E Admin', data: { role: 'ADMIN' as const } },
];
const made: string[] = [];
const skipped: string[] = [];
for (const r of roles) {
  const email = process.env[`TEST_${r.key}_EMAIL`]?.trim().toLowerCase();
  const password = process.env[`TEST_${r.key}_PASSWORD`];
  if (!email || !password) {
    skipped.push(`TEST_${r.key}_EMAIL / TEST_${r.key}_PASSWORD not set`);
    continue;
  }
  await prisma.user.create({
    data: { email, name: r.name, passwordHash: await hashPassword(password), isEmailVerified: true, ...r.data },
  });
  made.push(`${r.key.toLowerCase()} ${email}`);
}

console.log(`seed-e2e: seeded ${databaseName}: ${await prisma.auction.count()} auctions, ${await prisma.user.count()} users.`);
console.log(`  signed-in accounts: ${made.length ? made.join(', ') : 'none'}`);
for (const s of skipped) console.log(`  skipped: ${s}`);
await prisma.$disconnect();
// world.ts pulls in the rate-limit Redis client, which would otherwise keep the process alive.
process.exit(0);
