import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
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
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_REFRESH_EXPIRES_IN_DAYS: z.coerce.number().int().positive().default(14),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// CLIENT_ORIGIN may be a comma-separated list of allowed origins (e.g. the
// production domain plus a legacy Vercel subdomain still in use).
export const clientOrigins = env.CLIENT_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
