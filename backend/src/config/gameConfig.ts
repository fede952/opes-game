/**
 * @file src/config/gameConfig.ts
 * @description Server-authoritative configuration for all building types in Opes.
 *
 * ================================================================
 * WHY DOES THIS FILE EXIST?
 * ================================================================
 *
 * In a Server-Authoritative Architecture, the server is the single
 * source of truth for ALL game rules. Building configurations — what
 * a building produces, how much it costs to run, what level scaling
 * applies — must never be trusted from the client.
 *
 * This file is the CANONICAL registry of building economics. Every
 * route that involves production costs, yield amounts, or upgrade
 * pricing reads exclusively from this config. The client receives
 * a cosmetic copy for display purposes (in Dashboard.tsx), but the
 * actual economic outcomes are computed here.
 *
 * ================================================================
 * LEVEL SCALING FORMULAS
 * ================================================================
 *
 * All numeric values scale linearly with building level:
 *
 *   actual_yield      = base_yield      * level
 *   actual_wage_cost  = base_cost       * level   (Sestertius per run)
 *   actual_input      = input.amount    * level   (raw material per run)
 *   upgrade_cost      = upgrade_base_cost * level  (to advance to level+1)
 *
 * Examples — PISTRINUM at level 3:
 *   yield       = 5  * 3 = 15 FARINA per run
 *   wage_cost   = 5  * 3 = 15 SESTERTIUS per run
 *   input       = 10 * 3 = 30 FRUMENTUM consumed per run
 *   upgrade_cost (3→4) = 100 * 3 = 300 SESTERTIUS
 *
 * This linear scaling is intentionally simple. Future phases could
 * introduce diminishing returns, quadratic costs, or per-resource
 * multipliers — all changes are isolated to this file.
 *
 * ================================================================
 * PRODUCTION CHAIN — PISTRINUM
 * ================================================================
 *
 * PISTRINUM is the first "secondary production" building in Opes.
 * It introduces a PRODUCTION CHAIN — it consumes FRUMENTUM (a primary
 * resource produced by FUNDUS_FRUMENTI) to produce FARINA (flour),
 * a higher-value processed good.
 *
 * Economic incentive:
 *   Selling FRUMENTUM to NPC:   3 Sestertius per unit
 *   10 FRUMENTUM via PISTRINUM: produces 5 FARINA (level 1)
 *   Selling FARINA to NPC:      10 Sestertius per unit
 *   Revenue: 50 Sestertius vs 30 Sestertius for raw grain — a 67% premium.
 *   Operating cost: 5 Sestertius wages (level 1).
 *   Net: 50 - 5 - 30 (opportunity cost) = 15 Sestertius profit vs
 *        simply selling the FRUMENTUM directly.
 *
 *   This incentivizes players to invest in the PISTRINUM despite its
 *   higher construction cost and input requirements.
 *
 * ================================================================
 * HOW TO ADD A NEW BUILDING TYPE
 * ================================================================
 *
 *   1. Add an entry to BUILDING_CONFIGS below.
 *   2. If the building has a `build_cost`, players can construct it
 *      via POST /api/v1/buildings/build.
 *   3. Add the building's display name to frontend/src/i18n/locales/en.json
 *      under the "buildings" key.
 *   4. If the building's output resource is new, add it to:
 *        - STARTING_RESOURCES in auth.ts (new players)
 *        - dashboard.resources in en.json (display name)
 *        - Market.tsx NPC_DISPLAY_PRICES (if NPC-tradable)
 *        - npcMarket.ts NPC_BUY_PRICES (if NPC-tradable)
 */

// ================================================================
// TYPES
// ================================================================

/**
 * A single raw material input consumed per production run at level 1.
 *
 * Scaled at runtime: actual_consumption = amount * building.level
 */
export interface BuildingInput {
  /** Resource ID of the consumed material (e.g., 'FRUMENTUM'). */
  resource: string;
  /** Base units consumed per run at level 1. Multiplied by level at runtime. */
  amount:   number;
}

/**
 * Full economic configuration for a single building type.
 */
export interface BuildingConfig {
  /** The resource ID this building produces as output (e.g., 'FARINA'). */
  output:            string;

  /**
   * Base units of `output` produced per completed run at level 1.
   * Actual yield = base_yield * building.level.
   * For passive buildings (passive: true) this is 0 and is never used.
   */
  base_yield:        number;

  /**
   * Base Sestertius wage cost charged per production run at level 1.
   * Represents labor costs — paid up-front when production starts.
   * Actual wage = base_cost * building.level.
   * For passive buildings (passive: true) this is 0 and is never used.
   */
  base_cost:         number;

