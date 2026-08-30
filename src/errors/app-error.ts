/**
 * A deliberately user-safe error that can cross the HTTP boundary.
 *
 * Everything else is treated as an internal failure by errorHandler. Keeping the marker
 * explicit prevents a database/SDK error message from becoming public merely because it is
 * an Error instance.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
