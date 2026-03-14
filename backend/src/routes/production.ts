/**
 * @file src/routes/production.ts
 * @description Time-based production: start a run (consuming wages + inputs) and collect output.
 *
 * ================================================================
 * PHASE 7 CHANGES FROM PHASE 6
 * ================================================================
 *
 * 1. QUALITY SYSTEM (POST /start)
 *    Clients now submit an optional `quality` parameter (0, 1, or 2).
 *    Producing at quality > 0 requires additional RESEARCH point inputs:
 *      Q1: 2 RESEARCH consumed  |  Q2: 4 RESEARCH consumed
 *    The job records `target_quality`, which determines which inventory
 *    row receives the output on collect.
 *    RESEARCH resources can only be produced at Q0 (quality-researching
 *    research would be circular and is rejected server-side).
 *
 * 2. PASSIVE BUILDING GUARD (POST /start)
 *    HORREUM (Warehouse) is a passive building — it has no production runs.
 *    Attempting to start production on a passive building returns 400.
 *
 * 3. STORAGE LIMIT CHECK (POST /collect)
 *    Before awarding the collected resource, we verify the player's
 *    physical inventory has room. If adding yield_amount would exceed
 *    the player's storage capacity, the collect is rejected with 400.
 *    SESTERTIUS and RESEARCH are weightless and skip this check.
 *
 * 4. INVENTORY KEY CHANGE
 *    All SELECT/UPDATE/INSERT on inventories now include `quality`.
 *    The new PK is (user_id, resource_id, quality).
 *    Consumed resources (wages, material inputs, RESEARCH) are always
 *    at quality = 0. Output quality is determined by `target_quality`.
 *
 * ================================================================
 * DEADLOCK PREVENTION — ALPHABETICAL LOCK ORDERING (UNCHANGED)
 * ================================================================
 *
 * When starting production with quality > 0 on PISTRINUM, the full sorted
 * lock order for resources consumed at Q0 is:
 *   FRUMENTUM < RESEARCH < SESTERTIUS  (alphabetical)
 *
 * The sort in Step 5 handles RESEARCH automatically since it is in the same
 * `resourcesToConsume` array as the other inputs.
 *
 * ================================================================
 * LOCK ORDERING — BUILDING ROW BEFORE INVENTORY ROWS (UNCHANGED)
 * ================================================================
 *
 * We lock user_buildings FIRST, then inventory rows (alphabetically).
 * The buildings.ts POST /upgrade endpoint locks in the opposite order
 * (SESTERTIUS first, then building). See buildings.ts for the cross-table
 * deadlock discussion.
 */

import { Router, Request, Response, NextFunction } from 'express';
import authMiddleware               from '../middleware/authMiddleware';
import { withTransaction }          from '../db/connection';
import { BUILDING_CONFIGS }         from '../config/gameConfig';
import { HttpError }                from '../utils/HttpError';
import { getStorageState, WEIGHTLESS_RESOURCES } from '../utils/storageUtils';

const router = Router();

router.use(authMiddleware);

// ================================================================
// CONSTANTS
// ================================================================

/**
 * Maximum quality tier a player can request.
 * Q0 = standard | Q1 = fine | Q2 = masterwork.
 */
const MAX_QUALITY = 2;

/**
 * RESEARCH points consumed per quality tier above 0.
 * Consuming Q1 requires 1 × 2 = 2 RESEARCH.
 * Consuming Q2 requires 2 × 2 = 4 RESEARCH.
 */
const RESEARCH_COST_PER_QUALITY = 2;

// ================================================================
// ROUTE: POST /api/v1/production/start
// ================================================================

/**
 * Starts a production run for the specified building.
 *
 * Phase 7 additions:
 *   - Rejects passive buildings (HORREUM).
 *   - Accepts optional `quality` (0–2); defaults to 0.
 *   - Adds RESEARCH cost to resourcesToConsume when quality > 0.
 *   - Stores target_quality in the production_jobs row.
 *   - All inventory locks and deductions target quality = 0 for
 *     consumed resources; target_quality applies only to the OUTPUT.
 *
 * REQUEST BODY: { "building_id": "uuid", "quality": 0 }
 *
 * SUCCESS: 200 OK
 * {
 *   message: "Production started. Collect after 60 seconds.",
 *   building: { id, building_type, level, status: "PRODUCING", job: {...} }
 * }
 *
 * ERRORS:
 *   400 — building_id missing / passive building / unknown type
 *   400 — quality is not 0, 1, or 2
 *   400 — insufficient Sestertius / inputs / RESEARCH
 *   404 — building not found
 *   409 — building already producing
 */
