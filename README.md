[![CI](https://github.com/subhanlone/bidvault-backend/actions/workflows/ci.yml/badge.svg)](https://github.com/subhanlone/bidvault-backend/actions/workflows/ci.yml)

# BidVault Backend

Auction platform API. Node.js (ESM) + Express + TypeScript + Prisma/PostgreSQL,
with Redis + BullMQ for auction lifecycle jobs, Socket.IO for live bidding,
Stripe for payment, Resend for transactional email and Cloudinary for images.

Deployed on Railway as two services off this one repo: the API (`npm start`)
and the lifecycle worker (`npm run worker`).

## API

All routes are under `/api/v1`.

### Auth — `/auth`

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/register` | |
| POST | `/verify-email` | body field is `otp` |
| POST | `/resend-verification` | |
| POST | `/login` | |
| POST | `/refresh` | rotating refresh token |
| POST | `/logout` | |
| POST | `/forgot-password` | |
| POST | `/verify-reset-otp` | |
| POST | `/reset-password` | |
| POST | `/change-password` | authenticated |
| GET | `/me` | |
| GET / PATCH | `/me/preferences` | outbid / wins / news email opt-outs |

### Listings — `/listings`

| Method | Path | Role |
| --- | --- | --- |
| POST | `/upload-signature` | seller — signed Cloudinary upload |
| POST | `/` | seller |
| GET | `/mine` | seller |
| GET | `/pending` | admin |
| POST | `/:listingId/approve` | admin — creates the auction |
| POST | `/approve-all` | admin |
| POST | `/:listingId/reject` | admin — `PENDING` listings only |

### Auctions — `/auctions`

| Method | Path | Role |
| --- | --- | --- |
| GET | `/` | public |
| GET | `/:auctionId` | public |
| GET | `/:auctionId/bids` | public |
| GET | `/mine/bids` | buyer |
| POST | `/:auctionId/bids` | buyer |

Reserve prices are never serialised. The DTO exposes `reserveMet`
(`true` / `false` / `null` for no reserve) and nothing else about the floor.

### Watchlist — `/watchlist`

`GET /` · `POST /:auctionId` · `DELETE /:auctionId`

### Payments — `/payments`

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/my-wins` | buyer |
| GET | `/seller-stats` | seller |
| POST | `/create-intent` | Stripe PaymentIntent |
| POST | `/webhook` | Stripe — needs the raw body, mounted before `express.json` |

PKR is a zero-decimal currency, so amounts are **not** multiplied by 100.

### Notifications — `/notifications`

`GET /` · `POST /:notificationId/read` · `POST /read-all`

### Reviews — `/reviews`

`POST /` · `GET /seller/:sellerId`

### Settings — `/settings`

`GET /public` (unauthenticated) · `GET /` and `PUT /` (admin).
Backed by the `PlatformSetting` table with a 10s cache. Controls the minimum
listing price, maximum bid increment, review timeout, support email,
whether activity emails send, and maintenance mode.

### Platform — no prefix

- `GET /health` — liveness only; it does not check the database or Redis.
- `GET /stats` — public counters. Revenue counts `COMPLETED` transactions
  only, because a transaction row exists from the moment an auction closes,
  whether or not the winner ever pays.

## Background jobs

One BullMQ queue drives auction closure:

- `auction:end` — closes the auction, picks the winner, decides
  `reserveMet`, writes the transaction and fires notifications, all inside a
  single Prisma transaction with `SELECT … FOR UPDATE` on the auction row.
  If a reserve was set and not met the auction closes unsold: no transaction,
  no winner, both parties told why.
- A reconciliation sweep catches auctions whose job was lost.

`QUEUE_PREFIX` namespaces the queue. Development and production currently
share one Redis instance, so this variable is the only thing stopping a local
worker from consuming production jobs — set it before running the worker.

## Socket.IO

Authenticated through `io.use`. Clients join a room by emitting
`auction:subscribe` with the auction id **as a bare string**, not an object — the handler
rejects anything else, and the server verifies the auction exists before joining. Leave with
`auction:unsubscribe`.

The broadcast is `bid:placed`, payload `{ auctionId, bid: { bidId, amount, buyerId,
buyerName, timestamp } }` — the bid is nested, not at the top level.

## Local setup

1. `cp .env.example .env` and fill it in.
2. `npm install`
3. Start PostgreSQL and Redis.
4. `npm run prisma:generate`
5. `npx prisma db push` — use this locally. Do **not** run `prisma migrate dev`
   against Railway; it is interactive and fails there.
6. `npm run prisma:seed` (optional)
7. `npm run dev` — API on `http://localhost:4000`
8. `npm run dev:worker` — lifecycle worker

Production migrations apply on their own: `npm start` runs
`prisma migrate deploy` before booting.

## Notes

- Prices are integer PKR throughout.
- OTP and reset codes come back in the API response outside production, for
  local testing.
- Access + refresh tokens with refresh rotation.
- Seed accounts are defined in `prisma/seed.ts`. Their credentials are not
  listed here on purpose — this repository is public.
