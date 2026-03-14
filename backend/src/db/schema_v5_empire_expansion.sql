/**
 * @file src/db/schema_v5_empire_expansion.sql
 * @description Phase 7 — Empire Expansion: Quality system, storage limits, dynamic NPC economy.
 *
 * ================================================================
 * MIGRATION STRATEGY — IDEMPOTENT ALTERATIONS
 * ================================================================
 *
 * This script is designed to be run safely multiple times. Every operation
 * uses IF NOT EXISTS / IF EXISTS guards and ON CONFLICT DO NOTHING for data
 * inserts. Running the script a second time is harmless.
 *
 * ================================================================
 * BREAKING CHANGE: inventories PRIMARY KEY
 * ================================================================
 *
 * BEFORE Phase 7:
 *   PRIMARY KEY (user_id, resource_id)
 *   — One row per player per resource type.
 *
 * AFTER Phase 7:
 *   PRIMARY KEY (user_id, resource_id, quality)
 *   — One row per player per (resource, quality) tier.
 *     e.g., a player can have both Q0 Lignum and Q1 Lignum.
 *
 * WHY THIS DOES NOT CORRUPT EXISTING DATA:
 *   All existing inventory rows receive quality = 0 automatically (the
 *   column DEFAULT). The new PK still uniquely identifies every existing
 *   row because each existing (user_id, resource_id) pair maps to exactly
 *   one (user_id, resource_id, 0) triple. No data is duplicated or lost.
 *
 * DOWNSTREAM IMPACT:
 *   All ON CONFLICT (user_id, resource_id) clauses in the application code
 *   must be updated to ON CONFLICT (user_id, resource_id, quality). This
 *   migration is paired with updates to every relevant route file.
 *
 * ================================================================
 * THE QUALITY (Q) SYSTEM
 * ================================================================
 *
 * Resources can be produced at Quality 0 (standard), Quality 1 (fine),
 * or Quality 2 (masterwork). Higher-quality goods:
 *   - Fetch a higher NPC sell price: price * (1 + quality * 0.5)
 *     Q0: 1× base price | Q1: 1.5× base price | Q2: 2× base price
 *   - Require Research Points as an additional input:
 *     Q1: 2 RESEARCH consumed on production start
 *     Q2: 4 RESEARCH consumed on production start
 *
 * ================================================================
 * STORAGE LIMITS
 * ================================================================
 *
 * Physical resources (LIGNUM, FRUMENTUM, FARINA, etc.) occupy storage.
 * SESTERTIUS (currency) and RESEARCH (points) are weightless and do not
 * count towards capacity.
 *
 * Default capacity:     500 units
 * HORREUM contribution: +500 units per level, per building
 *
 * ================================================================
 * DYNAMIC NPC PRICES
 * ================================================================
 *
 * Phase 5 used hardcoded NPC prices in npcMarket.ts.
 * Phase 7 replaces these with a DB-driven npc_prices table. Prices
 * fluctuate via the simulateMarketEvents.ts script (±20% per event).
 * The server reads the current price from the DB on every sell request,
 * so the frontend always sees live prices via GET /market/npc/prices.
 */

-- ================================================================
-- STEP 1: ALTER inventories — add quality column
-- ================================================================

-- Add the quality column first, defaulting to 0.
-- All existing rows receive quality = 0, preserving every player's inventory.
ALTER TABLE inventories
  ADD COLUMN IF NOT EXISTS quality INT NOT NULL DEFAULT 0;

-- ================================================================
-- STEP 2: ALTER inventories — replace PRIMARY KEY
-- ================================================================

-- Drop the old 2-column PK. This is safe because no FK references this PK
-- from other tables — inventories is a leaf table (only referenced by nothing).
ALTER TABLE inventories
  DROP CONSTRAINT IF EXISTS inventories_pkey;

-- Add the new 3-column PK. Every existing row satisfies this because
-- each (user_id, resource_id, 0) triple is unique (as proven above).
ALTER TABLE inventories
  ADD CONSTRAINT inventories_pkey PRIMARY KEY (user_id, resource_id, quality);

-- Add a check constraint for quality values.
-- The application caps quality at 2, but the DB enforces the non-negative floor.
ALTER TABLE inventories
  DROP CONSTRAINT IF EXISTS inventories_quality_non_negative;
ALTER TABLE inventories
  ADD CONSTRAINT inventories_quality_non_negative CHECK (quality >= 0);

-- ================================================================
-- STEP 3: ALTER market_listings — add quality column
-- ================================================================

-- Listings carry the quality of the resource being sold in escrow.
-- Existing listings (all created before Phase 7) receive quality = 0.
ALTER TABLE market_listings
  ADD COLUMN IF NOT EXISTS quality INT NOT NULL DEFAULT 0;

ALTER TABLE market_listings
  DROP CONSTRAINT IF EXISTS market_listings_quality_non_negative;
ALTER TABLE market_listings
  ADD CONSTRAINT market_listings_quality_non_negative CHECK (quality >= 0);

-- ================================================================
-- STEP 4: ALTER production_jobs — add target_quality column
-- ================================================================

-- The target quality is set when production is STARTED and determines
-- which inventory row receives the output on COLLECT.
-- Existing active jobs (mid-run at migration time) receive target_quality = 0,
-- which is correct — they were started before the quality system existed.
ALTER TABLE production_jobs
  ADD COLUMN IF NOT EXISTS target_quality INT NOT NULL DEFAULT 0;

ALTER TABLE production_jobs
  DROP CONSTRAINT IF EXISTS production_jobs_quality_non_negative;
ALTER TABLE production_jobs
  ADD CONSTRAINT production_jobs_quality_non_negative CHECK (target_quality >= 0);

-- ================================================================
-- STEP 5: CREATE npc_prices — dynamic market pricing
-- ================================================================

/**
 * Stores the current NPC buy price for each tradeable resource.
 *
 * current_buy_price — The Sestertius reward per unit at Quality 0.
 *                     The actual payout scales with quality:
 *                     payout = amount × current_buy_price × (1 + quality × 0.5)
 *
 * updated_at — Timestamp of the last price update. Used by the frontend to
 *              show "last updated" information and by simulateMarketEvents.ts.
 *
 * MINIMUM PRICE GUARANTEE:
 *   The simulateMarketEvents.ts script enforces a floor of 1 Sestertius.
 *   The CHECK constraint here is an extra DB-level safety net.
 */
CREATE TABLE IF NOT EXISTS npc_prices (
  resource_id       VARCHAR(50) PRIMARY KEY,
  current_buy_price INT         NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT npc_prices_price_positive CHECK (current_buy_price > 0)
);

-- Populate initial prices. ON CONFLICT DO NOTHING makes this idempotent:
-- re-running the script does not overwrite prices that have already fluctuated.
INSERT INTO npc_prices (resource_id, current_buy_price)
VALUES
  ('FARINA',    10),
  ('FRUMENTUM',  3),
  ('LIGNUM',     2)
ON CONFLICT (resource_id) DO NOTHING;

-- Index for quick single-resource lookups (e.g., during NPC sell transaction).
-- The PK already provides this, but the comment explains the access pattern.
-- No extra index needed — PK on resource_id covers the lookup exactly.
