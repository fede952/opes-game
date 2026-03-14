/**
 * @file src/routes/npcMarket.ts
 * @description NPC "Empire" Market: sell resources to the Empire for dynamic Sestertius prices.
 *
 * ================================================================
 * PHASE 7 CHANGES FROM PHASE 5/6
 * ================================================================
 *
 * Phase 5/6: Prices were hardcoded in a server-side constant (NPC_BUY_PRICES).
 *
 * Phase 7: Prices are stored in the `npc_prices` database table and can
 * fluctuate over time via the simulateMarketEvents.ts script (±20% per event).
 * The application reads the current price from the DB on every sell request,
 * ensuring players always trade at the live market rate.
 *
 * ================================================================
 * QUALITY-ADJUSTED PRICING (Phase 7)
 * ================================================================
 *
 * The Empire pays a premium for higher-quality goods:
 *
 *   payout = FLOOR(amount × current_buy_price × (1 + quality × 0.5))
 *
 *   Quality 0 (standard):   1.0× base price  (no premium)
 *   Quality 1 (fine):       1.5× base price
 *   Quality 2 (masterwork): 2.0× base price
 *
 * FLOOR() ensures the payout is always a whole integer of Sestertius.
 * The Empire rounds down in its favor — this is intentional.
 *
 * Example: 5 Q1 FARINA at base price 10:
 *   5 × 10 × 1.5 = 75 Sestertius
 *
 * ================================================================
 * TRANSACTION SAFETY
 * ================================================================
 *
 * The NPC sell transaction runs inside a single ACID transaction:
 *
 *   BEGIN
 *     [1] Fetch current price from npc_prices       (read — no lock needed)
 *     [2] Lock player's resource row                (SELECT FOR UPDATE at quality=$3)
 *     [3] Validate sufficient resources
 *     [4] Deduct resource at specified quality
 *     [5] Credit Sestertius (upsert at quality=0)
 *   COMMIT
 *
 * Alphabetical lock ordering is not strictly required here (only one
 * inventory row is locked), but the SESTERTIUS credit uses upsert to
 * handle the edge case of a missing SESTERTIUS row.
 */

import { Router, Request, Response, NextFunction } from 'express';
import authMiddleware          from '../middleware/authMiddleware';
import { query, withTransaction } from '../db/connection';
import { HttpError }          from '../utils/HttpError';

const router = Router();

// All NPC market routes require authentication (JWT in Authorization header).
router.use(authMiddleware);

// ================================================================
// ROUTE: GET /api/v1/market/npc/prices
// ================================================================

/**
 * Returns the current NPC buy prices from the database.
 *
 * The frontend uses this to display live prices and calculate payout previews.
 * Prices change whenever simulateMarketEvents.ts runs.
 *
 * This endpoint is intentionally NOT cached — freshness matters for the
 * player experience. A short TTL cache could be added if latency becomes
 * a concern.
 *
 * SUCCESS: 200 OK
 * {
 *   prices: [
 *     { resource_id: "LIGNUM",    current_buy_price: 2,  updated_at: "..." },
 *     { resource_id: "FRUMENTUM", current_buy_price: 3,  updated_at: "..." },
 *     { resource_id: "FARINA",    current_buy_price: 10, updated_at: "..." }
 *   ]
 * }
 */
router.get(
  '/prices',
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await query<{
        resource_id:       string;
        current_buy_price: number;
        updated_at:        string;
      }>(
        `SELECT resource_id, current_buy_price, updated_at
         FROM   npc_prices
         ORDER  BY resource_id ASC`
      );

      res.status(200).json({ prices: result.rows });

    } catch (error) {
      next(error);
    }
  }
);

// ================================================================
// ROUTE: POST /api/v1/market/npc/sell
// ================================================================

/**
 * Sells a player's resource to the NPC Empire Market.
 *
 * Phase 7 additions over Phase 5/6:
 *   - Price fetched from `npc_prices` DB table (not hardcoded constant).
 *   - `quality` parameter: sell a specific quality tier of the resource.
 *   - Payout is quality-adjusted: price × (1 + quality × 0.5), floored.
 *   - Inventory lock and deduction target (user_id, resource_id, quality).
 *   - SESTERTIUS credit uses the 3-column ON CONFLICT key.
 *
 * Request body: { "resource_id": "LIGNUM", "amount": 5, "quality": 0 }
 *               quality defaults to 0 if omitted.
 *
 * SUCCESS: 200 OK
 * {
 *   message: "Sold 5 Q0 LIGNUM for 10 Sestertius.",
 *   trade: {
 *     resource_id:         "LIGNUM",
 *     quality:             0,
 *     amount_sold:         5,
 *     price_per_unit:      2,
 *     quality_multiplier:  1.0,
 *     total_payout:        10,
 *     new_sestertius:      110,
 *     new_resource_amount: 15
 *   }
 * }
 *
 * ERRORS:
 *   400 — resource_id missing or not tradable with NPC
 *   400 — quality missing / not 0, 1, or 2
 *   400 — amount is not a positive integer
 *   400 — insufficient resources at the specified quality
 */
