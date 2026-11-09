import { SELLER_TERMS_VERSION, type SellerProvince } from '../src/config/seller.js';

/**
 * The columns POST /seller/enroll writes (services/seller-account.service.ts), for a seeded
 * seller. FR-13: the seeds used to create `role: SELLER` rows without `isSeller`, which since the
 * one-account model (B5) is what lets an account list, so a freshly seeded seller could not sell.
 * A seeded seller is now an ordinary account that has enrolled, like every real seller.
 */
export function enrolledSellerFields(city: string, province: SellerProvince) {
  const now = new Date();
  return {
    isSeller: true,
    sellerSince: now,
    sellerTermsAcceptedAt: now,
    sellerTermsVersion: SELLER_TERMS_VERSION,
    ageConfirmedAt: now,
    sellerCity: city,
    sellerProvince: province,
  };
}
