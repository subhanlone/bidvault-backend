// Checks the published contract against a running API.
//
// A generated type is only worth having if it is true. This parses real responses through
// the same schemas openapi.json (and therefore the frontend's api.d.ts) is built from, so a
// contract that has drifted from the server fails here rather than in a screen.
//
//   npm run api:verify                      -> production
//   npm run api:verify http://localhost:4000 -> local
import { z } from 'zod';
import * as S from '../src/openapi/schemas.js';

const base = (process.argv[2] ?? 'https://bidvault-backend-production.up.railway.app').replace(/\/$/, '');

type Check = { path: string; schema: z.ZodType; note?: string };

// Only unauthenticated routes: this runs without credentials on purpose.
const checks: Check[] = [
  { path: '/api/v1/health', schema: S.HealthDto },
  { path: '/api/v1/stats', schema: S.PlatformStatsDto },
  { path: '/api/v1/settings/public', schema: S.PublicSettingsDto },
  { path: '/api/v1/auctions', schema: z.array(S.AuctionDto), note: 'every auction in the list' },
];

const envelope = z.object({ success: z.literal(true), data: z.unknown() });

let failures = 0;

for (const { path, schema, note } of checks) {
  const label = `${path}${note ? ` (${note})` : ''}`;
  try {
    const res = await fetch(`${base}${path}`);
    const body = await res.json();

    const outer = envelope.safeParse(body);
    if (!outer.success) {
      console.log(`FAIL  ${label}\n      response was not { success: true, data }`);
      failures++;
      continue;
    }

    const parsed = schema.safeParse(outer.data.data);
    if (!parsed.success) {
      failures++;
      console.log(`FAIL  ${label}`);
      for (const issue of parsed.error.issues.slice(0, 6)) {
        console.log(`      ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      continue;
    }

    const count = Array.isArray(parsed.data) ? ` [${parsed.data.length} items]` : '';
    console.log(`ok    ${label}${count}`);
  } catch (err) {
    failures++;
    console.log(`ERROR ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// The reserve-price invariant, checked against live data rather than assumed.
try {
  const res = await fetch(`${base}/api/v1/auctions`);
  const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
  const leaking = data.filter((a) => 'reservePrice' in a);
  if (leaking.length > 0) {
    console.log(`FAIL  ${leaking.length} auction(s) expose reservePrice`);
    failures++;
  } else {
    console.log(`ok    no auction exposes reservePrice [${data.length} checked]`);
  }
} catch {
  // covered by the check above
}

console.log(failures === 0 ? '\ncontract matches the running API' : `\n${failures} mismatch(es)`);
process.exit(failures === 0 ? 0 : 1);
