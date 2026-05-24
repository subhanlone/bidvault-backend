import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import authRoutes from './modules/auth/auth.routes.js';
import auctionRoutes from './modules/auctions/auctions.routes.js';
import listingRoutes from './modules/listings/listings.routes.js';
import watchlistRoutes from './modules/watchlist/watchlist.routes.js';
import { env } from './config/env.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { ok } from './utils/response.js';

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
      credentials: true,
    }),
  );
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('dev'));

  app.get('/api/v1/health', (_req, res) => {
    ok(res, { status: 'ok', service: 'bidvault-backend' });
  });

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/auctions', auctionRoutes);
  app.use('/api/v1/listings', listingRoutes);
  app.use('/api/v1/watchlist', watchlistRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
