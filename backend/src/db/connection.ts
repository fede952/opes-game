/**
 * @file db/connection.ts
 * @description PostgreSQL connection pool and transaction utilities for Opes.
 *
 * ================================================================
 * WHY POSTGRESQL FOR AN ECONOMIC SIMULATION?
 * ================================================================
 *
 * Opes is a game where thousands of players simultaneously trade resources,
 * accumulate wealth, and interact with a shared marketplace. The database
 * is the backbone of the entire economy. Choosing the right database and
 * using it correctly is one of the most critical architectural decisions.
 *
 * PostgreSQL is the right choice because it is fully ACID-compliant.
 *
 * ================================================================
 * WHAT ARE ACID TRANSACTIONS? (Critical for a multiplayer economy)
 * ================================================================
 *
 * A "transaction" is a group of database operations treated as a single
 * logical unit of work. ACID describes the four guarantees that make
 * transactions reliable, even under failure or high concurrency.
 *
 * --- A: ATOMICITY — "All or Nothing" ---
 *
 *   Scenario: Player A sends 100 gold to Player B.
 *   This requires two SQL UPDATE statements:
 *     (1) Deduct 100 from Player A's balance.
 *     (2) Add 100 to Player B's balance.
 *
 *   Without atomicity: If the server crashes between step 1 and step 2,
 *   Player A loses 100 gold but Player B never receives it. Gold is
 *   permanently DESTROYED from the game economy. Players lose trust.
 *
 *   With atomicity: Both operations are wrapped in a transaction.
 *   If step 2 fails for ANY reason, step 1 is automatically ROLLED BACK.
 *   The database is restored to its exact state before the transaction began.
 *   No gold is ever created or destroyed accidentally.
 *
 * --- C: CONSISTENCY — "Rules Are Always Enforced" ---
 *
 *   Database constraints (CHECK, UNIQUE, FOREIGN KEY) define the rules of
 *   the Opes economy (e.g., "gold_balance >= 0", "resource_amount >= 0").
 *   A transaction that would violate ANY of these rules is rejected entirely.
 *
 *   Example: A player tries to buy something they can't afford.
 *   The transaction is rejected — no partial state is ever saved.
 *
 * --- I: ISOLATION — "Concurrent Players Don't Interfere" ---
 *
 *   This is the most critical property for a multiplayer game.
 *
 *   Scenario (Race Condition without isolation):
 *     - The marketplace has exactly 1 unit of Garum (fish sauce) remaining.
 *     - Player A and Player B both click "Buy" at the exact same millisecond.
 *     - Without isolation, both transactions might read "quantity = 1",
 *       both decide there's enough, and both succeed — creating 2 purchases
 *       from 1 item. This is a "duplication exploit" that breaks the economy.
 *
 *   With isolation: One transaction acquires a lock on the row first.
 *   The other transaction must WAIT or FAIL. Only one purchase succeeds.
 *   The economy remains consistent.
 *
 *   For high-contention items (like limited marketplace auctions), you can
 *   use PostgreSQL's "SELECT ... FOR UPDATE" to acquire a row-level lock
 *   before checking quantity, preventing race conditions entirely.
 *
 * --- D: DURABILITY — "Committed Data Survives Crashes" ---
 *
 *   Once a transaction is committed (COMMIT is acknowledged), the data is
 *   permanently written to disk. A power outage or server crash immediately
 *   after a COMMIT will NOT lose that transaction's changes.
 *
 *   Player's hard-earned gold is safe even if our server crashes.
 *
 * ================================================================
 * WHY A CONNECTION POOL?
 * ================================================================
 *
 * Establishing a fresh database connection for every HTTP request is very slow:
 * it involves TCP handshakes, SSL negotiation, PostgreSQL authentication, and
 * process setup — adding 50-200ms of latency to EVERY request.
 *
 * A connection POOL maintains a set of pre-established, reusable connections.
 * When a request needs the database:
 *   1. It "checks out" an idle connection from the pool (near-instant).
 *   2. It executes its query.
 *   3. It "releases" the connection back to the pool.
 *
 * SCALABILITY: With 10 connections in the pool, the server can process 10
 * simultaneous database queries. A queue forms for requests beyond that —
 * they wait for a connection to be released (up to connectionTimeoutMillis).
 * Increase the pool size as player traffic grows, staying below PostgreSQL's
 * own max_connections limit (default 100; tunable in postgresql.conf).
 */

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import dotenv from 'dotenv';

// Ensure .env variables are available (safe to call multiple times).
dotenv.config();

// ================================================================
// CONNECTION POOL INSTANCE
// ================================================================

