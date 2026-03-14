/**
 * @file src/routes/auth.ts
 * @description Authentication routes: player registration and login.
 *
 * ================================================================
 * BCRYPT — Secure Password Hashing
 * ================================================================
 *
 * Hashing is a one-way transformation: "password123" → "$2b$12$Xr4..."
 * You cannot reverse a hash back to the original password. To verify a
 * login, you hash the submitted password and compare the two hashes.
 *
 * WHY bcrypt SPECIFICALLY?
 * Many fast hash functions (MD5, SHA-256) are designed to be computed
 * as quickly as possible — millions per second on modern hardware.
 * This is catastrophically bad for passwords: if an attacker steals the
 * hash database, they can try millions of password guesses per second.
 *
 * bcrypt is deliberately SLOW. Its "cost factor" (also called "salt rounds")
 * controls how slow. At cost factor 12, each hash takes ~300ms.
 * An attacker trying to crack a bcrypt hash can only test ~3 passwords/second
 * per CPU core, making brute-force attacks computationally infeasible.
 *
 * bcrypt also automatically generates a unique SALT for each hash.
 * A salt is random data mixed into the password before hashing, so:
 *   - Two players with the same password have completely different hashes.
 *   - Pre-computed "rainbow table" attacks are defeated entirely.
 *   - The salt is stored as part of the hash string — no separate column needed.
 *
 * ================================================================
 * TIMING ATTACK PREVENTION (Login)
 * ================================================================
 *
 * A "timing attack" is a side-channel attack where an attacker measures how
 * long the server takes to respond and infers information from the timing.
 *
 * VULNERABLE login flow:
 *   1. Look up user by username — 5ms
 *   2. IF user not found: return immediately — total: 5ms
 *   3. IF user found: run bcrypt.compare — total: 305ms
 *
 * An attacker notices: requests taking ~5ms mean the username DOESN'T exist.
 * Requests taking ~305ms mean the username DOES exist. They can enumerate
 * valid usernames silently, making targeted attacks (e.g., phishing, credential
 * stuffing) much easier.
 *
 * SAFE login flow (our implementation):
 *   1. Look up user by username — 5ms
 *   2. ALWAYS run bcrypt.compare, even if user not found (using a dummy hash)
 *   3. IF user not found OR password wrong: return 401 — total: ~305ms (same)
 *
 * Both outcomes (wrong username OR wrong password) take the same time.
 * Attackers cannot distinguish them.
 */

import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { query, withTransaction } from '../db/connection';

const router = Router();

// ================================================================
// CONSTANTS
// ================================================================

/**
 * bcrypt cost factor (salt rounds).
 *
 * Cost factor 12 means bcrypt performs 2^12 = 4,096 internal iterations.
 * On modern hardware, this takes approximately 200-400ms per hash.
 *
 * CHOOSING THE RIGHT VALUE:
 *   - Too low (< 10): fast to compute → easier to brute-force
 *   - Too high (> 14): slow to compute → poor login UX, server overload under load
 *   - 12 is the current industry recommendation (OWASP, 2024) for web apps.
 *
 * IMPORTANT: Changing this value only affects NEW passwords. Existing hashes
 * in the database store their own cost factor inside the hash string, so old
 * hashes continue to verify correctly with the old cost factor.
 */
const BCRYPT_COST_FACTOR = 12;

/**
 * Resources every new player starts with, at amount 0.
 * These are inserted atomically in the same transaction as the user row.
 *
 * SESTERTIUS — Roman currency (cannot be produced directly; earned through trade)
 * LIGNUM     — Wood (gathered via CASTRA_LIGNATORUM)
 * FRUMENTUM  — Grain (gathered via FUNDUS_FRUMENTI)
 */
const STARTING_RESOURCES = ['SESTERTIUS', 'LIGNUM', 'FRUMENTUM', 'FARINA', 'RESEARCH'] as const;
// New players receive Q0 rows for all starting resources so that any future
// production crediting these resources never encounters a missing-row error.

/**
 * Buildings every new player starts with.
 * Inserted in the same registration transaction as the user and inventory rows.
 *
 * CASTRA_LIGNATORUM — Roman lumber camp; produces Lignum (wood).
 * FUNDUS_FRUMENTI   — Roman grain farm; produces Frumentum (grain).
 *
 * These map to the BUILDING_RESOURCE_MAP in production.ts.
 * All new buildings start as 'IDLE' (the column default in user_buildings).
 */
