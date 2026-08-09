import type { NextFunction, Request, Response } from 'express';
import { z, ZodError } from 'zod';

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ success: false, error: 'Route not found' });
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: 'Validation error',
      // See validate.ts — same shape as zod 3's error.flatten().
      details: z.flattenError(error).fieldErrors,
    });
    return;
  }

  if (error instanceof Error) {
    res.status(500).json({ success: false, error: error.message });
    return;
  }

  res.status(500).json({ success: false, error: 'Internal server error' });
}
