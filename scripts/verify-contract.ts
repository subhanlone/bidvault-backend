// Checks the published contract against a *running* server, with real data.
//
//   npm run api:verify                          -> production
//   npm run api:verify http://localhost:4000    -> local
//
// This overlaps the test suite deliberately but is not redundant with it. The suite runs
// every route against a database it seeded itself, so it proves the code matches the
// contract. This runs against rows nobody wrote for the occasion — a column that went null
// years ago, a listing from before a field existed — and proves the *data* does too. Test
// fixtures cannot fail that way, which is exactly why they are not enough.
//
// Read-only by construction: every check below is a GET. The only writes are the login that
// obtains a token and the logout that revokes it, which is the footprint of a normal user
// session and leaves nothing behind. Mutating routes are not checked here at all — pointing
// them at production would create real listings, bids and payments. Their response shapes
// are the suite's job.
//
// Credentials are optional and come from the environment. Without them the authenticated
// half is skipped and this behaves as it always did:
//
//   VERIFY_BUYER_EMAIL / VERIFY_BUYER_PASSWORD
//   VERIFY_SELLER_EMAIL / VERIFY_SELLER_PASSWORD
//   VERIFY_ADMIN_EMAIL / VERIFY_ADMIN_PASSWORD
import { responseSchemaFor } from '../src/middleware/response-contract.js';

const base = (process.argv[2] ?? 'https://bidvault-backend-production.up.railway.app').replace(/\/$/, '');
const isProduction = base.includes('railway.app') || base.includes('bidvault.tech');

type Role = 'buyer' | 'seller' | 'admin';

let failures = 0;
let checked = 0;
const skipped: string[] = [];

function fail(label: string, detail: string) {
  failures++;
  console.log(`FAIL  ${label}`);
  for (const line of detail.split('\n')) console.log(`      ${line}`);
}

/**
 * Fetches `path`, then parses the whole envelope through the schema the contract publishes
 * for it — the same object the response-contract middleware uses, via responseSchemaFor.
 */
async function check(
  template: string,
  opts: { params?: Record<string, string>; token?: string; note?: string } = {},
): Promise<unknown> {
  const { params = {}, token, note } = opts;

  // The template is the key the contract uses; the request needs ids substituted in. Looking
  // the schema up by the concrete path would find nothing for every parameterised route.
  const path = Object.entries(params).reduce(
    (acc, [k, v]) => acc.replace(`{${k}}`, encodeURIComponent(v)),
    template,
  );
  const label = `GET ${path}${note ? ` (${note})` : ''}`;

  const schema = responseSchemaFor('GET', template);
  if (!schema) {
    fail(label, `no schema published for GET ${template} — is it in document.ts?`);
    return undefined;
  }

  let body: unknown;
  try {
    const res = await fetch(`${base}/api/v1${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    body = await res.json();
    if (res.status !== 200) {
      fail(label, `expected 200, got ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      return undefined;
    }
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
    return undefined;
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    fail(
      label,
      parsed.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n'),
    );
    return undefined;
  }

  checked++;
  const data = (parsed.data as { data: unknown }).data;
  const count = Array.isArray(data) ? ` [${data.length}]` : '';
  console.log(`ok    ${label}${count}`);
  return data;
}

/** Logs in and returns both tokens, or null when the role has no credentials configured. */
async function signIn(role: Role): Promise<{ access: string; refresh: string } | null> {
  const email = process.env[`VERIFY_${role.toUpperCase()}_EMAIL`];
  const password = process.env[`VERIFY_${role.toUpperCase()}_PASSWORD`];
  if (!email || !password) {
    skipped.push(role);
    return null;
  }

  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { data?: { accessToken: string; refreshToken: string } };
  if (res.status !== 200 || !body.data?.accessToken) {
    fail(`login as ${role}`, `status ${res.status} — check VERIFY_${role.toUpperCase()}_*`);
    return null;
  }
  return { access: body.data.accessToken, refresh: body.data.refreshToken };
}

/** Revokes the refresh token this run created, so it leaves nothing behind. */
async function signOut(refresh: string): Promise<void> {
  await fetch(`${base}/api/v1/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: refresh }),
  }).catch(() => undefined);
}

console.log(`${base}${isProduction ? '  (production — read-only)' : ''}\n`);

// ---- public ----------------------------------------------------------------------------

await check('/health');
await check('/stats');
await check('/settings/public');
const auctions = (await check('/auctions', { note: 'every auction in the list' })) as
  | Array<Record<string, unknown>>
  | undefined;

// Path parameters come from what the server just returned, so this needs no fixture ids and
// stays correct as the data changes.
const sample = auctions?.[0];
if (sample) {
  await check('/auctions/{auctionId}', { params: { auctionId: sample.auctionId as string } });
  await check('/auctions/{auctionId}/bids', { params: { auctionId: sample.auctionId as string } });
  await check('/reviews/seller/{sellerId}', { params: { sellerId: sample.sellerId as string } });
} else {
  skipped.push('per-auction routes (no auctions returned)');
}

// ---- authenticated ---------------------------------------------------------------------

const buyer = await signIn('buyer');
if (buyer) {
  await check('/auth/me', { token: buyer.access });
  await check('/auth/me/preferences', { token: buyer.access });
  await check('/watchlist', { token: buyer.access });
  await check('/notifications', { token: buyer.access });
  await check('/payments/my-wins', { token: buyer.access });
  await check('/auctions/mine/bids', { token: buyer.access });
  await signOut(buyer.refresh);
}

const seller = await signIn('seller');
if (seller) {
  await check('/listings/mine', { token: seller.access });
  await check('/payments/seller-stats', { token: seller.access });
  await signOut(seller.refresh);
}

const admin = await signIn('admin');
if (admin) {
  await check('/listings/pending', { token: admin.access });
  await check('/settings', { token: admin.access });
  await check('/admin/analytics', { token: admin.access });
  await signOut(admin.refresh);
}

// ---- invariants ------------------------------------------------------------------------
//
// Statements about the API that no schema can express, because they are domain rules rather
// than shapes. A seller's reserve is secret; the schema cannot say "and never present".

if (auctions) {
  const leaking = auctions.filter((a) => 'reservePrice' in a);
  if (leaking.length > 0) {
    fail('invariant: reservePrice is never public', `${leaking.length} auction(s) expose it`);
  } else {
    console.log(`ok    invariant: no auction exposes reservePrice [${auctions.length} checked]`);
    checked++;
  }
}

// ---- report ------------------------------------------------------------------------------

console.log();
if (skipped.length) {
  console.log(`skipped: ${skipped.join(', ')}`);
  console.log('  set VERIFY_<ROLE>_EMAIL / VERIFY_<ROLE>_PASSWORD to include the authenticated routes\n');
}
console.log(
  failures === 0
    ? `contract matches the running API — ${checked} checks passed`
    : `${failures} mismatch(es) across ${checked + failures} checks`,
);
// exitCode rather than exit(): calling process.exit() while fetch's keep-alive sockets are
// still closing aborts Node mid-teardown on Windows with a libuv assertion, and the run dies
// partway through its own report. Setting the code lets the loop drain and exit cleanly.
process.exitCode = failures === 0 ? 0 : 1;
