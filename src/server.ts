import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { createApp } from './app.js';
import { env, clientOrigins } from './config/env.js';
import { prisma } from './db/prisma.js';
import { redisConnection } from './infra/redis.js';
import { verifyAccessToken } from './utils/jwt.js';

const app = createApp();
const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: clientOrigins,
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
  socket.on('auction:subscribe', (auctionId: unknown) => {
    if (typeof auctionId !== 'string' || !auctionId.trim()) return;

    // Deliberately not an async listener. Socket.IO ignores the returned promise, so a
    // rejection here — the database being briefly unreachable, say — was an unhandled
    // rejection, which Node turns into a process exit. One anonymous socket subscribing at
    // the wrong moment could take the API down. The lookup is best-effort: if it fails, the
    // client simply does not join the room.
    void prisma.auction
      // NEW-02: validate auction exists before joining room
      .findUnique({ where: { id: auctionId }, select: { id: true } })
      .then((exists) => {
        if (exists) void socket.join(`auction:${auctionId}`);
      })
      .catch((err: unknown) => {
        console.error('[socket] auction:subscribe lookup failed:', err instanceof Error ? err.message : err);
      });
  });

  socket.on('auction:unsubscribe', (auctionId: unknown) => {
    if (typeof auctionId === 'string') void socket.leave(`auction:${auctionId}`);
  });
});

httpServer.listen(env.PORT, () => {
  console.log(`BidVault backend running on http://localhost:${env.PORT}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down...`);
  void io.close();
  httpServer.close(() => {
    void (async () => {
      await prisma.$disconnect();
      await redisConnection.quit();
      process.exit(0);
    })();
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
