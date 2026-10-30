/**
 * A seller's socket is put in their own room, `seller:<id>`, when it connects: that is where
 * "someone bid on your auction" is delivered. The server does it from the identity checked at the
 * handshake, so a client cannot ask for anyone else's room. Whether the account is a seller is
 * answered by the database (B5), so the role in the token does not decide it.
 */
import { describe, expect, it, vi } from 'vitest';
import { registerSellerRoom, sellerRoom } from '../src/socket/seller-room.js';

function fakeSocket(data: { userId?: string; role?: string }) {
  return { data, join: vi.fn() };
}

describe('registerSellerRoom', () => {
  it('puts a seller in their own room', async () => {
    const socket = fakeSocket({ userId: 'u1', role: 'SELLER' });
    await registerSellerRoom(socket, () => Promise.resolve(true));
    expect(socket.join).toHaveBeenCalledExactlyOnceWith('seller:u1');
  });

  it('puts a seller in their room whatever role their token carries', async () => {
    // An account that became a seller after it signed in still holds a BUYER token.
    const socket = fakeSocket({ userId: 'u1', role: 'BUYER' });
    await registerSellerRoom(socket, () => Promise.resolve(true));
    expect(socket.join).toHaveBeenCalledExactlyOnceWith('seller:u1');
  });

  it('asks about the connected account, and nobody else', async () => {
    const isSeller = vi.fn(() => Promise.resolve(true));
    await registerSellerRoom(fakeSocket({ userId: 'u7', role: 'BUYER' }), isSeller);
    expect(isSeller).toHaveBeenCalledExactlyOnceWith('u7');
  });

  it('names the room the same way the sender does', () => {
    expect(sellerRoom('abc')).toBe('seller:abc');
  });

  it('does not put an account that is not a seller in any seller room', async () => {
    const socket = fakeSocket({ userId: 'u1', role: 'BUYER' });
    await registerSellerRoom(socket, () => Promise.resolve(false));
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('does not put an admin in any seller room', async () => {
    const socket = fakeSocket({ userId: 'u1', role: 'ADMIN' });
    const isSeller = vi.fn(() => Promise.resolve(true));
    await registerSellerRoom(socket, isSeller);
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('does not put an anonymous connection in any room', async () => {
    const socket = fakeSocket({});
    await registerSellerRoom(socket, () => Promise.resolve(true));
    expect(socket.join).not.toHaveBeenCalled();
  });
});