  /**
   * How long a single production run takes, in seconds.
   * This replaces the old global PRODUCTION_DURATION_SECONDS env-var so
   * each building type can have a distinct cycle time.
   *
   * Design intent (Phase 11 "Mid-Core" rebalance):
   *   Base resources  (LIGNUM, FRUMENTUM) — 900 s  (15 min): quick, low-value
   *   Advanced        (FARINA)            — 3600 s (60 min): slow, high-value
   *   Research        (RESEARCH)          — 1800 s (30 min): medium, strategic
   *
   * For passive buildings (passive: true) this field is present but never
   * read by the production route (passive buildings cannot start jobs).
   */
  duration_seconds:  number;

  /**
   * Raw material inputs consumed per run at level 1.
   * Empty array = no raw materials needed (primary resource building).
   * Actual consumption = input.amount * building.level.
   */
  inputs:            BuildingInput[];

  /**
   * Base cost to upgrade from level N to N+1, in Sestertius.
   * Actual upgrade cost = upgrade_base_cost * current_level.
   *
   * Example: CASTRA_LIGNATORUM upgrade_base_cost = 50
   *   Level 1 → 2: 50 * 1 = 50 Sestertius
   *   Level 2 → 3: 50 * 2 = 100 Sestertius
   *   Level 3 → 4: 50 * 3 = 150 Sestertius
   */
  upgrade_base_cost: number;

  /**
   * One-time Sestertius cost to construct this building from scratch.
   * `undefined` means this is a starter building given at registration —
   * it cannot be purchased via POST /buildings/build.
   */
  build_cost?:       number;

  /**
   * Phase 7: If true, this building has a PASSIVE effect and cannot have
   * production runs started on it. Its level affects game state indirectly
   * (e.g., HORREUM level increases storage capacity) without producing a resource.
   *
   * `undefined` or `false` means the building is a normal production building.
   */
  passive?:          boolean;
}

// ================================================================
// BUILDING CONFIGURATIONS
// ================================================================

/**
 * The canonical registry of all building types and their economics.
 *
 * `Readonly` prevents accidental mutation at runtime (e.g., a bug that
 * modifies a price during request handling would silently corrupt all
 * future requests without Readonly — with it, TypeScript catches the error).
 *
 * `as const` narrows the type to exact literal values rather than the
 * wider `number` or `string` types, catching typos in config lookups.
 */
