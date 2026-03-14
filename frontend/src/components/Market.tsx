/**
 * @file src/components/Market.tsx
 * @description The Market screen: NPC Empire market (dynamic prices) + P2P Forum (player-to-player).
 *
 * ================================================================
 * PHASE 7 CHANGES FROM PHASE 5
 * ================================================================
 *
 * 1. DYNAMIC NPC PRICES
 *    The hardcoded NPC_DISPLAY_PRICES constant is gone. Prices are fetched
 *    from GET /market/npc/prices (npc_prices DB table) on mount. The payout
 *    preview uses these live values and stays accurate as market events
 *    fluctuate prices (±20% via simulateMarketEvents.ts).
 *
 * 2. QUALITY DIMENSION
 *    Both the NPC sell form and P2P list form include a quality dropdown
 *    (Q0 / Q1 / Q2). For NPC sells the payout preview shows:
 *      FLOOR(amount × current_price × (1 + quality × 0.5))
 *    The P2P listings table gains a "Quality" column.
 *
 * 3. FARINA ADDED
 *    FARINA is now tradeable in both markets (NPC prices table + P2P
 *    LISTABLE_RESOURCES). The balance bar shows FARINA inventory too.
 *
 * 4. INVENTORY AGGREGATION
 *    Phase 7 inventories have one row per (resource, quality) pair.
 *    The Market component sums all quality tiers per resource for display.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation }  from 'react-i18next';
import { useAuth }         from '../context/AuthContext';
import { apiRequest }      from '../api/client';
import ResourceIcon        from './ResourceIcon';

// ================================================================
// TYPES
// ================================================================

interface NpcPrice {
  resource_id:       string;
  current_buy_price: number; // Base price stored in npc_prices table
  effective_price:   number; // Base × current event multiplier (what the player receives)
  updated_at:        string;
}

/** Shape of the current empire event returned by GET /market/npc/prices */
interface GameEventInfo {
  id:          string;                    // e.g., 'WAR_IN_GAUL'
  multipliers: Record<string, number>;    // e.g., { LIGNUM: 1.5, ... }
}

interface NpcPricesApiResponse {
  prices: NpcPrice[];
  event:  GameEventInfo; // Module 2: active empire event
}

interface Listing {
  id:              string;
  resource_id:     string;
  quality:         number;   // Phase 7: quality tier (0, 1, or 2)
  amount:          number;
  price_per_unit:  number;
  /** Computed server-side as amount * price_per_unit (INT × INT = INT). */
  total_price:     number;
  seller_username: string;
  created_at:      string;
}

interface InventoryRow {
  resource_id: string;
  quality:     number;  // Phase 7: quality tier (0, 1, or 2)
  amount:      number;
}

interface InventoryApiResponse {
  inventory: InventoryRow[];
}

interface ListingsApiResponse {
  listings: Listing[];
}

// ================================================================
// CONSTANTS
// ================================================================

/**
 * Resources that the player can sell to the NPC Empire.
 * These must have rows in the npc_prices table. Phase 7 adds FARINA.
 * Mirrors the initial INSERT in schema_v5_empire_expansion.sql.
 */
const NPC_SELLABLE_RESOURCES = ['FARINA', 'FRUMENTUM', 'LIGNUM'] as const;
type NpcSellableResource = (typeof NPC_SELLABLE_RESOURCES)[number];

/**
 * Resources that can be listed on the P2P market.
 * FARINA added in Phase 7 (processed goods are now player-tradeable).
 * Mirrors LISTABLE_RESOURCES in backend/src/routes/p2pMarket.ts.
 */
const LISTABLE_RESOURCES = ['FARINA', 'FRUMENTUM', 'LIGNUM'] as const;
type ListableResource = (typeof LISTABLE_RESOURCES)[number];

// ================================================================
// MARKET COMPONENT
// ================================================================

