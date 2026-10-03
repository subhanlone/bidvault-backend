import type { Response } from 'express';

export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data });
}

export function fail(res: Response, message: string, status = 400, code?: string): void {
  res.status(status).json({ success: false, error: message, code });
}

/**
 * A rejected business rule that is about one request field. Same `details` shape validateBody
 * answers with ({ field: [messages] }), so a client can show the message at the field instead of
 * only in a toast -- the part of the failure a bare `error` string cannot carry. `field` is the
 * name in the request body, not a label.
 */
export function failField(res: Response, field: string, message: string, status = 422, code?: string): void {
  res.status(status).json({ success: false, error: message, code, details: { [field]: [message] } });
}
