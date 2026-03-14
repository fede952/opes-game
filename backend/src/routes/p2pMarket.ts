/**
 * @file src/routes/p2pMarket.ts
 * @description P2P "Forum" Market: player-to-player resource trading with escrow.
 *
 * ================================================================
 * PHASE 7 CHANGES FROM PHASE 5
 * ================================================================
 *
 * 1. QUALITY DIMENSION
 *    Listings now carry a `quality` field (0, 1, or 2). A seller chooses
 *    which quality tier to list (e.g., Q1 FARINA for a premium price).
 *    The buyer receives the resource at exactly that quality tier.
 *
 *    Inventory escrow deduction targets (resource_id, quality) specifically:
 *    a player with 50 Q0 LIGNUM and 10 Q1 LIGNUM listing 5 Q1 LIGNUM
 *    deducts 5 from the Q1 row only.
 *
 * 2. EXPANDED LISTABLE RESOURCES
 *    FARINA is now tradeable on the P2P market (was not in Phase 5).
 *    RESEARCH remains non-listable (it's an abstract resource, not a physical good).
 *    SESTERTIUS remains non-listable (currency cannot be traded for currency).
 *
 * 3. STORAGE LIMIT CHECK ON BUY
 *    Before completing a purchase, the server checks whether the buyer has
 *    room for the incoming resources. If their physical storage would
 *    overflow, the buy is rejected with 400 "Insufficient storage capacity".
 *    SESTERTIUS and RESEARCH skip this check (they are weightless).
 *
 * 4. ON CONFLICT KEY UPDATE
 *    All inventory upserts use the new 3-column PK (user_id, resource_id, quality).
 *
 * ================================================================
 * LOCK ORDERING (ALPHABETICAL WITHIN TABLE — UNCHANGED)
 * ================================================================
 *
 * The buy transaction locks:
 *   (1) market_listings row   (to prevent double-buy)
 *   (2) buyer SESTERTIUS row  (to prevent double-spend — Q0 only)
 * These are in different tables, so same-table alphabetical ordering
 * does not apply. The cross-table order is fixed and consistent:
 * listing → SESTERTIUS inventory.
 */

import { Router, Request, Response, NextFunction } from 'express';
import authMiddleware               from '../middleware/authMiddleware';
import { query, withTransaction }   from '../db/connection';
import { HttpError }                from '../utils/HttpError';
import { getStorageState, WEIGHTLESS_RESOURCES } from '../utils/storageUtils';

const router = Router();

router.use(authMiddleware);

// ================================================================
// CONSTANTS
// ================================================================

/**
 * Resources that players may list on the P2P market.
 *
 * SESTERTIUS: excluded — currency cannot trade for currency.
 * RESEARCH:   excluded — abstract knowledge points, not a physical good.
 *
 * FARINA added in Phase 7: processed goods are now player-tradeable.
 */
const LISTABLE_RESOURCES = new Set<string>(['FARINA', 'FRUMENTUM', 'LIGNUM']);

// ================================================================
// ROUTE: GET /api/v1/market/p2p
// ================================================================

/**
 * Returns all active P2P market listings including quality tier.
 *
 * Phase 7: listings now include `quality` and `seller_id` is kept private
 * (only `seller_username` is exposed, as before).
 *
 * SUCCESS: 200 OK
 * {
 *   listings: [
 *     {
 *       id:              "uuid",
 *       resource_id:     "LIGNUM",
 *       quality:         1,
 *       amount:          10,
 *       price_per_unit:  5,
 *       total_price:     50,
 *       seller_username: "marcus",
 *       created_at:      "..."
 *     }
 *   ]
 * }
 */
