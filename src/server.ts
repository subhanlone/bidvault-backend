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

  // /health answers 503 the moment this runs (see app.ts), so a load balancer stops routing
  // new traffic here while the process is still up to answer that check.
  app.set('shuttingDown', true);

  // httpServer.close() stops accepting new connections but waits for every existing one to
  // close on its own -- and an HTTP/1.1 keep-alive connection a client is simply holding open
  // idle never will, so its callback could otherwise never fire. closeIdleConnections() (Node
  // 18.2+) drops those immediately; only a request genuinely in flight still gets to finish.
  //
  // The timer below is the backstop for the case that still hangs -- a query or an external
  // call that never returns. unref'd so it cannot itself keep the process alive for 10s once
  // everything else has already exited cleanly; it only fires if something else already is.
  const forceExit = setTimeout(() => {
    console.error('Graceful shutdown did not complete within 10s; forcing exit.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  void io.close();
  httpServer.closeIdleConnections();
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
