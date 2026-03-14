/**
 * @file scripts/simulateGameplay.ts
 * @description End-to-end gameplay simulation for Phase 4 manual testing.
 *
 * This script exercises the full time-based production loop via HTTP requests
 * against a running backend server. It is a black-box integration test:
 * it only uses the public API, exactly as the frontend would.
 *
 * ================================================================
 * WHAT THIS SCRIPT TESTS
 * ================================================================
 *
 *   1. POST /auth/register          — Create a fresh test account
 *   2. GET  /buildings              — Confirm 2 buildings were created (IDLE)
 *   3. POST /production/start       — Start production on CASTRA_LIGNATORUM
 *   4. GET  /buildings              — Confirm building is now PRODUCING
 *   5. Wait for end_time            — Sleep until production is complete
 *   6. POST /production/collect     — Collect the output
 *   7. GET  /inventory              — Verify LIGNUM increased by yield_amount
 *
 * ================================================================
 * SETUP BEFORE RUNNING
 * ================================================================
 *
 *   1. Start the backend:
 *        npm run dev:backend   (from the repo root)
 *
 *   2. For fast testing, add to backend/.env:
 *        PRODUCTION_DURATION_SECONDS=10
 *      This makes production complete in 10 seconds instead of 60.
 *      The script reads end_time from the API and waits accordingly.
 *
 *   3. Run this script:
 *        npx ts-node backend/scripts/simulateGameplay.ts
 *
 * ================================================================
 * USAGE
 * ================================================================
 *
 *   Optional env vars:
 *     SIMULATE_API_URL  — Override the API base URL (default: http://localhost:3001/api/v1)
 */

// ================================================================
// CONFIGURATION
// ================================================================

const BASE_URL = process.env.SIMULATE_API_URL ?? 'http://localhost:3001/api/v1';

// A unique username per run prevents conflicts if the script is run multiple times.
// Using Date.now() gives millisecond precision — highly unlikely to collide.
const TEST_USERNAME = `sim_${Date.now()}`;
const TEST_PASSWORD = 'simulation_password_123';

// ================================================================
// UTILITIES
// ================================================================

