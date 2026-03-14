/**
 * @file src/routes/contracts.ts
 * @description B2B Private Contracts: player-to-player direct trade proposals with escrow.
 *
 * ================================================================
 * ROUTES IN THIS FILE
 * ================================================================
 *
 *   GET  /api/v1/contracts        — All PENDING contracts where the caller is sender or receiver.
 *   POST /api/v1/contracts/send   — Propose a contract; deducts resources into escrow immediately.
 *   POST /api/v1/contracts/accept — Receiver accepts; transfers Sestertius and delivers resource.
 *   POST /api/v1/contracts/cancel — Either party cancels; returns escrowed resources to sender.
 *
 * ================================================================
 * ESCROW MODEL
 * ================================================================
 *
 *   When a contract is created (status = PENDING):
 *     • `amount` units of `resource_id` at `quality` are DEDUCTED from the sender's
 *       inventory immediately. They are considered "in escrow" — implicitly held by
 *       the contract row itself.
 *
 *   On ACCEPT:
 *     • The buyer (receiver) pays `amount × price_per_unit` Sestertius to the sender.
 *     • The receiver receives the resource at the contract's quality tier.
 *     • No resource movement from the sender's inventory is needed (already deducted).
 *
 *   On CANCEL (by sender or receiver):
 *     • The escrowed resources are returned to the sender's inventory.
 *
 * ================================================================
 * LOCKING STRATEGY — POST /accept (TWO-USER TRANSACTION)
 * ================================================================
 *
 * The accept transaction touches TWO players' SESTERTIUS inventory rows:
 *   • Receiver's row — deducted (payment)
 *   • Sender's row   — credited (receipt)
 *
 * DEADLOCK RISK WITHOUT ORDERING:
 *   Suppose Alice accepts Bob's contract at the same time Bob accepts Alice's
 *   contract (two separate contract rows). Without ordering:
 *     T1 might lock Bob's SESTERTIUS → then try Alice's SESTERTIUS
 *     T2 might lock Alice's SESTERTIUS → then try Bob's SESTERTIUS
 *   This is a classic circular-wait deadlock.
 *
 * SOLUTION — ALPHABETICAL USER_ID ORDERING:
 *   Before acquiring FOR UPDATE locks, we sort [senderId, receiverId]
 *   alphabetically by their UUID string values:
 *
 *     const [firstId, secondId] = [senderId, receiverId].sort();
 *     // Lock first user's SESTERTIUS row
 *     // Lock second user's SESTERTIUS row
 *
 *   Both T1 and T2 then always lock in the same global order (whichever UUID
 *   comes first alphabetically). The second transaction waits for the first to
 *   release — no circular wait — no deadlock. This mirrors PostgreSQL's own
 *   recommended practice of consistent lock ordering across transactions.
 *
 * FULL LOCK ORDER IN /accept:
 *   [1] Lock private_contracts row          (prevents double-accept)
 *   [2] Lock SESTERTIUS of min(sender, receiver) by user_id ASC
 *   [3] Lock SESTERTIUS of max(sender, receiver) by user_id ASC
 *   [4] Validate receiver balance
 *   [5] Execute Sestertius transfer
 *   [6] Deliver resource to receiver (upsert)
 *   [7] Update contract status
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

interface ContractRow {
  id:              string;
  sender_id:       string;
  receiver_id:     string;
  resource_id:     string;
  amount:          number;
  quality:         number;
  price_per_unit:  number;
  status:          string;
  created_at:      string;
  sender_username:   string;
  receiver_username: string;
}

// ================================================================
// ROUTE: GET /api/v1/contracts
// ================================================================

/**
 * Returns all PENDING contracts where the caller is the sender or receiver.
 *
 * Joins with users to expose sender_username and receiver_username so the
 * frontend can display human-readable counterparty names.
 *
 * SUCCESS: 200 OK
 * { contracts: [...] }
 */
router.get(
  '/',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;

      const result = await query<ContractRow>(
        `SELECT  pc.id,
                 pc.sender_id,
                 pc.receiver_id,
                 pc.resource_id,
                 pc.amount,
                 pc.quality,
                 pc.price_per_unit,
                 pc.status,
                 pc.created_at,
                 s.username AS sender_username,
                 r.username AS receiver_username
         FROM    private_contracts pc
         JOIN    users s ON s.id = pc.sender_id
         JOIN    users r ON r.id = pc.receiver_id
         WHERE   pc.status = 'PENDING'
           AND   (pc.sender_id = $1 OR pc.receiver_id = $1)
         ORDER  BY pc.created_at DESC`,
        [userId]
      );

      res.status(200).json({ contracts: result.rows });

    } catch (error) {
      next(error);
    }
  }
);