router.post(
  '/sell',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;

      const { resource_id, amount, quality } = req.body as {
        resource_id?: unknown;
        amount?:      unknown;
        quality?:     unknown;
      };

      // ---- INPUT VALIDATION ----

      if (typeof resource_id !== 'string' || resource_id.trim().length === 0) {
        res.status(400).json({ error: 'resource_id is required and must be a non-empty string.' });
        return;
      }

      const normalizedResource = resource_id.trim().toUpperCase();

      // Parse and validate quality (0, 1, or 2).
      const parsedQuality =
        quality === undefined || quality === null
          ? 0
          : typeof quality === 'number'
            ? Math.floor(quality)
            : parseInt(String(quality), 10);

      if (!Number.isFinite(parsedQuality) || parsedQuality < 0 || parsedQuality > 2) {
        res.status(400).json({ error: 'quality must be 0, 1, or 2.' });
        return;
      }

      // Parse amount safely.
      const parsedAmount =
        typeof amount === 'number'
          ? Math.floor(amount)
          : parseInt(String(amount), 10);

      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        res.status(400).json({ error: 'amount must be a positive integer (e.g., 5).' });
        return;
      }

      const result = await withTransaction(async (client) => {

        // ---- STEP 1: Fetch current price from npc_prices table ----
        //
        // We read the price INSIDE the transaction for consistency. If a market
        // event fires between validation and transaction start, we use the
        // post-event price, which is the most up-to-date and fair value.
        //
        // If the resource is not in npc_prices, the Empire does not buy it.
        const priceResult = await client.query<{ current_buy_price: number }>(
          `SELECT current_buy_price
           FROM   npc_prices
           WHERE  resource_id = $1`,
          [normalizedResource]
        );

        if (priceResult.rowCount === 0) {
          throw new HttpError(
            400,
            `The Empire does not purchase '${normalizedResource}'. ` +
            `Check GET /market/npc/prices for currently tradeable resources.`
          );
        }

        const pricePerUnit: number = priceResult.rows[0].current_buy_price;

        // ---- STEP 2: Calculate quality-adjusted payout ----
        //
        // qualityMultiplier: Q0 = 1.0, Q1 = 1.5, Q2 = 2.0
        // FLOOR() keeps the result as a whole integer — the Empire rounds down.
        const qualityMultiplier: number = 1 + parsedQuality * 0.5;
        const totalPayout: number = Math.floor(parsedAmount * pricePerUnit * qualityMultiplier);

        // ---- STEP 3: Lock the player's resource row at the specified quality ----
        //
        // FOR UPDATE on (user_id, resource_id, quality) serializes concurrent sell
        // requests for this exact quality tier of this resource.
        // If the player tries to sell the same quality simultaneously from two
        // browser tabs, one waits while the other deducts and commits.
        const resourceRow = await client.query<{ amount: number }>(
          `SELECT amount
           FROM   inventories
           WHERE  user_id     = $1
             AND  resource_id = $2
             AND  quality     = $3
           FOR UPDATE`,
          [userId, normalizedResource, parsedQuality]
        );

        // No row at all means the player has zero of this (resource, quality) pair.
        if (resourceRow.rowCount === 0) {
          throw new HttpError(
            400,
            `You have no ${normalizedResource} at Quality ${parsedQuality} to sell.`
          );
        }

        const currentAmount: number = resourceRow.rows[0].amount;

        // ---- STEP 4: Validate sufficient quantity ----
        if (currentAmount < parsedAmount) {
          throw new HttpError(
            400,
            `Insufficient ${normalizedResource} at Quality ${parsedQuality}. ` +
            `You have ${currentAmount} but tried to sell ${parsedAmount}.`
          );
        }

        // ---- STEP 5: Deduct the sold resource from inventory ----
        await client.query(
          `UPDATE inventories
           SET    amount = amount - $1
           WHERE  user_id     = $2
             AND  resource_id = $3
             AND  quality     = $4`,
          [parsedAmount, userId, normalizedResource, parsedQuality]
        );

        // ---- STEP 6: Credit Sestertius to the player ----
        //
        // SESTERTIUS is always at quality = 0 (currency has no quality tier).
        // ON CONFLICT uses the new 3-column PK (user_id, resource_id, quality).
        const sestertiumResult = await client.query<{ amount: number }>(
          `INSERT INTO inventories (user_id, resource_id, quality, amount)
           VALUES ($1, 'SESTERTIUS', 0, $2)
           ON CONFLICT (user_id, resource_id, quality) DO UPDATE
             SET amount = inventories.amount + EXCLUDED.amount
           RETURNING amount`,
          [userId, totalPayout]
        );

        return {
          resource_id:        normalizedResource,
          quality:            parsedQuality,
          amount_sold:        parsedAmount,
          price_per_unit:     pricePerUnit,
          quality_multiplier: qualityMultiplier,
          total_payout:       totalPayout,
          new_sestertius:     sestertiumResult.rows[0].amount,
          new_resource_amount: currentAmount - parsedAmount,
        };
      });

      const qualityLabel = result.quality > 0 ? ` Q${result.quality}` : '';
      res.status(200).json({
        message: `Sold ${result.amount_sold}${qualityLabel} ${result.resource_id} ` +
                 `for ${result.total_payout} Sestertius.`,
        trade: result,
      });

    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      next(error);
    }
  }
);

export default router;
