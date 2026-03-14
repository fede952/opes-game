/**
 * @file src/routes/buildings.ts
 * @description Building management: read roster, upgrade buildings, construct new buildings.
 *
 * ================================================================
 * ROUTES IN THIS FILE
 * ================================================================
 *
 *   GET  /api/v1/buildings         — Full building roster with jobs + levels.
 *   POST /api/v1/buildings/upgrade — Upgrade a building by 1 level.
 *   POST /api/v1/buildings/build   — Construct a new buildable building.
 *
 * ================================================================
 * PHASE 7 CHANGES FROM PHASE 6
 * ================================================================
 *
 * 1. PASSIVE BUILDING GUARD (POST /build)
 *    When constructing a passive building (HORREUM), skip the step that
 *    creates an output resource inventory row — passive buildings produce
 *    nothing and have no output resource.
 *
 * 2. ON CONFLICT KEY UPDATE
 *    All inventory upserts/creates now use the 3-column PK introduced in
 *    schema_v5_empire_expansion.sql: (user_id, resource_id, quality).
 *    SESTERTIUS deductions explicitly target quality = 0.
 *
 * 3. NEW BUILDABLE BUILDINGS (HORREUM, ACADEMIA)
 *    gameConfig.ts defines two new buildable building types:
 *      HORREUM  (passive, 200 Sestertius): adds +500 storage per level.
 *      ACADEMIA (active, 150 Sestertius): produces RESEARCH points.
 *    The build endpoint handles them automatically via BUILDING_CONFIGS.
 *
 * ================================================================
 * BUILDING LEVEL SYSTEM (Phase 6, unchanged)
 * ================================================================
 *
 *   yield_amount  = base_yield      × level
 *   wage_cost     = base_cost       × level
 *   input_amounts = base_input.amt  × level
 *   upgrade_cost  = upgrade_base_cost × level
 *
 * ================================================================
 * UPGRADE TRANSACTION: SESTERTIUS → BUILDING
 * ================================================================
 *
 *   1. Lock SESTERTIUS inventory row (Q0) first (SELECT FOR UPDATE)
 *   2. Lock building row second        (SELECT FOR UPDATE)
 *
 * ⚠️ CROSS-TABLE DEADLOCK AWARENESS:
 * production/start locks: building → inventory (alphabetical).
 * upgrade locks: SESTERTIUS inventory → building.
 * A simultaneous upgrade + start produces a cross-table deadlock resolved
 * by PostgreSQL (error 40P01 → 409 response). No data is corrupted.
 *
 * ================================================================
 * CONSTRUCTION TRANSACTION: POST /build
 * ================================================================
 *
 *   1a. Lock any build_cost_resources rows alphabetically by resource_id
 *       (e.g., LIGNUM row — L comes before S alphabetically, so it must
 *       be locked first to maintain a consistent cross-route lock order
 *       and prevent deadlocks with the production route).
 *   1b. Lock SESTERTIUS (Q0)
 *   2.  Validate all resource balances ≥ required amounts
 *   3.  Deduct build_cost_resources (e.g., LIGNUM)
 *   4.  Deduct Sestertius (Q0)
 *   5.  Insert new building row
 *   6.  Ensure output resource Q0 row exists (upsert, non-passive only)
 */

import { Router, Request, Response, NextFunction } from 'express';
import authMiddleware          from '../middleware/authMiddleware';
import { query, withTransaction } from '../db/connection';
import { BUILDING_CONFIGS }    from '../config/gameConfig';
import { HttpError }           from '../utils/HttpError';

const router = Router();

router.use(authMiddleware);

// ================================================================
// TYPES
// ================================================================

interface BuildingRow {
  id:            string;
  building_type: string;
  level:         number;
  job_id:        string | null;
  resource_type: string | null;
  quality:       number | null;
  start_time:    Date   | null;
  end_time:      Date   | null;
}

// ================================================================
// ROUTE: GET /api/v1/buildings
// ================================================================

/**
 * Returns the player's full building roster with live production state and levels.
 *
 * Phase 7: job now includes `target_quality` so the frontend can show
 * "Producing Q1 FARINA" instead of just "Producing FARINA".
 */
router.get(
  '/',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;

      const result = await query<BuildingRow>(
        `SELECT  ub.id,
                 ub.building_type,
                 ub.level,
                 pj.id             AS job_id,
                 pj.resource_type,
                 pj.quality,
                 pj.start_time,
                 pj.end_time
         FROM    user_buildings ub
         LEFT JOIN production_jobs pj
                ON pj.user_building_id = ub.id
         WHERE   ub.user_id = $1
         ORDER   BY ub.id ASC`,
        [userId]
      );

      const buildings = result.rows.map((row) => ({
        id:            row.id,
        building_type: row.building_type,
        level:         row.level,
        status:        row.job_id ? 'PRODUCING' : 'IDLE',
        job: row.job_id
          ? {
              id:            row.job_id,
              resource_type: row.resource_type,
              quality:       row.quality,
              start_time:    row.start_time,
              end_time:      row.end_time,
            }
          : null,
      }));

      res.status(200).json({ buildings });

    } catch (error) {
      next(error);
    }
  }
);