const Market: React.FC = () => {
  const { t }            = useTranslation();
  const { user, logout } = useAuth();

  // ---- DOGANA STATE ----
  // Whether this player has built a Customs Office. Controls NPC market access.
  // Defaults to false (locked) until the buildings fetch resolves.
  const [hasDogana, setHasDogana] = useState<boolean>(false);

  // ---- NPC PRICES STATE ----
  // Fetched from GET /market/npc/prices. Replaces hardcoded NPC_DISPLAY_PRICES.
  const [npcPrices, setNpcPrices] = useState<NpcPrice[]>([]);

  // ---- CURRENT EVENT STATE (Module 2) ----
  // Parsed from the /prices response (no separate API call needed).
  // null while loading — the banner is not rendered until data arrives.
  const [currentEvent, setCurrentEvent] = useState<GameEventInfo | null>(null);

  // ---- INVENTORY STATE ----
  // We fetch inventory to show the player their current balances,
  // which helps them decide what to sell/list and whether they can afford a buy.

  const [sestertius,      setSestertius]      = useState<number>(0);
  const [resourceAmounts, setResourceAmounts] = useState<Record<string, number>>({
    LIGNUM:    0,
    FRUMENTUM: 0,
    FARINA:    0,
  });
  const [isLoadingInv, setIsLoadingInv] = useState<boolean>(true);

  // ---- P2P LISTINGS STATE ----

  const [listings,          setListings]          = useState<Listing[]>([]);
  const [isLoadingListings, setIsLoadingListings] = useState<boolean>(true);
  const [listingsError,     setListingsError]     = useState<string | null>(null);

  // ---- NPC SELL FORM STATE ----

  const [npcResource, setNpcResource] = useState<NpcSellableResource>('LIGNUM');
  const [npcQuality,  setNpcQuality]  = useState<number>(0);
  const [npcAmount,   setNpcAmount]   = useState<string>('');
  const [npcLoading,  setNpcLoading]  = useState<boolean>(false);
  const [npcError,    setNpcError]    = useState<string | null>(null);
  const [npcSuccess,  setNpcSuccess]  = useState<string | null>(null);

  // ---- P2P LIST FORM STATE ----

  const [listResource, setListResource] = useState<ListableResource>('LIGNUM');
  const [listQuality,  setListQuality]  = useState<number>(0);
  const [listAmount,   setListAmount]   = useState<string>('');
  const [listPrice,    setListPrice]    = useState<string>('');
  const [listLoading,  setListLoading]  = useState<boolean>(false);
  const [listError,    setListError]    = useState<string | null>(null);
  const [listSuccess,  setListSuccess]  = useState<string | null>(null);

  // ---- BUY ACTION STATE ----

  /**
   * Tracks which listing_id is currently being purchased.
   * null = no buy request in flight.
   * Like Dashboard's actionInProgress, we track per-listing so
   * only the specific row being purchased shows a loading state.
   */
  const [buyingId,     setBuyingId]     = useState<string | null>(null);
  const [buyErrors,    setBuyErrors]    = useState<Record<string, string>>({});

  // ---- CANCEL ACTION STATE ----
  /** Tracks which listing_id is currently being cancelled (own listings only). */
  const [cancellingId,  setCancellingId]  = useState<string | null>(null);
  const [cancelErrors,  setCancelErrors]  = useState<Record<string, string>>({});

  // ================================================================
  // DATA FETCHING
  // ================================================================

  /**
   * Checks whether the logged-in player owns a DOGANA (Customs Office).
   *
   * The DOGANA gates access to the NPC Empire market (Module 1: Trade Reform).
   * We fetch the full building roster and look for a DOGANA entry. If the
   * fetch fails, we default to `false` (locked) — the secure default.
   */
  const fetchDoganaStatus = useCallback(async (): Promise<void> => {
    try {
      const data = await apiRequest<{ buildings: { building_type: string }[] }>('/buildings');
      setHasDogana(data.buildings.some((b) => b.building_type === 'DOGANA'));
    } catch {
      setHasDogana(false); // Default: no access if check cannot be confirmed
    }
  }, []);

  /**
   * Fetches current NPC buy prices from the server.
   *
   * Phase 7: prices live in the npc_prices DB table and can fluctuate
   * via simulateMarketEvents.ts (±20% per event). We read them fresh
   * on market mount so the displayed prices and payout previews are live.
   */
  const fetchNpcPrices = useCallback(async (): Promise<void> => {
    try {
      const data = await apiRequest<NpcPricesApiResponse>('/market/npc/prices');
      setNpcPrices(data.prices);
      // Module 2: parse the current empire event from the prices response.
      // No separate API call needed — the event is bundled into /prices.
      setCurrentEvent(data.event ?? null);
    } catch {
      // Silently degrade — the sell form still works; server validates on submit.
    }
  }, []);

  const fetchInventory = useCallback(async (): Promise<void> => {
    setIsLoadingInv(true);
    try {
      const data = await apiRequest<InventoryApiResponse>('/inventory');

      // Phase 7: multiple rows can exist per resource_id (one per quality tier).
      // Sum all quality tiers together to get the total per resource for display.
      const map = data.inventory.reduce<Record<string, number>>(
        (acc, row) => {
          acc[row.resource_id] = (acc[row.resource_id] ?? 0) + row.amount;
          return acc;
        },
        {}
      );

      setSestertius(map['SESTERTIUS'] ?? 0);
      setResourceAmounts({
        LIGNUM:    map['LIGNUM']    ?? 0,
        FRUMENTUM: map['FRUMENTUM'] ?? 0,
        FARINA:    map['FARINA']    ?? 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Unauthorized') || message.includes('expired')) {
        logout();
      }
      // If inventory fails to load, silently degrade (not a blocking error).
    } finally {
      setIsLoadingInv(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchListings = useCallback(async (): Promise<void> => {
    setIsLoadingListings(true);
    setListingsError(null);
    try {
      const data = await apiRequest<ListingsApiResponse>('/market/p2p');
      setListings(data.listings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setListingsError(message);
    } finally {
      setIsLoadingListings(false);
    }
  }, []);

  // Fetch all data sources when the Market tab first renders.
  useEffect(() => {
    void fetchDoganaStatus();
    void fetchNpcPrices();
    void fetchInventory();
    void fetchListings();
  }, [fetchDoganaStatus, fetchNpcPrices, fetchInventory, fetchListings]);

  // ================================================================
  // NPC SELL HANDLER
  // ================================================================

  const handleNpcSell = async (): Promise<void> => {
    setNpcError(null);
    setNpcSuccess(null);

    // Client-side validation to provide instant feedback.
    // The server performs its own independent validation — this is UX only.
    const parsedAmount = parseInt(npcAmount, 10);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setNpcError(t('market.errors.invalidAmount'));
      return;
    }

    setNpcLoading(true);
    try {
      const data = await apiRequest<{ message: string }>('/market/npc/sell', {
        method: 'POST',
        body:   JSON.stringify({
          resource_id: npcResource,
          amount:      parsedAmount,
          quality:     npcQuality,
        }),
      });
      setNpcSuccess(data.message);
      setNpcAmount('');
      setNpcQuality(0);
      // Re-fetch inventory to show updated Sestertius balance after the sale.
      await fetchInventory();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Unauthorized') || message.includes('expired')) {
        logout();
        return;
      }
      setNpcError(message);
    } finally {
      setNpcLoading(false);
    }
  };

  // ================================================================
  // P2P LIST HANDLER
  // ================================================================

  const handleList = async (): Promise<void> => {
    setListError(null);
    setListSuccess(null);

    const parsedAmount = parseInt(listAmount, 10);
    const parsedPrice  = parseInt(listPrice, 10);

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setListError(t('market.errors.invalidAmount'));
      return;
    }
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      setListError(t('market.errors.invalidPrice'));
      return;
    }

    setListLoading(true);
    try {
      const data = await apiRequest<{ message: string }>('/market/p2p/list', {
        method: 'POST',
        body:   JSON.stringify({
          resource_id:    listResource,
          quality:        listQuality,
          amount:         parsedAmount,
          price_per_unit: parsedPrice,
        }),
      });
      setListSuccess(data.message);
      setListAmount('');
      setListPrice('');
      setListQuality(0);
      // Re-fetch both:
      //   - inventory: to show the reduced resource balance (escrow deducted)
      //   - listings: to show the newly created listing in the market feed
      await Promise.all([fetchInventory(), fetchListings()]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Unauthorized') || message.includes('expired')) {
        logout();
        return;
      }
      setListError(message);
    } finally {
      setListLoading(false);
    }
  };

  // ================================================================
  // P2P BUY HANDLER
  // ================================================================

  const handleBuy = async (listingId: string): Promise<void> => {
    if (buyingId === listingId) return;

    setBuyingId(listingId);
    setBuyErrors((prev) => ({ ...prev, [listingId]: '' }));

    try {
      await apiRequest('/market/p2p/buy', {
        method: 'POST',
        body:   JSON.stringify({ listing_id: listingId }),
      });
      // Re-fetch both after a successful purchase:
      //   - listings: the bought listing is now SOLD and should disappear
      //   - inventory: buyer's Sestertius decreased, resource increased
      await Promise.all([fetchListings(), fetchInventory()]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Unauthorized') || message.includes('expired')) {
        logout();
        return;
      }
      setBuyErrors((prev) => ({ ...prev, [listingId]: message }));
    } finally {
      setBuyingId(null);
    }
  };

  // ================================================================
  // P2P CANCEL HANDLER
  // ================================================================

  const handleCancel = async (listingId: string): Promise<void> => {
    if (cancellingId === listingId) return;

    setCancellingId(listingId);
    setCancelErrors((prev) => ({ ...prev, [listingId]: '' }));

    try {
      await apiRequest('/market/p2p/cancel', {
        method: 'POST',
        body:   JSON.stringify({ listing_id: listingId }),
      });
      // Re-fetch both after cancellation:
      //   - listings: the cancelled listing should disappear
      //   - inventory: escrowed resources returned to the player
      await Promise.all([fetchListings(), fetchInventory()]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Unauthorized') || message.includes('expired')) {
        logout();
        return;
      }
      setCancelErrors((prev) => ({ ...prev, [listingId]: message }));
    } finally {
      setCancellingId(null);
    }
  };

  // ================================================================
  // RENDER HELPERS
  // ================================================================

  /**
   * Looks up the current NPC buy price for a resource from fetched state.
   * Returns 0 if prices haven't loaded yet (the payout preview shows 0,
   * which is fine — the server always uses the authoritative live price).
   */
  // Returns the event-adjusted effective price for the payout preview.
  // Uses effective_price (base × event multiplier) so the displayed preview
  // exactly matches what the server will pay on POST /sell.
  const getNpcPrice = (resourceId: string): number =>
    npcPrices.find((p) => p.resource_id === resourceId)?.effective_price ?? 0;

  /**
   * Computes the quality multiplier for the NPC payout preview.
   * Mirrors the server formula: 1 + quality × 0.5
   * Q0 = 1.0×, Q1 = 1.5×, Q2 = 2.0×
   */
  const getQualityMultiplier = (quality: number): number => 1 + quality * 0.5;

  // Shared Tailwind classes for form inputs and selects.
  const inputCls  = 'px-2.5 py-1.5 border border-roman-gold/60 rounded text-sm bg-roman-marble text-roman-dark w-full focus:outline-none focus:ring-1 focus:ring-roman-gold';
  const selectCls = `${inputCls} cursor-pointer`;

  // Section header: label + decorative horizontal rule.
  // Defined here as a helper so each section uses the same visual pattern.
  const SectionHeader = ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div className="mb-4">
      <div className="flex items-center gap-3 mb-1">
        <h3 className="text-sm font-bold text-roman-dark uppercase tracking-widest whitespace-nowrap m-0">
          {title}
        </h3>
        <div className="flex-1 h-px bg-roman-gold/20" />
      </div>
      {subtitle && <p className="text-gray-500 text-sm m-0">{subtitle}</p>}
    </div>
  );

  // ================================================================
  // RENDER
  // ================================================================

  // Per-event banner styles. Full class strings kept intact so Tailwind's
  // JIT scanner can detect them without dynamic string concatenation.
  const EVENT_STYLES: Record<string, { bg: string; border: string; accent: string; tag: string; icon: string }> = {
    PAX_ROMANA:  { bg: 'bg-roman-gold/10', border: 'border-roman-gold/30', accent: 'text-roman-gold',  tag: 'bg-roman-gold/10 border-roman-gold/30 text-roman-gold',  icon: '🕊️' },
    WAR_IN_GAUL: { bg: 'bg-red-50',        border: 'border-roman-red/40',  accent: 'text-roman-red',   tag: 'bg-red-50 border-roman-red/40 text-roman-red',            icon: '⚔️' },
    FAMINE:      { bg: 'bg-amber-50',      border: 'border-amber-400',     accent: 'text-amber-700',   tag: 'bg-amber-50 border-amber-400 text-amber-700',             icon: '🌾' },
  };

  return (
    <div className="flex flex-col gap-8">

      {/* ---- EMPIRE EVENT BANNER (Module 2) ----
       * Market.tsx shows its own banner; Dashboard suppresses the outer
       * banner while activeView === 'market' to avoid showing it twice. */}
      {currentEvent && (() => {
        const s = EVENT_STYLES[currentEvent.id];
        if (!s) return null;
        return (
          <div className={`px-4 py-3 rounded-xl border ${s.bg} ${s.border} flex items-center gap-3 flex-wrap`}>
            <span className="text-xl shrink-0" aria-hidden="true">{s.icon}</span>
            <div className="flex-1 min-w-0">
              <span className={`font-bold text-sm uppercase tracking-wider ${s.accent}`}>
                {t(`events.${currentEvent.id}.name`)}
              </span>
              <span className="text-roman-stone text-sm ml-2">
                — {t(`events.${currentEvent.id}.description`)}
              </span>
            </div>
            <span className={`text-xs font-mono px-2 py-0.5 rounded border shrink-0 ${s.tag}`}>
              {t(`events.${currentEvent.id}.effect`)}
            </span>
          </div>
        );
      })()}

      {/* ---- BALANCE BAR ---- */}
      <div className="p-3 px-5 bg-roman-ivory rounded-xl border border-roman-gold/30 shadow-sm flex items-center gap-4 flex-wrap">
        <span className="text-roman-stone text-sm">{t('market.yourBalance')}:</span>
        <span className="font-bold text-roman-gold text-lg flex items-center gap-1.5">
          <ResourceIcon resourceId="SESTERTIUS" className="w-5 h-5 object-contain" />
          {isLoadingInv ? '...' : sestertius} {t('dashboard.resources.SESTERTIUS')}
        </span>
        <span className="text-roman-stone text-xs">
          | {t('dashboard.resources.LIGNUM')}: {resourceAmounts['LIGNUM']}
          {' '}| {t('dashboard.resources.FRUMENTUM')}: {resourceAmounts['FRUMENTUM']}
          {' '}| {t('dashboard.resources.FARINA')}: {resourceAmounts['FARINA']}
        </span>
      </div>

      {/* ================================================================ */}
      {/* SECTION 1: NPC "The Empire" Market                               */}
      {/* ================================================================ */}
      <section>
        <SectionHeader title={t('market.npc.title')} subtitle={hasDogana ? t('market.npc.subtitle') : undefined} />

        {/* Lock card — shown when the player has not built a DOGANA yet.
         * The NPC sell form is hidden entirely; only the Forum is available. */}
        {!hasDogana && (
          <div className="p-6 bg-roman-ivory rounded-xl border border-roman-gold/20 flex flex-col items-center gap-3 text-center">
            <span className="text-3xl" aria-hidden="true">🏛️</span>
            <p className="font-bold text-roman-dark text-sm uppercase tracking-wider m-0">
              {t('market.npc.lockedTitle')}
            </p>
            <p className="text-roman-stone text-sm max-w-sm m-0">
              {t('market.npc.lockedMessage')}
            </p>
          </div>
        )}

        {/* NPC sell UI — only rendered when the player owns a DOGANA */}
        {hasDogana && (<>

        {/* Dynamic price display — live values from the npc_prices DB table.
         * Prices can fluctuate via simulateMarketEvents.ts (±20% per event).
         * An empty list means prices are still loading; tiles appear once ready. */}
        {npcPrices.length > 0 && (
          <div className="flex gap-3 mb-5 flex-wrap">
            {npcPrices.map(({ resource_id, effective_price }) => (
              <div
                key={resource_id}
                className="px-4 py-1.5 bg-amber-50 border border-roman-gold/30 rounded-md text-sm text-gray-600 flex items-center gap-1.5"
              >
                <ResourceIcon resourceId={resource_id} />
                <strong className="text-roman-dark">
                  {t(`dashboard.resources.${resource_id}`)}
                </strong>
                {/* Show effective_price (event-adjusted) — this is what the player receives */}
                {' → '}{effective_price}{' '}
                <ResourceIcon resourceId="SESTERTIUS" className="w-4 h-4 object-contain" />
                {t('dashboard.resources.SESTERTIUS')} / {t('market.npc.unitLabel')}
              </div>
            ))}
          </div>
        )}

        {/* Sell form */}
        <div className="p-4 bg-roman-ivory rounded-xl shadow-sm border border-roman-gold/20 flex gap-3 items-end flex-wrap">

          {/* Resource selector */}
          <div className="flex flex-col gap-1 min-w-[155px]">
            <label className="text-xs text-gray-500">
              {t('market.npc.resourceLabel')}
            </label>
            <select
              value={npcResource}
              onChange={(e) => setNpcResource(e.target.value as NpcSellableResource)}
              className={selectCls}
            >
              {NPC_SELLABLE_RESOURCES.map((r) => (
                <option key={r} value={r}>
                  {t(`dashboard.resources.${r}`)}
                </option>
              ))}
            </select>
          </div>

          {/* Phase 7: Quality selector — sell a specific quality tier of the resource */}
          <div className="flex flex-col gap-1 min-w-[110px]">
            <label className="text-xs text-gray-500">
              {t('buildings.qualityLabel')}
            </label>
            <select
              value={npcQuality}
              onChange={(e) => setNpcQuality(parseInt(e.target.value, 10))}
              className={selectCls}
            >
              <option value={0}>Q0 (×1.0)</option>
              <option value={1}>Q1 (×1.5)</option>
              <option value={2}>Q2 (×2.0)</option>
            </select>
          </div>

          {/* Amount input — shows total inventory as a hint (sum of all quality tiers) */}
          <div className="flex flex-col gap-1 min-w-[130px]">
            <label className="text-xs text-gray-500">
              {t('market.npc.amountLabel')}
              {' '}({t('market.available')}: {resourceAmounts[npcResource]})
            </label>
            <div className="flex gap-1">
              <input
                type="number"
                min={1}
                max={resourceAmounts[npcResource]}
                value={npcAmount}
                onChange={(e) => setNpcAmount(e.target.value)}
                placeholder="e.g. 5"
                className={inputCls}
              />
              <button
                type="button"
                onClick={() => setNpcAmount(String(resourceAmounts[npcResource]))}
                className="px-2 py-1 text-xs bg-roman-gold/20 text-roman-dark border border-roman-gold/50 rounded hover:bg-roman-gold/40 transition-colors whitespace-nowrap"
              >
                Max
              </button>
            </div>
          </div>

          {/* Sell button */}
          <div className="flex flex-col gap-1">
            {/* Invisible label keeps the button vertically aligned with inputs. */}
            <label className="text-xs text-transparent">&nbsp;</label>
            <button
              onClick={() => void handleNpcSell()}
              disabled={npcLoading || npcAmount.trim() === ''}
              className="px-5 py-2 bg-roman-gold text-white border-none rounded text-sm font-roman cursor-pointer hover:opacity-90 transition-opacity disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {npcLoading ? t('market.npc.selling') : t('market.npc.sellButton')}
            </button>
          </div>

          {/* Phase 7: Live payout preview with quality multiplier.
           * Formula mirrors the server:  FLOOR(amount × current_price × (1 + quality × 0.5))
           * Uses the fetched price so the preview stays accurate as prices fluctuate. */}
          {npcAmount.trim() !== '' && parseInt(npcAmount, 10) > 0 && (
            <div className="text-sm text-green-700 self-center">
              {'= '}
              {Math.floor(
                parseInt(npcAmount, 10) *
                getNpcPrice(npcResource) *
                getQualityMultiplier(npcQuality)
              )}
              {' '}{t('dashboard.resources.SESTERTIUS')}
              {npcQuality > 0 && (
                <span className="text-roman-gold text-xs ml-1">
                  (×{getQualityMultiplier(npcQuality).toFixed(1)})
                </span>
              )}
            </div>
          )}
        </div>

        {npcError && (
          <p role="alert" className="text-red-600 text-sm mt-2">{npcError}</p>
        )}
        {npcSuccess && (
          <p className="text-green-700 text-sm mt-2">{npcSuccess}</p>
        )}
        </>)}
      </section>

      {/* ================================================================ */}
      {/* SECTION 2: P2P "The Forum" Market                                */}
      {/* ================================================================ */}
      <section>
        <SectionHeader title={t('market.p2p.title')} subtitle={t('market.p2p.subtitle')} />

        {/* ---- CREATE LISTING FORM ---- */}
        <div className="p-4 bg-roman-ivory rounded-xl shadow-sm border border-roman-gold/20 mb-6">
          <h4 className="m-0 mb-4 text-roman-dark text-sm font-bold uppercase tracking-wider">
            {t('market.p2p.listForm')}
          </h4>
          <div className="flex gap-3 items-end flex-wrap">

            {/* Resource selector */}
            <div className="flex flex-col gap-1 min-w-[155px]">
              <label className="text-xs text-gray-500">
                {t('market.p2p.resourceLabel')}
              </label>
              <select
                value={listResource}
                onChange={(e) => setListResource(e.target.value as ListableResource)}
                className={selectCls}
              >
                {LISTABLE_RESOURCES.map((r) => (
                  <option key={r} value={r}>
                    {t(`dashboard.resources.${r}`)}
                  </option>
                ))}
              </select>
            </div>

            {/* Phase 7: Quality selector — which quality tier to list */}
            <div className="flex flex-col gap-1 min-w-[110px]">
              <label className="text-xs text-gray-500">
                {t('buildings.qualityLabel')}
              </label>
              <select
                value={listQuality}
                onChange={(e) => setListQuality(parseInt(e.target.value, 10))}
                className={selectCls}
              >
                <option value={0}>Q0</option>
                <option value={1}>Q1</option>
                <option value={2}>Q2</option>
              </select>
            </div>

            {/* Amount input */}
            <div className="flex flex-col gap-1 min-w-[130px]">
              <label className="text-xs text-gray-500">
                {t('market.p2p.amountLabel')}
                {' '}({t('market.available')}: {resourceAmounts[listResource]})
              </label>
              <div className="flex gap-1">
                <input
                  type="number"
                  min={1}
                  max={resourceAmounts[listResource]}
                  value={listAmount}
                  onChange={(e) => setListAmount(e.target.value)}
                  placeholder="e.g. 10"
                  className={inputCls}
                />
                <button
                  type="button"
                  onClick={() => setListAmount(String(resourceAmounts[listResource]))}
                  className="px-2 py-1 text-xs bg-roman-gold/20 text-roman-dark border border-roman-gold/50 rounded hover:bg-roman-gold/40 transition-colors whitespace-nowrap"
                >
                  Max
                </button>
              </div>
            </div>

            {/* Price per unit input */}
            <div className="flex flex-col gap-1 min-w-[155px]">
              <label className="text-xs text-gray-500">
                {t('market.p2p.priceLabel')}
              </label>
              <input
                type="number"
                min={1}
                value={listPrice}
                onChange={(e) => setListPrice(e.target.value)}
                placeholder="e.g. 5"
                className={inputCls}
              />
            </div>

            {/* List button */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-transparent">&nbsp;</label>
              <button
                onClick={() => void handleList()}
                disabled={listLoading || listAmount.trim() === '' || listPrice.trim() === ''}
                className="px-5 py-2 bg-roman-gold text-white border-none rounded text-sm font-roman cursor-pointer hover:opacity-90 transition-opacity disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                {listLoading ? t('market.p2p.listing') : t('market.p2p.listButton')}
              </button>
            </div>
          </div>

          {listError && (
            <p role="alert" className="text-red-600 text-sm mt-2">{listError}</p>
          )}
          {listSuccess && (
            <p className="text-green-700 text-sm mt-2">{listSuccess}</p>
          )}
        </div>

        {/* ---- ACTIVE LISTINGS TABLE ---- */}
        <h4 className="m-0 mb-3 text-roman-dark text-sm font-bold uppercase tracking-wider">
          {t('market.p2p.activeListings')}
        </h4>

        {isLoadingListings && (
          <p className="text-gray-400 italic">{t('market.p2p.loadingListings')}</p>
        )}

        {listingsError && (
          <p role="alert" className="text-red-600">{listingsError}</p>
        )}

        {!isLoadingListings && !listingsError && listings.length === 0 && (
          <p className="text-gray-400 italic">{t('market.p2p.noListings')}</p>
        )}

        {!isLoadingListings && !listingsError && listings.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm border border-roman-gold/30">
              <thead>
                <tr>
                  <th className="p-2 px-3 text-left font-bold text-xs border-b-2 border-roman-gold bg-amber-100 text-roman-dark">{t('market.p2p.colSeller')}</th>
                  <th className="p-2 px-3 text-left font-bold text-xs border-b-2 border-roman-gold bg-amber-100 text-roman-dark">{t('market.p2p.colResource')}</th>
                  <th className="p-2 px-3 text-left font-bold text-xs border-b-2 border-roman-gold bg-amber-100 text-roman-dark">{t('market.p2p.colQuality')}</th>
                  <th className="p-2 px-3 text-right font-bold text-xs border-b-2 border-roman-gold bg-amber-100 text-roman-dark">{t('market.p2p.colAmount')}</th>
                  <th className="p-2 px-3 text-right font-bold text-xs border-b-2 border-roman-gold bg-amber-100 text-roman-dark">{t('market.p2p.colPricePerUnit')}</th>
                  <th className="p-2 px-3 text-right font-bold text-xs border-b-2 border-roman-gold bg-amber-100 text-roman-dark">{t('market.p2p.colTotal')}</th>
                  <th className="p-2 px-3 text-right font-bold text-xs border-b-2 border-roman-gold bg-amber-100 text-roman-dark"></th>
                </tr>
              </thead>
              <tbody>
                {listings.map((listing) => {
                  const isOwnListing  = listing.seller_username === user?.username;
                  // Disable "Buy" if the buyer cannot afford it (client-side hint).
                  // The server enforces this independently — this is a UX affordance only.
                  const canAfford     = sestertius >= listing.total_price;
                  const isBuying      = buyingId   === listing.id;
                  const isCancelling  = cancellingId === listing.id;
                  const buyError      = buyErrors[listing.id];
                  const cancelError   = cancelErrors[listing.id];

                  return (
                    // React.Fragment with a key lets us add the optional error row
                    // without wrapping in a <div> (which would break table structure).
                    <React.Fragment key={listing.id}>
                      <tr className={`border-b border-roman-gold/20 ${isOwnListing ? 'bg-yellow-50' : 'bg-white'}`}>
                        <td className="py-2.5 px-3">
                          {listing.seller_username}
                          {isOwnListing && (
                            <span className="text-xs text-roman-gold ml-1">
                              ({t('market.p2p.ownListing')})
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3">
                          <span className="flex items-center gap-1.5">
                            <ResourceIcon resourceId={listing.resource_id} />
                            {t(`dashboard.resources.${listing.resource_id}`)}
                          </span>
                        </td>
                        {/* Phase 7: quality tier cell — highlight non-Q0 with a badge */}
                        <td className="py-2.5 px-3">
                          {listing.quality > 0 ? (
                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-roman-gold border border-roman-gold/60">
                              Q{listing.quality}
                            </span>
                          ) : (
                            <span className="text-gray-400 text-xs">Q0</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right">{listing.amount}</td>
                        <td className="py-2.5 px-3 text-right">{listing.price_per_unit}</td>
                        <td className="py-2.5 px-3 text-right font-bold text-roman-dark">{listing.total_price}</td>
                        <td className="py-2.5 px-3 text-right">
                          {isOwnListing ? (
                            // Own listings show a Cancel button — returns escrowed resources.
                            <button
                              onClick={() => void handleCancel(listing.id)}
                              disabled={isCancelling}
                              className={[
                                'px-3.5 py-1 border-none rounded text-xs transition-opacity',
                                isCancelling
                                  ? 'bg-gray-300 text-gray-400 cursor-not-allowed'
                                  : 'bg-red-600 text-white cursor-pointer hover:opacity-90',
                              ].join(' ')}
                            >
                              {isCancelling ? '...' : t('market.p2p.cancelButton')}
                            </button>
                          ) : (
                            <button
                              onClick={() => void handleBuy(listing.id)}
                              disabled={isBuying || !canAfford}
                              // Show a tooltip if the player cannot afford it.
                              title={!canAfford ? t('market.errors.insufficientFunds') : undefined}
                              className={[
                                'px-3.5 py-1 border-none rounded text-xs transition-opacity',
                                isBuying || !canAfford
                                  ? 'bg-gray-300 text-gray-400 cursor-not-allowed'
                                  : 'bg-roman-gold text-white cursor-pointer hover:opacity-90',
                              ].join(' ')}
                            >
                              {isBuying
                                ? t('market.p2p.buying')
                                : t('market.p2p.buyButton')}
                            </button>
                          )}
                        </td>
                      </tr>

                      {/* Show per-row errors directly below the affected listing row. */}
                      {(buyError || cancelError) && (
                        <tr className="bg-red-50">
                          <td
                            colSpan={7}
                            role="alert"
                            className="py-1 px-3 text-red-600 text-xs"
                          >
                            {buyError || cancelError}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

export default Market;
