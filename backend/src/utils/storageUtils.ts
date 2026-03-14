/**
 * @file src/utils/storageUtils.ts
 * @description Utility for computing a player's current storage usage vs. capacity.
 *
 * ================================================================
 * STORAGE SYSTEM (Phase 7)
 * ================================================================
 *
 * Not all resources occupy physical storage space in a player's settlement.
 * "Weightless" resources (SESTERTIUS and RESEARCH) are abstract: coins
 * in a treasury ledger and scholarly notes in a library — they never take
 * up warehouse shelf space.
 *
 * Physical resources (LIGNUM, FRUMENTUM, FARINA, and any future goods) do
 * occupy space. Each unit counts as 1 storage slot regardless of quality —
 * a barrel of Q1 flour takes the same space as a barrel of Q0 flour.
 *
 * ================================================================
 * CAPACITY FORMULA
 * ================================================================
 *
 *   max_capacity = BASE_CAPACITY + SUM(horreum.level × 500)
 *
 * where BASE_CAPACITY = 500 and the SUM is over all HORREUM buildings
 * owned by the player.
 *
 * Examples:
 *   No HORREUM:             500 units
 *   1× HORREUM level 1:    1000 units  (+500)
 *   1× HORREUM level 2:    1500 units  (+1000)
 *   2× HORREUM level 1:    1500 units  (+500, +500)
 *   1× HORREUM level 3:    2000 units  (+1500)
 *
 * ================================================================
 * WHY THIS RUNS INSIDE A TRANSACTION
 * ================================================================
 *
 * getStorageState() is designed to be called INSIDE a withTransaction()
 * callback, using the transaction's PoolClient. This ensures the storage
 * check reads the same consistent snapshot as the subsequent INSERT/UPDATE
 * that would award the new resources. A separate connection could see a
 * stale or uncommitted state.
 *
 * For concurrent collect/buy operations:
 *   The storage check is a "soft" pre-flight — it reads the committed sum
 *   at the start of the transaction. In a high-concurrency scenario, two
 *   simultaneous collects could both pass the check and both commit,
 *   temporarily exceeding capacity by a small margin. For a game context
 *   this is acceptable — exact atomicity of storage would require a
 *   separate row-level lock on a "storage counter" row, adding significant
 *   complexity for minimal gameplay benefit.
 */

import { PoolClient } from 'pg';

// ================================================================
// CONSTANTS
// ================================================================

/**
 * Base storage capacity every player always has, regardless of buildings.
 * 500 units is enough to hold several production runs at level 1.
 */
const BASE_CAPACITY = 500;

/**
 * Resources that do NOT count towards storage capacity.
 *
 * SESTERTIUS — Currency. Coins are stored in a treasury, not a warehouse.
 * RESEARCH   — Research points. Abstract knowledge, not physical goods.
 *
 * Using a Set for O(1) membership check when filtering inventory rows.
 */
export const WEIGHTLESS_RESOURCES = new Set<string>(['SESTERTIUS', 'RESEARCH']);

// ================================================================
// TYPE
// ================================================================

export interface StorageState {
  /** Total storage slots currently occupied by physical resources. */
  used: number;
  /** Maximum storage slots available based on base + HORREUM buildings. */
  capacity: number;
}

// ================================================================
// FUNCTION
// ================================================================

/**
 * Computes the player's current storage usage and maximum capacity.
 *
 * MUST be called inside a withTransaction() callback with the transaction
 * client. Both queries run on the same client, ensuring a consistent read.
 *
 * @param client - The PoolClient from an active withTransaction() call.
 * @param userId - The player's UUID (from authMiddleware).
 * @returns A StorageState with `used` and `capacity` integers.
 */
export async function getStorageState(
  client: PoolClient,
  userId:  string
): Promise<StorageState> {

  // ---- QUERY 1: Count all physical resource units ----
  //
  // SUM(amount) across all quality tiers of all non-weightless resources.
  // A player with 50 Q0 LIGNUM and 10 Q1 LIGNUM has 60 LIGNUM units
  // consuming 60 storage slots.
  //
  // COALESCE(SUM(...), 0) returns 0 when the player has no physical
  // resources yet, rather than NULL (which parseInt would misread as NaN).
  const usedResult = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM   inventories
     WHERE  user_id     = $1
       AND  resource_id NOT IN ('SESTERTIUS', 'RESEARCH')`,
    [userId]
  );

  // ---- QUERY 2: Calculate capacity bonus from HORREUM buildings ----
  //
  // Each HORREUM at level N contributes N × 500 capacity.
  // SUM aggregates across ALL HORREUMs the player has built.
  //
  //   1× lv.1 HORREUM: 1×500 = 500 bonus → total 1000
  //   1× lv.2 HORREUM: 2×500 = 1000 bonus → total 1500
  //   2× lv.1 HORREUMs: 2×500 = 1000 bonus → total 1500
  const capacityResult = await client.query<{ bonus: string }>(
    `SELECT COALESCE(SUM(level * 500), 0) AS bonus
     FROM   user_buildings
     WHERE  user_id       = $1
       AND  building_type = 'HORREUM'`,
    [userId]
  );

  const used:     number = parseInt(usedResult.rows[0].total,    10);
  const bonus:    number = parseInt(capacityResult.rows[0].bonus, 10);
  const capacity: number = BASE_CAPACITY + bonus;

  return { used, capacity };
}
