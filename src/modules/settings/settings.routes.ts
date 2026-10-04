import { Router } from 'express';
import type { z } from 'zod';
import { asyncHandler } from '../../utils/async-handler.js';
import { ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { updateSettingsSchema } from '../../openapi/requests.js';
import { getPlatformSettings, updatePlatformSettings } from '../../services/settings.service.js';

const router = Router();

// Public — only what a visitor who has not signed in needs: the maintenance gate and the footer's
// support contact. Everything else is cherry-picked in on purpose, never spread from the settings
// row (OWASP API3: keep returned data to the bare minimum the endpoint's requirement calls for).
//
// minListingPrice and maxBidIncrement used to ride along here so the create-listing form could
// check against them. They are rules for sellers, so they moved to the seller-only
// GET /listings/limits (contract 9.1.0) and were removed from here once the frontend had stopped
// reading them (10.0.0). reviewTimeoutHours and emailNotifsEnabled stay admin-only.
router.get(
  '/public',
  asyncHandler(async (_req, res) => {
    const s = await getPlatformSettings();
    ok(res, {
      maintenanceMode: s.maintenanceMode,
      supportEmail: s.supportEmail,
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
  validateBody(updateSettingsSchema),
  asyncHandler<z.infer<typeof updateSettingsSchema>>(async (req, res) => {
    ok(res, await updatePlatformSettings(req.body));
  }),
);

export default router;
