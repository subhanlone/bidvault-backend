// Single source of truth for the one-time-code window. Imported by auth.routes.ts (which issues
// and validates the codes) and email.service.ts (which advertises the window in the email body),
// so the two can never drift apart.
//
// Product decision: 90s. Still far tighter than the OWASP ASVS V2.7.2 / NIST 800-63B 10-minute
// maximum for out-of-band OTPs, but with enough headroom to absorb send + delivery + spam-filter
// latency, which at the previous 60s could consume most of the window.
//
// Clients must count down to the `codeExpiresAt` returned alongside the code rather than starting
// their own timer on receipt — otherwise the two drift and the UI shows time remaining on a code
// the server has already expired.
export const OTP_EXPIRY_MS = 90 * 1000;

export const OTP_EXPIRY_SECONDS = OTP_EXPIRY_MS / 1000;
