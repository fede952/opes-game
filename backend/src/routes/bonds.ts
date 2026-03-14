/**
 * @file src/routes/bonds.ts
 * @description Financial Bonds: player-issued debt instruments for short-term capital.
 *
 * ================================================================
 * ROUTES IN THIS FILE
 * ================================================================
 *
 *   GET  /api/v1/bonds         — Market bonds + caller's issued/bought bonds.
 *   POST /api/v1/bonds/issue   — Issue a new bond (no money moves yet).
 *   POST /api/v1/bonds/buy     — Buy a bond on the market; principal transfers instantly.
 *   POST /api/v1/bonds/repay   — Issuer repays principal + interest to buyer.
 *
 * ================================================================
 * BOND ECONOMICS
 * ================================================================
 *
 *   On BUY:
 *     buyer pays principal_amount Sestertius → issuer receives principal_amount
 *
 *   On REPAY:
 *     issuer pays total_repayment Sestertius → buyer receives total_repayment
 *     total_repayment = principal_amount + FLOOR(principal_amount × interest_rate_percentage / 100)
 *
 *   Example: principal=100, rate=10%
 *     total_repayment = 100 + FLOOR(100 × 10 / 100) = 100 + 10 = 110 Sestertius
 *
 * ================================================================
 * LOCKING STRATEGY — POST /buy and POST /repay (TWO-USER TRANSACTIONS)
 * ================================================================
 *
 * Both operations move Sestertius between two users: issuer and buyer.
 * To prevent deadlocks when two transactions involving the same pair of users
 * run concurrently, we always acquire FOR UPDATE locks on their SESTERTIUS
 * inventory rows in ASCENDING numeric user_id order.
 *
 *   const [firstId, secondId] = [issuerId, buyerId].sort((a, b) => a - b);
 *   // Lock firstId's SESTERTIUS FOR UPDATE
 *   // Lock secondId's SESTERTIUS FOR UPDATE
 *
 * Because user IDs are integers, we sort numerically (not lexicographically).
 * Lexicographic sort of integers gives wrong results: e.g., 9 > 10 as strings.
 * Numeric sort is the correct, consistent global ordering that prevents deadlocks.
 *
 * FULL LOCK ORDER IN /buy:
 *   [1] Lock bond row                           (prevents double-buy)
 *   [2] Lock SESTERTIUS of min(issuerId, buyerId) by user_id ASC (numeric)
 *   [3] Lock SESTERTIUS of max(issuerId, buyerId) by user_id ASC (numeric)
 *   [4] Validate buyer has sufficient Sestertius
 *   [5] Execute transfer + update bond
 *
 * FULL LOCK ORDER IN /repay:
 *   [1] Lock bond row                             (ensures BOUGHT status)
 *   [2] Lock SESTERTIUS of min(issuerId, buyerId) by user_id ASC (numeric)
 *   [3] Lock SESTERTIUS of max(issuerId, buyerId) by user_id ASC (numeric)
 *   [4] Validate issuer has sufficient Sestertius
 *   [5] Execute repayment + update bond
 *
 * ================================================================
 * INTEGER IDs
 * ================================================================
 *
 * users.id and bonds.id are both INTEGER/SERIAL in the database.
 * All user ID comparisons pass Number(req.userId!) so the pg driver
 * sends the value as an integer, not as text or uuid.
 * Bond IDs from the request body are parsed with parseInt() before use.
 */

import { Router, Request, Response, NextFunction } from 'express';
import authMiddleware          from '../middleware/authMiddleware';
import { query, withTransaction } from '../db/connection';
import { HttpError }           from '../utils/HttpError';

const router = Router();

router.use(authMiddleware);

// ================================================================
// TYPES
// ================================================================

interface BondRow {
  id:                       number;
  issuer_id:                number;
  buyer_id:                 number | null;
  principal_amount:         number;
  interest_rate_percentage: number;
  status:                   string;
  created_at:               string;
  issuer_username:          string;
  buyer_username:           string | null;
}

