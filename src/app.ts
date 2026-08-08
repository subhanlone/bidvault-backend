import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import authRoutes from './modules/auth/auth.routes.js';
import auctionRoutes from './modules/auctions/auctions.routes.js';
import listingRoutes from './modules/listings/listings.routes.js';
import watchlistRoutes from './modules/watchlist/watchlist.routes.js';
import paymentRoutes from './modules/payments/payments.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import reviewRoutes from './modules/reviews/reviews.routes.js';
import settingsRoutes from './modules/settings/settings.routes.js';
import { env, clientOrigins } from './config/env.js';
import { maintenanceGuard } from './middleware/maintenance.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { ok } from './utils/response.js';
import { prisma } from './db/prisma.js';

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || clientOrigins.includes(origin)) callback(null, true);
        else callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
    }),
  );
  app.use(helmet());
  app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('dev'));
  app.use(maintenanceGuard);

  app.get('/api/v1/health', (_req, res) => {
    ok(res, { status: 'ok', service: 'bidvault-backend' });
  });

  app.get('/api/v1/stats', async (_req, res, next) => {
    try {
      const [userCount, activeAuctionCount, txSum, listingCount, completedSalesCount] =
        await Promise.all([
          prisma.user.count(),
          prisma.auction.count({ where: { status: 'ACTIVE' } }),
          // COMPLETED only — a transaction row exists from the moment an auction closes,
          // long before (and whether or not) the winner actually pays.
          prisma.auctionTransaction.aggregate({
            where: { status: 'COMPLETED' },
            _sum: { finalAmount: true },
          }),
          // Feeds the public stat panels. They previously padded themselves out with
          // invented figures ("4.9/5 satisfaction", "99% satisfaction", "99.9% uptime")
          // that nothing measured; these are real counts so every tile traces to a query.
          prisma.listing.count({ where: { status: 'APPROVED' } }),
          prisma.auctionTransaction.count({ where: { status: 'COMPLETED' } }),
        ]);
      ok(res, {
        userCount,
        activeAuctionCount,
        transactionTotal: txSum._sum.finalAmount ?? 0,
        listingCount,
        completedSalesCount,
      });
    } catch (err) {
      next(err);
    }
  });

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/auctions', auctionRoutes);
  app.use('/api/v1/listings', listingRoutes);
  app.use('/api/v1/watchlist', watchlistRoutes);
  app.use('/api/v1/payments', paymentRoutes);
  app.use('/api/v1/admin', adminRoutes);
  app.use('/api/v1/notifications', notificationRoutes);
  app.use('/api/v1/reviews', reviewRoutes);
  app.use('/api/v1/settings', settingsRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
