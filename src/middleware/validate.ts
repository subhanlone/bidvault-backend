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
      const details: Record<string, string[] | undefined> = { ...z.flattenError(parsed.error).fieldErrors };
      // A strict schema (the pay body's method branches) reports a field that does not belong as
      // one root-level "unrecognized_keys" issue, which flattenError files under formErrors, so
      // `details` came back empty. Name each such field, so the 400 says which one to drop.
      for (const issue of parsed.error.issues) {
        if (issue.code !== 'unrecognized_keys') continue;
        for (const key of issue.keys) {
          const path = [...issue.path, key].join('.');
          details[path] = [...(details[path] ?? []), 'This field is not allowed here.'];
        }
      }
      sendValidationError(res, details);
      return;
    }

    req.body = parsed.data;
    next();
  };
}
