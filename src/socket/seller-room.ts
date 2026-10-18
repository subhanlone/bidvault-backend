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

export function registerSellerRoom(socket: RoomSocket): void {
  if (socket.data.role === 'SELLER' && socket.data.userId) {
    void socket.join(sellerRoom(socket.data.userId));
  }
}
