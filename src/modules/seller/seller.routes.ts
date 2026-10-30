import { Router } from 'express';
import type { z } from 'zod';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { enrollSellerSchema } from '../../openapi/requests.js';
import { enrollSeller } from '../../services/seller-account.service.js';
import { sanitizeUser } from '../auth/user-dto.js';

const router = Router();

// The caller becomes a seller (B5). Open to any signed-in non-admin account; an account that is
// already a seller gets its record back unchanged (see enrollSeller).
router.post(
  '/enroll',
  requireAuth(['BUYER']),
  validateBody(enrollSellerSchema),
  asyncHandler<z.infer<typeof enrollSellerSchema>>(async (req, res) => {
    const result = await enrollSeller(req.auth!.userId, req.body);
    if (result.kind === 'not-found') {
      fail(res, 'User not found.', 404);
      return;
    }
    if (result.kind === 'terms-changed') {
      fail(res, 'The seller terms have changed. Please review them and try again.', 409);
      return;
    }
    ok(res, { user: sanitizeUser(result.user) });
  }),
);

export default router;