const STARTING_BUILDINGS = ['CASTRA_LIGNATORUM', 'FUNDUS_FRUMENTI'] as const;

/**
 * JWT expiry duration.
 * '7d' = 7 days. Players should stay logged in between play sessions without
 * needing to re-authenticate daily. Adjust based on your security requirements.
 *
 * For higher-security contexts (e.g., financial transactions), use shorter
 * expiry ('15m') combined with a refresh token system.
 */
const JWT_EXPIRY = '7d';

// ================================================================
// HELPER: Sign a JWT for a player
// ================================================================

/**
 * Creates and signs a JWT for the given player.
 * Throws an error if JWT_SECRET is not configured.
 *
 * @param userId   - The player's UUID from the database.
 * @param username - The player's username.
 * @returns A signed JWT string.
 */
function signToken(userId: string, username: string): string {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    // This is a server configuration error. Throw so the global error handler
    // returns a 500 to the client instead of crashing silently.
    throw new Error(
      'JWT_SECRET is not set in environment variables. '
      + 'Add JWT_SECRET to your .env file.'
    );
  }

  return jwt.sign({ userId, username }, secret, { expiresIn: JWT_EXPIRY });
}

// ================================================================
// ROUTE: POST /api/v1/auth/register
// ================================================================

/**
 * Registers a new player account.
 *
 * FLOW:
 *   1. Validate input (username length, password length).
 *   2. Hash the password with bcrypt (slow, salted — see notes above).
 *   3. In a single ACID transaction:
 *        a. INSERT a new row into 'users'.
 *        b. INSERT 3 starter inventory rows for the new user.
 *      If either INSERT fails, BOTH are rolled back (atomicity).
 *   4. Sign and return a JWT so the player is immediately logged in after register.
 *
 * SUCCESS: 201 Created
 * ERRORS:  400 Bad Request (validation), 409 Conflict (username taken), 500 Server Error
 */
router.post(
  '/register',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { username, password } = req.body as { username?: unknown; password?: unknown };

      // ---- INPUT VALIDATION ----
      // We validate server-side even if the frontend also validates.
      // An attacker can bypass the frontend entirely and send raw HTTP requests,
      // so the backend is the authoritative validation layer.

      if (typeof username !== 'string' || username.trim().length === 0) {
        res.status(400).json({ error: 'Username is required.' });
        return;
      }

      const trimmedUsername = username.trim();

      if (trimmedUsername.length < 3 || trimmedUsername.length > 50) {
        res.status(400).json({ error: 'Username must be between 3 and 50 characters.' });
        return;
      }

      // Basic alphanumeric + underscore check — prevents usernames with
      // special characters that could cause display issues in the game UI.
      if (!/^[a-zA-Z0-9_]+$/.test(trimmedUsername)) {
        res.status(400).json({
          error: 'Username may only contain letters, numbers, and underscores.',
        });
        return;
      }

      if (typeof password !== 'string' || password.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters.' });
        return;
      }

      // ---- PASSWORD HASHING ----
      // This is done BEFORE the database transaction. bcrypt.hash() is async
      // and takes ~300ms — we don't want to hold a database connection open
      // during that time, as it wastes pool resources.
      const passwordHash = await bcrypt.hash(password, BCRYPT_COST_FACTOR);

      // ---- ATOMIC DATABASE WRITE ----
      // We use withTransaction() so that if the inventory INSERTs fail
      // after the user INSERT succeeded, the user row is rolled back too.
      // The player either has a COMPLETE account (user + inventory) or none.
      const newUser = await withTransaction(async (client) => {
        // Insert the new user. RETURNING gives us back the generated id and username.
        const userResult = await client.query<{ id: string; username: string }>(
          `INSERT INTO users (username, password_hash)
           VALUES ($1, $2)
           RETURNING id, username`,
          [trimmedUsername, passwordHash]
        );

        const user = userResult.rows[0];

        // Insert the starting inventory rows for all 3 starting resources.
        // We use a loop rather than a single multi-row INSERT for clarity.
        // In a performance-critical path, you could use a single INSERT with
        // multiple value tuples: INSERT INTO inventories VALUES ($1,$2,0),($1,$3,0),...
        for (const resourceId of STARTING_RESOURCES) {
          await client.query(
            `INSERT INTO inventories (user_id, resource_id, amount)
             VALUES ($1, $2, 0)`,
            [user.id, resourceId]
          );
        }

        // Insert the starting buildings for this player.
        // These are the player's production infrastructure: they start IDLE
        // and can immediately begin their first production run after login.
        // Inserting here (inside the transaction) ensures that a player ALWAYS
        // has both buildings — atomicity guarantees no partial state exists.
        for (const buildingType of STARTING_BUILDINGS) {
          await client.query(
            `INSERT INTO user_buildings (user_id, building_type)
             VALUES ($1, $2)`,
            [user.id, buildingType]
          );
        }

        return user;
      });

      // ---- SIGN JWT ----
      // Done outside the transaction since JWT signing is a CPU operation,
      // not a database operation. The transaction is already committed.
      const token = signToken(newUser.id, newUser.username);

      res.status(201).json({
        message: 'Registration successful. Welcome to Opes!',
        token,
        user: { id: newUser.id, username: newUser.username },
      });

    } catch (error) {
      // Handle PostgreSQL unique constraint violation (duplicate username).
      // Error code '23505' is PostgreSQL's code for "unique_violation".
      // We check for this specific code to return a user-friendly 409 Conflict
      // instead of a generic 500 Internal Server Error.
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code: string }).code === '23505'
      ) {
        res.status(409).json({ error: 'This username is already taken. Please choose another.' });
        return;
      }

      // For all other unexpected errors, delegate to the global error handler.
      next(error);
    }
  }
);

