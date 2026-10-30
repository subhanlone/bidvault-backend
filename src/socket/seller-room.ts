import { hasSellerCapability } from '../services/user-status.service.js';

/**
 * The room a seller's own events are delivered to ("someone bid on your auction").
 *
 * The server puts a seller's socket in it when it connects, from the identity checked at the
 * handshake (server.ts's `io.use`). A client never asks for it by name, so it cannot ask for
 * anyone else's, and a buyer, an admin or an anonymous connection is never in one.
 */
export const sellerRoom = (userId: string): string => `seller:${userId}`;

interface RoomSocket {
  data: { userId?: string; role?: string };
  join: (room: string) => unknown;
}

/**
 * Whether the account may list is read from the database (B5), not from the role in the token the
 * socket connected with: a buyer who became a seller after signing in is a seller here too.
 */
export async function registerSellerRoom(
  socket: RoomSocket,
  isSeller: (userId: string) => Promise<boolean> = hasSellerCapability,
): Promise<void> {
  const { userId, role } = socket.data;
  if (!userId || role === 'ADMIN') return;
  if (await isSeller(userId)) await socket.join(sellerRoom(userId));
}
