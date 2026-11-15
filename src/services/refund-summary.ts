import type { AuctionTransaction, PaymentMethod, RefundReason, RefundedBy } from '@prisma/client';

/**
 * How a sale was paid and how it was refunded, worded for the person asking. Every reader (the
 * shared invoice, My Wins, the seller's items, admin transactions, refund notifications and
 * e-mails) goes through here, so the one rule that matters is enforced once: the seller never
 * learns where the buyer's money came from or went (no account hint, no bank reference, no
 * expected arrival). Admins see everything, because they answer buyers' questions.
 *
 * Nothing is invented for legacy rows: a sale paid before payment methods existed was a card and
 * shows as "Card" with no hint; a refund made before the refund record existed shows only its
 * amount and payment reference.
 */

export type Viewer = 'buyer' | 'seller' | 'admin';

export type PresentableSale = Pick<
  AuctionTransaction,
  | 'status' | 'finalAmount' | 'paymentReference' | 'paymentMethod' | 'paymentAccountHint' | 'bankTransferReference'
  | 'refundedAt' | 'refundReference' | 'refundReason' | 'refundedBy' | 'refundNote'
>;

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  CARD: 'Card',
  JAZZCASH: 'JazzCash',
  EASYPAISA: 'Easypaisa',
  BANK_TRANSFER: 'Bank transfer',
};

/** The buyer's words for why they were refunded (exact copy from the plan). */
export const REFUND_REASON_TEXT: Record<RefundReason, string> = {
  NOT_SHIPPED_SELLER: 'The seller could not send the item',
  NOT_SHIPPED_ADMIN: 'The item was not sent, so BidVault refunded you',
  NOT_SHIPPED_AUTO: 'The item was not sent after you reported it',
  DISPUTE_UPHELD: 'Your dispute was decided in your favour',
  LISTING_TAKEN_DOWN: 'BidVault removed this listing',
};

/** The same reasons for the seller and admins: about the buyer, not addressed to "you". */
export const REFUND_REASON_TEXT_OTHERS: Record<RefundReason, string> = {
  NOT_SHIPPED_SELLER: 'The seller could not send the item',
  NOT_SHIPPED_ADMIN: 'The item was not sent, so BidVault refunded the buyer',
  NOT_SHIPPED_AUTO: 'The item was not sent after the buyer reported it',
  DISPUTE_UPHELD: "The buyer's dispute was decided in their favour",
  LISTING_TAKEN_DOWN: 'BidVault removed this listing',
};

const SIMULATED = ' (simulated: no real money moves)';

/** Typical timing, worked out from the method rather than stored. */
export const EXPECTED_ARRIVAL: Record<PaymentMethod, string> = {
  CARD: `Usually 5–7 working days${SIMULATED}`,
  JAZZCASH: `Immediately${SIMULATED}`,
  EASYPAISA: `Immediately${SIMULATED}`,
  BANK_TRANSFER: `Usually 1–3 working days${SIMULATED}`,
};

export type PaymentInfoView = {
  method: PaymentMethod;
  methodLabel: string;
  accountHint?: string;
  bankTransferReference?: string;
};

export type RefundSummaryView = {
  amount: number;
  reason?: RefundReason;
  reasonText?: string;
  refundedBy?: RefundedBy;
  note?: string;
  refundedAt?: string;
  refundReference?: string;
  paymentReference?: string;
  paidTo?: string;
  expectedArrival?: string;
};

/** Where the money came from (and goes back to): "JazzCash 0300•••567", "Visa •••4242",
 * "Bank transfer (ref FT2611110001)"; a legacy card with no hint is just "Card". */
function paidToOf(sale: PresentableSale): string {
  const method = sale.paymentMethod ?? 'CARD';
  if (method === 'BANK_TRANSFER') {
    return sale.bankTransferReference ? `Bank transfer (ref ${sale.bankTransferReference})` : 'Bank transfer';
  }
  if (method === 'CARD') return sale.paymentAccountHint ?? 'Card';
  return sale.paymentAccountHint ? `${METHOD_LABEL[method]} ${sale.paymentAccountHint}` : METHOD_LABEL[method];
}

/** How the sale was paid, or undefined when it has not been. */
export function paymentInfo(sale: PresentableSale, viewer: Viewer): PaymentInfoView | undefined {
  if (!sale.paymentReference) return undefined;
  const method = sale.paymentMethod ?? 'CARD';
  const info: PaymentInfoView = { method, methodLabel: METHOD_LABEL[method] };
  if (viewer === 'seller') return info;
  if (sale.paymentAccountHint) info.accountHint = sale.paymentAccountHint;
  if (sale.bankTransferReference) info.bankTransferReference = sale.bankTransferReference;
  return info;
}

/** The refund explained, or undefined unless the sale is REFUNDED. */
export function refundSummary(sale: PresentableSale, viewer: Viewer): RefundSummaryView | undefined {
  if (sale.status !== 'REFUNDED') return undefined;
  const view: RefundSummaryView = { amount: sale.finalAmount };

  if (sale.refundReason) {
    view.reason = sale.refundReason;
    view.reasonText = (viewer === 'buyer' ? REFUND_REASON_TEXT : REFUND_REASON_TEXT_OTHERS)[sale.refundReason];
  }
  if (sale.refundedBy) view.refundedBy = sale.refundedBy;
  if (sale.refundNote) view.note = sale.refundNote;
  if (sale.refundedAt) view.refundedAt = sale.refundedAt.toISOString();
  if (sale.refundReference) view.refundReference = sale.refundReference;
  if (sale.paymentReference) view.paymentReference = sale.paymentReference;

  // Where the money went and when it lands: the buyer's business, and admins', never the seller's.
  // Only for a refund that has its record; a legacy refund keeps to what is actually known.
  if (viewer !== 'seller' && sale.refundReason) {
    view.paidTo = paidToOf(sale);
    view.expectedArrival = EXPECTED_ARRIVAL[sale.paymentMethod ?? 'CARD'];
  }
  return view;
}
