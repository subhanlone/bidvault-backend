/**
 * What the seller's emails tell them to do and where the money goes has to match the product.
 * My Listings and My Sales were replaced by one screen, My Items; and a payout is a ledger entry
 * added to the seller's earnings (the in-app notification already says so), not a transfer to a
 * connected account. Both emails kept the old wording after the changes that made it untrue.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mail = vi.hoisted(() => ({ send: vi.fn(() => Promise.resolve({ data: { id: 'email_test' }, error: null })) }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mail.send };
  },
}));

const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const email = await import('../src/services/email.service.js');

const buyer = { email: 'buyer@test.local', name: 'Bilal' };
const seller = { email: 'seller@test.local', name: 'Sana' };

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(() => {
  mail.send.mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

/** The HTML of the email that went to `to`. */
function htmlTo(to: string): string {
  const call = mail.send.mock.calls
    .map((c) => (c as unknown as [{ to: string | string[]; html: string }])[0])
    .find((m) => m.to === to);
  expect(call, `an email to ${to}`).toBeDefined();
  return call!.html;
}

const NO_OLD_SCREENS = /My Sales|My Listings/;

describe('the seller emails', () => {
  it('a sale that went unpaid points the seller at My Items for the next step', async () => {
    await email.sendPaymentDeadlineVoidedEmail(buyer, seller, { title: 'Vintage Lamp', finalAmount: 8_000 });

    const html = htmlTo(seller.email);
    expect(html).toMatch(/offer the item to the next-highest bidder[^<]*relist it[^<]*from My Items/);
    expect(html).not.toMatch(NO_OLD_SCREENS);
  });

  it('a paid sale tells the seller to mark it shipped from My Items', async () => {
    await email.sendPaymentCompletedEmail(buyer, seller, {
      auctionTitle: 'Vintage Lamp',
      finalAmount: 8_000,
      deliveryAddress: '123 Test Street, Karachi',
      deliveryPhone: '03001234567',
    });

    const html = htmlTo(seller.email);
    expect(html).toMatch(/mark it shipped from My Items/);
    expect(html).not.toMatch(NO_OLD_SCREENS);
  });

  it('a released payout says it was added to the seller’s earnings, not sent to an account', async () => {
    await email.sendDeliveryConfirmedEmail(seller, { auctionTitle: 'Vintage Lamp', finalAmount: 8_000, auto: false });

    const html = htmlTo(seller.email);
    expect(html).toMatch(/added to your earnings/);
    expect(html).not.toMatch(/connected account/);
  });
});