router.get(
  '/',
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await query<{
        id:              string;
        resource_id:     string;
        quality:         number;
        amount:          number;
        price_per_unit:  number;
        total_price:     number;
        seller_username: string;
        created_at:      string;
      }>(
        `SELECT  ml.id,
                 ml.resource_id,
                 ml.quality,
                 ml.amount,
                 ml.price_per_unit,
                 ml.amount * ml.price_per_unit AS total_price,
                 u.username                    AS seller_username,
                 ml.created_at
         FROM    market_listings ml
         JOIN    users u ON u.id = ml.seller_id
         WHERE   ml.status = 'ACTIVE'
         ORDER BY ml.created_at DESC`
      );

      res.status(200).json({ listings: result.rows });

    } catch (error) {
      next(error);
    }
  }
);

// ================================================================
// ROUTE: POST /api/v1/market/p2p/list
// ================================================================

/**
 * Creates a new P2P listing. Implements the ESCROW step.
 *
 * Phase 7 additions:
 *   - Accepts optional `quality` parameter (0–2, default 0).
 *   - Escrow deduction targets the specific (resource_id, quality) inventory row.
 *   - market_listings INSERT includes quality.
 *   - FARINA is now listable.
 *
 * Request body: { "resource_id": "LIGNUM", "amount": 10, "price_per_unit": 5, "quality": 0 }
 *
 * SUCCESS: 201 Created
 *
 * ERRORS:
 *   400 — resource_id missing / not listable
 *   400 — quality not 0, 1, or 2
 *   400 — amount or price_per_unit not a positive integer
 *   400 — insufficient resources at the specified quality
 */
router.post(
  '/list',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;

      const { resource_id, amount, price_per_unit, quality } = req.body as {
        resource_id?:    unknown;
        amount?:         unknown;
        price_per_unit?: unknown;
        quality?:        unknown;
      };

      // ---- INPUT VALIDATION ----

      if (typeof resource_id !== 'string' || resource_id.trim().length === 0) {
        res.status(400).json({ error: 'resource_id is required.' });
        return;
      }

      const normalizedResource = resource_id.trim().toUpperCase();

      if (!LISTABLE_RESOURCES.has(normalizedResource)) {
        res.status(400).json({
          error: `Cannot list '${normalizedResource}' on the market. ` +
                 `Listable resources: ${[...LISTABLE_RESOURCES].sort().join(', ')}.`,
        });
        return;
      }

      // Parse quality (default 0).
      const parsedQuality =
        quality === undefined || quality === null
          ? 0
          : typeof quality === 'number'
            ? Math.floor(quality)
            : parseInt(String(quality), 10);

      if (!Number.isFinite(parsedQuality) || parsedQuality < 0 || parsedQuality > 2) {
        res.status(400).json({ error: 'quality must be 0, 1, or 2.' });
        return;
      }

      const parsedAmount =
        typeof amount === 'number'
          ? Math.floor(amount)
          : parseInt(String(amount), 10);

      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        res.status(400).json({ error: 'amount must be a positive integer.' });
        return;
      }

      const parsedPrice =
        typeof price_per_unit === 'number'
          ? Math.floor(price_per_unit)
          : parseInt(String(price_per_unit), 10);

      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        res.status(400).json({ error: 'price_per_unit must be a positive integer.' });
        return;
      }

      const listing = await withTransaction(async (client) => {

        // ---- STEP 1: Lock the seller's specific (resource, quality) inventory row ----
        //
        // Targeting (resource_id, quality) prevents the seller from double-listing
        // the same quality tier simultaneously or selling it to the NPC market
        // at the same time.
        const resourceRow = await client.query<{ amount: number }>(
          `SELECT amount
           FROM   inventories
           WHERE  user_id     = $1
             AND  resource_id = $2
             AND  quality     = $3
           FOR UPDATE`,
          [userId, normalizedResource, parsedQuality]
        );

        if (resourceRow.rowCount === 0) {
          throw new HttpError(
            400,
            `You have no ${normalizedResource} at Quality ${parsedQuality} to list.`
          );
        }

        const currentAmount: number = resourceRow.rows[0].amount;

        // ---- STEP 2: Validate sufficient resources ----
        if (currentAmount < parsedAmount) {
          throw new HttpError(
            400,
            `Insufficient ${normalizedResource} at Quality ${parsedQuality}. ` +
            `You have ${currentAmount} but tried to list ${parsedAmount}.`
          );
        }

        // ---- STEP 3: ESCROW — deduct from seller's inventory at specified quality ----
        await client.query(
          `UPDATE inventories
           SET    amount = amount - $1
           WHERE  user_id     = $2
             AND  resource_id = $3
             AND  quality     = $4`,
          [parsedAmount, userId, normalizedResource, parsedQuality]
        );

        // ---- STEP 4: Create the market listing with quality ----
        const listingResult = await client.query<{
          id:             string;
          resource_id:    string;
          quality:        number;
          amount:         number;
          price_per_unit: number;
          status:         string;
          created_at:     string;
        }>(
          `INSERT INTO market_listings (seller_id, resource_id, quality, amount, price_per_unit)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, resource_id, quality, amount, price_per_unit, status, created_at`,
          [userId, normalizedResource, parsedQuality, parsedAmount, parsedPrice]
        );

        return listingResult.rows[0];
      });

      const qualityLabel = listing.quality > 0 ? ` Q${listing.quality}` : '';
      res.status(201).json({
        message: `Listed ${listing.amount}${qualityLabel} ${listing.resource_id} at ` +
                 `${listing.price_per_unit} Sestertius each. Resources are now held in escrow.`,
        listing,
      });

    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
    }
  }
);

