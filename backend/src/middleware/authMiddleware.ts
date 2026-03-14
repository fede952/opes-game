/**
 * @file src/middleware/authMiddleware.ts
 * @description JWT authentication middleware — protects routes that require a logged-in player.
 *
 * ================================================================
 * WHAT IS A JWT (JSON Web Token)?
 * ================================================================
 *
 * A JWT is a compact, self-contained token that represents a verified identity.
 * It is composed of 3 base64url-encoded parts separated by dots:
 *
 *   HEADER.PAYLOAD.SIGNATURE
 *
 *   HEADER:    { "alg": "HS256", "typ": "JWT" }
 *              Declares the token type and signing algorithm.
 *
 *   PAYLOAD:   { "userId": "uuid-here", "username": "Marcus", "iat": 1700000000, "exp": 1700086400 }
 *              Contains "claims" — facts about the user and the token itself.
 *              "iat" = issued-at timestamp, "exp" = expiry timestamp.
 *              NOTE: The payload is base64-encoded, NOT encrypted. Anyone can
 *              decode and READ the payload. Never put sensitive data (passwords,
 *              credit cards) in a JWT payload.
 *
 *   SIGNATURE: HMAC-SHA256(base64(header) + "." + base64(payload), SECRET_KEY)
 *              A cryptographic signature that proves the token was issued by
 *              OUR server (the only entity that knows the SECRET_KEY).
 *
 * ================================================================
 * HOW AUTHENTICATION WORKS IN OPES
 * ================================================================
 *
 *   1. Player logs in (POST /api/v1/auth/login).
 *   2. Server verifies password, then signs and returns a JWT:
 *        jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '7d' })
 *   3. Frontend stores the JWT in localStorage.
 *   4. For every subsequent request to a protected route, the frontend includes:
 *        Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 *   5. This middleware extracts the token, verifies the signature using JWT_SECRET,
 *      and attaches the decoded userId to req.userId.
 *   6. The route handler uses req.userId to query the database for that player's data.
 *
 * ================================================================
 * WHY NOT SESSIONS + COOKIES?
 * ================================================================
 *
 * Traditional session-based auth stores a session ID in a cookie and keeps
 * session data on the server (usually in Redis or a DB table). JWTs are
 * "stateless" — the server stores NO session data. All information is in the
 * token itself, verified by the signature.
 *
 * Pros of JWTs for Opes:
 *   - SCALABILITY: Any server instance can verify a JWT without shared session storage.
 *     This is critical for horizontal scaling (running many server instances behind
 *     a load balancer).
 *   - SIMPLICITY: No Redis or session table needed in Phase 1.
 *
 * Cons of JWTs to be aware of:
 *   - TOKEN REVOCATION: You cannot "invalidate" a JWT before it expires without
 *     a blocklist (which reintroduces statefulness). If a player's account is
 *     banned, their token remains valid until it expires. Mitigate with short
 *     expiry times (e.g., 15 minutes) + refresh tokens (advanced pattern).
 *   - PAYLOAD IS READABLE: Never put sensitive data in the JWT payload.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// ================================================================
// TYPE AUGMENTATION — Extend Express's Request type
// ================================================================

/**
 * We extend Express's built-in Request interface to add our custom properties.
 *
 * HOW IT WORKS (Declaration Merging):
 * TypeScript allows you to "merge" into an existing type declaration by
 * declaring the same namespace/interface again. Express checks for augmentations
 * in the global "Express" namespace.
 *
 * After this declaration, EVERY file in the backend can access req.userId
 * and req.username without needing to import a custom type or cast.
 *
 * WHY OPTIONAL (?) properties?
 * The '?' makes these optional on the base Request type, because unauthenticated
 * routes (like /health or /auth/login) don't have these values. Only routes
 * that run AFTER authMiddleware will have them populated.
 * In route handlers that require authentication, we assert non-null with '!' after
 * verifying the middleware ran (e.g., const userId = req.userId!).
 */
declare global {
  namespace Express {
    interface Request {
      /** The authenticated player's UUID, extracted from the verified JWT. */
      userId?: string;
      /** The authenticated player's username, extracted from the verified JWT. */
      username?: string;
    }
  }
}