// ================================================================
// ROUTE: GET /api/v1/bonds
// ================================================================

/**
 * Returns three views of the bond market:
 *   market:         All ISSUED bonds (available to purchase), with issuer username.
 *   my_issued:      All bonds issued by the caller (all statuses for history).
 *   my_investments: All bonds where the caller is the buyer (BOUGHT or REPAID).
 *
 * SUCCESS: 200 OK
 * { market: [...], my_issued: [...], my_investments: [...] }
 */
router.get(
  '/',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Number() converts "42" → 42 and the raw number 42 → 42.
      // Passing an integer ensures PostgreSQL uses integer comparison,
      // avoiding the "operator does not exist: integer = uuid" error.
      const userId = Number(req.userId!);

      const [marketResult, myIssuedResult, myInvestmentsResult] = await Promise.all([

        // All ISSUED bonds on the open market (not issued by the caller themselves).
        query<BondRow>(
          `SELECT  b.id,
                   b.issuer_id,
                   b.buyer_id,
                   b.principal_amount,
                   b.interest_rate_percentage,
                   b.status,
                   b.created_at,
                   u.username AS issuer_username,
                   NULL       AS buyer_username
           FROM    bonds b
           JOIN    users u ON u.id = b.issuer_id
           WHERE   b.status = 'ISSUED'
             AND   b.issuer_id <> $1
           ORDER  BY b.created_at DESC`,
          [userId]
        ),

        // All bonds issued by the caller (all statuses for history).
        query<BondRow>(
          `SELECT  b.id,
                   b.issuer_id,
                   b.buyer_id,
                   b.principal_amount,
                   b.interest_rate_percentage,
                   b.status,
                   b.created_at,
                   ui.username AS issuer_username,
                   ub.username AS buyer_username
           FROM    bonds b
           JOIN    users ui ON ui.id = b.issuer_id
           LEFT JOIN users ub ON ub.id = b.buyer_id
           WHERE   b.issuer_id = $1
           ORDER  BY b.created_at DESC`,
          [userId]
        ),

        // All bonds the caller has bought (BOUGHT or REPAID).
        query<BondRow>(
          `SELECT  b.id,
                   b.issuer_id,
                   b.buyer_id,
                   b.principal_amount,
                   b.interest_rate_percentage,
                   b.status,
                   b.created_at,
                   ui.username AS issuer_username,
                   ub.username AS buyer_username
           FROM    bonds b
           JOIN    users ui ON ui.id = b.issuer_id
           JOIN    users ub ON ub.id = b.buyer_id
           WHERE   b.buyer_id = $1
           ORDER  BY b.created_at DESC`,
          [userId]
        ),
      ]);

      res.status(200).json({
        market:         marketResult.rows,
        my_issued:      myIssuedResult.rows,
        my_investments: myInvestmentsResult.rows,
      });

    } catch (error) {
      next(error);
    }
  }
);

// ================================================================
// ROUTE: POST /api/v1/bonds/issue
// ================================================================

/**
 * Issues a new bond. No money moves — the bond is posted to the market
 * where any other player can buy it.
 *
 * Request body: { principal_amount: number, interest_rate_percentage: number }
 *
 * SUCCESS: 201 Created
 * ERRORS:  400 (validation)
 */
