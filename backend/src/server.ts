/**
 * @file server.ts
 * @description Main entry point for the Opes game backend API server.
 *
 * ================================================================
 * CORE ARCHITECTURE: SERVER-AUTHORITATIVE DESIGN
 * ================================================================
 *
 * In multiplayer games, especially economic simulations like Opes,
 * the server MUST be the single source of truth for ALL game state.
 * This principle is called "Server-Authoritative Architecture".
 *
 * ---- THE PROBLEM: Why can't we trust the client? ----
 *
 * The "client" is anything running on the player's machine: the browser,
 * a mobile app, or even a custom script. A malicious player has full
 * control over their own client. They can:
 *
 *   1. Open browser DevTools and modify JavaScript variables in memory.
 *   2. Use a proxy tool (like Burp Suite or Charles) to intercept and
 *      modify the data their browser sends to our server.
 *   3. Write a custom bot script that sends crafted HTTP requests directly
 *      to our API, bypassing the game UI entirely.
 *
 * If any economic calculation (prices, gold balances, trade outcomes)
 * happened on the client side, a cheater could simply send:
 *   POST /api/trade { "myGoldAfterTrade": 99999999 }
 * ...and our server would have no way to know it was a lie.
 *
 * ---- THE SOLUTION: Client sends INTENT, server executes ACTION ----
 *
 * The correct model is:
 *
 *   Client → Server:  "I INTEND to buy 10 wheat."
 *                      (Just the request — no amounts, no calculations)
 *
 *   Server:           1. Fetches player's REAL gold balance from the DATABASE
 *                        (never from the client's request body).
 *                     2. Calculates the REAL current wheat price (server-side logic).
 *                     3. Validates: does the player have enough gold?
 *                     4. Executes the transaction atomically (see db/connection.ts).
 *                     5. Returns the confirmed new state.
 *
 *   Server → Client:  "Confirmed. You now have 85 gold and 10 wheat."
 *                      (The client DISPLAYS what the server says — it doesn't own state)
 *
 * The client is essentially a "dumb terminal" that renders what the server
 * tells it, and reports what the player wants to do. All logic lives here.
 *
 * ---- PRACTICAL RULES for Opes developers: ----
 *
 *   ✅ DO:   Read player data from the database at the start of every handler.
 *   ✅ DO:   Perform all calculations (price, tax, yield) in route handlers or
 *            dedicated service files on the server.
 *   ✅ DO:   Validate every piece of input from the client, no matter how trusted
 *            the player seems.
 *   ✅ DO:   Use ACID transactions for any operation that modifies multiple records.
 *
 *   ❌ DON'T: Accept "resultingBalance" or "newPrice" values from the client.
 *   ❌ DON'T: Trust client-provided IDs without verifying ownership in the DB.
 *   ❌ DON'T: Perform economic calculations in React/frontend code and send results.
 */

import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import authRoutes        from './routes/auth';
import inventoryRoutes   from './routes/inventory';
import buildingsRoutes   from './routes/buildings';
import productionRoutes  from './routes/production';
import npcMarketRoutes   from './routes/npcMarket';
import p2pMarketRoutes   from './routes/p2pMarket';
import contractsRoutes   from './routes/contracts';
import bondsRoutes       from './routes/bonds';
import leaderboardRoutes from './routes/leaderboard';

// Load environment variables from the .env file into process.env.
// MUST be called before any process.env access below.
// SECURITY: Secrets (DB passwords, JWT keys) live in .env — never in source code.
dotenv.config();

// ================================================================
// CONFIGURATION
// ================================================================

/**
 * The TCP port this server listens on.
 *
 * Why parseInt with radix 10?
 * process.env values are always strings. parseInt converts "3001" → 3001.
 * The '?? "3001"' part is a "nullish coalescing" fallback: if PORT is not
 * set in .env, we default to 3001 (leaving 3000 free for the Vite dev server).
 */
const PORT: number = parseInt(process.env.PORT ?? '3001', 10);

/**
 * The current runtime environment.
 *
 * We use this throughout the codebase to enable dev-only features
 * (verbose logging, detailed error messages) and disable them in production.
 *
 * SECURITY: Never expose stack traces or internal details to clients in
 * production. Attackers use them to map your system and target known CVEs.
 */
const NODE_ENV: string = process.env.NODE_ENV ?? 'development';

// Create the main Express application instance.
const app: Application = express();

// ================================================================
// MIDDLEWARE PIPELINE
// ================================================================
// Middleware functions execute in the ORDER they are registered with app.use().
// Every incoming HTTP request passes through this pipeline from top to bottom
// before reaching a route handler. Think of it as a security + parsing checkpoint.

