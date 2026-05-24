import type { Response } from 'express';

export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data });
}

export function fail(res: Response, message: string, status = 400): void {
  res.status(status).json({ success: false, error: message });
}