// ================================================================
// ROUTE: POST /api/v1/contracts/send
// ================================================================

/**
 * Proposes a new private contract. Resources are escrowed immediately.
 *
 * Request body:
 *   { receiver_username: string, resource_id: string, amount: number,
 *     quality?: number (0–2, default 0), price_per_unit: number }
 *
 * TRANSACTION STEPS:
 *   [1] Resolve receiver_username → receiver_id (read, no lock)
 *   [2] Lock sender's (resource_id, quality) inventory row (FOR UPDATE)
 *   [3] Validate sender has sufficient resources
 *   [4] Deduct resources from sender (escrow)
 *   [5] Insert contract row
 *
 * SUCCESS: 201 Created
 * ERRORS:  400 (validation), 404 (receiver not found), 400 (insufficient resources)
 */
router.post(
  '/send',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const senderId = req.userId!;

      const { receiver_username, resource_id, amount, quality, price_per_unit } = req.body as {
        receiver_username?: unknown;
        resource_id?:       unknown;
        amount?:            unknown;
        quality?:           unknown;
        price_per_unit?:    unknown;
      };

      // ---- INPUT VALIDATION ----

      if (typeof receiver_username !== 'string' || receiver_username.trim().length === 0) {
        res.status(400).json({ error: 'receiver_username is required.' });
        return;
      }

      if (typeof resource_id !== 'string' || resource_id.trim().length === 0) {
        res.status(400).json({ error: 'resource_id is required.' });
        return;
      }

      const normalizedResource = resource_id.trim().toUpperCase();

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

      const contract = await withTransaction(async (client) => {

        // ---- STEP 1: Resolve receiver by username ----
        const receiverResult = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE username = $1`,
          [receiver_username.trim()]
        );

        if (receiverResult.rowCount === 0) {
          throw new HttpError(404, `User '${receiver_username.trim()}' not found.`);
        }

        const receiverId: string = receiverResult.rows[0].id;

        if (receiverId === senderId) {
          throw new HttpError(400, 'You cannot send a contract to yourself.');
        }

        // ---- STEP 2: Lock the sender's resource row at the specified quality ----
        const resourceRow = await client.query<{ amount: number }>(
          `SELECT amount
           FROM   inventories
           WHERE  user_id     = $1
             AND  resource_id = $2
             AND  quality     = $3
           FOR UPDATE`,
          [senderId, normalizedResource, parsedQuality]
        );

        if (resourceRow.rowCount === 0) {
          throw new HttpError(
            400,
            `You have no ${normalizedResource} at Quality ${parsedQuality} to escrow.`
          );
        }

        const currentAmount: number = resourceRow.rows[0].amount;

        // ---- STEP 3: Validate sufficient resources ----
        if (currentAmount < parsedAmount) {
          throw new HttpError(
            400,
            `Insufficient ${normalizedResource} at Quality ${parsedQuality}. ` +
            `You have ${currentAmount} but tried to escrow ${parsedAmount}.`
          );
        }

        // ---- STEP 4: Deduct resources from sender (escrow) ----
        await client.query(
          `UPDATE inventories
           SET    amount = amount - $1
           WHERE  user_id     = $2
             AND  resource_id = $3
             AND  quality     = $4`,
          [parsedAmount, senderId, normalizedResource, parsedQuality]
        );

        // ---- STEP 5: Insert the contract row ----
        const contractResult = await client.query<{
          id:            string;
          resource_id:   string;
          amount:        number;
          quality:       number;
          price_per_unit: number;
          status:        string;
          created_at:    string;
        }>(
          `INSERT INTO private_contracts
             (sender_id, receiver_id, resource_id, amount, quality, price_per_unit)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, resource_id, amount, quality, price_per_unit, status, created_at`,
          [senderId, receiverId, normalizedResource, parsedAmount, parsedQuality, parsedPrice]
        );

        return { ...contractResult.rows[0], receiver_username: receiver_username.trim() };
      });

      const qualityLabel = contract.quality > 0 ? ` Q${contract.quality}` : '';
      res.status(201).json({
        message: `Contract sent: ${contract.amount}${qualityLabel} ${contract.resource_id} ` +
                 `to ${contract.receiver_username} at ${contract.price_per_unit} Sestertius/unit. ` +
                 `Resources are now held in escrow.`,
        contract,
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
// ROUTE: POST /api/v1/contracts/accept
// ================================================================

/**
 * Receiver accepts a PENDING contract. Transfers Sestertius and delivers resource.
 *
 * Request body: { contract_id: string }
 *
 * DEADLOCK PREVENTION:
 *   Two players' SESTERTIUS rows are locked in alphabetical order by user_id.
 *   See the file-level comment for the full explanation.
 *
 * TRANSACTION STEPS:
 *   [1] Lock contract row                            (prevents double-accept)
 *   [2] Validate PENDING + caller is receiver
 *   [3] Lock SESTERTIUS of min(senderId, receiverId) (alphabetical)
 *   [4] Lock SESTERTIUS of max(senderId, receiverId) (alphabetical)
 *   [5] Validate receiver has sufficient Sestertius
 *   [6] Deduct Sestertius from receiver
 *   [7] Credit Sestertius to sender (upsert)
 *   [8] Deliver resource to receiver (upsert at contract quality)
 *   [9] Update contract status → ACCEPTED
 *
 * SUCCESS: 200 OK
 * ERRORS:  400, 403, 404, 409
 */
router.post(
  '/accept',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const receiverId = req.userId!;

      const { contract_id } = req.body as { contract_id?: unknown };

      if (typeof contract_id !== 'string' || contract_id.trim().length === 0) {
        res.status(400).json({ error: 'contract_id is required.' });
        return;
      }

      const result = await withTransaction(async (client) => {

        // ---- STEP 1: Lock the contract row ----
        const contractResult = await client.query<{
          id:            string;
          sender_id:     string;
          receiver_id:   string;
          resource_id:   string;
          amount:        number;
          quality:       number;
          price_per_unit: number;
          status:        string;
        }>(
          `SELECT id, sender_id, receiver_id, resource_id, amount, quality, price_per_unit, status
           FROM   private_contracts
           WHERE  id = $1
           FOR UPDATE`,
          [contract_id.trim()]
        );

        if (contractResult.rowCount === 0) {
          throw new HttpError(404, 'Contract not found.');
        }

        const contract = contractResult.rows[0];

        // ---- STEP 2: Validate state ----
        if (contract.status !== 'PENDING') {
          throw new HttpError(409, `This contract is no longer pending (status: ${contract.status}).`);
        }

        if (contract.receiver_id !== receiverId) {
          throw new HttpError(403, 'Only the contract receiver can accept it.');
        }

        const totalCost: number = contract.amount * contract.price_per_unit;
        const senderId: string  = contract.sender_id;

        // ---- STEPS 3–4: Lock both SESTERTIUS rows in alphabetical user_id order ----
        //
        // Sort the two user IDs so both concurrent transactions acquire locks in
        // the same order. This eliminates the circular-wait condition that would
        // otherwise cause a deadlock when two players accept each other's contracts
        // simultaneously.
        const [firstUserId, secondUserId] = [senderId, receiverId].sort();

        // Lock first (alphabetically smaller user_id)
        await client.query(
          `SELECT amount
           FROM   inventories
           WHERE  user_id = $1 AND resource_id = 'SESTERTIUS' AND quality = 0
           FOR UPDATE`,
          [firstUserId]
        );

        // Lock second (alphabetically larger user_id)
        const secondSestRow = await client.query<{ amount: number }>(
          `SELECT amount
           FROM   inventories
           WHERE  user_id = $1 AND resource_id = 'SESTERTIUS' AND quality = 0
           FOR UPDATE`,
          [secondUserId]
        );

        // Read receiver's balance (it was locked in one of the two steps above).
        // We need a separate read if the receiver happened to be locked as the first
        // user and we don't have their amount yet.
        const receiverSestRow = await client.query<{ amount: number }>(
          `SELECT amount
           FROM   inventories
           WHERE  user_id = $1 AND resource_id = 'SESTERTIUS' AND quality = 0`,
          [receiverId]
        );

        // Suppress unused-variable warning: secondSestRow was fetched to acquire
        // the FOR UPDATE lock on the second user's row. Its value is not used
        // directly because we re-read the receiver's amount above for clarity.
        void secondSestRow;

        const receiverSestertius: number = receiverSestRow.rows[0]?.amount ?? 0;

        // ---- STEP 5: Validate receiver funds ----
        if (receiverSestertius < totalCost) {
          throw new HttpError(
            400,
            `Insufficient Sestertius. This contract costs ${totalCost} but you only have ${receiverSestertius}.`
          );
        }

        // ---- STEP 6: Deduct Sestertius from receiver ----
        await client.query(
          `UPDATE inventories
           SET    amount = amount - $1
           WHERE  user_id = $2 AND resource_id = 'SESTERTIUS' AND quality = 0`,
          [totalCost, receiverId]
        );

        // ---- STEP 7: Credit Sestertius to sender (upsert — sender may not have a row) ----
        await client.query(
          `INSERT INTO inventories (user_id, resource_id, quality, amount)
           VALUES ($1, 'SESTERTIUS', 0, $2)
           ON CONFLICT (user_id, resource_id, quality) DO UPDATE
             SET amount = inventories.amount + EXCLUDED.amount`,
          [senderId, totalCost]
        );

        // ---- STEP 8: Deliver resource to receiver at contract quality ----
        await client.query(
          `INSERT INTO inventories (user_id, resource_id, quality, amount)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, resource_id, quality) DO UPDATE
             SET amount = inventories.amount + EXCLUDED.amount`,
          [receiverId, contract.resource_id, contract.quality, contract.amount]
        );

        // ---- STEP 9: Mark contract ACCEPTED ----
        await client.query(
          `UPDATE private_contracts SET status = 'ACCEPTED' WHERE id = $1`,
          [contract.id]
        );

        return {
          contract_id:   contract.id,
          resource_id:   contract.resource_id,
          quality:       contract.quality,
          amount:        contract.amount,
          total_cost:    totalCost,
        };
      });

      const qualityLabel = result.quality > 0 ? ` Q${result.quality}` : '';
      res.status(200).json({
        message: `Contract accepted. Received ${result.amount}${qualityLabel} ${result.resource_id} ` +
                 `for ${result.total_cost} Sestertius.`,
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
// ROUTE: POST /api/v1/contracts/cancel
// ================================================================

/**
 * Either the sender or the receiver may cancel a PENDING contract.
 * The escrowed resources are returned to the sender's inventory.
 *
 * Request body: { contract_id: string }
 *
 * TRANSACTION STEPS:
 *   [1] Lock contract row
 *   [2] Validate PENDING + caller is sender or receiver
 *   [3] Return resources to sender's inventory (upsert)
 *   [4] Update contract status → CANCELLED
 *
 * SUCCESS: 200 OK
 * ERRORS:  400, 403, 404, 409
 */
router.post(
  '/cancel',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.userId!;

      const { contract_id } = req.body as { contract_id?: unknown };

      if (typeof contract_id !== 'string' || contract_id.trim().length === 0) {
        res.status(400).json({ error: 'contract_id is required.' });
        return;
      }

      await withTransaction(async (client) => {

        // ---- STEP 1: Lock the contract row ----
        const contractResult = await client.query<{
          id:          string;
          sender_id:   string;
          receiver_id: string;
          resource_id: string;
          amount:      number;
          quality:     number;
          status:      string;
        }>(
          `SELECT id, sender_id, receiver_id, resource_id, amount, quality, status
           FROM   private_contracts
           WHERE  id = $1
           FOR UPDATE`,
          [contract_id.trim()]
        );

        if (contractResult.rowCount === 0) {
          throw new HttpError(404, 'Contract not found.');
        }

        const contract = contractResult.rows[0];

        // ---- STEP 2: Validate ----
        if (contract.status !== 'PENDING') {
          throw new HttpError(409, `This contract is no longer pending (status: ${contract.status}).`);
        }

        if (contract.sender_id !== userId && contract.receiver_id !== userId) {
          throw new HttpError(403, 'You are not a party to this contract.');
        }

        // ---- STEP 3: Return escrowed resources to sender ----
        await client.query(
          `INSERT INTO inventories (user_id, resource_id, quality, amount)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, resource_id, quality) DO UPDATE
             SET amount = inventories.amount + EXCLUDED.amount`,
          [contract.sender_id, contract.resource_id, contract.quality, contract.amount]
        );

        // ---- STEP 4: Mark contract CANCELLED ----
        await client.query(
          `UPDATE private_contracts SET status = 'CANCELLED' WHERE id = $1`,
          [contract.id]
        );
      });

      res.status(200).json({ message: 'Contract cancelled. Escrowed resources returned to sender.' });

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
