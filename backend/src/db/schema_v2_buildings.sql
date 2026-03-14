/**
 * @file db/schema_v2_buildings.sql
 * @description Phase 4 migration: time-based production infrastructure.
 *
 * Adds two tables that power the building-based economic system:
 *
 *   user_buildings   — Each player's owned buildings (lumber camp, grain farm, etc.)
 *   production_jobs  — Active timed production runs (one per building, max)
 *
 * RUN AFTER schema.sql:
 *   psql -U postgres -d opes_db -f backend/src/db/schema_v2_buildings.sql
 *
 * ================================================================
 * DESIGN: Why separate tables for buildings and jobs?
 * ================================================================
 *
 * A building is a PERMANENT asset: it persists throughout the game and
 * always belongs to a player, regardless of whether it is currently
 * producing anything. Its identity (id, building_type, user_id) never
 * changes; only its status (IDLE ↔ PRODUCING) toggles.
 *
 * A production job is a TEMPORARY record: it is CREATED when a player
 * starts production and DELETED when they collect the output. Its entire
 * purpose is to record "this building is busy until end_time, and will
 * yield yield_amount of resource_id when collected."
 *
 * Storing job data on user_buildings would mean most columns are NULL
 * most of the time (when idle), which is a schema smell. Separate tables
 * keep each entity focused on its own lifecycle.
 *
 * State machine for a building:
 *
 *   [IDLE] ─── POST /production/start ──→ [PRODUCING]
 *                                               │
 *                POST /production/collect ◄─── ┘
 *               (only allowed when NOW() >= end_time)
 */

-- ================================================================
-- TABLE: user_buildings
-- ================================================================

CREATE TABLE IF NOT EXISTS user_buildings (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  /**
   * Foreign key to the owning player. CASCADE ensures that if a player
   * account is deleted, all their buildings are cleaned up automatically.
   * No orphaned building rows ever persist.
   */
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  /**
   * The type of building, used to look up what resource it produces.
   * Examples: 'CASTRA_LIGNATORUM' (lumber camp), 'FUNDUS_FRUMENTI' (grain farm).
   *
   * Stored as a string (not a FK to a building_types table) for simplicity
   * at this phase. The server-side BUILDING_RESOURCE_MAP constant validates
   * the type and maps it to a resource_id.
   */
  building_type VARCHAR(50) NOT NULL,

  /**
   * Server-authoritative state machine for this building.
   *
   * IDLE      — The building is available; the player can start a production job.
   * PRODUCING — A timed job is in progress; cannot start another until collected.
   *
   * The CHECK constraint is a database-level guard (defense in depth).
   * Even if application-layer code has a bug that passes an invalid status,
   * PostgreSQL will REJECT the INSERT/UPDATE with a constraint violation.
   * Three layers of protection: TypeScript type system → application validation
   * → this database constraint.
   */
  status        VARCHAR(20) NOT NULL DEFAULT 'IDLE'
                            CHECK (status IN ('IDLE', 'PRODUCING')),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

/**
 * Supports efficient retrieval of all buildings for a given player.
 * The GET /buildings endpoint queries WHERE user_id = $1 on every request,
 * so this index is critical for performance at scale.
 */
CREATE INDEX IF NOT EXISTS idx_user_buildings_user_id
  ON user_buildings(user_id);

-- ================================================================
-- TABLE: production_jobs
-- ================================================================

CREATE TABLE IF NOT EXISTS production_jobs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  /**
   * UNIQUE — a building can have at most ONE active production job.
   *
   * This is a database-level enforcement of a core game rule: you cannot
   * queue multiple simultaneous productions on the same building.
   *
   * Without this constraint, a perfectly-timed race condition could allow
   * two concurrent POST /production/start requests to both INSERT a job
   * for the same building before either transaction reads the PRODUCING status.
   * The UNIQUE constraint makes the second INSERT fail with error code 23505
   * (unique_violation), which the server handles as a 409 Conflict.
   *
   * ON DELETE CASCADE: when a building is deleted (e.g., player account
   * removed), any in-progress job for that building is cleaned up too.
   */
  user_building_id UUID        NOT NULL UNIQUE
                               REFERENCES user_buildings(id) ON DELETE CASCADE,

  /**
   * Which resource this job will produce (e.g., 'LIGNUM', 'FRUMENTUM').
   * Determined at job creation by the server-side BUILDING_RESOURCE_MAP.
   * The client cannot influence this value.
   */
  resource_id      VARCHAR(50) NOT NULL,

  /**
   * When this job was created (production started). Stored for auditing
   * and potential future use (e.g., production history, analytics).
   */
  start_time       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  /**
   * When this job becomes collectible: start_time + PRODUCTION_DURATION.
   * Set entirely by the server at job creation time.
   *
   * SECURITY: The collect endpoint checks NOW() >= end_time server-side.
   * A cheater cannot "fast-forward" production by modifying this timestamp —
   * they don't have write access to the database. Even if they modified the
   * collect request, the server re-reads end_time from the DB and validates.
   */
  end_time         TIMESTAMPTZ NOT NULL,

  /**
   * The number of resource_id units awarded on collection.
   * Set by the server-side PRODUCTION_YIELD_AMOUNT constant at job creation.
   * The client cannot set or modify this value.
   *
   * CHECK (yield_amount > 0): Production must yield something positive.
   * The database will reject any attempt to create a zero-yield job.
   */
  yield_amount     INTEGER     NOT NULL CHECK (yield_amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_production_jobs_building
  ON production_jobs(user_building_id);
