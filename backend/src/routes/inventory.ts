/**
 * @file src/routes/inventory.ts
 * @description Protected route for reading the player's resource inventory.
 *
 * In Phase 4, direct resource production (POST /produce) has been removed.
 * Resources are now earned exclusively through the time-based building
 * production loop: start a job on a building (POST /production/start),
 * wait for end_time, then collect (POST /production/collect).
 *
 * This file now exposes only the read endpoint: GET /inventory.
 *
 * ================================================================
 * SERVER-AUTHORITATIVE ANTI-CHEAT: Why we don't trust the client
 * ================================================================
 *
 * req.userId is set by authMiddleware from the validated JWT — NOT read from
 * the request body. This means a player can only ever read their own inventory.
 * They cannot pass someone else's user ID to steal their resource data.
 */

import { Router, Request, Response, NextFunction } from 'express';
import authMiddleware from '../middleware/authMiddleware';
import { query } from '../db/connection';

const router = Router();

/**
 * All inventory routes require a valid JWT.
 * This is applied once here rather than per-route so a developer adding
 * a new endpoint cannot accidentally forget the authentication guard.
 */
router.use(authMiddleware);

// ================================================================
// ROUTE: GET /api/v1/inventory
// ================================================================

/**
 * Fetches the complete resource inventory for the currently authenticated player.
 *
 * The player identity comes from req.userId (set by authMiddleware from the JWT).
 * We NEVER accept a player ID from the request body or query parameters —
 * that would let any player read any other player's inventory.
 *
 * SUCCESS: 200 OK with { inventory: [{ resource_id, amount }, ...] }
 */
router.get(
  '/',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // req.userId is guaranteed to be set because authMiddleware ran first.
      // The non-null assertion (!) is safe here — if userId were undefined,
      // authMiddleware would have returned 401 and never called next().
      const userId = req.userId!;

      const result = await query<{ resource_id: string; quality: number; amount: number }>(
        `SELECT resource_id, quality, amount
         FROM   inventories
         WHERE  user_id = $1
         ORDER  BY resource_id ASC, quality ASC`,
        [userId]
      );

      res.status(200).json({ inventory: result.rows });

    } catch (error) {
      next(error);
    }
  }
);

export default router;
