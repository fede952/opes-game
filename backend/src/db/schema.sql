-- =============================================================================
-- Opes Database Schema — Migration v1
-- =============================================================================
--
-- HOW TO RUN THIS FILE:
--   1. Create the database (only needed once):
--        psql -U postgres -c "CREATE DATABASE opes_db;"
--   2. Apply the schema:
--        psql -U postgres -d opes_db -f src/db/schema.sql
--
-- This script is IDEMPOTENT: it uses "IF NOT EXISTS" throughout, so you can
-- run it multiple times safely without errors or duplicate objects.
--
-- =============================================================================
-- DESIGN PHILOSOPHY
-- =============================================================================
--
-- The database is the ultimate enforcement layer for game rules.
-- The application code (TypeScript) validates input and handles business logic,
-- but we ALSO define constraints at the database level. This is called
-- "Defense in Depth" — multiple independent layers of protection.
--
-- Why is this important?
--   Imagine a future developer writes a new code path that bypasses our
--   TypeScript validation. Without database constraints, bad data would
--   silently corrupt the game economy. With DB constraints, PostgreSQL
--   rejects the invalid operation with a clear error, no matter what path
--   the application code took to get there.
--
-- =============================================================================


-- =============================================================================
-- EXTENSION: pgcrypto
-- =============================================================================
-- Enables gen_random_uuid(), which generates a cryptographically secure
-- random UUID (Universally Unique Identifier) for primary keys.
--
-- WHY UUIDs INSTEAD OF SEQUENTIAL INTEGERS (1, 2, 3...)?
--
--   SECURITY — Enumeration attacks:
--     Sequential IDs let an attacker guess other users' IDs by incrementing.
--     Example: if a player sees their own profile at /api/players/42, they
--     might try /api/players/41, /api/players/43, etc. to access other accounts.
--     UUID 'a3f2b1c4-...' cannot be guessed or iterated.
--
--   SCALABILITY — Distributed systems:
--     If you ever split the database across multiple servers (sharding), each
--     server can generate IDs independently without coordination, because UUIDs
--     are statistically guaranteed to be globally unique.
--
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- =============================================================================
-- TABLE: users
-- =============================================================================
-- Stores player account credentials and basic profile metadata.
-- This table contains SENSITIVE data (password hashes) and should be
-- treated with strict access controls in production.
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (

    -- Primary key: a randomly generated UUID.
    -- DEFAULT gen_random_uuid() means PostgreSQL auto-generates this on INSERT.
    -- The application code never needs to supply an ID for new users.
    id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The player's chosen display name, used to log in.
    -- VARCHAR(50): long enough for any reasonable name, short enough to display cleanly in UI.
    -- NOT NULL: every user must have a username — there is no concept of an anonymous user.
    -- The UNIQUE constraint is defined separately below (as a named constraint) so that
    -- PostgreSQL error messages include the constraint name, making them easier to handle
    -- in application code (we check for error code 23505 + constraint name).
    username      VARCHAR(50)   NOT NULL,

    -- Stores the bcrypt hash of the player's password.
    --
    -- CRITICAL SECURITY RULE: We NEVER store plaintext passwords.
    --
    -- If this database were ever stolen (a breach), attackers would get the hash,
    -- not the original password. bcrypt hashes are:
    --   1. SALTED: Each hash includes a random "salt" so two users with the same
    --      password have completely different hashes. This defeats precomputed
    --      "rainbow table" attacks.
    --   2. SLOW BY DESIGN: bcrypt is intentionally slow (configurable via "cost factor").
    --      At cost factor 12, hashing takes ~300ms, making brute-force attacks
    --      computationally infeasible even if an attacker gets the hash database.
    --
    -- VARCHAR(255) is sufficient — bcrypt hashes are always exactly 60 characters long,
    -- but we use 255 as a safe buffer in case we ever switch hashing algorithms.
    password_hash VARCHAR(255)  NOT NULL,

    -- Automatic timestamp set once when the row is first created.
    -- TIMESTAMPTZ ("timestamp with time zone") stores the UTC offset alongside the time.
    -- This ensures the time is unambiguous, regardless of the server's local timezone.
    -- Using plain TIMESTAMP (without time zone) is a common source of subtle bugs
    -- when servers are in different timezones or when daylight saving time changes.
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    -- Named unique constraint on username.
    -- Naming it allows us to identify it precisely in PostgreSQL error code 23505,
    -- so we can return a helpful "username is taken" message to the player.
    CONSTRAINT users_username_unique UNIQUE (username),

    -- Minimum length check enforced at the database level.
    -- Even if the API validation is bypassed (e.g., a bug, a direct DB insert),
    -- PostgreSQL will reject usernames shorter than 3 characters.
    CONSTRAINT users_username_min_length CHECK (char_length(username) >= 3)
);


