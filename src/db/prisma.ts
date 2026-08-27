import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

const databaseUrl = new URL(env.DATABASE_URL);
if (!databaseUrl.searchParams.has('connection_limit')) {
  databaseUrl.searchParams.set('connection_limit', String(env.DATABASE_CONNECTION_LIMIT));
}

export const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl.toString() } },
});
