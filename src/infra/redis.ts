import { Redis } from 'ioredis';
import { env } from '../config/env.js';

export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redisConnection.on('connect', () => console.log('[redis] Connected'));
redisConnection.on('error', (err) => console.error('[redis] Connection error:', err.message));
