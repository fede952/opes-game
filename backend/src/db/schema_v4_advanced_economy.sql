/**
 * @file schema_v4_advanced_economy.sql
 * @description Phase 6 migration: building levels, operating costs, and production chains.
 *
 * ================================================================
 * CHANGES IN THIS MIGRATION
 * ================================================================
 *
 *   1. user_buildings — Add `level` column (INT, default 1).
 *      Every existing building is retroactively assigned level 1.
 *      The column includes a CHECK constraint so level can never drop to 0 or below.
 *
 * ================================================================
 * WHY IDEMPOTENT MIGRATIONS MATTER
 * ================================================================
 *
 * We use ADD COLUMN IF NOT EXISTS so this file can be re-run safely
 * without throwing "column already exists" errors. For the CHECK
 * constraint, we DROP CONSTRAINT IF EXISTS before re-adding, which
 * makes the constraint addition idempotent as well.
 *
 * In a production environment with thousands of players, you would
 * use a migration tool (Flyway, Liquibase, node-pg-migrate) that
 * tracks which migrations have already been applied and skips them.
 * For Opes Phase 6, manual idempotency is sufficient.
 *
 * ================================================================
 * NEW BUILDING TYPE: PISTRINUM (Mill)
 * ================================================================
 *
 * PISTRINUM is a new building that produces FARINA (flour) from
 * FRUMENTUM (grain). It is a "production chain" building — it
 * consumes one resource to produce another, higher-value resource.
 *
 * The building_type column in user_buildings is a VARCHAR with no
 * CHECK constraint (the allowed types are enforced at the application
 * layer in gameConfig.ts). Adding PISTRINUM requires no schema change —
 * the application code's BUILDING_CONFIGS is the authoritative registry.
 *
 * Similarly, FARINA as a resource_id requires no schema change.
 * The inventories table uses EAV (Entity-Attribute-Value) with a
 * VARCHAR resource_id — new resource types need no schema migration.
 * New players will receive a FARINA row during registration (see auth.ts).
 * Existing players will receive their FARINA row when they build their
 * first PISTRINUM (handled by the POST /buildings/build endpoint).
 *
 * ================================================================
 * HOW TO RUN THIS MIGRATION
 * ================================================================
 *
 *   psql -U postgres -d opes_db -f backend/src/db/schema_v4_advanced_economy.sql
 *
 * Run AFTER schema.sql and schema_v2_buildings.sql.
 * Safe to run multiple times (idempotent).
 */

-- ================================================================
-- ALTER user_buildings: Add the `level` column
-- ================================================================

/**
 * The building's current upgrade level.
 *
 * Level 1 is the default for all new and existing buildings.
 * Upgrading a building increases its level by 1, which scales:
 *   - yield_amount  = base_yield * level
 *   - wage_cost     = base_cost * level   (Sestertius per production run)
 *   - input_amounts = base_input * level  (raw materials per production run)
 *   - upgrade_cost  = upgrade_base_cost * current_level  (to go to next level)
 *
 * WHY SCALE COSTS WITH LEVEL?
 * Higher-level buildings are more efficient (more output per time unit)
 * but also more expensive to operate. This creates a meaningful trade-off:
 * players must generate enough Sestertius income to sustain higher-level
 * production. A level 5 lumber camp produces 50 LIGNUM per run but costs
 * 10 SESTERTIUS in wages — the player must have a trading strategy to profit.
 *
 * DEFAULT 1: Every existing building (from Phase 4/5) retroactively
 * starts at level 1. No data loss — their production continues normally.
 *
 * NOT NULL: A building must always have an explicit level. NULL would
 * require IS NULL checks everywhere and creates ambiguous semantics.
 */
ALTER TABLE user_buildings
  ADD COLUMN IF NOT EXISTS level INT NOT NULL DEFAULT 1;

/**
 * Enforce that building level is always a positive integer.
 *
 * A building cannot be "downgraded" to level 0 or below. If application
 * code ever attempted a negative decrement, the database would REJECT
 * the operation entirely (defense in depth).
 *
 * We DROP IF EXISTS before ADD to make this section idempotent.
 */
ALTER TABLE user_buildings
  DROP CONSTRAINT IF EXISTS user_buildings_level_positive;

ALTER TABLE user_buildings
  ADD CONSTRAINT user_buildings_level_positive CHECK (level >= 1);
