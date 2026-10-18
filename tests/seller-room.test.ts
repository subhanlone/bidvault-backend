/**
 * A seller's socket is put in their own room, `seller:<id>`, when it connects: that is where
 * "someone bid on your auction" is delivered. The server does it from the identity checked at the
 * handshake, so a client cannot ask for anyone else's room, and nobody but a seller is in one.
 */
import { describe, expect, it, vi } from 'vitest';
import { registerSellerRoom, sellerRoom } from '../src/socket/seller-room.js';

function fakeSocket(data: { userId?: string; role?: string }) {
  return { data, join: vi.fn() };
}

describe('registerSellerRoom', () => {
  it('puts a seller in their own room', () => {
    const socket = fakeSocket({ userId: 'u1', role: 'SELLER' });
    registerSellerRoom(socket);
    expect(socket.join).toHaveBeenCalledExactlyOnceWith('seller:u1');
  });

  it('names the room the same way the sender does', () => {
    expect(sellerRoom('abc')).toBe('seller:abc');
  });

  it.each([['BUYER'], ['ADMIN']])('does not put a %s in any seller room', (role) => {
    const socket = fakeSocket({ userId: 'u1', role });
    registerSellerRoom(socket);
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('does not put an anonymous connection in any room', () => {
    const socket = fakeSocket({});
    registerSellerRoom(socket);
    expect(socket.join).not.toHaveBeenCalled();
  });
});
