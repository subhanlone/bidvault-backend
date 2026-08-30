import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { createApp } from './app.js';
import { env, clientOrigins } from './config/env.js';
import { prisma } from './db/prisma.js';
import { redisConnection } from './infra/redis.js';
import { verifyAccessToken } from './utils/jwt.js';
import { registerAuctionSubscriptions } from './socket/auction-subscriptions.js';

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
  registerAuctionSubscriptions(socket);
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
