import type { NextFunction, Request, Response } from 'express';
import { z, type ZodType } from 'zod';

/** The one 400 shape every validation failure uses: `details` maps a field to its messages. */
export function sendValidationError(res: Response, details: Record<string, string[] | undefined>): void {
  res.status(400).json({ success: false, error: 'Validation error', details });
}

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      // z.flattenError replaces zod 3's error.flatten(), which is deprecated in
      // zod 4. Same { formErrors, fieldErrors } shape, so the response body is
      // byte-for-byte what it was.
      sendValidationError(res, z.flattenError(parsed.error).fieldErrors);
      return;
    }

    req.body = parsed.data;
    next();
  };
}
