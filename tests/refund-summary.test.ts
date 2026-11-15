/**
 * The one presenter every reader uses for how a sale was paid and how it was refunded, per viewer.
 * Pure: rows are plain objects. The seller never sees where the money went (no account hint, no
 * bank reference, no expected arrival); legacy rows render without invented data.
 */
import { describe, expect, it } from 'vitest';
import { paymentInfo, refundSummary, type PresentableSale } from '../src/services/refund-summary.js';

const base: PresentableSale = {
  status: 'COMPLETED',
  finalAmount: 30_000,
  paymentReference: 'PAY-abc123',
  paymentMethod: 'JAZZCASH',
  paymentAccountHint: '0300•••567',
  bankTransferReference: null,
  refundedAt: null,
  refundReference: null,
  refundReason: null,
  refundedBy: null,
  refundNote: null,
};

const refunded: PresentableSale = {
  ...base,
  status: 'REFUNDED',
  refundedAt: new Date('2026-11-15T10:00:00.000Z'),
  refundReference: 'RFD-abcdefghijkl',
  refundReason: 'NOT_SHIPPED_SELLER',
  refundedBy: 'SELLER',
  refundNote: 'Item broke in storage',
};

describe('paymentInfo', () => {
  it('is undefined for an unpaid sale', () => {
    expect(paymentInfo({ ...base, status: 'PENDING', paymentReference: null, paymentMethod: null, paymentAccountHint: null }, 'buyer')).toBeUndefined();
  });

  it('gives the buyer and admin the method and hint', () => {
    expect(paymentInfo(base, 'buyer')).toEqual({ method: 'JAZZCASH', methodLabel: 'JazzCash', accountHint: '0300•••567' });
    expect(paymentInfo(base, 'admin')).toEqual({ method: 'JAZZCASH', methodLabel: 'JazzCash', accountHint: '0300•••567' });
  });

  it('gives the seller the method name only', () => {
    const bank = { ...base, paymentMethod: 'BANK_TRANSFER' as const, paymentAccountHint: null, bankTransferReference: 'FT2611110001' };
    expect(paymentInfo(base, 'seller')).toEqual({ method: 'JAZZCASH', methodLabel: 'JazzCash' });
    expect(paymentInfo(bank, 'seller')).toEqual({ method: 'BANK_TRANSFER', methodLabel: 'Bank transfer' });
    expect(paymentInfo(bank, 'buyer')).toEqual({ method: 'BANK_TRANSFER', methodLabel: 'Bank transfer', bankTransferReference: 'FT2611110001' });
  });

  it('shows a legacy paid sale (no method) as Card with no hint', () => {
    expect(paymentInfo({ ...base, paymentMethod: null, paymentAccountHint: null }, 'buyer')).toEqual({ method: 'CARD', methodLabel: 'Card' });
  });
});

describe('refundSummary', () => {
  it('is undefined unless the sale is refunded', () => {
    expect(refundSummary(base, 'buyer')).toBeUndefined();
  });

  it('tells the buyer where the money went, why, who, when, the references and the arrival', () => {
    expect(refundSummary(refunded, 'buyer')).toEqual({
      amount: 30_000,
      reason: 'NOT_SHIPPED_SELLER',
      reasonText: 'The seller could not send the item',
      refundedBy: 'SELLER',
      note: 'Item broke in storage',
      refundedAt: '2026-11-15T10:00:00.000Z',
      refundReference: 'RFD-abcdefghijkl',
      paymentReference: 'PAY-abc123',
      paidTo: 'JazzCash 0300•••567',
      expectedArrival: 'Immediately (simulated: no real money moves)',
    });
  });

  it('never tells the seller where the money went', () => {
    const v = refundSummary(refunded, 'seller');
    expect(v).toBeDefined();
    expect(v).not.toHaveProperty('paidTo');
    expect(v).not.toHaveProperty('expectedArrival');
    expect(JSON.stringify(v)).not.toContain('•••');
    expect(v).toMatchObject({ amount: 30_000, reasonText: 'The seller could not send the item', refundedBy: 'SELLER', refundReference: 'RFD-abcdefghijkl' });
  });

  it('names a card, a bank transfer and a legacy card refund', () => {
    expect(refundSummary({ ...refunded, paymentMethod: 'CARD', paymentAccountHint: 'Visa •••4242' }, 'buyer'))
      .toMatchObject({ paidTo: 'Visa •••4242', expectedArrival: 'Usually 5–7 working days (simulated: no real money moves)' });
    expect(refundSummary({ ...refunded, paymentMethod: 'BANK_TRANSFER', paymentAccountHint: null, bankTransferReference: 'FT2611110001' }, 'admin'))
      .toMatchObject({ paidTo: 'Bank transfer (ref FT2611110001)', expectedArrival: 'Usually 1–3 working days (simulated: no real money moves)' });
    expect(refundSummary({ ...refunded, paymentMethod: null, paymentAccountHint: null }, 'buyer'))
      .toMatchObject({ paidTo: 'Card' });
  });

  it('a refund made before the record existed gives the amount and payment reference only', () => {
    const legacy: PresentableSale = { ...base, status: 'REFUNDED', paymentMethod: null, paymentAccountHint: null };
    expect(refundSummary(legacy, 'buyer')).toEqual({ amount: 30_000, paymentReference: 'PAY-abc123' });
    expect(refundSummary(legacy, 'seller')).toEqual({ amount: 30_000, paymentReference: 'PAY-abc123' });
  });

  it('words the reason for the seller and admin in the third person, not to "you"', () => {
    const dispute = { ...refunded, refundReason: 'DISPUTE_UPHELD' as const, refundedBy: 'ADMIN' as const, refundNote: 'Photos show damage' };
    expect(refundSummary(dispute, 'buyer')).toMatchObject({ reasonText: 'Your dispute was decided in your favour' });
    expect(refundSummary(dispute, 'seller')).toMatchObject({ reasonText: "The buyer's dispute was decided in their favour" });
    expect(refundSummary(dispute, 'admin')).toMatchObject({ reasonText: "The buyer's dispute was decided in their favour" });
  });

  it('leaves out the note of an automatic refund', () => {
    const auto = { ...refunded, refundReason: 'NOT_SHIPPED_AUTO' as const, refundedBy: 'SYSTEM' as const, refundNote: null };
    const v = refundSummary(auto, 'buyer');
    expect(v).not.toHaveProperty('note');
    expect(v).toMatchObject({ reasonText: 'The item was not sent after you reported it', refundedBy: 'SYSTEM' });
  });
});