router.post(
  '/issue',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const issuerId = Number(req.userId!);

      const { principal_amount, interest_rate_percentage } = req.body as {
        principal_amount?:         unknown;
        interest_rate_percentage?: unknown;
      };

      const parsedPrincipal =
        typeof principal_amount === 'number'
          ? Math.floor(principal_amount)
          : parseInt(String(principal_amount), 10);

      if (!Number.isFinite(parsedPrincipal) || parsedPrincipal <= 0) {
        res.status(400).json({ error: 'principal_amount must be a positive integer.' });
        return;
      }

      const parsedRate =
        typeof interest_rate_percentage === 'number'
          ? Math.floor(interest_rate_percentage)
          : parseInt(String(interest_rate_percentage), 10);

      if (!Number.isFinite(parsedRate) || parsedRate < 0) {
        res.status(400).json({ error: 'interest_rate_percentage must be a non-negative integer.' });
        return;
      }

      const result = await query<{
        id:                       number;
        principal_amount:         number;
        interest_rate_percentage: number;
        status:                   string;
        created_at:               string;
      }>(
        `INSERT INTO bonds (issuer_id, principal_amount, interest_rate_percentage)
         VALUES ($1, $2, $3)
         RETURNING id, principal_amount, interest_rate_percentage, status, created_at`,
        [issuerId, parsedPrincipal, parsedRate]
      );

      const bond = result.rows[0];
      const totalRepayment = parsedPrincipal + Math.floor(parsedPrincipal * parsedRate / 100);

      res.status(201).json({
        message: `Bond issued for ${parsedPrincipal} Sestertius at ${parsedRate}% interest ` +
                 `(total repayment: ${totalRepayment} Sestertius). Listed on the market.`,
        bond,
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
// ROUTE: POST /api/v1/bonds/buy
// ================================================================

/**
 * Purchases an ISSUED bond. Transfers principal from buyer to issuer immediately.
 *
 * Request body: { bond_id: number }
 *
 * TRANSACTION STEPS:
 *   [1] Lock bond row                              (prevents double-buy)
 *   [2] Validate ISSUED + caller is not the issuer
 *   [3] Lock SESTERTIUS of min(issuerId, buyerId)  (numeric ascending)
 *   [4] Lock SESTERTIUS of max(issuerId, buyerId)  (numeric ascending)
 *   [5] Validate buyer has enough Sestertius
 *   [6] Deduct from buyer
 *   [7] Credit issuer (upsert)
 *   [8] Update bond: buyer_id = caller, status = BOUGHT
 *
 * SUCCESS: 200 OK
 * ERRORS:  400, 403, 404, 409
 */
router.post(
  '/buy',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const buyerId = Number(req.userId!);

      const { bond_id } = req.body as { bond_id?: unknown };

      // Accept bond_id as either a number or a numeric string.
      // bonds.id is SERIAL (integer) in the database.
      const parsedBondId =
        typeof bond_id === 'number'
          ? Math.floor(bond_id)
          : parseInt(String(bond_id), 10);

      if (!Number.isFinite(parsedBondId) || parsedBondId <= 0) {
        res.status(400).json({ error: 'bond_id must be a positive integer.' });
        return;
      }

      const result = await withTransaction(async (client) => {

        // ---- STEP 1: Lock the bond row ----
        const bondResult = await client.query<{
          id:               number;
          issuer_id:        number;
          principal_amount: number;
          status:           string;
        }>(
          `SELECT id, issuer_id, principal_amount, status
           FROM   bonds
           WHERE  id = $1
           FOR UPDATE`,
          [parsedBondId]
        );

        if (bondResult.rowCount === 0) {
          throw new HttpError(404, 'Bond not found.');
        }

        const bond = bondResult.rows[0];

        // ---- STEP 2: Validate ----
        if (bond.status !== 'ISSUED') {
          throw new HttpError(409, `This bond is no longer available (status: ${bond.status}).`);
        }

        if (bond.issuer_id === buyerId) {
          throw new HttpError(400, 'You cannot buy your own bond.');
        }

        const issuerId = bond.issuer_id;
        const principal = bond.principal_amount;

        // ---- STEPS 3–4: Lock both SESTERTIUS rows in numeric user_id order ----
        //
        // Sort NUMERICALLY (not lexicographically) because user IDs are integers.
        // Lexicographic sort: "9" > "10" (wrong). Numeric sort: 9 < 10 (correct).
        // Consistent ordering prevents circular-wait deadlocks.
        const [firstId, secondId] = [issuerId, buyerId].sort((a, b) => a - b);

        await client.query(
          `SELECT amount
           FROM   inventories
           WHERE  user_id = $1 AND resource_id = 'SESTERTIUS' AND quality = 0
           FOR UPDATE`,
          [firstId]
        );

        await client.query(
          `SELECT amount
           FROM   inventories
           WHERE  user_id = $1 AND resource_id = 'SESTERTIUS' AND quality = 0
           FOR UPDATE`,
          [secondId]
        );

        // Read buyer's current balance (the row is already locked above).
        const buyerRow = await client.query<{ amount: number }>(
          `SELECT amount
           FROM   inventories
           WHERE  user_id = $1 AND resource_id = 'SESTERTIUS' AND quality = 0`,
          [buyerId]
        );

        const buyerSestertius: number = buyerRow.rows[0]?.amount ?? 0;

        // ---- STEP 5: Validate buyer funds ----
        if (buyerSestertius < principal) {
          throw new HttpError(
            400,
            `Insufficient Sestertius. This bond costs ${principal} but you only have ${buyerSestertius}.`
          );
        }

        // ---- STEP 6: Deduct from buyer ----
        await client.query(
          `UPDATE inventories
           SET    amount = amount - $1
           WHERE  user_id = $2 AND resource_id = 'SESTERTIUS' AND quality = 0`,
          [principal, buyerId]
        );

        // ---- STEP 7: Credit issuer ----
        await client.query(
          `INSERT INTO inventories (user_id, resource_id, quality, amount)
           VALUES ($1, 'SESTERTIUS', 0, $2)
           ON CONFLICT (user_id, resource_id, quality) DO UPDATE
             SET amount = inventories.amount + EXCLUDED.amount`,
          [issuerId, principal]
        );

        // ---- STEP 8: Update bond ----
        await client.query(
          `UPDATE bonds
           SET    buyer_id = $1,
                  status   = 'BOUGHT'
           WHERE  id = $2`,
          [buyerId, bond.id]
        );

        return { bond_id: bond.id, principal_amount: principal };
      });

      res.status(200).json({
        message: `Bond purchased. You paid ${result.principal_amount} Sestertius. ` +
                 `Await repayment from the issuer.`,
        result,
      });

    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code: string }).code === '40P01'
      ) {
        res.status(409).json({ error: 'Transaction conflict detected. Please try again.' });
        return;
      }
      next(error);
    }
  }
);

