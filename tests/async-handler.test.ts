/**
 * asyncHandler: a route handler may be async or plain, and whatever goes wrong in it -- a rejection
 * or a synchronous throw -- reaches `next`, so the error handler sees both.
 *
 * It started as async-only. A route that never awaits anything (upload-signature only signs and
 * answers) was `async` purely to satisfy the wrapper, which `require-await` rightly rejects; the
 * wrapper now accepts both so that rule can be on.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { asyncHandler } from '../src/utils/async-handler.js';

// The request type the wrapper itself hands to a handler (it narrows Express's own params type).
type Wrapped = ReturnType<typeof asyncHandler>;
const req = {} as Parameters<Wrapped>[0];
const res = {} as Response;

// The wrapper answers through `next`, not a return value: wait for a microtask turn so a
// rejection has had the chance to be forwarded.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('asyncHandler', () => {
  it('runs a handler that is not async, once, and does not call next', async () => {
    const handler = vi.fn(() => undefined);
    const next = vi.fn();
    asyncHandler(handler)(req, res, next);
    await settle();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it('runs an async handler and does not call next when it resolves', async () => {
    const handler = vi.fn(() => Promise.resolve());
    const next = vi.fn();
    asyncHandler(handler)(req, res, next);
    await settle();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a rejection to next', async () => {
    const boom = new Error('rejected');
    const next = vi.fn();
    asyncHandler(() => Promise.reject(boom))(req, res, next);
    await settle();
    expect(next).toHaveBeenCalledExactlyOnceWith(boom);
  });

  it('forwards a synchronous throw to next', async () => {
    const boom = new Error('thrown');
    const next = vi.fn();
    asyncHandler(() => {
      throw boom;
    })(req, res, next);
    await settle();
    expect(next).toHaveBeenCalledExactlyOnceWith(boom);
  });

  it('calls the handler synchronously, as before (it has already run when the wrapper returns)', () => {
    let ran = false;
    asyncHandler(() => {
      ran = true;
    })(req, res, vi.fn());
    expect(ran).toBe(true);
  });
});