router.post(
  '/start',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;
      const { building_id, quality } = req.body as {
        building_id?: unknown;
        quality?:     unknown;
      };

      if (typeof building_id !== 'string' || building_id.trim().length === 0) {
        res.status(400).json({ error: 'building_id is required.' });
        return;
      }

      // Parse and validate quality.
      const parsedQuality =
        quality === undefined || quality === null
          ? 0
          : typeof quality === 'number'
            ? Math.floor(quality)
            : parseInt(String(quality), 10);

      if (!Number.isFinite(parsedQuality) || parsedQuality < 0 || parsedQuality > MAX_QUALITY) {
        res.status(400).json({ error: `quality must be 0, 1, or 2.` });
        return;
      }

      const result = await withTransaction(async (client) => {

        // ---- STEP 1: Lock the building row and check for an active job ----
        //
        // user_buildings has no status column — IDLE/PRODUCING is derived from
        // whether a production_jobs row exists for this building.
        const buildingResult = await client.query<{
          id:              string;
          building_type:   string;
          level:           number;
          active_job_id:   string | null;
        }>(
          `SELECT ub.id, ub.building_type, ub.level,
                  pj.id AS active_job_id
           FROM   user_buildings ub
           LEFT JOIN production_jobs pj ON pj.user_building_id = ub.id
           WHERE  ub.id = $1 AND ub.user_id = $2
           FOR UPDATE OF ub`,
          [building_id.trim(), userId]
        );

        if (buildingResult.rowCount === 0) {
          throw new HttpError(404, 'Building not found.');
        }

        const building = buildingResult.rows[0];

        // ---- STEP 2: Validate IDLE status ----
        if (building.active_job_id !== null) {
          throw new HttpError(
            409,
            'Building is already producing. Collect the current job first.'
          );
        }

        // ---- STEP 3: Look up the building configuration ----
        const config = BUILDING_CONFIGS[building.building_type];
        if (!config) {
          throw new HttpError(400, `Unknown building type: '${building.building_type}'.`);
        }

        // ---- Phase 7: Reject passive buildings ----
        //
        // HORREUM (warehouse) is a passive building: it adds storage capacity
        // but cannot run production jobs. Attempting to start a run on it is
        // a client error, not a server error.
        if (config.passive === true) {
          throw new HttpError(
            400,
            `'${building.building_type}' is a passive building and cannot produce resources. ` +
            `Its effect (storage bonus) is applied automatically based on its level.`
          );
        }

        // ---- Phase 7: Block quality production for RESEARCH ----
        //
        // RESEARCH is an abstract resource (knowledge/study points).
        // It has no meaningful "quality tier" — you cannot quality-research research.
        // Enforce this server-side so the constraint cannot be bypassed.
        if (parsedQuality > 0 && config.output === 'RESEARCH') {
          throw new HttpError(
            400,
            'Research cannot be produced at a higher quality. Use quality: 0 for ACADEMIA.'
          );
        }

        const level: number = building.level;

        // ---- STEP 4: Calculate level-scaled costs and yield ----
        const wageCost:    number = config.base_cost  * level;
        const yieldAmount: number = config.base_yield * level;
        const resourceId:  string = config.output;

        // ---- STEP 5: Build the sorted list of resources to lock and deduct ----
        //
        // All consumed resources are deducted at quality = 0:
        //   - Wages (SESTERTIUS) — currency is quality-neutral
        //   - Material inputs (e.g., FRUMENTUM) — use standard-grade inputs
        //   - RESEARCH points — always quality-neutral
        //
        // ⚠️ CRITICAL: Sort alphabetically BEFORE locking.
        // Phase 7 adds RESEARCH ('R' between 'F' and 'S') to the list.
        // Sorted order: FRUMENTUM < RESEARCH < SESTERTIUS
        const resourcesToConsume: Array<{ resource_id: string; amount: number }> = [];

        if (wageCost > 0) {
          resourcesToConsume.push({ resource_id: 'SESTERTIUS', amount: wageCost });
        }

        for (const input of config.inputs) {
          const scaledInputAmount: number = input.amount * level;
          if (scaledInputAmount > 0) {
            resourcesToConsume.push({ resource_id: input.resource, amount: scaledInputAmount });
          }
        }

        // Add RESEARCH cost for quality > 0.
        // Q1: 2 RESEARCH | Q2: 4 RESEARCH
        if (parsedQuality > 0) {
          const researchCost: number = parsedQuality * RESEARCH_COST_PER_QUALITY;
          resourcesToConsume.push({ resource_id: 'RESEARCH', amount: researchCost });
        }

        // Alphabetical sort — DEADLOCK PREVENTION.
        // For a Q1 PISTRINUM: FRUMENTUM ('F'), RESEARCH ('R'), SESTERTIUS ('S').
        // All concurrent transactions acquire locks in this same order.
        resourcesToConsume.sort((a, b) => a.resource_id.localeCompare(b.resource_id));

        // ---- STEP 6: Lock + validate each inventory row in sorted order ----
        //
        // We lock at quality = 0 for ALL consumed resources. Wages, material
        // inputs, and RESEARCH are all standard-grade (Q0) goods.
        for (const { resource_id, amount } of resourcesToConsume) {
          const inventoryRow = await client.query<{ amount: number }>(
            `SELECT amount
             FROM   inventories
             WHERE  user_id     = $1
               AND  resource_id = $2
               AND  quality     = 0
             FOR UPDATE`,
            [userId, resource_id]
          );

          const available: number = inventoryRow.rows[0]?.amount ?? 0;

          if (available < amount) {
            const label =
              resource_id === 'SESTERTIUS'
                ? `Sestertius (wages for Level ${level} production)`
                : resource_id === 'RESEARCH'
                  ? `Research points (Quality ${parsedQuality} premium: need ${amount})`
                  : resource_id;

            throw new HttpError(
              400,
              `Insufficient ${label}. Need ${amount}, you have ${available}.`
            );
          }
        }

        // ---- STEP 7: Deduct all required resources at quality = 0 ----
        for (const { resource_id, amount } of resourcesToConsume) {
          await client.query(
            `UPDATE inventories
             SET    amount = amount - $1
             WHERE  user_id     = $2
               AND  resource_id = $3
               AND  quality     = 0`,
            [amount, userId, resource_id]
          );
        }

        // ---- STEP 8: Insert the production job with target_quality ----
        //
        // target_quality records the intended output tier.
        // The collect endpoint reads this to determine which inventory row
        // to credit (e.g., insert into quality=1 for a Q1 production run).
        // duration_seconds is defined per building type in gameConfig.ts.
        // Different buildings have different cycle times (Phase 11 rebalance):
        //   CASTRA_LIGNATORUM / FUNDUS_FRUMENTI: 900 s (15 min)
        //   PISTRINUM: 3600 s (60 min)
        //   ACADEMIA:  1800 s (30 min)
        const durationSeconds: number = config.duration_seconds;

        const jobResult = await client.query<{
          id:            string;
          resource_type: string;
          quality:       number;
          start_time:    Date;
          end_time:      Date;
        }>(
          `INSERT INTO production_jobs
                (user_building_id, resource_type, quality, end_time)
           VALUES ($1, $2, $3, NOW() + ($4::INTEGER * INTERVAL '1 second'))
           RETURNING id, resource_type, quality, start_time, end_time`,
          [building.id, resourceId, parsedQuality, durationSeconds]
        );

        const job = jobResult.rows[0];

        return { building, job, yieldAmount };
      });

      const durationSeconds = Math.ceil(
        (result.job.end_time.getTime() - Date.now()) / 1000
      );
      res.status(200).json({
        message: `Production started. Collect after ${durationSeconds} seconds.`,
        building: {
          id:            result.building.id,
          building_type: result.building.building_type,
          level:         result.building.level,
          status:        'PRODUCING',
          job:           { ...result.job, yield_amount: result.yieldAmount },
        },
      });

    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }

      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code: string }).code === '23505'
      ) {
        res.status(409).json({ error: 'Building is already producing.' });
        return;
      }

      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code: string }).code === '40P01'
      ) {
        res.status(409).json({
          error: 'Transaction conflict detected. Please try again.',
        });
        return;
      }

      next(error);
    }
  }
);