/**
 * The singleton PostgreSQL connection pool.
 *
 * All configuration is read from environment variables.
 * SECURITY: Database credentials must NEVER be hard-coded in source files.
 * Source code is often committed to version control and may be shared with
 * contractors, open-sourced accidentally, or leaked in a git breach.
 * Secrets in environment variables are kept outside the codebase entirely.
 */
const pool = new Pool({
  host:     process.env.DB_HOST     ?? 'localhost',
  port:     parseInt(process.env.DB_PORT ?? '5432', 10),
  database: process.env.DB_NAME     ?? 'opes_db',
  user:     process.env.DB_USER     ?? 'postgres',
  password: process.env.DB_PASSWORD,  // Intentionally no default — must be explicitly set.

  /**
   * Maximum number of concurrent connections maintained in the pool.
   *
   * Rule of thumb for a web app: start with 10, increase under load.
   * Too low: requests queue up and slow down under load.
   * Too high: PostgreSQL server runs out of connections (it also has a limit).
   *
   * SCALABILITY: If you run multiple instances of this server (horizontal scaling),
   * the TOTAL connections across ALL instances = (max * numberOfInstances).
   * Plan accordingly to stay under your DB's max_connections.
   */
  max: parseInt(process.env.DB_MAX_CONNECTIONS ?? '10', 10),

  /**
   * How long (milliseconds) an idle connection can sit in the pool before
   * being automatically closed and removed.
   *
   * This frees resources on the PostgreSQL server during off-peak hours
   * (e.g., low player count overnight). The pool will create new connections
   * when traffic picks up again.
   */
  idleTimeoutMillis: 30_000,

  /**
   * How long (milliseconds) to wait for a connection to become available
   * from the pool. If all connections are busy and none are freed within
   * this time, the request fails with a timeout error.
   *
   * This is a safety valve: it prevents requests from hanging indefinitely
   * during a database overload event, instead failing fast with a clear error.
   */
  connectionTimeoutMillis: 5_000,
});

// ================================================================
// POOL ERROR LISTENER
// ================================================================

/**
 * Handle unexpected errors emitted by idle pool connections.
 *
 * Without this listener, an error on an idle connection would be an
 * "unhandledRejection" event that crashes the entire Node.js process.
 * With this listener, we log the error and allow the pool to safely
 * remove and replace the broken connection.
 *
 * Common cause: the PostgreSQL server restarted or forcibly closed a
 * connection that was sitting idle in our pool.
 */
pool.on('error', (err: Error) => {
  console.error('[DB Pool] Unexpected error on idle client:', err.message);
});

// ================================================================
// QUERY UTILITY
// ================================================================

/**
 * Executes a single parameterized SQL query using a pool connection.
 *
 * Use this for read-only operations (SELECT) or simple single-row mutations
 * (INSERT/UPDATE/DELETE on a single table) that don't need transactional
 * guarantees spanning multiple operations.
 *
 * The pool automatically manages the connection lifecycle:
 * check out → query → release. You do not need to manage this manually.
 *
 * ----------------------------------------------------------------
 * PARAMETERIZED QUERIES — SQL INJECTION PREVENTION
 * ----------------------------------------------------------------
 * This is one of the most critical security practices in web development.
 *
 * SQL Injection is an attack where a malicious user crafts input that,
 * when concatenated into a SQL string, changes the meaning of the query.
 *
 * Classic example — VULNERABLE (never do this):
 *   const name = req.body.name; // Attacker sends: "'; DROP TABLE players; --"
 *   pool.query("SELECT * FROM players WHERE name = '" + name + "'");
 *   // Executed SQL: SELECT * FROM players WHERE name = ''; DROP TABLE players; --'
 *   // Result: The entire players table is deleted.
 *
 * SAFE approach using parameterized queries ($1, $2, ...):
 *   pool.query("SELECT * FROM players WHERE name = $1", [name]);
 *   // The driver sends the query and parameters SEPARATELY to PostgreSQL.
 *   // PostgreSQL treats $1 as pure DATA, not SQL code — it can never be
 *   // interpreted as a SQL command, regardless of its content.
 *
 * RULE: Always use $1, $2, $3 placeholders. NEVER concatenate user input
 * directly into SQL strings. No exceptions.
 *
 * @param text   - SQL query with $1, $2, ... parameter placeholders.
 * @param params - Values to substitute for the placeholders, in order.
 * @returns      A Promise resolving to the PostgreSQL QueryResult object.
 *
 * @example
 * // Fetch a player by ID (safe):
 * const { rows } = await query(
 *   'SELECT id, username, gold FROM players WHERE id = $1',
 *   [playerId]
 * );
 * const player = rows[0];
 */
