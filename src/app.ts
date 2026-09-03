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
import { responseContract, violationCount } from './middleware/response-contract.js';
import { ok, fail } from './utils/response.js';
import { asyncHandler } from './utils/async-handler.js';
import { prisma } from './db/prisma.js';
import { REVENUE_STATUSES } from './services/fulfillment.service.js';
import { probeDatabase, probeRedis, getWorkerHeartbeatAgeSeconds } from './services/health.service.js';
import { document } from './openapi/document.js';
import { AppError } from './errors/app-error.js';
import { globalRateLimit } from './middleware/rate-limit.js';

/**
 * Every module router, paired with the prefix it mounts under.
 *
 * Exported so scripts/verify-routes.ts can build the served-route list from this explicit
 * mapping plus each router's own flat `.stack` (still a literal `route.path` per route in
 * Express 5) instead of reverse-engineering the mount prefix from the router layer's own
 * internals. Express 5's path-to-regexp v8 rewrite replaced the old layer.regexp (a real
 * RegExp whose source could be parsed back into a literal prefix) with an opaque compiled
 * matcher function that exposes no string form at all — there is no longer anything to parse.
 * The prefix was always known statically here; this just stops asking the router to hand back
 * information it no longer carries.
 */
export const routeMounts: Array<[string, express.Router]> = [
  ['/api/v1/auth', authRoutes],
  ['/api/v1/auctions', auctionRoutes],
  ['/api/v1/listings', listingRoutes],
  ['/api/v1/watchlist', watchlistRoutes],
  ['/api/v1/payments', paymentRoutes],
  ['/api/v1/admin', adminRoutes],
  ['/api/v1/notifications', notificationRoutes],
  ['/api/v1/reviews', reviewRoutes],
  ['/api/v1/settings', settingsRoutes],
];

export function createApp() {
  const app = express();

  // Railway terminates TLS at its edge and forwards over an internal hop, so without this
  // `req.ip` is the proxy's address and X-Forwarded-For is ignored. Everything that records
  // or keys off a client address is then wrong: RefreshToken.ipAddress stores the same few
  // infrastructure IPs for every session, and any IP-based rate limit would bucket the whole
  // world under one key — express-rate-limit v7 refuses to start when it detects that.
  //
  // The hop count comes from the environment (see config/env.ts): 0 locally, and whatever the
  // deployed topology actually is in production. It is deliberately not hardcoded, because
  // the correct number can only be measured against a running deployment.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || clientOrigins.includes(origin)) callback(null, true);
        else callback(new AppError(403, 'Origin not allowed.'));
      },
      credentials: true,
    }),
  );
  app.use(helmet());
  app.use(globalRateLimit);
  app.use(express.json({ limit: '1mb' }));
  // Silent under test: the conformance suite makes a few hundred requests and the access
  // log buries the actual assertion output, in CI especially.
  if (env.NODE_ENV !== 'test') app.use(morgan('dev'));
  // Wraps res.json for everything below, so each response is checked against the schema
  // openapi.json publishes for it. Must sit above the routes to intercept their handlers.
  app.use(responseContract());
  app.use(asyncHandler(maintenanceGuard));

  // Liveness, with dependency state reported rather than enforced.
  //
  // This deliberately still answers 200 when Postgres or Redis is down. Railway uses this
  // path to decide whether to restart the service, and Redis is a shared instance that has
  // been observed flapping (repeated ETIMEDOUT/ECONNRESET from some networks). Returning 503
  // on a Redis blip would cycle a backend that is otherwise serving fine — and the system
  // already tolerates brief Redis loss by design: listing approval swallows scheduling
  // errors and reconcileOverdueAuctions catches up afterwards.
  //
  // So: the status code answers "is this process alive", the body answers "and how are its
  // dependencies". A caller that needs readiness reads `dependencies`.
  app.get('/api/v1/health', asyncHandler(async (req, res) => {
    // Set by server.ts's shutdown handler the moment SIGTERM/SIGINT arrives. Distinct from
    // the dependency-down case just above: that is "alive but degraded, do not restart me",
    // this is "about to stop accepting work, stop sending me new traffic" (BV-052).
    if (req.app.get('shuttingDown')) {
      fail(res, 'Shutting down.', 503);
      return;
    }
    const [database, redis, workerHeartbeatAgeSeconds] = await Promise.all([
      probeDatabase(),
      probeRedis(),
      getWorkerHeartbeatAgeSeconds(),
    ]);
    ok(res, {
      status: 'ok',
      service: 'bidvault-backend',
      version: document.info.version,
      commit: env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
      dependencies: { database, redis },
      contractViolations: violationCount(),
      workerHeartbeatAgeSeconds,
    });
  }));

  app.get('/api/v1/stats', asyncHandler(async (_req, res) => {
    const [userCount, activeAuctionCount, txSum, listingCount, completedSalesCount] =
      await Promise.all([
        prisma.user.count(),
        prisma.auction.count({ where: { status: 'ACTIVE' } }),
        // A paid status, not just COMPLETED (BV-047 split payment from fulfilment) — a
        // transaction row exists from the moment an auction closes, long before (and whether
        // or not) the winner actually pays, so PENDING/FAILED/VOIDED still don't count, and
        // REFUNDED is excluded because the money went back.
        prisma.auctionTransaction.aggregate({
          where: { status: { in: REVENUE_STATUSES } },
          _sum: { finalAmount: true },
        }),
        // Feeds the public stat panels. They previously padded themselves out with
        // invented figures ("4.9/5 satisfaction", "99% satisfaction", "99.9% uptime")
        // that nothing measured; these are real counts so every tile traces to a query.
        prisma.listing.count({ where: { status: 'APPROVED' } }),
        prisma.auctionTransaction.count({ where: { status: { in: REVENUE_STATUSES } } }),
      ]);
    ok(res, {
      userCount,
      activeAuctionCount,
      transactionTotal: txSum._sum.finalAmount ?? 0,
      listingCount,
      completedSalesCount,
    });
  }));

  for (const [prefix, router] of routeMounts) app.use(prefix, router);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
