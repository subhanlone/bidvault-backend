import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import { redisConnection } from './infra/redis.js';

const app = createApp();
const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: env.CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

app.set('io', io);

io.on('connection', (socket) => {
  socket.on('auction:subscribe', (auctionId: string) => {
    socket.join(`auction:${auctionId}`);
  });

  socket.on('auction:unsubscribe', (auctionId: string) => {
    socket.leave(`auction:${auctionId}`);
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
