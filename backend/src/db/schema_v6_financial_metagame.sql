-- =============================================================================
-- schema_v6_financial_metagame.sql
-- Phase 8: The Financial Metagame — B2B Contracts, Bonds, and Global Leaderboard.
--
-- Run this script once against the live database AFTER schema_v5_empire_expansion.sql.
-- All statements are idempotent (IF NOT EXISTS / IF EXISTS guards).
-- =============================================================================

-- =============================================================================
-- TABLE: private_contracts
-- =============================================================================
--
-- Represents a bilateral trade proposal between two players.
--
-- Lifecycle:
--   PENDING   → sender sends, resources held in escrow (deducted from sender)
--   ACCEPTED  → receiver accepts, Sestertius transferred, resource delivered
--   REJECTED  → receiver explicitly rejects (reserved for future use; for now
--               players use CANCEL from either side)
--   CANCELLED → sender OR receiver cancels; escrowed resources returned to sender
--
-- Escrow model:
--   When a contract is created (PENDING), `amount` units of the resource at
--   the specified quality are immediately deducted from the sender's inventory.
--   They are held implicitly in the contract row. On ACCEPTED the receiver gets
--   them; on CANCELLED they are returned to the sender.
--
CREATE TABLE IF NOT EXISTS private_contracts (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id      UUID        NOT NULL REFERENCES users(id),
  receiver_id    UUID        NOT NULL REFERENCES users(id),
  resource_id    VARCHAR(50) NOT NULL,
  amount         INT         NOT NULL,
  quality        INT         NOT NULL DEFAULT 0,
  price_per_unit INT         NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT private_contracts_amount_positive  CHECK (amount > 0),
  CONSTRAINT private_contracts_price_positive   CHECK (price_per_unit > 0),
  CONSTRAINT private_contracts_quality_valid    CHECK (quality BETWEEN 0 AND 2),
  CONSTRAINT private_contracts_status_valid     CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED')),
  -- Prevent self-contracting: a player cannot propose a trade with themselves.
  CONSTRAINT private_contracts_no_self_trade    CHECK (sender_id <> receiver_id)
);

-- Index: fast lookup of all contracts a player is party to (used by GET /contracts).
CREATE INDEX IF NOT EXISTS idx_private_contracts_sender
  ON private_contracts (sender_id, status);

CREATE INDEX IF NOT EXISTS idx_private_contracts_receiver
  ON private_contracts (receiver_id, status);

-- =============================================================================
-- TABLE: bonds
-- =============================================================================
--
-- Represents a debt instrument issued by one player and optionally bought by
-- another. The issuer asks for a loan; a buyer provides the principal upfront
-- and receives principal + interest when the issuer repays.
--
-- Lifecycle:
--   ISSUED    → issuer creates the bond; visible on the market; no money moves yet
--   BOUGHT    → a buyer purchases it; principal transfers issuer ← buyer immediately
--   REPAID    → issuer repays principal + interest back to buyer
--   DEFAULTED → reserved for future game mechanics (cron job, admin action, etc.)
--
-- interest_rate_percentage is stored as a whole integer, e.g., 10 = 10%.
-- Total repayment = principal + FLOOR(principal * interest_rate_percentage / 100).
--
CREATE TABLE IF NOT EXISTS bonds (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer_id                UUID        NOT NULL REFERENCES users(id),
  -- buyer_id is NULL until someone buys the bond (status = ISSUED).
  buyer_id                 UUID        REFERENCES users(id),
  principal_amount         INT         NOT NULL,
  interest_rate_percentage INT         NOT NULL,
  status                   VARCHAR(20) NOT NULL DEFAULT 'ISSUED',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT bonds_principal_positive    CHECK (principal_amount > 0),
  CONSTRAINT bonds_interest_non_negative CHECK (interest_rate_percentage >= 0),
  CONSTRAINT bonds_status_valid          CHECK (status IN ('ISSUED', 'BOUGHT', 'REPAID', 'DEFAULTED')),
  -- Prevent self-dealing: a player cannot buy their own bond.
  CONSTRAINT bonds_no_self_buy           CHECK (issuer_id <> buyer_id)
);

-- Index: fast lookup of bonds on the open market.
CREATE INDEX IF NOT EXISTS idx_bonds_status
  ON bonds (status);

-- Index: fast lookup of bonds issued by or bought by a user.
CREATE INDEX IF NOT EXISTS idx_bonds_issuer
  ON bonds (issuer_id);

CREATE INDEX IF NOT EXISTS idx_bonds_buyer
  ON bonds (buyer_id);
