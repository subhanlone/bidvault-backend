import { PrismaClient, AuctionStatus, ListingStatus, UserRole, ItemCondition } from '@prisma/client';
import { hash } from '@node-rs/bcrypt';
import { assertSeedTarget, requiredPassword } from '../scripts/seed-guard.js';

assertSeedTarget('prisma:seed');

const prisma = new PrismaClient();

function addHours(date: Date, h: number): Date {
  return new Date(date.getTime() + h * 60 * 60 * 1000);
}

async function upsertUser(params: {
  email: string;
  name: string;
  role: UserRole;
  password: string;
  isEmailVerified?: boolean;
}) {
  const passwordHash = await hash(params.password, 12);
  return prisma.user.upsert({
    where: { email: params.email },
    // Deliberately empty. This branch used to rewrite `passwordHash`, so re-running the seed
    // against a database where the address already existed silently reset that account's
    // password to the seeded value. Seeding must be able to run twice without changing a
    // credential it did not create.
    update: {},
    create: {
      name: params.name,
      email: params.email,
      role: params.role,
      passwordHash,
      isEmailVerified: params.isEmailVerified ?? true,
    },
  });
}

async function main() {
  // Passwords come from the environment, with no defaults — see scripts/seed-guard.ts.
  const buyerPassword = requiredPassword('SEED_BUYER_PASSWORD');
  const sellerPassword = requiredPassword('SEED_SELLER_PASSWORD');
  const adminPassword = requiredPassword('SEED_ADMIN_PASSWORD');

  const buyer = await upsertUser({
    name: 'Sawera Noor',
    email: 'sawera@gmail.com',
    role: UserRole.BUYER,
    password: buyerPassword,
  });

  const seller = await upsertUser({
    name: 'Ahmed Raza',
    email: 'ahmed@gmail.com',
    role: UserRole.SELLER,
    password: sellerPassword,
  });

  await upsertUser({
    name: 'Admin BidVault',
    email: 'admin@bidvault.com',
    role: UserRole.ADMIN,
    password: adminPassword,
  });

  const listing = await prisma.listing.upsert({
    where: { listingCode: 'BV-2026-01001' },
    update: {},
    create: {
      listingCode: 'BV-2026-01001',
      sellerId: seller.id,
      title: 'iPhone 15 Pro Max 256GB - Natural Titanium',
      category: 'Electronics',
      condition: ItemCondition.LIKE_NEW,
      description:
        'iPhone 15 Pro Max 256GB, excellent condition, original box and accessories included.',
      startPrice: 285000,
      reservePrice: 320000,
      minIncrement: 1000,
      durationDays: 1,
      status: ListingStatus.APPROVED,
      imageUrl:
        'https://images.unsplash.com/photo-1695048133142-1a20484d2569?w=600&auto=format&fit=crop&q=80',
      emoji: '📱',
    },
  });

  const auction = await prisma.auction.upsert({
    where: { listingId: listing.id },
    update: {},
    create: {
      listingId: listing.id,
      sellerId: seller.id,
      title: listing.title,
      category: listing.category,
      condition: listing.condition,
      description: listing.description,
      imageUrl: listing.imageUrl,
      emoji: listing.emoji,
      startPrice: listing.startPrice,
      reservePrice: listing.reservePrice,
      minIncrement: listing.minIncrement,
      currentBid: 312000,
      bidCount: 1,
      startTime: addHours(new Date(), -2),
      endTime: addHours(new Date(), 4),
      status: AuctionStatus.ACTIVE,
    },
  });

  const existingBid = await prisma.bid.findFirst({
    where: { auctionId: auction.id, buyerId: buyer.id, amount: 312000 },
  });

  if (!existingBid) {
    await prisma.bid.create({
      data: {
        auctionId: auction.id,
        buyerId: buyer.id,
        amount: 312000,
      },
    });
  }

  console.log('Seed complete.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