// ================================================================
// ROUTE: POST /api/v1/buildings/upgrade
// ================================================================

/**
 * Upgrades the specified building by 1 level.
 *
 * Phase 7 change: SESTERTIUS lock and deduction now explicitly target quality = 0.
 *
 * UPGRADE COST FORMULA:
 *   cost = upgrade_base_cost × current_level
 *
 * TRANSACTION LOCK ORDER:
 *   Step 1: Lock SESTERTIUS row (Q0) in inventories (SELECT FOR UPDATE)
 *   Step 2: Lock building row in user_buildings    (SELECT FOR UPDATE)
 *
 * Request body: { "user_building_id": "uuid" }
 */
router.post(
  '/upgrade',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;
      const { user_building_id } = req.body as { user_building_id?: unknown };

      // Accept as either a number (integer DB id) or a numeric string.
      const parsedBuildingId =
        typeof user_building_id === 'number'
          ? Math.floor(user_building_id)
          : parseInt(String(user_building_id), 10);

      if (!Number.isFinite(parsedBuildingId) || parsedBuildingId <= 0) {
        res.status(400).json({ error: 'user_building_id is required.' });
        return;
      }

      const upgradeResult = await withTransaction(async (client) => {

        // ---- STEP 1: Lock the player's SESTERTIUS row at quality = 0 ----
        const sestertiumRow = await client.query<{ amount: number }>(
          `SELECT amount
           FROM   inventories
           WHERE  user_id = $1 AND resource_id = 'SESTERTIUS' AND quality = 0
           FOR UPDATE`,
          [userId]
        );

        const currentSestertius: number = sestertiumRow.rows[0]?.amount ?? 0;

        // ---- STEP 2: Lock the building row ----
        const buildingRow = await client.query<{
          id:            string;
          building_type: string;
          level:         number;
        }>(
          `SELECT id, building_type, level
           FROM   user_buildings
           WHERE  id = $1 AND user_id = $2
           FOR UPDATE`,
          [parsedBuildingId, userId]
        );

        if (buildingRow.rowCount === 0) {
          throw new HttpError(404, 'Building not found.');
        }

        const building = buildingRow.rows[0];

        // ---- STEP 3: Look up configuration and calculate upgrade cost ----
        const config = BUILDING_CONFIGS[building.building_type];
        if (!config) {
          throw new HttpError(400, `Unknown building type: '${building.building_type}'.`);
        }

        const upgradeCost: number = config.upgrade_base_cost * building.level;

        // ---- STEP 4: Validate sufficient Sestertius ----
        if (currentSestertius < upgradeCost) {
          throw new HttpError(
            400,
            `Insufficient Sestertius. Upgrading this building to level ` +
            `${building.level + 1} requires ${upgradeCost} Sestertius ` +
            `but you only have ${currentSestertius}.`
          );
        }

        // ---- STEP 5: Deduct the upgrade cost from Sestertius at Q0 ----
        await client.query(
          `UPDATE inventories
           SET    amount = amount - $1
           WHERE  user_id = $2 AND resource_id = 'SESTERTIUS' AND quality = 0`,
          [upgradeCost, userId]
        );

        // ---- STEP 6: Increment the building's level ----
        const updatedBuilding = await client.query<{ level: number }>(
          `UPDATE user_buildings
           SET    level = level + 1
           WHERE  id = $1
           RETURNING level`,
          [building.id]
        );

        const newLevel: number = updatedBuilding.rows[0].level;
        const nextUpgradeCost: number = config.upgrade_base_cost * newLevel;

        return {
          building_id:       building.id,
          building_type:     building.building_type,
          old_level:         building.level,
          new_level:         newLevel,
          cost_paid:         upgradeCost,
          next_upgrade_cost: nextUpgradeCost,
        };
      });

      res.status(200).json({
        message:  `${upgradeResult.building_type} upgraded from ` +
                  `Level ${upgradeResult.old_level} to Level ${upgradeResult.new_level}. ` +
                  `Cost: ${upgradeResult.cost_paid} Sestertius.`,
        upgrade:  upgradeResult,
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
// ROUTE: POST /api/v1/buildings/build
// ================================================================

/**
 * Constructs a new building for the player.
 *
 * Phase 7: adds support for HORREUM (passive) and ACADEMIA.
 *   HORREUM: passive building — skips the output inventory row creation step
 *            because passive buildings have no output resource.
 *   ACADEMIA: standard production building — creates a RESEARCH Q0 row.
 *
 * Phase 7 ON CONFLICT: uses 3-column PK (user_id, resource_id, quality).
 *
 * Request body: { "building_type": "PISTRINUM" | "HORREUM" | "ACADEMIA" }
 *
 * SUCCESS: 201 Created
 * ERRORS:  400 (insufficient funds / unknown type / starter building)
 */
router.post(
  '/build',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;

      const { building_type } = req.body as { building_type?: unknown };

      if (typeof building_type !== 'string' || building_type.trim().length === 0) {
        res.status(400).json({ error: 'building_type is required.' });
        return;
      }

      const normalizedType = building_type.trim().toUpperCase();
      const config = BUILDING_CONFIGS[normalizedType];

      if (!config) {
        res.status(400).json({ error: `Unknown building type: '${normalizedType}'.` });
        return;
      }

      if (config.build_cost === undefined) {
        res.status(400).json({
          error: `'${normalizedType}' is a starter building assigned at registration. ` +
                 `It cannot be constructed via this endpoint.`,
        });
        return;
      }

      const buildCost: number = config.build_cost;

      // Sort resource costs alphabetically so we always lock in the same order.
      // LIGNUM (L) must be locked before SESTERTIUS (S) to avoid deadlocks with
      // the production/start route, which also locks inventory alphabetically.
      const resourceCosts = [...(config.build_cost_resources ?? [])].sort(
        (a, b) => a.resource.localeCompare(b.resource)
      );

      const newBuilding = await withTransaction(async (client) => {

        // ---- STEP 1a: Lock and validate build_cost_resources (alphabetical) ----
        //
        // We lock these BEFORE SESTERTIUS because their resource_id values
        // (e.g., 'LIGNUM') sort before 'SESTERTIUS' alphabetically.
        // Consistent lock ordering across all routes prevents deadlocks.
        const lockedResources: Array<{ resource: string; required: number }> = [];

        for (const { resource, amount: required } of resourceCosts) {
          const row = await client.query<{ amount: number }>(
            `SELECT amount
             FROM   inventories
             WHERE  user_id = $1 AND resource_id = $2 AND quality = 0
             FOR UPDATE`,
            [userId, resource]
          );

          const current: number = row.rows[0]?.amount ?? 0;

          if (current < required) {
            throw new HttpError(
              400,
              `Insufficient ${resource}. Constructing a ${normalizedType} requires ` +
              `${required} ${resource} but you only have ${current}.`
            );
          }

          lockedResources.push({ resource, required });
        }

        // ---- STEP 1b: Lock SESTERTIUS row at quality = 0 ----
        //
        // Locked AFTER build_cost_resources because 'SESTERTIUS' sorts after
        // all current material resource IDs alphabetically.
        const sestertiumRow = await client.query<{ amount: number }>(
          `SELECT amount
           FROM   inventories
           WHERE  user_id = $1 AND resource_id = 'SESTERTIUS' AND quality = 0
           FOR UPDATE`,
          [userId]
        );

        const currentSestertius: number = sestertiumRow.rows[0]?.amount ?? 0;

        // ---- STEP 2: Validate Sestertius balance ----
        if (currentSestertius < buildCost) {
          throw new HttpError(
            400,
            `Insufficient Sestertius. Constructing a ${normalizedType} requires ` +
            `${buildCost} Sestertius but you only have ${currentSestertius}.`
          );
        }

        // ---- STEP 3: Deduct build_cost_resources from inventory (Q0) ----
        for (const { resource, required } of lockedResources) {
          await client.query(
            `UPDATE inventories
             SET    amount = amount - $1
             WHERE  user_id = $2 AND resource_id = $3 AND quality = 0`,
            [required, userId, resource]
          );
        }

        // ---- STEP 4: Deduct construction cost from SESTERTIUS (Q0) ----
        await client.query(
          `UPDATE inventories
           SET    amount = amount - $1
           WHERE  user_id = $2 AND resource_id = 'SESTERTIUS' AND quality = 0`,
          [buildCost, userId]
        );

        // ---- STEP 5: Insert the new building ----
        const buildingResult = await client.query<{
          id:            string;
          building_type: string;
          level:         number;
        }>(
          `INSERT INTO user_buildings (user_id, building_type)
           VALUES ($1, $2)
           RETURNING id, building_type, level`,
          [userId, normalizedType]
        );

        // ---- STEP 6: Ensure output resource Q0 inventory row exists ----
        //
        // Skip for passive buildings (HORREUM has no output resource).
        // For production buildings, ensure the player can receive the new
        // resource type even if they've never seen it before.
        // Uses the 3-column ON CONFLICT (user_id, resource_id, quality).
        if (!config.passive && config.output) {
          await client.query(
            `INSERT INTO inventories (user_id, resource_id, quality, amount)
             VALUES ($1, $2, 0, 0)
             ON CONFLICT (user_id, resource_id, quality) DO NOTHING`,
            [userId, config.output]
          );
        }

        return buildingResult.rows[0];
      });

      const outputInfo = config.passive
        ? `Increases storage capacity by ${500} units per level.`
        : `Ready to produce ${config.output} at Level 1.`;

      res.status(201).json({
        message:  `${normalizedType} constructed successfully! ${outputInfo}`,
        building: newBuilding,
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
