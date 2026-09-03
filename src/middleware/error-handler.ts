import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z, ZodError } from 'zod';
import { AppError } from '../errors/app-error.js';

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ success: false, error: 'Route not found' });
}

function redact(text: string): string {
  return text.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]');
}

function safeLogError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown; type?: unknown };
    return {
      name: error.name,
      message: redact(error.message),
      ...(typeof withCode.code === 'string' && { code: withCode.code }),
      ...(typeof withCode.type === 'string' && { type: withCode.type }),
      ...(error.stack && { stack: redact(error.stack) }),
    };
  }
  return { value: redact(String(error)) };
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: 'Validation error',
      // See validate.ts — same shape as zod 3's error.flatten().
      details: z.flattenError(error).fieldErrors,
    });
    return;
  }

  if (error instanceof AppError) {
    res.status(error.status).json({ success: false, error: error.message, code: error.code });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      res.status(409).json({ success: false, error: 'A record with these details already exists.' });
      return;
    }
    if (error.code === 'P2025') {
      res.status(404).json({ success: false, error: 'Resource not found.' });
      return;
    }
  }

  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  console.error(`[error] ${requestId}`, {
    method: req.method,
    route: req.originalUrl,
    error: safeLogError(error),
  });
  res.status(500).json({ success: false, error: 'Internal server error', requestId });
}
