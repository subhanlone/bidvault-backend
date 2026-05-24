import { PrismaClient, AuctionStatus, ListingStatus, UserRole, ItemCondition } from '@prisma/client';
import bcrypt from 'bcryptjs';

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
  const passwordHash = await bcrypt.hash(params.password, 10);
  return prisma.user.upsert({
    where: { email: params.email },
    update: {
      name: params.name,
      role: params.role,
      passwordHash,
      isEmailVerified: params.isEmailVerified ?? true,
    },
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
  const buyer = await upsertUser({
    name: 'Sawera Noor',
    email: 'sawera@gmail.com',
    role: UserRole.BUYER,
    password: 'password123',
  });

  const seller = await upsertUser({
    name: 'Ahmed Raza',
    email: 'ahmed@gmail.com',
    role: UserRole.SELLER,
    password: 'password123',
  });

  await upsertUser({
    name: 'Admin BidVault',
    email: 'admin@bidvault.com',
    role: UserRole.ADMIN,
    password: 'admin123',
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
      startAt: addHours(new Date(), -2),
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
