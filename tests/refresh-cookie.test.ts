/**
 * The refresh token as an HttpOnly cookie (OWASP: no credentials in localStorage/sessionStorage).
 *
 * The JSON body still carries the token pair -- existing clients read it, and a session that
 * still lives in localStorage migrates onto the cookie by sending its token in the body once --
 * so everything here is about the cookie: its attributes, the CSRF defence on the cookie-only
 * path, "remember me" surviving rotation, and the reuse interval handing back the same cookie.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resData, resError } from './helpers/api.js';

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: vi.fn(async () => ({ data: { id: 'email_test' }, error: null })) };
  },
}));

const { createApp } = await import('../src/app.js');
const { clientOrigins } = await import('../src/config/env.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { takeViolations } = await import('../src/middleware/response-contract.js');
const { resetRateLimits } = await import('../src/middleware/rate-limit.js');
const { verifyRefreshToken } = await import('../src/utils/jwt.js');
const { hashToken } = await import('../src/utils/token-hash.js');
const { seedWorld, PASSWORD } = await import('./helpers/world.js');

type World = Awaited<ReturnType<typeof seedWorld>>;
type Tokens = { accessToken: string; refreshToken: string };

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const ORIGIN = clientOrigins[0];
const COOKIE = 'bv_refresh';

let w: World;

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  resetRateLimits();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  w = await seedWorld();
});

afterEach(() => {
  takeViolations();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

const login = (remember?: boolean) =>
  request(app)
    .post(api('/auth/login'))
    .send({ email: w.buyer.email, password: PASSWORD, ...(remember === undefined ? {} : { remember }) });

const setCookies = (res: request.Response): string[] => {
  const raw = res.headers['set-cookie'] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : [];
};
/** The Set-Cookie header line for the refresh cookie, or undefined when the response sets none. */
const refreshCookieLine = (res: request.Response) =>
  setCookies(res).find((line) => line.startsWith(`${COOKIE}=`));
const cookieValue = (line: string) => line.split(';')[0].slice(COOKIE.length + 1);
const isCleared = (line: string) => cookieValue(line) === '' && /expires=thu, 01 jan 1970/i.test(line);

/** What the browser does: send the cookie back, plus the Origin it always sends. */
const refreshByCookie = (value: string, origin: string | null = ORIGIN) => {
  const req = request(app).post(api('/auth/refresh')).set('Cookie', `${COOKIE}=${value}`).send({});
  return origin === null ? req : req.set('Origin', origin);
};
const refreshByBody = (refreshToken: string) =>
  request(app).post(api('/auth/refresh')).send({ refreshToken });

