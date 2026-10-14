/**
 * Reading the refresh token the way a client now has to: from the Set-Cookie header.
 *
 * Login, refresh and change-password no longer put it in the response body (contract 11.0.0),
 * so a test that needs the token -- to replay it, to age it, to send it back -- takes it from the
 * `bv_refresh` cookie the same response set. `res` only needs `headers`, for the same reason
 * helpers/api.ts only needs `body`.
 */
export const REFRESH_COOKIE = 'bv_refresh';

interface WithHeaders {
  headers: Record<string, unknown>;
}

export const setCookies = (res: WithHeaders): string[] => {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? (raw as string[]) : [];
};

/** The Set-Cookie header line for the refresh cookie, or undefined when the response sets none. */
export const refreshCookieLine = (res: WithHeaders): string | undefined =>
  setCookies(res).find((line) => line.startsWith(`${REFRESH_COOKIE}=`));

/** The value part of a Set-Cookie line, without its attributes. */
export const cookieValue = (line: string): string => line.split(';')[0].slice(REFRESH_COOKIE.length + 1);

/** The refresh token a response issued. Throws when it set none, so a missing cookie fails loudly. */
export const refreshTokenOf = (res: WithHeaders): string => {
  const line = refreshCookieLine(res);
  if (!line) throw new Error('the response set no refresh cookie');
  return cookieValue(line);
};