// ================================================================
// ROUTE: POST /api/v1/production/collect
// ================================================================

/**
 * Collects the output of a completed production run.
 *
 * Phase 7 additions:
 *   - Reads `target_quality` from the job row.
 *   - Performs a storage capacity check before awarding the resource.
 *     If physical storage is full, returns 400 "Insufficient storage capacity".
 *   - Awards the resource at the job's target_quality tier using the
 *     3-column ON CONFLICT (user_id, resource_id, quality) key.
 *
 * SESTERTIUS and RESEARCH skip the storage check (they are weightless).
 *
 * REQUEST BODY: { "building_id": "uuid" }
 *
 * SUCCESS: 200 OK
 * { message: "Collected 15 FARINA.", collected: { resource_id, quality, amount_collected, new_inventory_amount } }
 *
 * ERRORS:
 *   400 — building_id missing
 *   400 — insufficient storage capacity
 *   404 — building not found or no active job
 *   409 — production not yet complete
 */
router.post(
  '/collect',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId          = req.userId!;
      const { building_id } = req.body as { building_id?: unknown };

      if (typeof building_id !== 'string' || building_id.trim().length === 0) {
        res.status(400).json({ error: 'building_id is required.' });
        return;
      }

      const collected = await withTransaction(async (client) => {

        // ---- STEP 1: Lock the building and fetch the job ----
        const lockResult = await client.query<{
          job_id:        string;
          resource_type: string;
          quality:       number;
          end_time:      Date;
          level:         number;
          building_type: string;
        }>(
          `SELECT  pj.id             AS job_id,
                   pj.resource_type,
                   pj.quality,
                   pj.end_time,
                   ub.level,
                   ub.building_type
           FROM    user_buildings ub
           JOIN    production_jobs pj ON pj.user_building_id = ub.id
           WHERE   ub.id = $1 AND ub.user_id = $2
           FOR UPDATE OF ub`,
          [building_id.trim(), userId]
        );

        if (lockResult.rowCount === 0) {
          throw new HttpError(404, 'Building not found or no active production job.');
        }

        const { job_id, resource_type, quality, end_time, level, building_type } =
          lockResult.rows[0];

        // Compute yield from building config and current level (yield_amount is not stored in DB).
        const collectConfig = BUILDING_CONFIGS[building_type];
        const yield_amount: number = collectConfig ? collectConfig.base_yield * level : 0;
        const resource_id = resource_type;

        // ---- STEP 2: Verify production is complete ----
        if (new Date() < end_time) {
          const remainingSeconds = Math.ceil(
            (end_time.getTime() - Date.now()) / 1000
          );
          throw new HttpError(
            409,
            `Production not yet complete. ${remainingSeconds} second(s) remaining.`
          );
        }

        // ---- Phase 7: STEP 3 — Storage capacity check ----
        //
        // Physical resources (not SESTERTIUS, not RESEARCH) consume storage slots.
        // If awarding yield_amount would push the player over their capacity, reject
        // the collect and ask them to make room (sell or trade first).
        //
        // Note: the check reads current storage state at the start of the
        // transaction. See storageUtils.ts for notes on the concurrency model.
        if (!WEIGHTLESS_RESOURCES.has(resource_id)) {
          const storage = await getStorageState(client, userId);

          if (storage.used + yield_amount > storage.capacity) {
            throw new HttpError(
              400,
              `Insufficient storage capacity. ` +
              `You have ${storage.capacity - storage.used} free slots ` +
              `but need ${yield_amount} to collect this production run. ` +
              `Build or upgrade a Horreum (Warehouse) to increase capacity, ` +
              `or sell some resources first.`
            );
          }
        }

        // ---- STEP 4: Award resources at the target quality tier ----
        //
        // ON CONFLICT now uses the 3-column PK (user_id, resource_id, quality).
        // If the player has never collected this (resource, quality) before, a
        // new row is inserted. If they have, the amount is added to the existing row.
        const inventoryResult = await client.query<{
          resource_id: string;
          quality:     number;
          amount:      number;
        }>(
          `INSERT INTO inventories (user_id, resource_id, quality, amount)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, resource_id, quality) DO UPDATE
             SET amount = inventories.amount + EXCLUDED.amount
           RETURNING resource_id, quality, amount`,
          [userId, resource_id, quality, yield_amount]
        );

        // ---- STEP 5: Delete the completed production job ----
        await client.query(
          `DELETE FROM production_jobs WHERE id = $1`,
          [job_id]
        );

        return {
          resource_id,
          quality,
          amount_collected:     yield_amount,
          new_inventory_amount: inventoryResult.rows[0]?.amount ?? yield_amount,
        };
      });

      const qualityLabel = collected.quality > 0 ? ` Q${collected.quality}` : '';
      res.status(200).json({
        message:   `Collected ${collected.amount_collected}${qualityLabel} ${collected.resource_id}.`,
        collected,
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