-- =============================================================================
-- TABLE: inventories
-- =============================================================================
-- Stores the quantity of each resource owned by each player.
--
-- DESIGN PATTERN: Entity-Attribute-Value (EAV) for resources
--
-- We could design this table as:
--   user_id UUID, sestertius INT, lignum INT, frumentum INT
--
-- But we chose the EAV pattern instead (one row per user+resource):
--
--   ADVANTAGE 1 — Adding a new resource requires NO schema migration.
--     In a live game with thousands of players, ALTER TABLE is risky and slow.
--     With EAV, a new resource type just means inserting new rows with the
--     new resource_id. Zero downtime.
--
--   ADVANTAGE 2 — Scales to hundreds of resource types cleanly.
--     A column-per-resource table would become unwieldy with many resources.
--
--   TRADE-OFF — Slightly more complex queries.
--     Getting all resources for a player uses a simple WHERE clause, but
--     "pivoting" (showing all resources as columns in one row) requires
--     a crosstab query. For Opes, this trade-off is worth it.
--
-- =============================================================================
CREATE TABLE IF NOT EXISTS inventories (

    -- Foreign key reference to the owning player.
    -- ON DELETE CASCADE: if a user account is deleted, ALL their inventory rows
    -- are automatically deleted too. This prevents "orphaned" rows (inventory
    -- data for a player who no longer exists) which would waste storage and
    -- cause confusing query results.
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Human-readable identifier for the resource type.
    -- Convention: SCREAMING_SNAKE_CASE (e.g., 'SESTERTIUS', 'LIGNUM', 'FRUMENTUM').
    -- This is NOT a foreign key to a resource_types table (to keep the schema
    -- simple for Phase 1). In a future migration, we would add a resource_types
    -- lookup table and convert this to a proper foreign key.
    resource_id VARCHAR(50) NOT NULL,

    -- The quantity of this resource the player currently owns.
    -- NOT NULL + DEFAULT 0 ensures we always have an explicit numeric value.
    -- Using NULL to represent "0 amount" would require IS NULL checks everywhere.
    amount      INTEGER     NOT NULL DEFAULT 0,

    -- Composite primary key: (user_id, resource_id) together are unique.
    -- This enforces "one row per player per resource" at the database level.
    -- A player can own WHEAT and WOOD, but cannot have two WHEAT rows.
    PRIMARY KEY (user_id, resource_id),

    -- ANTI-CHEAT constraint: resource amounts can never go negative.
    -- Even if a bug in the application code attempts to subtract more than
    -- the player has, PostgreSQL will REJECT the entire transaction with an
    -- error, and the ROLLBACK will undo any partial changes.
    -- This is the database acting as a final guardian of game economy rules.
    CONSTRAINT inventories_amount_non_negative CHECK (amount >= 0)
);

-- Index to speed up "fetch all resources for player X" queries.
-- The composite PRIMARY KEY index handles (user_id, resource_id) lookups,
-- but this single-column index is more efficient for:
--   SELECT * FROM inventories WHERE user_id = $1
-- Without this index, every inventory fetch scans the entire table (O(n)).
-- With it, lookups are O(log n) via the B-tree index structure.
CREATE INDEX IF NOT EXISTS idx_inventories_user_id ON inventories(user_id);


-- =============================================================================
-- NOTES FOR DEVELOPERS
-- =============================================================================
--
-- STARTING RESOURCES:
--   When a new user registers, the application code (src/routes/auth.ts)
--   inserts the following rows into inventories within an ACID transaction:
--     (new_user_id, 'SESTERTIUS', 0)  — Roman currency
--     (new_user_id, 'LIGNUM',     0)  — Wood
--     (new_user_id, 'FRUMENTUM',  0)  — Grain
--
-- HOW TO ADD A NEW RESOURCE TYPE (future development):
--   1. No schema change needed — just add the new resource_id string to the
--      application's STARTING_RESOURCES constant in src/routes/auth.ts.
--   2. For existing users, write a migration that INSERTs a row with amount=0
--      for each (existing_user_id, 'NEW_RESOURCE') pair.
--
-- FUTURE MIGRATIONS:
--   This file (schema.sql) is Migration v1.
--   Future schema changes should be in separate files:
--     schema_v2_add_buildings.sql
--     schema_v3_add_marketplace.sql
--   A proper migration tool (like Flyway, Liquibase, or node-pg-migrate)
--   should be adopted as the project grows.
-- =============================================================================