// ================================================================
// ROUTE: POST /api/v1/market/p2p/buy
// ================================================================

/**
 * Purchases an active P2P listing. Settles the escrow.
 *
 * Phase 7 additions:
 *   - Storage check before awarding the resource to the buyer.
 *   - Buyer receives resource at listing.quality (not always Q0).
 *   - Inventory upserts use 3-column ON CONFLICT key.
 *   - listing SELECT now returns `quality`.
 *
 * The full transaction (10 steps, unchanged in structure):
 *   [1] Lock listing row (prevents double-buy)
 *   [2] Validate ACTIVE
 *   [3] Validate buyer ≠ seller
 *   [4] Calculate total cost (INT arithmetic)
 *   [5] Storage check (if resource is physical)
 *   [6] Lock buyer SESTERTIUS
 *   [7] Validate funds
 *   [8] Deduct SESTERTIUS from buyer
 *   [9] Award resource at listing.quality to buyer (upsert)
 *  [10] Credit SESTERTIUS to seller (upsert at Q0)
 *  [11] Mark listing SOLD
 *
 * Request body: { "listing_id": "uuid" }
 *
 * SUCCESS: 200 OK
 * ERRORS: 400, 404, 409 (see JSDoc comments inside handler)
 */
router.post(
  '/buy',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const buyerId = req.userId!;

      const { listing_id } = req.body as { listing_id?: unknown };

      if (typeof listing_id !== 'string' || listing_id.trim().length === 0) {
        res.status(400).json({ error: 'listing_id is required.' });
        return;
      }

      const purchase = await withTransaction(async (client) => {

        // ---- STEP 1: Lock the listing row ----
        const listingResult = await client.query<{
          id:             string;
          seller_id:      string;
          resource_id:    string;
          quality:        number;
          amount:         number;
          price_per_unit: number;
          status:         string;
        }>(
          `SELECT id, seller_id, resource_id, quality, amount, price_per_unit, status
           FROM   market_listings
           WHERE  id = $1
           FOR UPDATE`,
          [listing_id.trim()]
        );

        if (listingResult.rowCount === 0) {
          throw new HttpError(404, 'Listing not found.');
        }

        const listing = listingResult.rows[0];

        // ---- STEP 2: Verify listing is still ACTIVE ----
        if (listing.status !== 'ACTIVE') {
          throw new HttpError(
            409,
            'This listing is no longer available (already sold or cancelled).'
          );
        }

        // ---- STEP 3: Prevent self-purchase ----
        if (listing.seller_id === buyerId) {
          throw new HttpError(400, 'You cannot buy your own listing.');
        }

        // ---- STEP 4: Calculate total cost (integer arithmetic) ----
        const totalCost: number = listing.amount * listing.price_per_unit;

        // ---- Phase 7: STEP 5 — Storage capacity check ----
        //
        // If the buyer is purchasing a physical resource, verify they have room.
        // SESTERTIUS and RESEARCH are weightless — no check needed for those.
        if (!WEIGHTLESS_RESOURCES.has(listing.resource_id)) {
          const storage = await getStorageState(client, buyerId);

          if (storage.used + listing.amount > storage.capacity) {
            throw new HttpError(
              400,
              `Insufficient storage capacity. ` +
              `You have ${storage.capacity - storage.used} free slots ` +
              `but this listing contains ${listing.amount} units. ` +
              `Build or upgrade a Horreum (Warehouse) to increase capacity, ` +
              `or sell some resources first.`
            );
          }
        }

        // ---- STEP 6: Lock buyer's SESTERTIUS row ----
        //
        // SESTERTIUS is always at quality = 0 (currency has no quality tier).
        const buyerFundsResult = await client.query<{ amount: number }>(
          `SELECT amount
           FROM   inventories
           WHERE  user_id     = $1
             AND  resource_id = 'SESTERTIUS'
             AND  quality     = 0
           FOR UPDATE`,
          [buyerId]
        );

        const buyerSestertius: number = buyerFundsResult.rows[0]?.amount ?? 0;

        // ---- STEP 7: Validate buyer has sufficient funds ----
        if (buyerSestertius < totalCost) {
          throw new HttpError(
            400,
            `Insufficient funds. You have ${buyerSestertius} Sestertius ` +
            `but this listing costs ${totalCost}.`
          );
        }

        // ---- STEP 8: Deduct Sestertius from buyer (Q0) ----
        await client.query(
          `UPDATE inventories
           SET    amount = amount - $1
           WHERE  user_id     = $2
             AND  resource_id = 'SESTERTIUS'
             AND  quality     = 0`,
          [totalCost, buyerId]
        );

        // ---- STEP 9: Add resource to buyer at listing.quality ----
        //
        // The buyer receives the resource at the quality tier specified
        // in the listing. ON CONFLICT uses the 3-column PK.
        await client.query(
          `INSERT INTO inventories (user_id, resource_id, quality, amount)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, resource_id, quality) DO UPDATE
             SET amount = inventories.amount + EXCLUDED.amount`,
          [buyerId, listing.resource_id, listing.quality, listing.amount]
        );

        // ---- STEP 10: Credit Sestertius to seller at Q0 ----
        await client.query(
          `INSERT INTO inventories (user_id, resource_id, quality, amount)
           VALUES ($1, 'SESTERTIUS', 0, $2)
           ON CONFLICT (user_id, resource_id, quality) DO UPDATE
             SET amount = inventories.amount + EXCLUDED.amount`,
          [listing.seller_id, totalCost]
        );

        // ---- STEP 11: Mark listing as SOLD ----
        await client.query(
          `UPDATE market_listings
           SET    status = 'SOLD'
           WHERE  id = $1`,
          [listing.id]
        );

        return {
          listing_id:  listing.id,
          resource_id: listing.resource_id,
          quality:     listing.quality,
          amount:      listing.amount,
          total_cost:  totalCost,
        };
      });

      const qualityLabel = purchase.quality > 0 ? ` Q${purchase.quality}` : '';
      res.status(200).json({
        message:  `Successfully purchased ${purchase.amount}${qualityLabel} ` +
                  `${purchase.resource_id} for ${purchase.total_cost} Sestertius.`,
        purchase,
      });

    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      next(error);
    }
  }
);

