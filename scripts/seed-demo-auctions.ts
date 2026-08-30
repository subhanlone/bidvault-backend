/**
 * One-off script: populates realistic demo auctions, one per category, plus
 * one already-closed auction with a completed transaction + review. Not part
 * of the regular prisma:seed reset — run manually against whichever DATABASE_URL
 * is active in the environment (e.g. via `railway run` for production).
 */
import { PrismaClient, ItemCondition, AuctionStatus } from '@prisma/client';
import { hash } from '@node-rs/bcrypt';
import crypto from 'node:crypto';
import { auctionLifecycleQueue, scheduleAuctionLifecycle } from '../src/queues/auction-lifecycle.queue.js';
import { redisConnection } from '../src/infra/redis.js';
import { assertSeedTarget, requiredPassword } from './seed-guard.js';

// This script is designed to be pointed at production (see the header above), so the guard
// permits that — it just has to be asked for by name via ALLOW_PRODUCTION_SEED=1.
assertSeedTarget('seed-demo-auctions');

const prisma = new PrismaClient();

function generateListingCode(): string {
  const year = new Date().getFullYear();
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `BV-${year}-${suffix}`;
}

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}
function hoursFromNow(h: number): Date {
  return new Date(Date.now() + h * 60 * 60 * 1000);
}

async function upsertUser(params: {
  email: string; name: string; role: 'BUYER' | 'SELLER'; cnic: string;
}) {
  const passwordHash = await hash(requiredPassword('SEED_DEMO_PASSWORD'), 12);
  return prisma.user.upsert({
    where: { email: params.email },
    update: {},
    create: {
      name: params.name,
      email: params.email,
      cnic: params.cnic,
      role: params.role,
      passwordHash,
      isEmailVerified: true,
    },
  });
}