export const query = async <R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<R>> => {
  const startTime = Date.now();

  const result = await pool.query<R>(text, params);

  const durationMs = Date.now() - startTime;

  // Log query performance in development to identify slow queries early.
  // "N+1 query problems" and missing indexes are best caught during development,
  // not after they've degraded production performance at scale.
  if (process.env.NODE_ENV !== 'production') {
    console.log(
      `[DB] ${durationMs}ms | ${result.rowCount ?? 0} row(s) | ${text.slice(0, 80)}...`
    );
  }

  return result;
};

// ================================================================
// TRANSACTION UTILITY
// ================================================================

/**
 * Executes multiple database operations within a single ACID transaction.
 *
 * Use this for ANY operation that modifies more than one record or table,
 * especially all player-to-player trades, marketplace purchases, treasury
 * transfers, or any scenario where partial failure would corrupt game state.
 *
 * This function implements the "Unit of Work" pattern:
 *   BEGIN      → Open the transaction (all subsequent operations are grouped)
 *   [callback] → Execute your sequence of INSERT/UPDATE/DELETE operations
 *   COMMIT     → If all succeeded, make ALL changes permanent simultaneously
 *   ROLLBACK   → If ANYTHING failed, undo ALL changes — database reverts fully
 *
 * The callback receives a dedicated PoolClient — a single connection that
 * must be used for all operations in the transaction. Using a different
 * connection for some operations would place them OUTSIDE the transaction.
 *
 * IMPORTANT: The callback must NOT call BEGIN, COMMIT, or ROLLBACK manually.
 * This wrapper handles the transaction lifecycle. The callback only executes
 * the business logic operations (the INSERTs, UPDATEs, etc.).
 *
 * @param callback - Async function that receives a PoolClient and performs
 *                   all database operations for this unit of work.
 *                   Returns a value T that this function will also return.
 * @returns        A Promise resolving to whatever the callback returns.
 * @throws         Re-throws any error from the callback after rolling back.
 *
 * @example
 * // Transfer 100 gold from Player A to Player B — atomically:
 * const tradeResult = await withTransaction(async (client) => {
 *   // Step 1: Deduct from sender (AND verify they have enough with the WHERE clause)
 *   const deductResult = await client.query(
 *     `UPDATE players
 *      SET gold = gold - $1
 *      WHERE id = $2 AND gold >= $1
 *      RETURNING id, gold`,
 *     [100, playerAId]
 *   );
 *
 *   // If no row was updated, Player A didn't have enough gold.
 *   if (deductResult.rowCount === 0) {
 *     throw new Error('Insufficient gold for transfer.');
 *     // This triggers the ROLLBACK — no gold is lost.
 *   }
 *
 *   // Step 2: Credit the recipient
 *   await client.query(
 *     'UPDATE players SET gold = gold + $1 WHERE id = $2',
 *     [100, playerBId]
 *   );
 *
 *   return { success: true, transferredAmount: 100 };
 * });
 */
export const withTransaction = async <T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> => {
  // Check out a DEDICATED connection from the pool.
  // This connection is exclusively reserved for this transaction until released.
  const client: PoolClient = await pool.connect();

  try {
    // BEGIN: Open the transaction. All subsequent queries on this client
    // are part of the same transaction until COMMIT or ROLLBACK.
    await client.query('BEGIN');

    // Execute the caller's business logic operations.
    const result: T = await callback(client);

    // COMMIT: All operations succeeded. Make all changes permanent.
    // At this point, the changes are written to disk (durable).
    await client.query('COMMIT');

    return result;
  } catch (error) {
    // ROLLBACK: Something went wrong. Undo ALL changes made since BEGIN.
    // The database is restored to its exact state before this transaction started.
    await client.query('ROLLBACK');

    console.error('[DB Transaction] ROLLBACK executed:', error);

    // Re-throw so the route handler receives the error and can return
    // an appropriate HTTP error response to the client.
    throw error;
  } finally {
    // ALWAYS release the connection back to the pool, whether we succeeded
    // or failed. The 'finally' block runs even if an error was thrown.
    //
    // WARNING: Forgetting client.release() causes a "connection leak".
    // The pool connection is never returned, so it can never be reused.
    // Under load, all pool connections get leaked, no new queries can run,
    // and the server effectively stops responding to database requests.
    client.release();
  }
};

// ================================================================
// GRACEFUL SHUTDOWN
// ================================================================

/**
 * Closes all connections in the pool gracefully.
 *
 * Should be called when the server process is shutting down (SIGTERM/SIGINT),
 * to cleanly close all open DB connections before the process exits.
 * This prevents "dangling connection" warnings in PostgreSQL logs and
 * ensures in-flight queries are not abruptly terminated.
 *
 * @example
 * process.on('SIGTERM', async () => {
 *   await closePool();
 *   process.exit(0);
 * });
 */
export const closePool = async (): Promise<void> => {
  await pool.end();
  console.log('[DB Pool] All connections closed gracefully.');
};

export default pool;
