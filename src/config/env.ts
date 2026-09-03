import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  DATABASE_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  // Namespaces the BullMQ keyspace. Dev and production have historically shared one
  // Redis instance while pointing at different databases, which let a locally-run
  // worker consume production jobs (and vice versa) — the stolen job found no
  // matching auction, returned early, and was marked completed, so that auction
  // never closed. Defaults to BullMQ's own 'bull' so production is unchanged and
  // its already-scheduled jobs stay reachable; local .env overrides it to 'bull:dev'.
  // Deliberately NOT derived from NODE_ENV: the worker service does not set it.
  QUEUE_PREFIX: z.string().min(1).default('bull'),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_REFRESH_EXPIRES_IN_DAYS: z.coerce.number().int().positive().default(14),
  // How many reverse proxies sit between the client and this process, for Express's
  // `trust proxy`. Railway terminates TLS at its edge and forwards over an internal hop, so
  // the deployed value is at least 1; locally there is no proxy at all, hence the 0 default.
  //
  // A hop *count* rather than `true`: trusting X-Forwarded-For outright lets a client spoof
  // its own address by sending the header. Too high is equally wrong in the other direction —
  // it reads an attacker-supplied entry as the client.
  //
  // Configurable rather than hardcoded because the correct number cannot be established from
  // the repository: it depends on the deployed topology, and the deploy pipeline is currently
  // paused. Setting it in the environment means the number can be corrected from the Railway
  // dashboard the moment it can be measured, without a code change and a redeploy.
  //
  // Verify after any deploy: log `req.ip` and `x-forwarded-for` and confirm req.ip is the
  // real client address. express-rate-limit (BV-002) also validates this at startup.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  // Injected by Railway on GitHub-triggered deploys. Reported by GET /health so the
  // running build is identifiable from the outside — without it the only way to tell
  // which commit is live is to read GitHub's deployment records.
  RAILWAY_GIT_COMMIT_SHA: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

// The 0 default is right for local development and catastrophic in a deployment.
//
// Behind a proxy with `trust proxy` set to 0, `req.ip` is the proxy's address rather than the
// client's — the same value for everybody. The IP rate limiters (middleware/rate-limit.ts) then
// share one counter across the entire user base, so the global 300/minute becomes the whole
// platform's ceiling and the first burst of legitimate traffic locks everyone out. Nothing
// about that looks like a misconfiguration from the outside; it looks like the API is down.
//
// Defaulting silently is what makes it dangerous, so in production the value must be stated.
// Refusing to boot is the lesser failure: it is immediate, it names its own fix, and it happens
// before any traffic is served.
if (parsed.data.NODE_ENV === 'production' && process.env.TRUST_PROXY_HOPS === undefined) {
  console.error(
    'TRUST_PROXY_HOPS must be set explicitly when NODE_ENV=production.\n' +
      '  It is the number of reverse proxies between the client and this process.\n' +
      '  Railway terminates TLS at its edge and forwards over one internal hop, so 1 is the\n' +
      '  expected value there. Confirm it after deploying by logging req.ip alongside the\n' +
      "  x-forwarded-for header: req.ip must be the caller's address, not the edge's.",
  );
  process.exit(1);
}

export const env = parsed.data;

// CLIENT_ORIGIN may be a comma-separated list of allowed origins (e.g. the
// production domain plus a legacy Vercel subdomain still in use).
export const clientOrigins = env.CLIENT_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
