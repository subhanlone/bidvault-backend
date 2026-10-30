import type { User } from '@prisma/client';
import type { UserDtoType } from '../../openapi/schemas.js';

/** The user object every auth response carries -- never the password hash, never seller-private
 * details (phone, bio). `isSeller` is what the client shows seller screens from. */
export function sanitizeUser(
  user: Pick<User, 'id' | 'name' | 'email' | 'role' | 'isEmailVerified' | 'isSeller' | 'sellerSince' | 'createdAt'>,
): UserDtoType {
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isEmailVerified: user.isEmailVerified,
    isSeller: user.isSeller,
    sellerSince: user.sellerSince ? user.sellerSince.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
  };
}
