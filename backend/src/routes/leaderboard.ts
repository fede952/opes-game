/**
 * @file src/routes/leaderboard.ts
 * @description Global Senate Leaderboard: top 50 players ranked by net worth.
 *
 * ================================================================
 * NET WORTH FORMULA
 * ================================================================
 *
 *   net_worth = sestertius_balance
 *             + inventory_value
 *             + building_value
 *
 *   sestertius_balance:
 *     The player's Sestertius at quality = 0.
 *
 *   inventory_value:
 *     For each physical resource row (excluding SESTERTIUS and RESEARCH):
 *       FLOOR(amount × current_npc_buy_price × (1 + quality × 0.5))
 *     Summed across all (resource_id, quality) rows the player owns.
 *     Resources not in npc_prices (e.g., RESEARCH) are valued at 0.
 *
 *   building_value:
 *     For each building owned:
 *       upgrade_base_cost × level
 *     The upgrade_base_cost values are embedded as a CASE expression
 *     mirroring BUILDING_CONFIGS in gameConfig.ts:
 *       CASTRA_LIGNATORUM = 50
 *       FUNDUS_FRUMENTI   = 50
 *       PISTRINUM         = 100
 *       HORREUM           = 150
 *       ACADEMIA          = 75
 *
 * ================================================================
 * IMPLEMENTATION NOTES
 * ================================================================
 *
 * The query uses CTEs (WITH clauses) to compute each component separately,
 * then joins them to the users table. BIGINT arithmetic is used throughout
 * to avoid INT overflow for large amounts.
 *
 * This endpoint does NOT lock any rows — it is a read-only snapshot.
 * Slight inconsistency is acceptable for a leaderboard display.
 */

import { Router, Request, Response, NextFunction } from 'express';
import authMiddleware from '../middleware/authMiddleware';
import { query }      from '../db/connection';

const router = Router();

router.use(authMiddleware);

// ================================================================
// ROUTE: GET /api/v1/leaderboard
// ================================================================

/**
 * Returns the top 50 players ranked by calculated net worth.
 *
 * SUCCESS: 200 OK
 * {
 *   leaderboard: [
 *     {
 *       rank:           1,
 *       user_id:        "uuid",
 *       username:       "marcus",
 *       sestertius:     1000,
 *       inventory_value: 450,
 *       building_value:  300,
 *       net_worth:      1750
 *     },
 *     ...
 *   ]
 * }
 */
router.get(
  '/',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await query<{
        rank:            string;   // PostgreSQL ROW_NUMBER() returns bigint as string
        user_id:         string;
        username:        string;
        sestertius:      string;
        inventory_value: string;
        building_value:  string;
        net_worth:       string;
      }>(
        `WITH

          -- ----------------------------------------------------------------
          -- CTE 1: Sestertius balance per user
          -- Always quality = 0 (currency has no quality tier).
          -- ----------------------------------------------------------------
          sest AS (
            SELECT user_id,
                   COALESCE(amount, 0)::BIGINT AS sest_value
            FROM   inventories
            WHERE  resource_id = 'SESTERTIUS'
              AND  quality = 0
          ),

          -- ----------------------------------------------------------------
          -- CTE 2: Physical inventory value per user
          -- Joins inventories with npc_prices to get current market value.
          -- Applies quality multiplier: FLOOR(amount × price × (1 + quality × 0.5))
          -- Excludes SESTERTIUS (counted separately) and RESEARCH (no NPC price).
          -- ----------------------------------------------------------------
          inv AS (
            SELECT   i.user_id,
                     COALESCE(
                       SUM(
                         FLOOR(
                           i.amount::NUMERIC *
                           np.current_buy_price::NUMERIC *
                           (1 + i.quality * 0.5)
                         )::BIGINT
                       ),
                       0
                     ) AS inv_value
            FROM     inventories i
            JOIN     npc_prices np ON np.resource_id = i.resource_id
            WHERE    i.resource_id NOT IN ('SESTERTIUS', 'RESEARCH')
            GROUP BY i.user_id
          ),

          -- ----------------------------------------------------------------
          -- CTE 3: Building portfolio value per user
          -- Uses upgrade_base_cost × level as the per-building capital value.
          -- upgrade_base_cost values mirror BUILDING_CONFIGS in gameConfig.ts.
          -- ----------------------------------------------------------------
          bldg AS (
            SELECT   user_id,
                     COALESCE(
                       SUM(
                         CASE building_type
                           WHEN 'CASTRA_LIGNATORUM' THEN 50
                           WHEN 'FUNDUS_FRUMENTI'   THEN 50
                           WHEN 'PISTRINUM'         THEN 100
                           WHEN 'HORREUM'           THEN 150
                           WHEN 'ACADEMIA'          THEN 75
                           ELSE 0
                         END * level
                       )::BIGINT,
                       0
                     ) AS bldg_value
            FROM     user_buildings
            GROUP BY user_id
          )

        SELECT
          ROW_NUMBER() OVER (ORDER BY
            COALESCE(s.sest_value, 0) +
            COALESCE(i.inv_value, 0) +
            COALESCE(b.bldg_value, 0)
          DESC) AS rank,
          u.id       AS user_id,
          u.username,
          COALESCE(s.sest_value, 0) AS sestertius,
          COALESCE(i.inv_value,  0) AS inventory_value,
          COALESCE(b.bldg_value, 0) AS building_value,
          COALESCE(s.sest_value, 0) +
          COALESCE(i.inv_value,  0) +
          COALESCE(b.bldg_value, 0) AS net_worth
        FROM       users u
        LEFT JOIN  sest s  ON s.user_id  = u.id
        LEFT JOIN  inv  i  ON i.user_id  = u.id
        LEFT JOIN  bldg b  ON b.user_id  = u.id
        ORDER BY   net_worth DESC
        LIMIT      50`
      );

      // Convert BigInt string columns to numbers.
      // PostgreSQL returns BIGINT and ROW_NUMBER() as strings in the pg driver.
      const leaderboard = result.rows.map((row) => ({
        rank:            parseInt(row.rank, 10),
        user_id:         row.user_id,
        username:        row.username,
        sestertius:      parseInt(row.sestertius,      10),
        inventory_value: parseInt(row.inventory_value, 10),
        building_value:  parseInt(row.building_value,  10),
        net_worth:       parseInt(row.net_worth,       10),
      }));

      res.status(200).json({ leaderboard });

    } catch (error) {
      next(error);
    }
  }
);

export default router;
