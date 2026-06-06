import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import { redisConnection } from './infra/redis.js';
import { verifyAccessToken } from './utils/jwt.js';

const app = createApp();
const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: env.CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

app.set('io', io);

io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) {
    // Anonymous connections allowed for read-only event reception (live bid updates)
    return next();
  }
  try {
    const payload = verifyAccessToken(token);
    socket.data.userId = payload.sub;
    socket.data.role = payload.role;
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
});

io.on('connection', (socket) => {
  socket.on('auction:subscribe', async (auctionId: unknown) => {
    if (typeof auctionId !== 'string' || !auctionId.trim()) return;
    // NEW-02: validate auction exists before joining room
    const exists = await prisma.auction.findUnique({ where: { id: auctionId }, select: { id: true } });
    if (exists) socket.join(`auction:${auctionId}`);
  });

  socket.on('auction:unsubscribe', (auctionId: unknown) => {
    if (typeof auctionId === 'string') socket.leave(`auction:${auctionId}`);
  });
});

httpServer.listen(env.PORT, () => {
  console.log(`BidVault backend running on http://localhost:${env.PORT}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down...`);
  io.close();
  httpServer.close(async () => {
    await prisma.$disconnect();
    await redisConnection.quit();
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