// ================================================================
// JWT PAYLOAD TYPE
// ================================================================

/**
 * Defines the shape of data we embed in our JWTs (the "claims").
 * This type is used when SIGNING a new token and when DECODING a verified one.
 *
 * Keep this minimal: only include what route handlers genuinely need to avoid
 * bloating the token size and to limit the blast radius of a payload exposure.
 */
interface OpesjwtPayload {
  userId:   string;
  username: string;
  iat:      number; // Issued-At timestamp (added automatically by jwt.sign)
  exp:      number; // Expiry timestamp (added automatically when expiresIn is set)
}

// ================================================================
// MIDDLEWARE FUNCTION
// ================================================================

/**
 * Express middleware that verifies the JWT from the Authorization header.
 *
 * On SUCCESS: attaches userId and username to req, then calls next() to
 *             continue to the route handler.
 *
 * On FAILURE: returns a 401 Unauthorized response and does NOT call next(),
 *             so the route handler is never reached.
 *
 * Usage — apply to a single route:
 *   router.get('/profile', authMiddleware, (req, res) => { ... });
 *
 * Usage — apply to all routes in a router:
 *   router.use(authMiddleware);
 */
const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // ---- STEP 1: Extract the token from the Authorization header ----
  //
  // The HTTP Authorization header follows the "Bearer Token" scheme (RFC 6750):
  //   Authorization: Bearer <token>
  //
  // We check that:
  //   a) The header exists
  //   b) It starts with "Bearer " (note the space — it's part of the standard)
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized: No authentication token provided. '
           + 'Include "Authorization: Bearer <token>" in your request headers.',
    });
    return; // Stop here — do NOT call next()
  }

  // Extract just the token part (everything after "Bearer ")
  const token = authHeader.slice(7); // "Bearer ".length === 7

  // ---- STEP 2: Verify the JWT signature and expiry ----
  //
  // jwt.verify() does TWO things simultaneously:
  //   1. Checks the SIGNATURE: re-computes the expected signature using our
  //      JWT_SECRET and compares it to the signature in the token.
  //      If they don't match, the token was tampered with — REJECT.
  //   2. Checks the EXPIRY: reads the 'exp' claim in the payload.
  //      If the current time is past exp, the token has expired — REJECT.
  //
  // If EITHER check fails, jwt.verify() throws an error.
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    // This is a server configuration error, not a client error.
    // We log it and return 500 to avoid leaking implementation details.
    console.error('[Auth] FATAL: JWT_SECRET environment variable is not set.');
    res.status(500).json({ error: 'Internal server error: auth is misconfigured.' });
    return;
  }

  try {
    const decoded = jwt.verify(token, jwtSecret) as OpesjwtPayload;

    // ---- STEP 3: Attach the verified identity to the request ----
    //
    // From this point forward, any downstream middleware or route handler can
    // safely read req.userId and req.username — they are guaranteed to be valid
    // (they came from a cryptographically verified token, not from the client body).
    req.userId   = decoded.userId;
    req.username = decoded.username;

    // Continue to the next middleware or route handler.
    next();

  } catch (error) {
    // jwt.verify() can throw several different error types — we handle each
    // distinctly to give the client a helpful, specific error message.

    if (error instanceof jwt.TokenExpiredError) {
      // The token was valid but has passed its expiry time.
      // The player needs to log in again to get a fresh token.
      res.status(401).json({
        error: 'Unauthorized: Your session has expired. Please log in again.',
      });
      return;
    }

    if (error instanceof jwt.JsonWebTokenError) {
      // The token signature is invalid, the token is malformed, or it was
      // signed with a different secret. This could indicate:
      //   - A tampered token (an attacker modified the payload)
      //   - A token from a different environment (wrong JWT_SECRET)
      //   - Corrupted data in localStorage
      res.status(401).json({
        error: 'Unauthorized: Invalid authentication token.',
      });
      return;
    }

    // For any other unexpected error, return 500 and log it server-side.
    console.error('[Auth] Unexpected error during token verification:', error);
    res.status(500).json({ error: 'Internal server error during authentication.' });
  }
};

export default authMiddleware;
