import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { buildSellerStatsMap } from '../auctions/auction-dto.js';
import type { SellerProfileDtoType } from '../../openapi/schemas.js';

/**
 * What anyone may read about a seller, signed in or not. (The signed-in seller's own account is
 * `/seller`, in `../seller`; this is the public face of it, under `/sellers`.)
 */
const router = Router();

router.get(
  '/:sellerId',
  asyncHandler(async (req, res) => {
    const { sellerId } = req.params;

    // One query answers "is this a seller people may see": a buyer who never enrolled, an admin, a
    // suspended account and a deleted one (which loses its seller status when it is anonymised) are
    // all the same 404, so the route cannot be used to ask who is who.
    const seller = await prisma.user.findFirst({
      where: { id: sellerId, isSeller: true, status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        createdAt: true,
        sellerSince: true,
        sellerCity: true,
        sellerProvince: true,
        sellerBio: true,
      },
    });
    if (!seller) {
      fail(res, 'Seller not found.', 404);
      return;
    }

    const [stats, ratingCount] = await Promise.all([
      buildSellerStatsMap([seller.id]),
      prisma.sellerReview.count({ where: { sellerId: seller.id } }),
    ]);
    const { rating, salesCount } = stats.get(seller.id) ?? { rating: null, salesCount: 0 };

    const profile: SellerProfileDtoType = {
      id: seller.id,
      displayName: seller.name,
      memberSince: (seller.sellerSince ?? seller.createdAt).toISOString(),
      city: seller.sellerCity,
      province: seller.sellerProvince,
      bio: seller.sellerBio,
      itemsSold: salesCount,
      rating,
      ratingCount,
    };
    ok(res, profile);
  }),
);

export default router;
