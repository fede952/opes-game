/**
 * @file utils/HttpError.ts
 * @description A typed error class that carries an HTTP status code.
 *
 * ================================================================
 * THE PROBLEM: Distinguishing business errors from server crashes
 * ================================================================
 *
 * Inside route handlers and transaction callbacks, many things can go wrong:
 *
 *   TYPE A — Business-logic violations (client's fault):
 *     - "Building is already producing"    → 409 Conflict
 *     - "Building not found"               → 404 Not Found
 *     - "Production not yet complete"      → 409 Conflict
 *     - "Unknown building type"            → 400 Bad Request
 *
 *   TYPE B — Unexpected server errors (our fault):
 *     - Database connection lost           → 500 Internal Server Error
 *     - SQL syntax error                   → 500 Internal Server Error
 *     - Null pointer dereference           → 500 Internal Server Error
 *
 * Express's global error handler (in server.ts) catches ALL errors passed
 * via next(error). Without a way to distinguish between Type A and Type B,
 * every error would become a 500 — which is wrong. "Building already producing"
 * is the CLIENT's error, not a server failure.
 *
 * ================================================================
 * THE SOLUTION: HttpError carries a status code
 * ================================================================
 *
 * By throwing an HttpError with an explicit statusCode, the route handler's
 * catch block can detect it and respond with the correct HTTP status:
 *
 *   } catch (error) {
 *     if (error instanceof HttpError) {
 *       res.status(error.statusCode).json({ error: error.message });
 *       return;
 *     }
 *     next(error); // Type B: unexpected — let global handler return 500
 *   }
 *
 * This pattern is especially important inside withTransaction() callbacks,
 * where throwing an error triggers a ROLLBACK. The error propagates out of
 * withTransaction() and arrives at the route handler's catch block, where
 * instanceof HttpError lets us return the right status code.
 *
 * @example
 *   throw new HttpError(404, 'Building not found.');
 *   throw new HttpError(409, 'Building is already producing.');
 *   throw new HttpError(409, 'Production is not yet complete.');
 */
export class HttpError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;

    // Restore the prototype chain.
    // Required when extending built-in classes like Error in TypeScript,
    // because TypeScript compiles to ES5 using Object.setPrototypeOf under
    // the hood, which can break instanceof checks without this fix.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