describe('the refresh cookie', () => {
  it('login sets it HttpOnly, SameSite=Strict, scoped to the auth routes, host-only, 14 days', async () => {
    const res = await login();
    expect(res.status).toBe(200);

    const line = refreshCookieLine(res);
    expect(line).toBeDefined();
    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*SameSite=Strict/i);
    expect(line).toMatch(/;\s*Path=\/api\/v1\/auth(;|$)/i);
    expect(line).toMatch(/;\s*Max-Age=1209600/i);
    expect(line).not.toMatch(/;\s*Domain=/i);

    // The body is unchanged: existing clients still read the pair from it, and it is the same token.
    const body = resData<Tokens>(res);
    expect(cookieValue(line!)).toBe(body.refreshToken);
  });

  it('login with remember:false sets a browser-session cookie (no Max-Age, no Expires)', async () => {
    const line = refreshCookieLine(await login(false));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/Max-Age=/i);
    expect(line).not.toMatch(/Expires=/i);
  });

  it('a refresh with only the cookie rotates the token and sets the successor cookie', async () => {
    const first = cookieValue(refreshCookieLine(await login())!);

    const res = await refreshByCookie(first);
    expect(res.status).toBe(200);
    const body = resData<Tokens>(res);
    expect(body.refreshToken).not.toBe(first);
    expect(cookieValue(refreshCookieLine(res)!)).toBe(body.refreshToken);

    const spent = await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashToken(first) } });
    expect(spent.revokedAt).toBeInstanceOf(Date);
  });

  it('a cookie-only refresh is refused without a trusted Origin, and does not spend the token', async () => {
    const first = cookieValue(refreshCookieLine(await login())!);

    const noOrigin = await refreshByCookie(first, null);
    expect(noOrigin.status).toBe(403);
    expect(resError(noOrigin).code).toBe('ORIGIN_NOT_ALLOWED');
    expect(refreshCookieLine(noOrigin)).toBeUndefined();

    expect((await refreshByCookie(first, 'https://evil.example')).status).toBe(403);

    // Still unspent: the same cookie works from the real origin.
    expect((await refreshByCookie(first)).status).toBe(200);
  });

  it('a body token still refreshes, with no Origin needed, and moves the session onto the cookie', async () => {
    const first = resData<Tokens>(await login()).refreshToken;

    const res = await refreshByBody(first);
    expect(res.status).toBe(200);
    const line = refreshCookieLine(res);
    expect(line).toBeDefined();
    expect(cookieValue(line!)).toBe(resData<Tokens>(res).refreshToken);
  });

  it('with neither a body token nor a cookie it is a 401, not a crash', async () => {
    const res = await request(app).post(api('/auth/refresh')).set('Origin', ORIGIN).send({});
    expect(res.status).toBe(401);
  });

  it('a refused cookie is cleared, so the browser stops sending a dead one; a refused body token sets nothing', async () => {
    const dead = await refreshByCookie('not-a-real-token');
    expect(dead.status).toBe(401);
    expect(isCleared(refreshCookieLine(dead)!)).toBe(true);

    const deadBody = await refreshByBody('not-a-real-token');
    expect(deadBody.status).toBe(401);
    expect(refreshCookieLine(deadBody)).toBeUndefined();
  });

  it('"remember me" off survives rotation and the reuse interval returns the very same cookie', async () => {
    const first = cookieValue(refreshCookieLine(await login(false))!);

    const rotated = await refreshByCookie(first);
    expect(rotated.status).toBe(200);
    const successor = resData<Tokens>(rotated).refreshToken;
    expect(verifyRefreshToken(successor).remember).toBe(false);
    const rotatedLine = refreshCookieLine(rotated)!;
    expect(rotatedLine).not.toMatch(/Max-Age=/i);

    // The same token again, a moment later (two tabs): answered with the successor, byte for byte,
    // which only works if re-signing reproduces the `rem` claim too.
    const repeat = await refreshByCookie(first);
    expect(repeat.status).toBe(200);
    expect(resData<Tokens>(repeat).refreshToken).toBe(successor);
    const repeatLine = refreshCookieLine(repeat)!;
    expect(cookieValue(repeatLine)).toBe(successor);
    expect(repeatLine).not.toMatch(/Max-Age=/i);
  });

  it('a remembered session stays remembered through rotation', async () => {
    const first = cookieValue(refreshCookieLine(await login(true))!);
    const rotated = await refreshByCookie(first);
    expect(verifyRefreshToken(resData<Tokens>(rotated).refreshToken).remember).toBe(true);
    expect(refreshCookieLine(rotated)).toMatch(/Max-Age=1209600/i);
  });

  it('logout by cookie revokes the token and clears the cookie', async () => {
    const first = cookieValue(refreshCookieLine(await login())!);

    const out = await request(app)
      .post(api('/auth/logout'))
      .set('Cookie', `${COOKIE}=${first}`)
      .set('Origin', ORIGIN)
      .send({});
    expect(out.status).toBe(200);
    expect(isCleared(refreshCookieLine(out)!)).toBe(true);

    const row = await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashToken(first) } });
    expect(row.revokedAt).toBeInstanceOf(Date);
  });

  it('logout by cookie from an untrusted origin is refused and revokes nothing', async () => {
    const first = cookieValue(refreshCookieLine(await login())!);

    const res = await request(app)
      .post(api('/auth/logout'))
      .set('Cookie', `${COOKIE}=${first}`)
      .set('Origin', 'https://evil.example')
      .send({});
    expect(res.status).toBe(403);

    const row = await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashToken(first) } });
    expect(row.revokedAt).toBeNull();
  });

  it('logout still works with a body token, and clears the cookie even when there was nothing to revoke', async () => {
    const body = resData<Tokens>(await login());
    const byBody = await request(app).post(api('/auth/logout')).send({ refreshToken: body.refreshToken });
    expect(byBody.status).toBe(200);
    expect(isCleared(refreshCookieLine(byBody)!)).toBe(true);

    const nothing = await request(app).post(api('/auth/logout')).send({});
    expect(nothing.status).toBe(200);
    expect(isCleared(refreshCookieLine(nothing)!)).toBe(true);
  });

  it('change-password hands back a fresh cookie and keeps a session-only login session-only', async () => {
    const res = await login(false);
    const { accessToken } = resData<Tokens>(res);
    const first = cookieValue(refreshCookieLine(res)!);

    const changed = await request(app)
      .post(api('/auth/change-password'))
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', `${COOKIE}=${first}`)
      .send({ currentPassword: PASSWORD, newPassword: 'Correct-Horse-Battery-Staple-42!' });
    expect(changed.status).toBe(200);

    const line = refreshCookieLine(changed);
    expect(line).toBeDefined();
    expect(cookieValue(line!)).toBe(resData<Tokens>(changed).refreshToken);
    expect(line).not.toMatch(/Max-Age=/i);
  });
});