// ================================================================
// ROUTE: POST /api/v1/market/p2p/cancel
// ================================================================

/**
 * Cancels an active P2P listing owned by the requesting player.
 * Returns the escrowed resources back to the seller's inventory.
 *
 * Transaction steps:
 *   [1] Lock the listing row (prevents concurrent cancel + buy race)
 *   [2] Verify the listing is ACTIVE and belongs to req.userId
 *   [3] Mark listing CANCELLED
 *   [4] Return escrowed resources to seller inventory (upsert at listing.quality)
 *
 * Request body: { "listing_id": "uuid" }
 *
 * SUCCESS: 200 OK
 * { message: "Listing cancelled. 10 LIGNUM returned to your inventory.", listing_id }
 *
 * ERRORS:
 *   400 — listing_id missing
 *   403 — listing does not belong to the requesting player
 *   404 — listing not found
 *   409 — listing is not ACTIVE (already sold or previously cancelled)
 */
router.post(
  '/cancel',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;

      const { listing_id } = req.body as { listing_id?: unknown };

      if (typeof listing_id !== 'string' || listing_id.trim().length === 0) {
        res.status(400).json({ error: 'listing_id is required.' });
        return;
      }

      const cancelled = await withTransaction(async (client) => {

        // ---- STEP 1: Lock the listing row ----
        //
        // FOR UPDATE locks the row to prevent a concurrent /buy from
        // simultaneously settling the same listing while we cancel it.
        const listingResult = await client.query<{
          id:          string;
          seller_id:   string;
          resource_id: string;
          quality:     number;
          amount:      number;
          status:      string;
        }>(
          `SELECT id, seller_id, resource_id, quality, amount, status
           FROM   market_listings
           WHERE  id = $1
           FOR UPDATE`,
          [listing_id.trim()]
        );

        if (listingResult.rowCount === 0) {
          throw new HttpError(404, 'Listing not found.');
        }

        const listing = listingResult.rows[0];

        // ---- STEP 2a: Verify ownership ----
        //
        // Only the original seller may cancel their own listing.
        // Returning 403 (Forbidden) rather than 404 to avoid leaking
        // existence information while still being informative.
        if (listing.seller_id !== userId) {
          throw new HttpError(403, 'You can only cancel your own listings.');
        }

        // ---- STEP 2b: Verify listing is still ACTIVE ----
        if (listing.status !== 'ACTIVE') {
          throw new HttpError(
            409,
            `Cannot cancel a listing with status '${listing.status}'. ` +
            `Only ACTIVE listings can be cancelled.`
          );
        }

        // ---- STEP 3: Mark listing as CANCELLED ----
        await client.query(
          `UPDATE market_listings
           SET    status = 'CANCELLED'
           WHERE  id = $1`,
          [listing.id]
        );

        // ---- STEP 4: Return escrowed resources to seller inventory ----
        //
        // The escrowed quantity is returned at the same quality tier it
        // was listed at — a Q1 listing returns Q1 resources.
        // ON CONFLICT handles the case where the seller's inventory row
        // may have been reduced to 0 (or deleted) while the listing was active.
        await client.query(
          `INSERT INTO inventories (user_id, resource_id, quality, amount)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, resource_id, quality) DO UPDATE
             SET amount = inventories.amount + EXCLUDED.amount`,
          [userId, listing.resource_id, listing.quality, listing.amount]
        );

        return listing;
      });

      const qualityLabel = cancelled.quality > 0 ? ` Q${cancelled.quality}` : '';
      res.status(200).json({
        message:    `Listing cancelled. ${cancelled.amount}${qualityLabel} ` +
                    `${cancelled.resource_id} returned to your inventory.`,
        listing_id: cancelled.id,
      });

    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      next(error);
    }
  }
);

export default router;