/** Wraps setTimeout in a Promise for async/await sleep. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Makes an authenticated or unauthenticated API request. Throws on non-2xx. */
async function apiCall<T>(
  endpoint: string,
  options: RequestInit = {},
  token?: string
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  const data = await response.json() as T & { error?: string };

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} on ${endpoint}: ${data.error ?? JSON.stringify(data)}`
    );
  }

  return data;
}

/** Prints a step header to visually separate simulation phases in the log. */
function step(n: number, total: number, description: string): void {
  console.log(`\n[Step ${n}/${total}] ${description}`);
}

/** Prints a success line. */
function ok(message: string): void {
  console.log(`  ✓  ${message}`);
}

/** Prints an info line (non-success detail). */
function info(message: string): void {
  console.log(`     ${message}`);
}

// ================================================================
// API RESPONSE TYPES
// ================================================================

interface RegisterResponse {
  token: string;
  user: { id: string; username: string };
}

interface BuildingsResponse {
  buildings: Array<{
    id:            string;
    building_type: string;
    status:        'IDLE' | 'PRODUCING';
    job: {
      id:           string;
      resource_id:  string;
      start_time:   string;
      end_time:     string;
      yield_amount: number;
    } | null;
  }>;
}

interface StartProductionResponse {
  message: string;
  building: {
    id:            string;
    building_type: string;
    status:        'PRODUCING';
    job: {
      id:           string;
      resource_id:  string;
      start_time:   string;
      end_time:     string;
      yield_amount: number;
    };
  };
}

interface CollectResponse {
  message: string;
  collected: {
    resource_id:          string;
    amount_collected:     number;
    new_inventory_amount: number;
  };
}

interface InventoryResponse {
  inventory: Array<{ resource_id: string; amount: number }>;
}

// ================================================================
// MAIN SIMULATION
// ================================================================

async function main(): Promise<void> {
  const TOTAL_STEPS = 7;

  console.log('='.repeat(60));
  console.log('  Opes — Phase 4 Gameplay Simulation');
  console.log(`  API: ${BASE_URL}`);
  console.log(`  Player: ${TEST_USERNAME}`);
  console.log('='.repeat(60));

  // ---- Step 1: Register ----
  step(1, TOTAL_STEPS, 'Registering test player...');
  const { token, user } = await apiCall<RegisterResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }),
  });
  ok(`Registered. Player ID: ${user.id}`);

  // ---- Step 2: Fetch buildings (expect 2 × IDLE) ----
  step(2, TOTAL_STEPS, 'Fetching buildings after registration...');
  const { buildings: initialBuildings } = await apiCall<BuildingsResponse>(
    '/buildings',
    {},
    token
  );

  if (initialBuildings.length !== 2) {
    throw new Error(
      `Expected 2 buildings after registration, got ${initialBuildings.length}.`
    );
  }

  for (const b of initialBuildings) {
    if (b.status !== 'IDLE') {
      throw new Error(`Expected building ${b.building_type} to be IDLE, got ${b.status}.`);
    }
    ok(`${b.building_type} — ${b.status}`);
  }

  // ---- Step 3: Start production on CASTRA_LIGNATORUM ----
  step(3, TOTAL_STEPS, 'Starting production on CASTRA_LIGNATORUM...');
  const lignatorum = initialBuildings.find(
    (b) => b.building_type === 'CASTRA_LIGNATORUM'
  );

  if (!lignatorum) {
    throw new Error('CASTRA_LIGNATORUM building not found.');
  }

  const { building: producingBuilding } = await apiCall<StartProductionResponse>(
    '/production/start',
    {
      method: 'POST',
      body: JSON.stringify({ building_id: lignatorum.id }),
    },
    token
  );

  ok(`Production started. Status: ${producingBuilding.status}`);
  info(`Resource: ${producingBuilding.job.resource_id}`);
  info(`Yield:    ${producingBuilding.job.yield_amount} units`);
  info(`End time: ${producingBuilding.job.end_time}`);

  // ---- Step 4: Confirm building is PRODUCING ----
  step(4, TOTAL_STEPS, 'Confirming building status is PRODUCING...');
  const { buildings: updatedBuildings } = await apiCall<BuildingsResponse>(
    '/buildings',
    {},
    token
  );

  const updatedLignatorum = updatedBuildings.find(
    (b) => b.building_type === 'CASTRA_LIGNATORUM'
  );

  if (updatedLignatorum?.status !== 'PRODUCING') {
    throw new Error(
      `Expected CASTRA_LIGNATORUM to be PRODUCING, got ${updatedLignatorum?.status}.`
    );
  }
  ok(`CASTRA_LIGNATORUM is PRODUCING. Job confirmed in database.`);

  // ---- Step 5: Wait for production to complete ----
  const endTime   = new Date(producingBuilding.job.end_time);
  const waitMs    = Math.max(0, endTime.getTime() - Date.now()) + 1000; // +1s buffer
  const waitSecs  = Math.ceil(waitMs / 1000);

  step(5, TOTAL_STEPS, `Waiting ${waitSecs}s for production to complete...`);
  info(`(Set PRODUCTION_DURATION_SECONDS=10 in .env to speed this up)`);

  // Print a dot every second so the terminal shows the script is still alive.
  const dotInterval = setInterval(() => process.stdout.write('.'), 1000);
  await sleep(waitMs);
  clearInterval(dotInterval);
  console.log(' done');
  ok(`Production window has passed.`);

  // ---- Step 6: Collect ----
  step(6, TOTAL_STEPS, 'Collecting production output...');
  const { collected } = await apiCall<CollectResponse>(
    '/production/collect',
    {
      method: 'POST',
      body: JSON.stringify({ building_id: lignatorum.id }),
    },
    token
  );

  ok(`Collected ${collected.amount_collected} ${collected.resource_id}.`);
  info(`New inventory total: ${collected.new_inventory_amount} ${collected.resource_id}`);

  // ---- Step 7: Verify inventory ----
  step(7, TOTAL_STEPS, 'Verifying final inventory...');
  const { inventory } = await apiCall<InventoryResponse>('/inventory', {}, token);

  for (const row of inventory) {
    ok(`${row.resource_id}: ${row.amount}`);
  }

  const lignum = inventory.find((r) => r.resource_id === 'LIGNUM');
  if (!lignum || lignum.amount < producingBuilding.job.yield_amount) {
    throw new Error(
      `LIGNUM should be >= ${producingBuilding.job.yield_amount}, got ${lignum?.amount ?? 0}.`
    );
  }

  // ---- Summary ----
  console.log('\n' + '='.repeat(60));
  console.log('  SIMULATION PASSED — All steps completed successfully.');
  console.log('='.repeat(60) + '\n');
}

// ================================================================
// ENTRY POINT
// ================================================================

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('\n[SIMULATION FAILED]', message);
  process.exit(1);
});
