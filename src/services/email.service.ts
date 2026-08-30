import { Resend } from 'resend';
import { env } from '../config/env.js';
import { OTP_EXPIRY_SECONDS } from '../config/otp.js';
import { getPlatformSettings } from './settings.service.js';

const client = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
const FROM = env.RESEND_FROM_EMAIL ?? 'BidVault <onboarding@resend.dev>';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);
}

function sanitizeSubject(value: string): string {
  // Subjects are mail headers, not HTML: remove CR/LF and control characters instead of
  // inserting HTML entities that recipients would see literally.
  return value
    .replace(/[\r\n]+/g, ' ')
    .split('')
    .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    .join('')
    .trim();
}

async function send(to: string | string[], subject: string, html: string): Promise<void> {
  const safeSubject = sanitizeSubject(subject);
  if (!client) {
    console.warn(`[email] RESEND_API_KEY not set — skipped: "${safeSubject}"`);
    return;
  }
  try {
    const { error } = await client.emails.send({ from: FROM, to, subject: safeSubject, html });
    if (error) console.error(`[email] send failed for "${safeSubject}":`, error.message);
  } catch (err) {
    // The SDK reports API-level problems via `error` above, but a transport failure — DNS,
    // timeout, connection reset — rejects instead. Callers dispatch these without awaiting,
    // so an escaping rejection would be unhandled and take the process down.
    console.error(`[email] transport error for "${safeSubject}":`, err instanceof Error ? err.message : err);
  }
}

/**
 * Send without making the caller wait.
 *
 * Every send used to be awaited inside the request that triggered it, so the user paid the
 * full Resend round-trip before getting a response: measured at 5023 ms for register and
 * 3281 ms for placing a bid — on the most latency-sensitive action in the product, where in
 * the closing seconds of a contested auction that delay decides who wins. The Stripe webhook
 * had the same problem, where a slow send risks exceeding Stripe's timeout and triggering
 * retries of an already-processed payment.
 *
 * Delivery is best-effort and always was: `send` swallows failures and only logs them, so
 * awaiting never gave the caller anything to act on. This makes that explicit rather than
 * paying for it. `context` identifies the site in logs, since there is no longer a request
 * to correlate the failure with.
 */
export function dispatchEmail(task: Promise<unknown>, context: string): void {
  void task.catch((err: unknown) => {
    console.error(`[email] background send failed (${context}):`, err instanceof Error ? err.message : err);
  });
}

