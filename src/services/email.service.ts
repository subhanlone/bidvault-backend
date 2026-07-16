import { Resend } from 'resend';
import { env } from '../config/env.js';
import { getPlatformSettings } from './settings.service.js';

const client = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
const FROM = env.RESEND_FROM_EMAIL ?? 'BidVault <onboarding@resend.dev>';

async function send(to: string | string[], subject: string, html: string): Promise<void> {
  if (!client) {
    console.warn(`[email] RESEND_API_KEY not set — skipped: "${subject}"`);
    return;
  }
  const { error } = await client.emails.send({ from: FROM, to, subject, html });
  if (error) console.error(`[email] send failed for "${subject}":`, error.message);
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
  <title>${title}</title>
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
          <p style="margin:0;color:#0b1f3a;font-size:36px;font-weight:800;letter-spacing:8px;">${code}</p>
          <p style="margin:6px 0 0;color:#94a3b8;font-size:11px;">Expires in 60 seconds</p>
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
            <td style="color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;width:40%;">${label}</td>
            <td style="color:#1e293b;font-size:13px;font-weight:600;text-align:right;">${value}</td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function h1(text: string): string {
  return `<h1 style="margin:0 0 8px;color:#0b1f3a;font-size:22px;font-weight:800;">${text}</h1>`;
}

function p(text: string): string {
  return `<p style="margin:0 0 16px;color:#475569;font-size:14px;line-height:1.6;">${text}</p>`;
}

function badge(text: string, color = '#2563eb'): string {
  return `<span style="display:inline-block;background-color:${color};color:#ffffff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:4px;letter-spacing:0.3px;">${text}</span>`;
}

function ctaButton(label: string, href: string): string {
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
      <tr>
        <td>
          <a href="${href}" style="display:inline-block;background-color:#2563eb;color:#ffffff;font-size:13px;font-weight:700;padding:12px 24px;border-radius:6px;text-decoration:none;">${label}</a>
        </td>
      </tr>
    </table>`;
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
    ${p(`Hi ${to.name}, your password has been successfully updated. All active sessions have been logged out.`)}
    ${p('If you did not make this change, contact support immediately.')}
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
    ${p(`Hi ${to.name}, great news — your listing has been approved and your auction is now scheduled.`)}
    ${divider()}
    <table width="100%" cellpadding="0" cellspacing="0">
      ${infoRow('Listing', listing.title)}
      ${infoRow('Reference', listing.listingCode)}
      ${infoRow('Status', 'Approved')}
    </table>
    ${divider()}
    ${p('Bidders will be able to place bids once your auction goes live at the scheduled start time.')}
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

export async function sendAuctionStartedEmail(
  to: { email: string; name: string },
  auction: { title: string; auctionId: string },
): Promise<void> {
  if (!(await alertsEnabled())) return;
  await send(to.email, `Your auction is now live — "${auction.title}"`, base(
    'Auction live',
    `
    ${h1('Your auction is live!')}
    ${p(`Hi ${to.name}, your auction has started and is now accepting bids.`)}
    ${divider()}
    <table width="100%" cellpadding="0" cellspacing="0">
      ${infoRow('Item', auction.title)}
      ${infoRow('Status', 'Live')}
      ${infoRow('Auction ID', auction.auctionId.slice(0, 8).toUpperCase())}
    </table>
    ${divider()}
    ${p('Log in to your seller dashboard to monitor bids in real time.')}
    `,
  ));
}

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
      ${p('Log in to your BidVault account and go to <strong>My Wins</strong> to complete payment.')}
    `;
    await send(winner.email, `You won "${auction.title}"!`, base('You won!', winnerBody));
  }
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
