# BidVault Backend

Backend API for BidVault using Node.js, Express, TypeScript, Prisma, PostgreSQL, Redis + BullMQ, JWT auth, Socket.IO, and n8n webhook integrations.

## What is implemented

- Auth:
  - `POST /api/v1/auth/register`
  - `POST /api/v1/auth/verify-email`
  - `POST /api/v1/auth/login`
  - `POST /api/v1/auth/refresh` (rotating refresh token)
  - `POST /api/v1/auth/logout`
  - `POST /api/v1/auth/forgot-password`
  - `POST /api/v1/auth/verify-reset-otp`
  - `POST /api/v1/auth/reset-password`
  - `GET /api/v1/auth/me`
- Listings:
  - `POST /api/v1/listings` (seller)
  - `GET /api/v1/listings/mine` (seller)
  - `GET /api/v1/listings/pending` (admin)
  - `POST /api/v1/listings/:listingId/approve` (admin)
  - `POST /api/v1/listings/:listingId/reject` (admin)
- Auctions:
  - `GET /api/v1/auctions`
  - `GET /api/v1/auctions/:auctionId`
  - `GET /api/v1/auctions/:auctionId/bids`
  - `POST /api/v1/auctions/:auctionId/bids` (buyer)
- Watchlist:
  - `GET /api/v1/watchlist`
  - `POST /api/v1/watchlist/:auctionId`
  - `DELETE /api/v1/watchlist/:auctionId`
- Health:
  - `GET /api/v1/health`
- Queue/automation:
  - BullMQ queue for auction lifecycle (`auction:start`, `auction:end`)
  - n8n webhook triggers for listing and auction events

## Quick start

1. Copy env file:
   - `cp .env.example .env` (or create `.env` manually on Windows)
2. Install dependencies:
   - `npm install`
3. Ensure services are running:
   - PostgreSQL
   - Redis
4. Generate Prisma client:
   - `npm run prisma:generate`
5. Run migrations:
   - `npm run prisma:migrate -- --name init`
6. Seed demo data:
   - `npm run prisma:seed`
7. Start API server:
   - `npm run dev`
8. Start lifecycle worker:
   - `npm run dev:worker`

Server runs at `http://localhost:4000` by default.

## Demo accounts (seed)

- Buyer: `sawera@gmail.com` / `password123`
- Seller: `ahmed@gmail.com` / `password123`
- Admin: `admin@bidvault.com` / `admin123`

## Notes

- OTP and reset codes are returned in API responses in non-production mode for local testing.
- Prices are stored as integer PKR values.
- Access + refresh token auth is implemented with refresh token rotation.
- Socket.IO channels:
  - Subscribe to room: `auction:subscribe` with `auctionId`
  - Event emitted on new bid: `bid:placed`
- n8n:
  - Set `N8N_WEBHOOK_URL` to receive event payloads.
  - Optional bearer token header via `N8N_WEBHOOK_TOKEN`.
