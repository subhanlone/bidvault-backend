import { Router } from 'express';
import Stripe from 'stripe';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import { triggerN8nWorkflow } from '../../services/n8n.service.js';

const router = Router();
const stripe = new Stripe(env.STRIPE_SECRET_KEY);

router.get(
  '/my-wins',
  requireAuth(['BUYER']),
  asyncHandler(async (req, res) => {
    const winnerId = req.auth!.userId;

    const transactions = await prisma.auctionTransaction.findMany({
      where: { winnerId },
      include: {
        auction: true,
        seller: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    ok(res, transactions.map((tx) => ({
      transactionId: tx.id,
      auctionId: tx.auctionId,
      auctionTitle: tx.auction.title,
      auctionEmoji: tx.auction.emoji ?? '📦',
      auctionImageUrl: tx.auction.imageUrl ?? '',
      sellerName: tx.seller.name,
      finalAmount: tx.finalAmount,
      status: tx.status,
      createdAt: tx.createdAt.toISOString(),
    })));
  }),
);

router.get(
  '/seller-stats',
  requireAuth(['SELLER']),
  asyncHandler(async (req, res) => {
    const sellerId = req.auth!.userId;
    const txs = await prisma.auctionTransaction.findMany({
      where: { sellerId, status: 'COMPLETED' },
      select: { finalAmount: true },
    });
    ok(res, {
      totalRevenue: txs.reduce((sum, tx) => sum + tx.finalAmount, 0),
      itemsSold: txs.length,
    });
  }),
);

router.post(
  '/create-intent',
  requireAuth(['BUYER']),
  asyncHandler(async (req, res) => {
    const winnerId = req.auth!.userId;
    const { transactionId } = req.body;

    if (!transactionId) {
      fail(res, 'transactionId is required.', 400);
      return;
    }

    const tx = await prisma.auctionTransaction.findUnique({
      where: { id: transactionId },
      include: { auction: true, winner: true },
    });

    if (!tx) {
      fail(res, 'Transaction not found.', 404);
      return;
    }

    if (tx.winnerId !== winnerId) {
      fail(res, 'Forbidden.', 403);
      return;
    }

    if (tx.status !== 'PENDING') {
      fail(res, 'Transaction is already completed or failed.', 400);
      return;
    }

    if (tx.stripePaymentIntentId) {
      const existing = await stripe.paymentIntents.retrieve(tx.stripePaymentIntentId);
      ok(res, { clientSecret: existing.client_secret });
      return;
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: tx.finalAmount,
      currency: 'pkr',
      metadata: { transactionId: tx.id, auctionId: tx.auctionId, winnerId },
      description: `BidVault - ${tx.auction.title}`,
    });

    await prisma.auctionTransaction.update({
      where: { id: tx.id },
      data: { stripePaymentIntentId: paymentIntent.id },
    });

    ok(res, { clientSecret: paymentIntent.client_secret });
  }),
);

router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const sig = req.headers['stripe-signature'] as string;

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, env.STRIPE_WEBHOOK_SECRET);
    } catch {
      fail(res, 'Webhook signature verification failed.', 400);
      return;
    }

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;

      const tx = await prisma.auctionTransaction.findUnique({
        where: { stripePaymentIntentId: paymentIntent.id },
        include: {
          winner: true,
          seller: true,
          auction: true,
        },
      });

      if (tx && tx.status === 'PENDING') {
        await prisma.auctionTransaction.update({
          where: { id: tx.id },
          data: { status: 'COMPLETED' },
        });

        await triggerN8nWorkflow('payment.completed', {
          transactionId: tx.id,
          auctionTitle: tx.auction.title,
          finalAmount: tx.finalAmount,
          winnerName: tx.winner.name,
          winnerEmail: tx.winner.email,
          sellerName: tx.seller.name,
          sellerEmail: tx.seller.email,
        });
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;

      await prisma.auctionTransaction.updateMany({
        where: { stripePaymentIntentId: paymentIntent.id },
        data: { status: 'FAILED' },
      });
    }

    ok(res, { received: true });
  }),
);

export default router;
