import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/async-handler.js';
import { ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { strictEmail } from '../../config/email.js';
import { getPlatformSettings, updatePlatformSettings } from '../../services/settings.service.js';

const router = Router();

const updateSchema = z.object({
  emailNotifsEnabled: z.boolean().optional(),
  maintenanceMode: z.boolean().optional(),
  maxBidIncrement: z.coerce.number().int().positive().optional(),
  minListingPrice: z.coerce.number().int().positive().optional(),
  reviewTimeoutHours: z.coerce.number().int().positive().optional(),
  // Stores an address, so it gets the strict rule — same one register uses.
  supportEmail: strictEmail.optional(),
});

// Public — needed by the frontend before auth (maintenance gate + footer contact), and by the
// create-listing form so it can enforce the same limits POST /listings does.
//
// minListingPrice and maxBidIncrement were previously admin-only. The seller's form therefore had
// no way to know them and could only discover a violation from a 400 on final submit — two steps
// after the offending field, with no inline error and nothing to indicate what value is legal.
// These two are safe to publish: they are platform rules a seller has to satisfy anyway, not
// private data. reviewTimeoutHours and emailNotifsEnabled stay admin-only.
router.get(
  '/public',
  asyncHandler(async (_req, res) => {
    const s = await getPlatformSettings();
    ok(res, {
      maintenanceMode: s.maintenanceMode,
      supportEmail: s.supportEmail,
      minListingPrice: s.minListingPrice,
      maxBidIncrement: s.maxBidIncrement,
    });
  }),
);

router.get(
  '/',
  requireAuth(['ADMIN']),
  asyncHandler(async (_req, res) => {
    ok(res, await getPlatformSettings());
  }),
);

router.put(
  '/',
  requireAuth(['ADMIN']),
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    ok(res, await updatePlatformSettings(req.body));
  }),
);

export default router;