// Activity/alert emails (bid, listing status, auction, payment) honour the platform-wide
// email toggle. Security emails (welcome/verify, password reset) always send and skip this.
async function alertsEnabled(): Promise<boolean> {
  try {
    return (await getPlatformSettings()).emailNotifsEnabled;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function base(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <!-- Header -->
        <tr>
          <td style="background-color:#0b1f3a;padding:24px 32px;border-radius:8px 8px 0 0;">
            <p style="margin:0;color:#ffffff;font-size:20px;font-weight:800;letter-spacing:-0.5px;">BidVault</p>
            <p style="margin:4px 0 0;color:rgba(255,255,255,0.45);font-size:12px;">Live Auction Platform</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="background-color:#ffffff;padding:32px;border-radius:0 0 8px 8px;">
            ${body}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:20px 0;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:11px;">
              &copy; 2025 BidVault &nbsp;&middot;&nbsp; You received this because you have an account with us.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function otpBlock(code: string): string {
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td align="center" style="background-color:#f8fafc;border:2px dashed #e2e8f0;border-radius:8px;padding:20px;">
          <p style="margin:0 0 4px;color:#64748b;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;">Your Code</p>
          <p style="margin:0;color:#0b1f3a;font-size:36px;font-weight:800;letter-spacing:8px;">${escapeHtml(code)}</p>
          <p style="margin:6px 0 0;color:#94a3b8;font-size:11px;">Expires in ${OTP_EXPIRY_SECONDS} seconds</p>
        </td>
      </tr>
    </table>`;
}

function infoRow(label: string, value: string): string {
  return `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;width:40%;">${escapeHtml(label)}</td>
            <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right;">${escapeHtml(value)}</td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function h1(text: string): string {
  return `<h1 style="margin:0 0 8px;color:#0b1f3a;font-size:22px;font-weight:800;">${escapeHtml(text)}</h1>`;
}

function p(text: string): string {
  return `<p style="margin:0 0 16px;color:#475569;font-size:14px;line-height:1.6;">${escapeHtml(text)}</p>`;
}



function divider(): string {
  return `<hr style="border:none;border-top:1px solid #f1f5f9;margin:20px 0;">`;
}

// ---------------------------------------------------------------------------
// Auth emails
// ---------------------------------------------------------------------------

export async function sendWelcomeEmail(to: { email: string; name: string }, code: string): Promise<void> {
  await send(to.email, 'Welcome to BidVault — verify your email', base(
    'Verify your email',
    `
    ${h1(`Welcome, ${to.name}!`)}
    ${p('Thanks for signing up. Verify your email address with the code below to activate your account.')}
    ${otpBlock(code)}
    ${p('If you didn\'t create an account, you can safely ignore this email.')}
    `,
  ));
}

export async function sendEmailVerifiedEmail(to: { email: string; name: string }): Promise<void> {
  await send(to.email, 'Email verified — you\'re all set', base(
    'Email verified',
    `
    ${h1('Email verified!')}
    ${p(`Hi ${to.name}, your email address has been successfully verified. Your BidVault account is now fully active.`)}
    ${p('You can now browse live auctions, place bids, and track your wins.')}
    `,
  ));
}

export async function sendPasswordResetEmail(to: { email: string; name: string }, code: string): Promise<void> {
  await send(to.email, 'Reset your BidVault password', base(
    'Password reset',
    `
    ${h1('Reset your password')}
    ${p(`Hi ${to.name}, we received a request to reset your password. Use the code below to proceed.`)}
    ${otpBlock(code)}
    ${p('If you didn\'t request a password reset, please ignore this email. Your password will remain unchanged.')}
    `,
  ));
}

export async function sendPasswordResetCompletedEmail(to: { email: string; name: string }): Promise<void> {
  await send(to.email, 'Your BidVault password has been changed', base(
    'Password changed',
    `
    ${h1('Password changed')}
    ${p(`Hi ${to.name}, your password has been successfully updated. Other sessions can no longer renew. An access token already in use may remain active for up to 15 minutes.`)}
    ${p('If you did not make this change, contact support immediately.')}
    `,
  ));
}

// BV-018: sent to the address the account had *before* it was anonymised -- once the route
// clears User.email there is nowhere left to deliver this, so it has to go out first.
export async function sendAccountDeletedEmail(to: { email: string; name: string }): Promise<void> {
  await send(to.email, 'Your BidVault account has been deleted', base(
    'Account deleted',
    `
    ${h1('Account deleted')}
    ${p(`Hi ${to.name}, your BidVault account has been deleted. Your name and email have been removed; bid and transaction records are kept as required for dispute resolution and legal compliance, but are no longer linked to an identifiable account.`)}
    ${p('If you did not request this, contact support immediately.')}
    `,
  ));
}

// BV-031: a revoked refresh token being presented again means two holders came from the same
// token family -- the signature the rotation machinery exists to catch. Revoking every
// session is the containment step; this is the notification, so the account owner learns
// about it instead of the incident going silent the way a bare 401 would leave it.
export async function sendSessionsRevokedSecurityAlertEmail(to: { email: string; name: string }): Promise<void> {
  await send(to.email, 'Security alert: all BidVault sessions were signed out', base(
    'Security alert',
    `
    ${h1('All sessions signed out')}
    ${p(`Hi ${to.name}, BidVault detected a sign-in token being used a second time after it had already been replaced. As a precaution, every session on your account has been signed out.`)}
    ${p('If this was you on another device, just sign in again. If it was not, change your password immediately and review your account activity.')}
    `,
  ));
}

export async function sendVerificationResentEmail(to: { email: string; name: string }, code: string): Promise<void> {
  await send(to.email, 'New verification code for BidVault', base(
    'New verification code',
    `
    ${h1('New verification code')}
    ${p(`Hi ${to.name}, here's your new email verification code. Your previous code has been invalidated.`)}
    ${otpBlock(code)}
    ${p('If you didn\'t request this, someone may have entered your email. You can ignore this safely.')}
    `,
  ));
}

// ---------------------------------------------------------------------------
// Listing emails
// ---------------------------------------------------------------------------

export async function sendListingSubmittedEmail(
  to: { email: string; name: string },
  listing: { title: string; listingCode: string },
): Promise<void> {
  if (!(await alertsEnabled())) return;
  await send(to.email, `Listing received — "${listing.title}"`, base(
    'Listing received',
    `
    ${h1('Listing received')}
    ${p(`Hi ${to.name}, we've received your listing and it's now under admin review.`)}
    ${divider()}
    <table width="100%" cellpadding="0" cellspacing="0">
      ${infoRow('Listing', listing.title)}
      ${infoRow('Reference', listing.listingCode)}
      ${infoRow('Status', 'Pending Review')}
    </table>
    ${divider()}
    ${p('You\'ll receive an email once your listing is reviewed, typically within 24–48 hours.')}
    `,
  ));
}

export async function sendListingApprovedEmail(
  to: { email: string; name: string },
  listing: { title: string; listingCode: string },
): Promise<void> {
  if (!(await alertsEnabled())) return;
  await send(to.email, `Your listing has been approved — "${listing.title}"`, base(
    'Listing approved',
    `
    ${h1('Listing approved!')}
    ${p(`Hi ${to.name}, great news — your listing has been approved and your auction is now live.`)}
    ${divider()}
    <table width="100%" cellpadding="0" cellspacing="0">
      ${infoRow('Listing', listing.title)}
      ${infoRow('Reference', listing.listingCode)}
      ${infoRow('Status', 'Live — accepting bids')}
    </table>
    ${divider()}
    ${p('Bidders can place bids right now. Approval starts the auction immediately — there is no separate start time to wait for.')}
    `,
  ));
}

export async function sendListingRejectedEmail(
  to: { email: string; name: string },
  listing: { title: string; reason: string },
): Promise<void> {
  if (!(await alertsEnabled())) return;
  await send(to.email, `Update on your listing — "${listing.title}"`, base(
    'Listing update',
    `
    ${h1('Listing not approved')}
    ${p(`Hi ${to.name}, unfortunately your listing was not approved after admin review.`)}
    ${divider()}
    <table width="100%" cellpadding="0" cellspacing="0">
      ${infoRow('Listing', listing.title)}
      ${infoRow('Status', 'Rejected')}
      ${infoRow('Reason', listing.reason)}
    </table>
    ${divider()}
    ${p('You\'re welcome to make changes and submit a new listing that meets our guidelines.')}
    `,
  ));
}

// ---------------------------------------------------------------------------
// Auction emails
// ---------------------------------------------------------------------------

export async function sendAuctionEndedEmail(
  seller: { email: string; name: string },
  auction: { title: string; finalBid: number; bidCount: number },
  winner: { email: string; name: string; amount: number } | null,
  notifyWinner = true,
): Promise<void> {
  if (!(await alertsEnabled())) return;
  const pkr = (n: number) => `PKR ${n.toLocaleString()}`;

  // Email to seller
  const sellerBody = winner
    ? `
      ${h1('Your auction has ended')}
      ${p(`Hi ${seller.name}, your auction has closed with a winning bid.`)}
      ${divider()}
      <table width="100%" cellpadding="0" cellspacing="0">
        ${infoRow('Item', auction.title)}
        ${infoRow('Final bid', pkr(winner.amount))}
        ${infoRow('Total bids', String(auction.bidCount))}
        ${infoRow('Winner', winner.name)}
      </table>
      ${divider()}
      ${p('The winner will complete their payment shortly. You\'ll be notified once payment is received.')}
    `
    : `
      ${h1('Your auction has ended')}
      ${p(`Hi ${seller.name}, your auction has closed without any bids.`)}
      ${divider()}
      <table width="100%" cellpadding="0" cellspacing="0">
        ${infoRow('Item', auction.title)}
        ${infoRow('Final bid', pkr(auction.finalBid))}
        ${infoRow('Total bids', String(auction.bidCount))}
        ${infoRow('Result', 'No bids received')}
      </table>
      ${divider()}
      ${p('You can submit a new listing to auction this item again.')}
    `;

  await send(seller.email, `Auction ended — "${auction.title}"`, base('Auction ended', sellerBody));

  // Email to winner (if any, and if they haven't opted out of win notifications)
  if (winner && notifyWinner) {
    const winnerBody = `
      ${h1('Congratulations — you won!')}
      ${p(`Hi ${winner.name}, you placed the winning bid on this auction. Complete your payment to claim the item.`)}
      ${divider()}
      <table width="100%" cellpadding="0" cellspacing="0">
        ${infoRow('Item', auction.title)}
        ${infoRow('Your winning bid', pkr(winner.amount))}
      </table>
      ${divider()}
      ${p('Log in to your BidVault account and go to My Wins to complete payment.')}
    `;
    await send(winner.email, `You won "${auction.title}"!`, base('You won!', winnerBody));
  }
}

/**
 * Sent instead of sendAuctionEndedEmail when an auction closed below its reserve.
 *
 * Both sides need telling explicitly: the seller so they know it did not sell, and the top
 * bidder so they are not left waiting for an invoice that will never arrive. The bidder's
 * mail is not gated on notifyWins — it is the correction of an expectation, not a win alert.
 */
export async function sendReserveNotMetEmail(
  seller: { email: string; name: string },
  auction: { title: string; reservePrice: number; bidCount: number },
  topBidder: { email: string; name: string; amount: number },
): Promise<void> {
  if (!(await alertsEnabled())) return;
  const pkr = (n: number) => `PKR ${n.toLocaleString()}`;
  const shortfall = auction.reservePrice - topBidder.amount;

  const sellerBody = `
    ${h1('Your auction ended below its reserve')}
    ${p(`Hi ${seller.name}, bidding closed under the reserve price you set, so the item was not sold.`)}
    ${divider()}
    <table width="100%" cellpadding="0" cellspacing="0">
      ${infoRow('Item', auction.title)}
      ${infoRow('Your reserve', pkr(auction.reservePrice))}
      ${infoRow('Highest bid', pkr(topBidder.amount))}
      ${infoRow('Short by', pkr(shortfall))}
      ${infoRow('Total bids', String(auction.bidCount))}
      ${infoRow('Result', 'Not sold — reserve not met')}
    </table>
    ${divider()}
    ${p('You keep the item and no sale was recorded. You can list it again, and lowering the reserve may help it sell.')}
  `;
  await send(
    seller.email,
    `Not sold — "${auction.title}" ended below reserve`,
    base('Reserve not met', sellerBody),
  );

  const bidderBody = `
    ${h1('The reserve price was not met')}
    ${p(`Hi ${topBidder.name}, you were the highest bidder on this auction, but the seller had set a reserve price that bidding did not reach — so the item was not sold.`)}
    ${divider()}
    <table width="100%" cellpadding="0" cellspacing="0">
      ${infoRow('Item', auction.title)}
      ${infoRow('Your highest bid', pkr(topBidder.amount))}
      ${infoRow('Result', 'Not sold — reserve not met')}
    </table>
    ${divider()}
    ${p('No payment is due and nothing has been charged. Browse BidVault for similar items still open for bidding.')}
  `;
  await send(
    topBidder.email,
    `Reserve not met — "${auction.title}"`,
    base('Reserve not met', bidderBody),
  );
}

export async function sendBidPlacedEmail(
  to: { email: string; name: string },
  bid: { title: string; amount: number; auctionId: string },
): Promise<void> {
  if (!(await alertsEnabled())) return;
  const pkr = (n: number) => `PKR ${n.toLocaleString()}`;
  await send(to.email, `Bid confirmed — ${pkr(bid.amount)} on "${bid.title}"`, base(
    'Bid confirmed',
    `
    ${h1('Bid confirmed')}
    ${p(`Hi ${to.name}, your bid has been placed successfully. You are currently the highest bidder.`)}
    ${divider()}
    <table width="100%" cellpadding="0" cellspacing="0">
      ${infoRow('Item', bid.title)}
      ${infoRow('Your bid', pkr(bid.amount))}
    </table>
    ${divider()}
    ${p('We\'ll notify you if you get outbid. Log in to the live auction to monitor activity.')}
    `,
  ));
}

// ---------------------------------------------------------------------------
// Payment emails
// ---------------------------------------------------------------------------

export async function sendPaymentCompletedEmail(
  winner: { email: string; name: string },
  seller: { email: string; name: string },
  details: { auctionTitle: string; finalAmount: number },
): Promise<void> {
  if (!(await alertsEnabled())) return;
  const pkr = (n: number) => `PKR ${n.toLocaleString()}`;

  const winnerBody = `
    ${h1('Payment confirmed')}
    ${p(`Hi ${winner.name}, your payment has been received. The seller will now arrange delivery.`)}
    ${divider()}
    <table width="100%" cellpadding="0" cellspacing="0">
      ${infoRow('Item', details.auctionTitle)}
      ${infoRow('Amount paid', pkr(details.finalAmount))}
      ${infoRow('Seller', seller.name)}
    </table>
    ${divider()}
    ${p('Thank you for using BidVault. Keep an eye on your email for delivery updates from the seller.')}
  `;

  const sellerBody = `
    ${h1('Payment received')}
    ${p(`Hi ${seller.name}, the buyer has completed payment for your item.`)}
    ${divider()}
    <table width="100%" cellpadding="0" cellspacing="0">
      ${infoRow('Item', details.auctionTitle)}
      ${infoRow('Amount', pkr(details.finalAmount))}
      ${infoRow('Buyer', winner.name)}
    </table>
    ${divider()}
    ${p('Please arrange delivery or handover with the buyer at your earliest convenience.')}
  `;

  await Promise.all([
    send(winner.email, `Payment confirmed — "${details.auctionTitle}"`, base('Payment confirmed', winnerBody)),
    send(seller.email, `Payment received for "${details.auctionTitle}"`, base('Payment received', sellerBody)),
  ]);
}