// ================================================================
// ROUTE: POST /api/v1/bonds/repay
// ================================================================

/**
 * The issuer repays principal + interest to the buyer.
 *
 * Request body: { bond_id: number }
 *
 * total_repayment = principal + FLOOR(principal × interest_rate_percentage / 100)
 *
 * TRANSACTION STEPS:
 *   [1] Lock bond row
 *   [2] Validate BOUGHT + caller is issuer
 *   [3] Lock SESTERTIUS of min(issuerId, buyerId)  (numeric ascending)
 *   [4] Lock SESTERTIUS of max(issuerId, buyerId)  (numeric ascending)
 *   [5] Validate issuer has enough Sestertius
 *   [6] Deduct from issuer
 *   [7] Credit buyer (upsert)
 *   [8] Update bond status → REPAID
 *
 * SUCCESS: 200 OK
 * ERRORS:  400, 403, 404, 409
 */
router.post(
  '/repay',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const issuerId = Number(req.userId!);

      const { bond_id } = req.body as { bond_id?: unknown };

      const parsedBondId =
        typeof bond_id === 'number'
          ? Math.floor(bond_id)
          : parseInt(String(bond_id), 10);

      if (!Number.isFinite(parsedBondId) || parsedBondId <= 0) {
        res.status(400).json({ error: 'bond_id must be a positive integer.' });
        return;
      }

      const result = await withTransaction(async (client) => {

        // ---- STEP 1: Lock the bond row ----
        const bondResult = await client.query<{
          id:                       number;
          issuer_id:                number;
          buyer_id:                 number;
          principal_amount:         number;
          interest_rate_percentage: number;
          status:                   string;
        }>(
          `SELECT id, issuer_id, buyer_id, principal_amount, interest_rate_percentage, status
           FROM   bonds
           WHERE  id = $1
           FOR UPDATE`,
          [parsedBondId]
        );

        if (bondResult.rowCount === 0) {
          throw new HttpError(404, 'Bond not found.');
        }

        const bond = bondResult.rows[0];

        // ---- STEP 2: Validate ----
        if (bond.status !== 'BOUGHT') {
          throw new HttpError(409, `Cannot repay this bond (status: ${bond.status}).`);
        }

        if (bond.issuer_id !== issuerId) {
          throw new HttpError(403, 'Only the bond issuer can repay it.');
        }

        const buyerId = bond.buyer_id;
        const totalRepayment = bond.principal_amount +
          Math.floor(bond.principal_amount * bond.interest_rate_percentage / 100);

        // ---- STEPS 3–4: Lock both SESTERTIUS rows in numeric user_id order ----
        const [firstId, secondId] = [issuerId, buyerId].sort((a, b) => a - b);

        await client.query(
          `SELECT amount
           FROM   inventories
           WHERE  user_id = $1 AND resource_id = 'SESTERTIUS' AND quality = 0
           FOR UPDATE`,
          [firstId]
        );

        await client.query(
          `SELECT amount
           FROM   inventories
           WHERE  user_id = $1 AND resource_id = 'SESTERTIUS' AND quality = 0
           FOR UPDATE`,
          [secondId]
        );

        // Read issuer's balance after the locks are held.
        const issuerRow = await client.query<{ amount: number }>(
          `SELECT amount
           FROM   inventories
           WHERE  user_id = $1 AND resource_id = 'SESTERTIUS' AND quality = 0`,
          [issuerId]
        );

        const issuerSestertius: number = issuerRow.rows[0]?.amount ?? 0;

        // ---- STEP 5: Validate issuer funds ----
        if (issuerSestertius < totalRepayment) {
          throw new HttpError(
            400,
            `Insufficient Sestertius. Repayment requires ${totalRepayment} but you only have ${issuerSestertius}.`
          );
        }

        // ---- STEP 6: Deduct from issuer ----
        await client.query(
          `UPDATE inventories
           SET    amount = amount - $1
           WHERE  user_id = $2 AND resource_id = 'SESTERTIUS' AND quality = 0`,
          [totalRepayment, issuerId]
        );

        // ---- STEP 7: Credit buyer ----
        await client.query(
          `INSERT INTO inventories (user_id, resource_id, quality, amount)
           VALUES ($1, 'SESTERTIUS', 0, $2)
           ON CONFLICT (user_id, resource_id, quality) DO UPDATE
             SET amount = inventories.amount + EXCLUDED.amount`,
          [buyerId, totalRepayment]
        );

        // ---- STEP 8: Mark bond REPAID ----
        await client.query(
          `UPDATE bonds SET status = 'REPAID' WHERE id = $1`,
          [bond.id]
        );

        return {
          bond_id:          bond.id,
          principal_amount: bond.principal_amount,
          interest_amount:  totalRepayment - bond.principal_amount,
          total_repayment:  totalRepayment,
        };
      });

      res.status(200).json({
        message: `Bond repaid. Paid ${result.total_repayment} Sestertius ` +
                 `(${result.principal_amount} principal + ${result.interest_amount} interest).`,
        result,
      });

    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code: string }).code === '40P01'
      ) {
        res.status(409).json({ error: 'Transaction conflict detected. Please try again.' });
        return;
      }
      next(error);
    }
  }
);

export default router;