async function main() {
  // ── Demo buyers & sellers ───────────────────────────────────────────────
  const buyers = await Promise.all([
    upsertUser({ email: 'bilal.khan.demo@gmail.com', name: 'Bilal Khan', role: 'BUYER', cnic: '35202-1111111-1' }),
    upsertUser({ email: 'ayesha.malik.demo@gmail.com', name: 'Ayesha Malik', role: 'BUYER', cnic: '35202-2222222-2' }),
    upsertUser({ email: 'hamza.sheikh.demo@gmail.com', name: 'Hamza Sheikh', role: 'BUYER', cnic: '35202-3333333-3' }),
    upsertUser({ email: 'fatima.iqbal.demo@gmail.com', name: 'Fatima Iqbal', role: 'BUYER', cnic: '35202-4444444-4' }),
    upsertUser({ email: 'usman.tariq.demo@gmail.com', name: 'Usman Tariq', role: 'BUYER', cnic: '35202-5555555-5' }),
  ]);
  const [bilal, ayesha, hamza, fatima, usman] = buyers;

  const sellerZainab = await upsertUser({ email: 'zainab.hussain.demo@gmail.com', name: 'Zainab Hussain', role: 'SELLER', cnic: '35202-6666666-6' });
  const sellerTariq = await upsertUser({ email: 'tariq.mehmood.demo@gmail.com', name: 'Tariq Mehmood', role: 'SELLER', cnic: '35202-7777777-7' });
  const sellerSana = await upsertUser({ email: 'sana.aslam.demo@gmail.com', name: 'Sana Aslam', role: 'SELLER', cnic: '35202-8888888-8' });

  interface DemoItem {
    seller: typeof sellerZainab;
    title: string;
    category: string;
    condition: ItemCondition;
    description: string;
    attributes: Record<string, string | number>;
    imageUrl: string;
    emoji: string;
    startPrice: number;
    minIncrement: number;
    reservePrice?: number;
    durationDays: number;
    startTime: Date;
    endTime: Date;
    status: AuctionStatus;
    bids: { buyer: typeof bilal; amount: number; at: Date }[];
    closedSale?: { winner: typeof bilal; finalAmount: number; reviewStars: number; reviewComment: string };
  }

  const items: DemoItem[] = [
    {
      seller: sellerZainab,
      title: 'Samsung Galaxy S24 Ultra 512GB - Titanium Black',
      category: 'Electronics & Gadgets',
      condition: ItemCondition.NEW,
      description: 'Brand new, factory sealed. 512GB storage, 12GB RAM, Snapdragon 8 Gen 3 processor, 200MP camera system with S-Pen included. Full manufacturer warranty, box unopened.',
      attributes: { brand: 'Samsung', model: 'Galaxy S24 Ultra', specifications: '512GB storage, 12GB RAM, Snapdragon 8 Gen 3, 200MP camera, S-Pen included' },
      imageUrl: 'https://images.unsplash.com/photo-1610792516286-524726503fb2?w=600&auto=format&fit=crop&q=80',
      emoji: '📱',
      startPrice: 180000, minIncrement: 5000, reservePrice: 215000, durationDays: 5,
      startTime: hoursAgo(20), endTime: hoursFromNow(28), status: AuctionStatus.ACTIVE,
      bids: [
        { buyer: bilal, amount: 185000, at: hoursAgo(19) },
        { buyer: ayesha, amount: 192000, at: hoursAgo(14) },
        { buyer: hamza, amount: 198000, at: hoursAgo(8) },
        { buyer: bilal, amount: 205000, at: hoursAgo(3) },
        { buyer: usman, amount: 212000, at: hoursAgo(1) },
      ],
    },
    {
      seller: sellerTariq,
      title: '2021 Honda Civic Oriel 1.8L - Pearl White',
      category: 'Vehicles',
      condition: ItemCondition.USED,
      description: 'Single owner, well maintained, all original parts with complete service history. Non-accidental, genuine mileage, new tyres fitted last month.',
      attributes: { make: 'Honda', model: 'Civic Oriel', year: 2021, mileage: 35000 },
      imageUrl: 'https://images.unsplash.com/photo-1550355291-bbee04a92027?w=600&auto=format&fit=crop&q=80',
      emoji: '🚗',
      startPrice: 4500000, minIncrement: 50000, reservePrice: 4800000, durationDays: 7,
      startTime: hoursAgo(30), endTime: hoursFromNow(48), status: AuctionStatus.ACTIVE,
      bids: [
        { buyer: fatima, amount: 4550000, at: hoursAgo(28) },
        { buyer: usman, amount: 4620000, at: hoursAgo(20) },
        { buyer: hamza, amount: 4700000, at: hoursAgo(10) },
        { buyer: fatima, amount: 4780000, at: hoursAgo(2) },
      ],
    },
    {
      seller: sellerSana,
      title: 'Designer Leather Jacket - Genuine Cowhide, Size L',
      category: 'Clothing & Fashion',
      condition: ItemCondition.LIKE_NEW,
      description: 'Premium genuine leather jacket, worn only a handful of times, excellent condition. Perfect for the winter season.',
      attributes: { size: 'L', color: 'Black', brand: 'Zara' },
      imageUrl: 'https://images.unsplash.com/photo-1551028719-00167b16eac5?w=600&auto=format&fit=crop&q=80',
      emoji: '🧥',
      startPrice: 8000, minIncrement: 500, durationDays: 3,
      startTime: hoursAgo(12), endTime: hoursFromNow(60), status: AuctionStatus.ACTIVE,
      bids: [
        { buyer: ayesha, amount: 8500, at: hoursAgo(11) },
        { buyer: bilal, amount: 9200, at: hoursAgo(6) },
        { buyer: ayesha, amount: 10000, at: hoursAgo(2) },
      ],
    },
    {
      seller: sellerZainab,
      title: "Complete Harry Potter Box Set - Hardcover Collector's Edition",
      category: 'Books & Education',
      condition: ItemCondition.LIKE_NEW,
      description: 'All 7 books, hardcover collector\'s edition, excellent condition with no markings or damage. Comes with original slipcase.',
      attributes: { author: 'J.K. Rowling', format: 'Physical', publisher: 'Bloomsbury' },
      imageUrl: 'https://images.unsplash.com/photo-1481627834876-b7833e8f5570?w=600&auto=format&fit=crop&q=80',
      emoji: '📚',
      startPrice: 6000, minIncrement: 300, durationDays: 4,
      startTime: hoursAgo(15), endTime: hoursFromNow(70), status: AuctionStatus.ACTIVE,
      bids: [
        { buyer: hamza, amount: 6300, at: hoursAgo(14) },
        { buyer: fatima, amount: 6800, at: hoursAgo(7) },
        { buyer: hamza, amount: 7400, at: hoursAgo(1) },
      ],
    },
    {
      seller: sellerTariq,
      title: 'Solid Sheesham Wood Dining Table Set (6-Seater)',
      category: 'Home & Furniture',
      condition: ItemCondition.USED,
      description: 'Handcrafted solid sheesham wood dining set with 6 matching chairs. Minor wear consistent with age, very sturdy build.',
      attributes: { material: 'Sheesham Wood', dimensions: '180x90x75cm', roomType: 'Kitchen' },
      imageUrl: 'https://images.unsplash.com/photo-1617806118233-18e1de247200?w=600&auto=format&fit=crop&q=80',
      emoji: '🍽️',
      startPrice: 45000, minIncrement: 2000, durationDays: 6,
      startTime: hoursAgo(40), endTime: hoursFromNow(100), status: AuctionStatus.ACTIVE,
      bids: [
        { buyer: usman, amount: 47000, at: hoursAgo(36) },
        { buyer: ayesha, amount: 51000, at: hoursAgo(20) },
        { buyer: usman, amount: 55000, at: hoursAgo(4) },
      ],
    },
    {
      seller: sellerSana,
      title: 'Professional Cricket Kit - Full Adult Set',
      category: 'Sports & Fitness',
      condition: ItemCondition.LIKE_NEW,
      description: 'Complete cricket kit including bat, pads, gloves, helmet, and kit bag. Used for one season only, excellent condition.',
      attributes: { sportType: 'Cricket', brand: 'Gray-Nicolls', size: 'Full Size (Adult)' },
      imageUrl: 'https://images.unsplash.com/photo-1595435742656-5272d0b3fa82?w=600&auto=format&fit=crop&q=80',
      emoji: '🏏',
      startPrice: 15000, minIncrement: 1000, durationDays: 3,
      startTime: hoursAgo(10), endTime: hoursFromNow(62), status: AuctionStatus.ACTIVE,
      bids: [
        { buyer: bilal, amount: 16000, at: hoursAgo(9) },
        { buyer: hamza, amount: 17500, at: hoursAgo(5) },
        { buyer: bilal, amount: 19000, at: hoursAgo(1) },
      ],
    },
    {
      seller: sellerZainab,
      title: 'Original Oil Painting - Lahore Skyline at Dusk',
      category: 'Art & Collectibles',
      condition: ItemCondition.NEW,
      description: 'Original hand-painted artwork by a local Pakistani artist, signed and dated on the back. Ready to hang, includes wooden frame.',
      attributes: { creator: 'Ahmed Zaman', medium: 'Oil on canvas', yearCreated: 2023 },
      imageUrl: 'https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?w=600&auto=format&fit=crop&q=80',
      emoji: '🎨',
      startPrice: 25000, minIncrement: 2000, durationDays: 5,
      startTime: hoursAgo(18), endTime: hoursFromNow(102), status: AuctionStatus.ACTIVE,
      bids: [
        { buyer: fatima, amount: 27000, at: hoursAgo(16) },
        { buyer: usman, amount: 30000, at: hoursAgo(9) },
        { buyer: fatima, amount: 34000, at: hoursAgo(2) },
      ],
    },
    // ── Closed auction — full lifecycle: bids, winner, payment, review ──────
    {
      seller: sellerTariq,
      title: 'iPhone 14 Pro 256GB - Deep Purple',
      category: 'Electronics & Gadgets',
      condition: ItemCondition.LIKE_NEW,
      description: 'Excellent condition, minor signs of use, all original accessories included. Battery health 92%.',
      attributes: { brand: 'Apple', model: 'iPhone 14 Pro', specifications: '256GB storage, Deep Purple, Battery health 92%' },
      imageUrl: 'https://images.unsplash.com/photo-1592286927505-1def25115558?w=600&auto=format&fit=crop&q=80',
      emoji: '📱',
      startPrice: 165000, minIncrement: 5000, reservePrice: 180000, durationDays: 5,
      startTime: hoursAgo(10 * 24), endTime: hoursAgo(3 * 24), status: AuctionStatus.CLOSED,
      bids: [
        { buyer: hamza, amount: 170000, at: hoursAgo(9 * 24) },
        { buyer: bilal, amount: 178000, at: hoursAgo(7 * 24) },
        { buyer: hamza, amount: 185000, at: hoursAgo(5 * 24) },
        { buyer: bilal, amount: 192000, at: hoursAgo((3 * 24) + 2) },
      ],
      closedSale: {
        winner: bilal, finalAmount: 192000, reviewStars: 5,
        reviewComment: 'Great seller, item exactly as described. Fast communication and secure packaging!',
      },
    },
  ];

  for (const item of items) {
    const existing = await prisma.listing.findFirst({ where: { title: item.title, sellerId: item.seller.id } });
    if (existing) {
      console.log(`Skipping "${item.title}" — already exists.`);
      continue;
    }

    const listing = await prisma.listing.create({
      data: {
        listingCode: generateListingCode(),
        sellerId: item.seller.id,
        title: item.title,
        category: item.category,
        condition: item.condition,
        description: item.description,
        startPrice: item.startPrice,
        reservePrice: item.reservePrice,
        minIncrement: item.minIncrement,
        durationDays: item.durationDays,
        status: 'APPROVED',
        imageUrl: item.imageUrl,
        emoji: item.emoji,
        attributes: item.attributes,
      },
    });

    const lastBid = item.bids[item.bids.length - 1];
    const auction = await prisma.auction.create({
      data: {
        listingId: listing.id,
        sellerId: item.seller.id,
        title: item.title,
        category: item.category,
        condition: item.condition,
        description: item.description,
        imageUrl: item.imageUrl,
        emoji: item.emoji,
        attributes: item.attributes,
        startPrice: item.startPrice,
        reservePrice: item.reservePrice,
        minIncrement: item.minIncrement,
        currentBid: lastBid ? lastBid.amount : item.startPrice,
        bidCount: item.bids.length,
        status: item.status,
        startTime: item.startTime,
        endTime: item.endTime,
      },
    });

    for (const b of item.bids) {
      await prisma.bid.create({
        data: { auctionId: auction.id, buyerId: b.buyer.id, amount: b.amount, createdAt: b.at },
      });
    }

    if (item.closedSale) {
      const tx = await prisma.auctionTransaction.create({
        data: {
          auctionId: auction.id,
          winnerId: item.closedSale.winner.id,
          sellerId: item.seller.id,
          finalAmount: item.closedSale.finalAmount,
          status: 'COMPLETED',
        },
      });
      await prisma.sellerReview.create({
        data: {
          transactionId: tx.id,
          auctionId: auction.id,
          buyerId: item.closedSale.winner.id,
          sellerId: item.seller.id,
          stars: item.closedSale.reviewStars,
          comment: item.closedSale.reviewComment,
        },
      });
    }

    // Writing the row directly bypasses the approval route, which is where the
    // close job is normally scheduled — without this the auction stays ACTIVE
    // forever once its end time passes.
    if (auction.status === 'ACTIVE') {
      await scheduleAuctionLifecycle({ auctionId: auction.id, endTime: auction.endTime });
    }

    console.log(`Created "${item.title}" (${item.category}, ${item.status}) with ${item.bids.length} bids.`);
  }

  console.log('Demo auction seed complete.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    // The queue holds an open Redis connection; without closing it the script hangs.
    await auctionLifecycleQueue.close();
    await redisConnection.quit();
  });