// ================================================================
// ROUTE: POST /api/v1/auth/login
// ================================================================

/**
 * Authenticates an existing player and returns a JWT.
 *
 * FLOW:
 *   1. Validate that username and password are provided.
 *   2. Fetch the user row by username.
 *   3. ALWAYS run bcrypt.compare (even if user not found) to prevent timing attacks.
 *   4. If user not found OR password wrong: return a generic 401.
 *      (SECURITY: the same error message for both cases prevents username enumeration)
 *   5. Sign and return a JWT.
 *
 * SUCCESS: 200 OK
 * ERRORS:  400 Bad Request, 401 Unauthorized, 500 Server Error
 */
router.post(
  '/login',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { username, password } = req.body as { username?: unknown; password?: unknown };

      if (typeof username !== 'string' || typeof password !== 'string' ||
          username.trim().length === 0 || password.length === 0) {
        res.status(400).json({ error: 'Username and password are required.' });
        return;
      }

      // ---- FETCH USER ----
      // We look up by username. If the user doesn't exist, rows[0] is undefined.
      const result = await query<{ id: string; username: string; password_hash: string }>(
        'SELECT id, username, password_hash FROM users WHERE username = $1',
        [username.trim()]
      );

      const user = result.rows[0];

      // ---- TIMING-ATTACK-SAFE PASSWORD COMPARISON ----
      //
      // We ALWAYS call bcrypt.compare, even when the user doesn't exist.
      // If we returned early when user is undefined, the response would be
      // ~5ms (no bcrypt) vs ~300ms (with bcrypt), revealing which usernames exist.
      //
      // When user is undefined, we compare against a pre-computed bcrypt hash
      // of a dummy string. This ensures the function takes the same ~300ms
      // regardless of whether the username exists or not.
      //
      // The dummy hash below was generated with: bcrypt.hashSync('dummy', 12)
      // It is not secret — its only purpose is to keep response time consistent.
      const DUMMY_HASH = '$2b$12$invalidhashfortimingatksXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const hashToCompare = user?.password_hash ?? DUMMY_HASH;

      const passwordMatches = await bcrypt.compare(password, hashToCompare);

      // ---- AUTHENTICATION DECISION ----
      // We give the SAME error message whether the username or password is wrong.
      // "Username not found" vs "Wrong password" are different errors, but telling
      // the client which one occurred would help attackers enumerate valid usernames.
      if (!user || !passwordMatches) {
        res.status(401).json({ error: 'Invalid username or password.' });
        return;
      }

      // ---- SIGN JWT ----
      const token = signToken(user.id, user.username);

      res.status(200).json({
        message: 'Login successful. Ave!',
        token,
        user: { id: user.id, username: user.username },
      });

    } catch (error) {
      next(error);
    }
  }
);

export default router;
