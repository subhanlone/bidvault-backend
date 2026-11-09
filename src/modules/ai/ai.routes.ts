import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { getValuation } from './ai-valuation.service.js';

/**
 * Agentic AI valuation. Public: the panel is on the auction page for everyone (decided 2026-11-09).
 * Cheap to call: it reads one row and at most asks the queue for a run (see getValuation).
 */
const router = Router();

router.get(
  '/valuations/:auctionId',
  asyncHandler(async (req, res) => {
    const result = await getValuation(req.params.auctionId);
    if (result.kind === 'not-found') {
      fail(res, 'Auction not found.', 404);
      return;
    }
    ok(res, result.view);
  }),
);

export default router;
