/**
 * @file src/scripts/simulateMarketEvents.ts
 * @description Standalone script that simulates NPC market price fluctuations.
 *
 * ================================================================
 * PURPOSE
 * ================================================================
 *
 * The NPC "Empire" market in Opes is no longer static. Prices for LIGNUM,
 * FRUMENTUM, and FARINA shift over time, reflecting supply/demand within
 * the empire's broader economy. This script drives those fluctuations.
 *
 * Running this script once simulates a single "market event" — each
 * resource price moves by a random ±20% from its current value.
 *
 * ================================================================
 * PRICE CHANGE FORMULA
 * ================================================================
 *
 *   change_factor  = 1 + (random ∈ [-0.20, +0.20])
 *   new_price      = MAX(1, ROUND(current_price × change_factor))
 *
 * - Prices are integers (whole Sestertius only — no fractions).
 * - ROUND() applies standard rounding: 0.5 rounds up.
 * - MAX(1, ...) enforces a minimum price of 1 Sestertius per unit.
 *   The Empire never pays nothing — it always values raw materials.
 *
 * Example price walk:
 *   Event 1: LIGNUM 2 → 2 × 0.93 = 1.86 → ROUND = 2  (minor drop, stays 2)
 *   Event 2: LIGNUM 2 → 2 × 1.18 = 2.36 → ROUND = 2  (minor rise, stays 2)
 *   Event 3: LIGNUM 2 → 2 × 1.20 = 2.40 → ROUND = 2  (max rise, stays 2)
 *   Event 4: LIGNUM 3 → 3 × 0.80 = 2.40 → ROUND = 2  (max drop)
 *
 * ================================================================
 * HOW TO RUN
 * ================================================================
 *
 * From the backend directory:
 *
 *   npx ts-node src/scripts/simulateMarketEvents.ts
 *
 * To simulate recurring market events, run on a schedule using:
 *   - A cron job (Linux/macOS): `0 * * * * npx ts-node ...` (hourly)
 *   - Windows Task Scheduler
 *   - A process manager like PM2 (production environments)
 *
 * ================================================================
 * TRANSACTION SAFETY
 * ================================================================
 *
 * The script reads all prices and writes all updates inside a single
 * atomic transaction with SELECT ... FOR UPDATE on the npc_prices table.
 *
 * This prevents two simultaneous script runs (e.g., a race condition
 * between cron jobs) from interleaving their writes, which could produce
 * wildly incorrect prices by double-applying the same price update.
 */

import { Pool, PoolClient } from 'pg';
import * as dotenv           from 'dotenv';
import * as path             from 'path';

// Load environment variables from the backend's .env file.
// path.resolve ensures we find .env relative to this script's location,
// not relative to whatever directory the user runs ts-node from.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ================================================================
// DATABASE CONNECTION
// ================================================================

// We create a short-lived Pool specifically for this script.
// It is terminated with pool.end() after the transaction completes,
// so the script process exits cleanly rather than hanging open.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ================================================================
// CONSTANTS
// ================================================================

/** Maximum price change per event, expressed as a fraction (20% = 0.20). */
const MAX_CHANGE_FRACTION = 0.20;

/** Minimum NPC buy price in Sestertius. The Empire always pays something. */
const MIN_PRICE = 1;

// ================================================================
// HELPER
// ================================================================

/**
 * Computes a new integer price after applying a random ±MAX_CHANGE_FRACTION
 * adjustment, floored at MIN_PRICE.
 *
 * @param current - The current price in Sestertius.
 * @returns A new integer price ∈ [MIN_PRICE, ∞).
 */
function applyPriceFluctuation(current: number): number {
  // Math.random() returns a value in [0, 1).
  // (Math.random() * 2 - 1) maps to (-1, 1).
  // × MAX_CHANGE_FRACTION maps to (-0.20, +0.20).
  const changeFraction = (Math.random() * 2 - 1) * MAX_CHANGE_FRACTION;
  const changeFactor   = 1 + changeFraction;
  const rawNew         = current * changeFactor;

  // Math.round() gives us an integer price.
  // Math.max(MIN_PRICE, ...) enforces the price floor.
  return Math.max(MIN_PRICE, Math.round(rawNew));
}

// ================================================================
// MAIN SIMULATION FUNCTION
// ================================================================

async function simulateMarketEvent(): Promise<void> {
  let client: PoolClient | null = null;

  try {
    client = await pool.connect();

    await client.query('BEGIN');

    // ---- Read all current prices, locking the rows ----
    //
    // SELECT FOR UPDATE prevents two simultaneous script invocations from
    // racing. The second invocation will block here until the first commits
    // and releases its locks, then it reads the post-first-event prices
    // as its starting point. This ensures events are sequential, not concurrent.
    const pricesResult = await client.query<{
      resource_id:       string;
      current_buy_price: number;
    }>(
      `SELECT resource_id, current_buy_price
       FROM   npc_prices
       FOR UPDATE`
    );

    if (pricesResult.rowCount === 0) {
      console.log('[Market Simulation] No resources found in npc_prices table. '
        + 'Run schema_v5_empire_expansion.sql first.');
      await client.query('ROLLBACK');
      return;
    }

    console.log('[Market Simulation] Applying price fluctuations...');

    // ---- Apply fluctuation to each resource ----
    for (const row of pricesResult.rows) {
      const oldPrice = row.current_buy_price;
      const newPrice = applyPriceFluctuation(oldPrice);

      await client.query(
        `UPDATE npc_prices
         SET    current_buy_price = $1,
                updated_at        = NOW()
         WHERE  resource_id       = $2`,
        [newPrice, row.resource_id]
      );

      const direction = newPrice > oldPrice ? '▲' : newPrice < oldPrice ? '▼' : '—';
      console.log(
        `  ${direction} ${row.resource_id.padEnd(12)} ${oldPrice} → ${newPrice} Sestertius/unit`
      );
    }

    await client.query('COMMIT');

    console.log('[Market Simulation] Complete. Prices updated successfully.');

  } catch (err) {
    if (client) {
      await client.query('ROLLBACK');
    }

    console.error('[Market Simulation] FAILED — transaction rolled back.', err);
    process.exitCode = 1;

  } finally {
    if (client) {
      client.release();
    }

    // Close the pool so the Node.js process exits cleanly.
    // Without this, the open PostgreSQL connections would keep the process alive.
    await pool.end();
  }
}

// Run the simulation when this script is executed directly.
void simulateMarketEvent();