/**
 * MIDDLEWARE 1: CORS — Cross-Origin Resource Sharing
 *
 * MUST come before Helmet so the Access-Control-Allow-Origin header is set
 * on the response before Helmet's Cross-Origin-Resource-Policy header can
 * interfere with it. If Helmet runs first and sets CORP: same-origin, the
 * browser blocks the response before it ever reads the CORS headers.
 *
 * SECURITY: NEVER use cors({ origin: '*' }) in production. Wildcard CORS
 * means ANY website on the internet can make authenticated requests to your
 * API using your players' sessions/cookies — a severe CSRF vulnerability.
 */
// DEPLOY_VERSION: 1.0.1
const CORS_WHITELIST = [
  'https://opes.federicosella.com',
  'https://opes-game.pages.dev',
  'http://localhost:5173',
];

console.log('[CORS] Whitelist initialized with:', CORS_WHITELIST);

app.use(
  cors({
    origin: (origin, callback) => {
      // Strip trailing slash defensively — some proxies/CDNs append one.
      const normalised = origin?.replace(/\/$/, '');
      console.log('[CORS Check] Request from origin:', origin, '→ normalised:', normalised);

      if (!normalised || CORS_WHITELIST.includes(normalised)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: Origin '${origin}' is not permitted.`));
      }
    },
    credentials: true,
  })
);

/**
 * MIDDLEWARE 2: Helmet — HTTP Security Headers
 *
 * Runs after CORS so it doesn't clobber the Access-Control-* headers that
 * cors() already wrote. crossOriginResourcePolicy is relaxed to "cross-origin"
 * so browsers can load resources served by this API from other origins.
 */
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

/**
 * MIDDLEWARE 3: JSON Body Parser
 *
 * Parses the raw request body bytes as JSON and attaches the result to req.body.
 *
 * The 'limit' option is critical for security:
 * Without a size limit, a malicious client could send a gigabyte-sized JSON
 * payload to crash or slow down the server (a form of Denial-of-Service attack).
 * 10kb is generous for game API requests; adjust if needed for specific endpoints.
 */
app.use(express.json({ limit: '10kb' }));

/**
 * MIDDLEWARE 4: URL-Encoded Body Parser
 *
 * Parses bodies sent as HTML form submissions (application/x-www-form-urlencoded).
 * Less common for a JSON API, but included for completeness (e.g., payment callbacks).
 * 'extended: false' uses the lightweight 'querystring' library (sufficient for our needs).
 */
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// ================================================================
// ROUTES
// ================================================================

/**
 * GET /health — Health Check Endpoint
 *
 * Returns a simple 200 OK with status metadata. This endpoint is used by:
 *
 *   - Load balancers (e.g., AWS ELB, nginx) to determine if this instance
 *     is alive and ready to receive traffic. If it returns non-200, the
 *     instance is removed from the pool until it recovers.
 *
 *   - Deployment pipelines (CI/CD): after deploying a new version, the pipeline
 *     hits /health to confirm the server started successfully before routing
 *     live player traffic to it.
 *
 *   - External monitoring tools (e.g., UptimeRobot, Datadog) to alert the
 *     team if the server goes down.
 *
 * SCALABILITY: In a horizontally-scaled setup (multiple server instances),
 * each instance reports its own health independently. This endpoint should be
 * extremely lightweight — no database calls, no heavy computation.
 */
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    game: 'Opes',
    environment: NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

/**
 * AUTH ROUTES — /api/v1/auth/*
 * Public endpoints (no JWT required): register and login.
 * Mounted at /api/v1/auth so route handlers inside only define /register, /login.
 */
app.use('/api/v1/auth', authRoutes);

/**
 * INVENTORY ROUTES — /api/v1/inventory/*
 * All routes in this router are protected by authMiddleware (JWT required).
 * Mounted at /api/v1/inventory so handlers define / (GET only in Phase 4).
 */
app.use('/api/v1/inventory', inventoryRoutes);

/**
 * BUILDINGS ROUTES — /api/v1/buildings/*
 * Returns the player's building roster with live production job state.
 * Protected by authMiddleware inside the router.
 */
app.use('/api/v1/buildings', buildingsRoutes);

/**
 * PRODUCTION ROUTES — /api/v1/production/*
 * POST /start   — Begin a timed production run on an IDLE building.
 * POST /collect — Collect a completed production run and award resources.
 * Both routes use ACID transactions with SELECT FOR UPDATE for concurrency safety.
 */
app.use('/api/v1/production', productionRoutes);

/**
 * NPC MARKET ROUTES — /api/v1/market/npc/*
 * POST /sell — Sell a resource to the NPC Empire at fixed server-defined prices.
 * Uses a transaction: lock resource row → validate balance → deduct → credit Sestertius.
 */
app.use('/api/v1/market/npc', npcMarketRoutes);

/**
 * P2P MARKET ROUTES — /api/v1/market/p2p/*
 * GET  /      — Fetch all ACTIVE listings (JOINed with seller username only).
 * POST /list  — Create a new listing with escrow (resource deducted immediately).
 * POST /buy   — Purchase a listing atomically (6-step ACID transaction with locking).
 */
app.use('/api/v1/market/p2p', p2pMarketRoutes);

/**
 * CONTRACTS ROUTES — /api/v1/contracts/*
 * GET  /       — PENDING contracts where caller is sender or receiver.
 * POST /send   — Propose a private B2B contract; resources escrowed immediately.
 * POST /accept — Receiver accepts; Sestertius transferred, resource delivered.
 * POST /cancel — Either party cancels; escrowed resources returned to sender.
 * Locking: SESTERTIUS rows locked in alphabetical user_id order to prevent deadlocks.
 */
app.use('/api/v1/contracts', contractsRoutes);

/**
 * BONDS ROUTES — /api/v1/bonds/*
 * GET  /       — Market bonds + caller's issued/bought bonds.
 * POST /issue  — Issue a new bond (no money moves until bought).
 * POST /buy    — Buy a bond; principal transfers buyer → issuer immediately.
 * POST /repay  — Issuer repays principal + interest to buyer.
 * Locking: SESTERTIUS rows locked in alphabetical user_id order to prevent deadlocks.
 */
app.use('/api/v1/bonds', bondsRoutes);

/**
 * LEADERBOARD ROUTES — /api/v1/leaderboard/*
 * GET / — Top 50 players ranked by net worth (Sestertius + inventory + buildings).
 */
app.use('/api/v1/leaderboard', leaderboardRoutes);

/**
 * GET /api/v1 — API Root
 *
 * A simple placeholder confirming the API is reachable.
 *
 * WHY VERSIONING (/api/v1/)?
 * API versioning is a SCALABILITY best practice. When you need to make a
 * breaking change to the API (change a field name, remove an endpoint, alter
 * a response shape), you can introduce /api/v2/ without breaking existing
 * clients still using /api/v1/. Both versions can coexist during a transition
 * period, then v1 is deprecated and eventually removed.
 *
 * As the project grows, you will import and mount route modules here:
 *   import playerRoutes from './routes/players';
 *   app.use('/api/v1/players', playerRoutes);
 *
 *   import marketRoutes from './routes/market';
 *   app.use('/api/v1/market', marketRoutes);
 */
app.get('/api/v1', (_req: Request, res: Response) => {
  res.status(200).json({
    message: 'Opes API is running. Ave, navigator!',
    version: '1.0.0',
    docs: '/api/v1/docs', // Placeholder for future API documentation endpoint
  });
});

// ================================================================
// ERROR HANDLING MIDDLEWARE
// ================================================================
// Express identifies error-handling middleware by the 4-argument signature:
// (err, req, res, next). It MUST be registered AFTER all routes and
// regular middleware, or Express will not route errors to it.

/**
 * 404 — Not Found Handler
 *
 * If execution reaches this point, no route above matched the incoming request.
 * We return a clean JSON 404 instead of Express's default HTML error page,
 * which is inconsistent with our JSON API contract.
 *
 * SECURITY: We intentionally do NOT say "route X does not exist" — this
 * prevents attackers from using error messages to map which routes DO exist
 * (a reconnaissance technique called "route enumeration").
 */
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Resource not found.' });
});

/**
 * Global Error Handler
 *
 * Catches all errors passed via next(error) from any route handler or middleware.
 *
 * SECURITY: In production, we return a generic error message. Returning stack
 * traces to clients exposes:
 *   - Internal file paths (reveals server directory structure)
 *   - Library versions (lets attackers target known CVEs for those exact versions)
 *   - Business logic (reveals what your code is doing and how it fails)
 *
 * We log the full error server-side for the development team, and send only
 * a safe, generic message to the client in production.
 *
 * FUTURE IMPROVEMENT: Replace console.error with a structured logging library
 * like Pino or Winston, which can forward logs to a centralized service
 * (e.g., Datadog, Logtail, AWS CloudWatch) for alerting and analysis.
 */
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // Log the full error details server-side for debugging.
  console.error('[Server Error]', err.message, '\n', err.stack);

  // Use the status code set on the response if it's not the default 200,
  // otherwise fall back to 500 Internal Server Error.
  const statusCode = res.statusCode !== 200 ? res.statusCode : 500;

  res.status(statusCode).json({
    error:
      NODE_ENV === 'production'
        ? 'An internal server error occurred. Please try again later.'
        : err.message, // In development: show the real error message for faster debugging.
  });
});

// ================================================================
// START THE SERVER
// ================================================================

/**
 * Begin accepting TCP connections on the configured PORT.
 *
 * We store the server instance in a variable and export it. This is a
 * common pattern that allows test frameworks (like Jest + Supertest) to
 * start and stop the server programmatically without port conflicts.
 */
const server = app.listen(PORT, () => {
  console.log(
    `[Opes] Server running in '${NODE_ENV}' mode → http://localhost:${PORT}`
  );
  console.log(`[Opes] Health check available at http://localhost:${PORT}/health`);
});

export default server;
