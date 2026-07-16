import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/async-handler.js';
import { ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { getPlatformSettings, updatePlatformSettings } from '../../services/settings.service.js';

const router = Router();

const updateSchema = z.object({
  emailNotifsEnabled: z.boolean().optional(),
  maintenanceMode: z.boolean().optional(),
  maxBidIncrement: z.coerce.number().int().positive().optional(),
  minListingPrice: z.coerce.number().int().positive().optional(),
  reviewTimeoutHours: z.coerce.number().int().positive().optional(),
  supportEmail: z.string().trim().email().optional(),
});

// Public — needed by the frontend before auth (maintenance gate + footer contact)
router.get(
  '/public',
  asyncHandler(async (_req, res) => {
    const s = await getPlatformSettings();
    ok(res, { maintenanceMode: s.maintenanceMode, supportEmail: s.supportEmail });
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
