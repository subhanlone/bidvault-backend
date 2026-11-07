import { Router } from 'express';
import type { z } from 'zod';
import { asyncHandler } from '../../utils/async-handler.js';
import { ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { updateSettingsSchema } from '../../openapi/requests.js';
import { SELLER_TERMS_VERSION } from '../../config/seller.js';
import { getPlatformSettings, updatePlatformSettings } from '../../services/settings.service.js';

const router = Router();

// Public: only what a visitor who has not signed in needs: the maintenance gate, the footer's
// support contact, the seller terms version, and the two buying-rule windows the auction page quotes
// to anyone considering a bid. Everything else is cherry-picked in on purpose, never spread from the
// settings row (OWASP API3: keep returned data to the bare minimum the endpoint's requirement calls
// for). minListingPrice and maxBidIncrement are rules for sellers and are served by the seller-only
// GET /listings/limits; emailNotifsEnabled stays admin-only.
router.get(
  '/public',
  asyncHandler(async (_req, res) => {
    const s = await getPlatformSettings();
    ok(res, {
      maintenanceMode: s.maintenanceMode,
      supportEmail: s.supportEmail,
      sellerTermsVersion: SELLER_TERMS_VERSION,
      paymentDeadlineHours: s.paymentDeadlineHours,
      reviewTimeoutHours: s.reviewTimeoutHours,
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