export const BUILDING_CONFIGS: Readonly<Record<string, BuildingConfig>> = {

  /**
   * CASTRA LIGNATORUM — Lumber Camp
   *
   * The most basic production building. Produces raw LIGNUM (wood) from
   * the surrounding forest. No raw material inputs — the forest is free.
   *
   * Starter building: given to all new players at registration (no build cost).
   *
   * Level 1:  10 LIGNUM per run,  2 Sestertius wages
   * Level 2:  20 LIGNUM per run,  4 Sestertius wages
   * Level 5:  50 LIGNUM per run, 10 Sestertius wages
   */
  CASTRA_LIGNATORUM: {
    output:            'LIGNUM',
    base_yield:        10,
    base_cost:         2,
    inputs:            [],
    upgrade_base_cost: 50,
    duration_seconds:  900,  // 15 minutes — base resource
    // No build_cost: starter building, given automatically at registration
  },

  /**
   * FUNDUS FRUMENTI — Grain Farm
   *
   * Produces FRUMENTUM (grain) from cultivated fields.
   * No raw material inputs — seeds are assumed to be replanted from harvest.
   *
   * Starter building: given to all new players at registration (no build cost).
   * Higher base_yield than CASTRA_LIGNATORUM because grain is more plentiful
   * but also more necessary as a PISTRINUM input.
   *
   * Level 1:  15 FRUMENTUM per run,  3 Sestertius wages
   * Level 2:  30 FRUMENTUM per run,  6 Sestertius wages
   * Level 5:  75 FRUMENTUM per run, 15 Sestertius wages
   */
  FUNDUS_FRUMENTI: {
    output:            'FRUMENTUM',
    base_yield:        15,
    base_cost:         3,
    inputs:            [],
    upgrade_base_cost: 50,
    duration_seconds:  900,  // 15 minutes — base resource
    // No build_cost: starter building, given automatically at registration
  },

  /**
   * PISTRINUM — Mill
   *
   * Processes FRUMENTUM (grain) into FARINA (flour), a higher-value
   * processed good. This is the first PRODUCTION CHAIN building in Opes:
   * it consumes a primary resource to produce a secondary one.
   *
   * Construction cost: 100 Sestertius (players must save up to build one).
   * Input: FRUMENTUM (raw grain from FUNDUS_FRUMENTI or P2P market).
   * Output: FARINA (flour, sold at 10 Sestertius/unit to the NPC market).
   *
   * Level 1:  5 FARINA per run, 5 Sestertius wages, 10 FRUMENTUM consumed
   * Level 2: 10 FARINA per run, 10 Sestertius wages, 20 FRUMENTUM consumed
   * Level 3: 15 FARINA per run, 15 Sestertius wages, 30 FRUMENTUM consumed
   *
   * Economic analysis (level 1):
   *   Revenue:         5 FARINA × 10 = 50 Sestertius
   *   Wage cost:       5 Sestertius
   *   Input opportunity cost: 10 FRUMENTUM × 3 = 30 Sestertius
   *   Net profit:      50 - 5 - 30 = 15 Sestertius per run
   *
   * This makes PISTRINUM strictly more profitable than raw grain selling,
   * but requires capital investment (100 Sestertius build cost) and
   * an active grain supply chain.
   */
  PISTRINUM: {
    output:            'FARINA',
    base_yield:        5,
    base_cost:         5,
    inputs:            [{ resource: 'FRUMENTUM', amount: 10 }],
    upgrade_base_cost: 100,
    build_cost:        100,  // One-time construction cost in Sestertius
    duration_seconds:  3600, // 60 minutes — advanced processed resource
  },

  /**
   * HORREUM — Warehouse (Phase 7)
   *
   * A PASSIVE building: it produces no resources and has no production runs.
   * Instead, each level increases the player's physical resource storage
   * capacity by +500 units.
   *
   *   Base capacity (no HORREUM): 500 units
   *   HORREUM level 1:          +500 → 1 000 total
   *   HORREUM level 2:          +1 000 → 1 500 total  (same HORREUM, upgraded)
   *   Two HORREUM level 1 each: +500 +500 → 1 500 total
   *
   * Construction cost: 200 Sestertius.
   * Upgrade cost formula: 150 × current_level (150 for lv.2, 300 for lv.3, …)
   *
   * ECONOMIC ROLE:
   *   Limits how much a player can accumulate without selling or trading.
   *   Encourages market participation and prevents infinite passive stockpiling.
   *   Players must invest in storage infrastructure to support higher-level
   *   production buildings that yield large quantities per run.
   *
   * `passive: true` — the POST /production/start endpoint rejects start
   * requests on passive buildings. Only upgrade is supported.
   */
  HORREUM: {
    output:            '',    // No output — passive building
    base_yield:        0,
    base_cost:         0,
    inputs:            [],
    upgrade_base_cost: 150,
    build_cost:        200,
    passive:           true,
    duration_seconds:  0,    // Passive: no production runs, value never used
  },

  /**
   * ACADEMIA — Academy (Phase 7)
   *
   * The Academy is a research institution that produces RESEARCH points.
   * RESEARCH is a weightless resource consumed as a prerequisite for
   * quality production: crafting a resource at Q1 costs 2 RESEARCH,
   * at Q2 costs 4 RESEARCH.
   *
   * Construction cost: 150 Sestertius.
   * Output: RESEARCH (weightless, not tradeable on markets)
   * Upgrade cost formula: 75 × current_level
   *
   * RESEARCH ECONOMICS (level 1):
   *   1 RESEARCH per run × 10 Sestertius wages = 10 Sestertius per RESEARCH point
   *   Q1 production: 2 RESEARCH consumed → 20 Sestertius of embedded cost
   *   Q1 NPC payout multiplier: 1.5× base price
   *   Q2 production: 4 RESEARCH consumed → 40 Sestertius of embedded cost
   *   Q2 NPC payout multiplier: 2.0× base price
   *
   * This gives players a meaningful quality-vs-quantity trade-off. A high-level
   * ACADEMIA can generate RESEARCH faster, making Q2 production economically viable.
   *
   * NOTE: RESEARCH cannot itself be quality-produced (you can't quality-research
   * research). The production start endpoint enforces this.
   */
  ACADEMIA: {
    output:            'RESEARCH',
    base_yield:        1,
    base_cost:         10,
    inputs:            [],
    upgrade_base_cost: 75,
    build_cost:        150,
    duration_seconds:  1800, // 30 minutes — strategic resource
  },

} as const;
