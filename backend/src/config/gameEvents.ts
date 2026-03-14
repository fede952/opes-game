/**
 * @file src/config/gameEvents.ts
 * @description Empire-wide event system: three rotating states that alter NPC prices.
 *
 * ================================================================
 * DESIGN: DETERMINISTIC TIME-BASED ROTATION
 * ================================================================
 *
 * The active event is computed from the UTC day number:
 *
 *   dayNumber    = Math.floor(Date.now() / 86_400_000)
 *   currentEvent = GAME_EVENTS[dayNumber % GAME_EVENTS.length]
 *
 * WHY DETERMINISTIC (not stored in the DB)?
 *
 *   No DB migration required — the event is derived from the clock.
 *   All server instances see the same event at the same time.
 *   Server restarts do not reset the event.
 *   The 24-hour window is predictable: players can anticipate
 *   tomorrow's event (dayNumber + 1) and plan production accordingly.
 *
 * The rotation order is intentional:
 *   PAX ROMANA → WAR IN GAUL → FAMINE → PAX ROMANA → ...
 *
 * A full cycle is 72 hours. This gives players a meaningful but
 * not-too-fast cadence: each event lasts a full day, long enough
 * to notice and react, short enough to keep the economy dynamic.
 *
 * ================================================================
 * HOW MULTIPLIERS WORK
 * ================================================================
 *
 * Each event applies a multiplier to the *base* NPC buy price
 * (the value stored in the `npc_prices` table):
 *
 *   effective_price = FLOOR( MAX(1, base_price × multiplier) )
 *
 * The FLOOR and MAX(1,...) ensure the price stays a positive
 * integer — identical to the quality-adjusted payout formula.
 *
 * Base prices continue to random-walk via simulateMarketEvents.ts.
 * Event multipliers are calculated at query time and never written
 * to the DB, so they do not corrupt the base price history.
 *
 * ================================================================
 * EVENT ECONOMIC LOGIC
 * ================================================================
 *
 *   PAX ROMANA (×1.0 all)
 *     Stable peacetime. The Empire buys at standard prices.
 *
 *   WAR IN GAUL (LIGNUM ×1.5, FRUMENTUM ×1.5, FARINA ×1.2)
 *     Legions march north. Timber is needed for siege engines and
 *     fortifications. Grain feeds the armies. Flour is secondary.
 *     Incentivises players to ramp up primary production.
 *
 *   FAMINE (LIGNUM ×0.8, FRUMENTUM ×2.0, FARINA ×2.0)
 *     Crops have failed across the provinces. Food commands a
 *     premium. Construction is suspended — timber prices drop.
 *     Incentivises P2P grain/flour hoarding and processing chains.
 */

// ================================================================
// TYPES
// ================================================================

/**
 * Configuration for a single empire event.
 *
 * `multipliers` maps resource_id → price multiplier for that event.
 * Resources absent from the map default to ×1.0 (unchanged).
 */
export interface GameEventConfig {
  /** Canonical event identifier. Also used as the i18n key suffix. */
  id:          string;
  /** NPC price multipliers keyed by resource_id. */
  multipliers: Readonly<Record<string, number>>;
}

// ================================================================
// EVENT DEFINITIONS
// ================================================================

export const GAME_EVENTS: readonly GameEventConfig[] = [
  {
    id:          'PAX_ROMANA',
    multipliers: { LIGNUM: 1.0, FRUMENTUM: 1.0, FARINA: 1.0 },
  },
  {
    id:          'WAR_IN_GAUL',
    multipliers: { LIGNUM: 1.5, FRUMENTUM: 1.5, FARINA: 1.2 },
  },
  {
    id:          'FAMINE',
    multipliers: { LIGNUM: 0.8, FRUMENTUM: 2.0, FARINA: 2.0 },
  },
];

// ================================================================
// HELPER FUNCTIONS
// ================================================================

/**
 * Returns the currently active empire event.
 *
 * Rotates once every 24 hours at midnight UTC, deterministically
 * from the UTC day number. All server instances compute the same
 * result simultaneously without any shared state.
 */
export function getCurrentEvent(): GameEventConfig {
  const dayNumber = Math.floor(Date.now() / 86_400_000); // ms → day
  return GAME_EVENTS[dayNumber % GAME_EVENTS.length];
}

/**
 * Applies the current event multiplier to a base NPC price.
 *
 * Formula: FLOOR( MAX(1, base_price × multiplier) )
 *
 * - FLOOR: prices are always integer Sestertius (no fractions).
 * - MAX(1): the Empire always pays at least 1 Sestertius.
 * - This formula is mirrored in the POST /sell payout so that
 *   the displayed price exactly matches what the player receives.
 *
 * @param resourceId - The resource being priced (e.g., 'LIGNUM').
 * @param basePrice  - The base price from the npc_prices DB table.
 * @returns An integer effective price ≥ 1 Sestertius.
 */
export function getEffectivePrice(resourceId: string, basePrice: number): number {
  const multiplier = getCurrentEvent().multipliers[resourceId] ?? 1.0;
  return Math.max(1, Math.floor(basePrice * multiplier));
}
