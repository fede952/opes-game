/**
 * @file src/components/Dashboard.tsx
 * @description The main game screen: buildings with time-based production + resource inventory.
 *
 * ================================================================
 * PHASE 4 — TIME-BASED PRODUCTION LOOP
 * ================================================================
 *
 * Players no longer click "Produce" for instant resources. Instead, they manage
 * a production cycle on their buildings:
 *
 *   1. Building is IDLE → player clicks "Start Production"
 *      → POST /production/start { building_id }
 *      → Server sets building to PRODUCING, records end_time
 *
 *   2. A countdown timer on the building card ticks down to zero.
 *      The timer is client-side cosmetic only — the actual end_time is stored
 *      in the database. Even if the client manipulates the timer display,
 *      the server will reject a collect attempt before end_time passes.
 *
 *   3. When the timer reaches zero → player clicks "Collect!"
 *      → POST /production/collect { building_id }
 *      → Server verifies end_time server-side, awards resources, resets building
 *
 * ================================================================
 * COUNTDOWN TIMER IMPLEMENTATION
 * ================================================================
 *
 * React components only re-render when their state or props change.
 * A countdown timer needs to update the display every second, so we need
 * a mechanism to force re-renders on a 1-second interval.
 *
 * We use a `tick` state variable that a setInterval increments every second.
 * The actual remaining time is NOT stored in state — it is computed fresh
 * from `Date.now()` vs `building.job.end_time` on each render.
 *
 * Why compute instead of storing?
 *   - Storing remaining seconds would require careful synchronization
 *     between the interval callback and render logic.
 *   - Computing from the fixed end_time is simpler and always accurate:
 *     `Math.ceil((new Date(end_time).getTime() - Date.now()) / 1000)`
 *   - If the tab is hidden and intervals fire less frequently, the computed
 *     value catches up automatically. Stored values would be stale.
 *
 * The interval is cleaned up (clearInterval) when:
 *   a) No buildings are PRODUCING (no need to tick)
 *   b) The component unmounts (avoids memory leaks)
 *
 * ================================================================
 * SERVER-AUTHORITATIVE PATTERN (same as Phase 3, extended)
 * ================================================================
 *
 * After a collect, we re-fetch BOTH buildings and inventory from the server.
 * We never compute `localInventory + yield_amount` — we use the confirmed
 * server value. This ensures the UI always reflects the true game state.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { apiRequest } from '../api/client';
import LanguageSelector from './LanguageSelector';
import ResourceIcon      from './ResourceIcon';
import Market            from './Market';
import Contracts         from './Contracts';
import Bank              from './Bank';
import Senate            from './Senate';

// ================================================================
// API RESPONSE TYPES
// ================================================================

interface ProductionJob {
  id:            string;
  resource_type: string;  // matches backend column name (NOT resource_id)
  quality:       number;  // quality tier 0/1/2 — matches backend column name (NOT target_quality)
  start_time:    string;  // ISO timestamp — serialized from PostgreSQL TIMESTAMPTZ
  end_time:      string;  // ISO timestamp — the authoritative "ready at" time
  // yield_amount does NOT exist in the DB; computed at collect time from config × level
}

interface Building {
  id:            string;
  building_type: string;
  level:         number;  // Phase 6: upgrade level (minimum 1)
  status:        'IDLE' | 'PRODUCING';
  job:           ProductionJob | null;
}

interface BuildingsApiResponse {
  buildings: Building[];
}

interface InventoryRow {
  resource_id: string;
  quality:     number;  // Phase 7: quality tier (0, 1, or 2)
  amount:      number;
}

interface InventoryApiResponse {
  inventory: InventoryRow[];
}

// ================================================================
// RESOURCE CONFIGURATION
// ================================================================

const ALL_RESOURCES = ['SESTERTIUS', 'LIGNUM', 'FRUMENTUM', 'FARINA', 'RESEARCH'] as const;
type ResourceId = (typeof ALL_RESOURCES)[number];

/**
 * Resources that do NOT count towards physical storage capacity.
 * SESTERTIUS — currency (treasury ledger). RESEARCH — abstract knowledge.
 * Mirrors WEIGHTLESS_RESOURCES in backend/src/utils/storageUtils.ts.
 */
const WEIGHTLESS_RESOURCES = new Set<ResourceId>(['SESTERTIUS', 'RESEARCH']);

/**
 * Maps building types to the resource they produce.
 *
 * Mirrors server-side BUILDING_CONFIGS[x].output.
 * Used client-side ONLY for display purposes (e.g., "Produces: Farina").
 * The server is the authoritative source — this is cosmetic only.
 */
const BUILDING_RESOURCE_MAP: Readonly<Record<string, ResourceId>> = {
  CASTRA_LIGNATORUM: 'LIGNUM',
  FUNDUS_FRUMENTI:   'FRUMENTUM',
  PISTRINUM:         'FARINA',
} as const;

/**
 * Client-side mirror of server-side BUILDING_CONFIGS (src/config/gameConfig.ts).
 *
 * Used ONLY for UI display: showing production costs before clicking "Start",
 * showing upgrade costs before clicking "Upgrade", and showing the Build section.
 * The server recomputes and enforces all actual costs independently.
 *
 * If these values drift from the server config, the displayed costs may be
 * incorrect, but the server transaction is always authoritative. Keep them
 * in sync when updating gameConfig.ts.
 */
interface ClientBuildingDisplay {
  output:                string;
  base_yield:            number;
  base_cost:             number;   // Sestertius wages per run at level 1
  inputs:                Array<{ resource: string; amount: number }>;
  upgrade_base_cost:     number;   // Cost to upgrade: upgrade_base_cost × current_level
  build_cost?:           number;   // One-time Sestertius construction cost
  build_cost_resources?: Array<{ resource: string; amount: number }>; // Non-Sestertius resource costs
  passive?:              boolean;  // Phase 7: passive buildings (HORREUM) have no production
}

/**
 * Client-side mirror of server-side BUILDING_CONFIGS (src/config/gameConfig.ts).
 *
 * Used ONLY for UI display. The server recomputes and enforces all actual costs.
 * Keep in sync with gameConfig.ts whenever adding or changing building economics.
 */
const BUILDING_DISPLAY_CONFIG: Readonly<Record<string, ClientBuildingDisplay>> = {
  CASTRA_LIGNATORUM: { output: 'LIGNUM',    base_yield: 10, base_cost: 2,  inputs: [],                                     upgrade_base_cost: 50,  passive: false },
  FUNDUS_FRUMENTI:   { output: 'FRUMENTUM', base_yield: 15, base_cost: 3,  inputs: [],                                     upgrade_base_cost: 50,  passive: false },
  PISTRINUM:         { output: 'FARINA',    base_yield: 5,  base_cost: 5,  inputs: [{ resource: 'FRUMENTUM', amount: 10 }], upgrade_base_cost: 100, build_cost: 100,  passive: false },
  HORREUM:           { output: '',          base_yield: 0,  base_cost: 0,  inputs: [],                                     upgrade_base_cost: 150, build_cost: 200,  passive: true  },
  ACADEMIA:          { output: 'RESEARCH',  base_yield: 1,  base_cost: 10, inputs: [],                                     upgrade_base_cost: 75,  build_cost: 150,                                             passive: false },
  DOGANA:            { output: '',          base_yield: 0,  base_cost: 0,  inputs: [],                                     upgrade_base_cost: 200, build_cost: 500, build_cost_resources: [{ resource: 'LIGNUM', amount: 50 }], passive: true  },
} as const;

/** Returns level-scaled production cost info for a building card display. */
const getProductionDisplay = (buildingType: string, level: number) => {
  const cfg = BUILDING_DISPLAY_CONFIG[buildingType];
  if (!cfg) return null;
  return {
    wages:  cfg.base_cost * level,
    inputs: cfg.inputs.map((i) => ({ resource: i.resource, amount: i.amount * level })),
    yield:  cfg.base_yield * level,
  };
};

/** Returns the Sestertius cost to upgrade from `level` to `level + 1`. */
const getUpgradeCost = (buildingType: string, level: number): number => {
  const cfg = BUILDING_DISPLAY_CONFIG[buildingType];
  return cfg ? cfg.upgrade_base_cost * level : 0;
};

// ================================================================
// UTILITIES
// ================================================================

/**
 * Computes the number of seconds remaining until end_time.
 *
 * Returns 0 if end_time is in the past (production is ready to collect).
 * Returns a positive integer if production is still in progress.
 *
 * Uses Math.ceil so the timer shows "1s left" rather than "0s left" in the
 * final second — gives the player a cue to click before the server confirms ready.
 *
 * @param endTime - ISO timestamp string from the production job (e.g., "2024-01-01T00:01:00Z")
 */
const getRemainingSeconds = (endTime: string): number =>
  Math.max(0, Math.ceil((new Date(endTime).getTime() - Date.now()) / 1000));

// ================================================================
// COMPONENT
// ================================================================

const Dashboard: React.FC = () => {
  const { t }            = useTranslation();
  const { user, logout } = useAuth();

  // ---- BUILDINGS STATE ----

  const [buildings,        setBuildings]        = useState<Building[]>([]);
  const [isLoadingBldgs,   setIsLoadingBldgs]   = useState<boolean>(true);
  const [buildingsError,   setBuildingsError]   = useState<string | null>(null);

  // ---- INVENTORY STATE ----

  const [inventory,        setInventory]        = useState<Record<ResourceId, number>>({
    SESTERTIUS: 0,
    LIGNUM:     0,
    FRUMENTUM:  0,
    FARINA:     0,
    RESEARCH:   0,
  });
  const [isLoadingInv,     setIsLoadingInv]     = useState<boolean>(true);
  const [inventoryError,   setInventoryError]   = useState<string | null>(null);

  // ---- ACTION STATE ----

  /**
   * The building_id currently being acted on (start or collect in progress).
   * null = no request in flight.
   *
   * We use the building_id rather than a boolean so that only the specific
   * building being acted on shows a loading state — other buildings remain
   * fully interactive.
   */
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  /** Per-building error messages shown below each building card's action button. */
  const [buildingErrors,   setBuildingErrors]   = useState<Record<string, string>>({});

  /**
   * The building_id currently being upgraded (null = no upgrade in flight).
   * Separate from actionInProgress so upgrade and start/collect can coexist
   * in the UI state without interfering with each other's loading indicators.
   */
  const [upgradingId,      setUpgradingId]      = useState<string | null>(null);

  /** Per-building upgrade error messages (separate from production errors). */
  const [upgradeErrors,    setUpgradeErrors]    = useState<Record<string, string>>({});

  /**
   * Tracks which building_type is currently being constructed.
   * null = no build in flight.
   * e.g., 'PISTRINUM' while waiting for the POST /buildings/build response.
   */
  const [buildingType,   setBuildingType]   = useState<string | null>(null);

  /** Per-building-type build error messages. */
  const [buildErrors,    setBuildErrors]    = useState<Record<string, string>>({});

  /** Per-building-type build success messages. */
  const [buildSuccesses, setBuildSuccesses] = useState<Record<string, string>>({});

  // ---- CURRENT EVENT STATE (Module 2) ----
  // The active empire event, fetched from GET /market/npc/event on mount.
  // null while loading — banner is simply not rendered until data arrives.
  const [currentEvent, setCurrentEvent] = useState<{
    id:          string;
    multipliers: Record<string, number>;
  } | null>(null);

  /**
   * Phase 7: Per-building quality selection for Start Production.
   * Maps building_id → selected quality (0, 1, or 2).
   * Default is 0 (standard quality) — players opt into higher quality.
   */
  const [qualitySelections, setQualitySelections] = useState<Record<string, number>>({});

  /**
   * Increments every second when any building is PRODUCING.
   * This forces a re-render so the countdown timer display stays up-to-date.
   * The actual remaining time is computed from Date.now() vs end_time — not
   * derived from tick. Tick is purely a re-render trigger.
   */
  const [tick, setTick] = useState<number>(0);

  /**
   * Controls which top-level tab is currently visible.
   *
   * 'production' — shows buildings + inventory (the existing Phase 4 view).
   * 'market'     — shows the Market component (Phase 5: NPC + P2P trading).
   *
   * We manage this at the Dashboard level (not App level) so that the
   * production data (buildings, inventory) stays fetched and fresh even
   * while the player is browsing the Market tab. Switching back to
   * Production is instant — no re-fetch needed unless data has changed.
   */
  const [activeView, setActiveView] = useState<'production' | 'market' | 'contracts' | 'bank' | 'senate'>('production');

  // ================================================================
  // DATA FETCHING
  // ================================================================

  const fetchBuildings = useCallback(async (): Promise<void> => {
    setIsLoadingBldgs(true);
    setBuildingsError(null);

    try {
      const data = await apiRequest<BuildingsApiResponse>('/buildings');
      setBuildings(data.buildings);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('Unauthorized') || message.includes('expired')) {
        logout();
        return;
      }

      setBuildingsError(message);
    } finally {
      setIsLoadingBldgs(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // NOTE: `logout` is excluded from deps intentionally — it's stable from context.

  const fetchInventory = useCallback(async (): Promise<void> => {
    setIsLoadingInv(true);
    setInventoryError(null);

    try {
      const data = await apiRequest<InventoryApiResponse>('/inventory');

      // Phase 7: multiple rows can exist per resource_id (one per quality tier).
      // Sum all quality tiers together to get the total per resource.
      const map = data.inventory.reduce<Record<string, number>>(
        (acc, row) => {
          acc[row.resource_id] = (acc[row.resource_id] ?? 0) + row.amount;
          return acc;
        },
        {}
      );

      // Phase 7: inventory rows now include quality (one row per resource+quality tier).
      // We sum all quality tiers together to get the total per resource for display.
      // The storage bar uses these totals. Quality-specific operations go through
      // the Market component which tracks per-quality amounts separately.
      setInventory({
        SESTERTIUS: map['SESTERTIUS'] ?? 0,
        LIGNUM:     map['LIGNUM']     ?? 0,
        FRUMENTUM:  map['FRUMENTUM']  ?? 0,
        FARINA:     map['FARINA']     ?? 0,
        RESEARCH:   map['RESEARCH']   ?? 0,
      });

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('Unauthorized') || message.includes('expired')) {
        logout();
        return;
      }

      setInventoryError(message);
    } finally {
      setIsLoadingInv(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Fetches the current empire event from GET /market/npc/event.
   *
   * The event is global game state computed server-side from the UTC day
   * number — it rotates every 24 hours. We fetch it once on mount and
   * store it for the banner. Errors are swallowed silently: the banner
   * is cosmetic and should not break the main game UI if unavailable.
   */
  const fetchCurrentEvent = useCallback(async (): Promise<void> => {
    try {
      const data = await apiRequest<{
        event: { id: string; multipliers: Record<string, number> };
      }>('/market/npc/event');
      setCurrentEvent(data.event);
    } catch {
      // Silently degrade — event banner is informational, not blocking.
    }
  }, []);

  // Fetch all data sources when the component mounts.
  useEffect(() => {
    void fetchBuildings();
    void fetchInventory();
    void fetchCurrentEvent();
  }, [fetchBuildings, fetchInventory, fetchCurrentEvent]);

  /**
   * Silently re-fetches buildings and inventory without showing loading spinners.
   *
   * Called every 10 seconds by the polling interval below. Unlike fetchBuildings /
   * fetchInventory (which set isLoading=true, causing the UI to briefly blank),
   * this function updates state in-place so the player sees the new values without
   * any visual disruption. It swallows errors silently — a missed poll is harmless.
   */
  const silentRefresh = useCallback(async (): Promise<void> => {
    try {
      const [bldgsData, invData] = await Promise.all([
        apiRequest<BuildingsApiResponse>('/buildings'),
        apiRequest<InventoryApiResponse>('/inventory'),
      ]);

      setBuildings(bldgsData.buildings);

      const map = invData.inventory.reduce<Record<string, number>>(
        (acc, row) => {
          acc[row.resource_id] = (acc[row.resource_id] ?? 0) + row.amount;
          return acc;
        },
        {}
      );
      setInventory({
        SESTERTIUS: map['SESTERTIUS'] ?? 0,
        LIGNUM:     map['LIGNUM']     ?? 0,
        FRUMENTUM:  map['FRUMENTUM']  ?? 0,
        FARINA:     map['FARINA']     ?? 0,
        RESEARCH:   map['RESEARCH']   ?? 0,
      });
    } catch {
      // Silently swallow polling errors — a missed tick is harmless.
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ================================================================
  // COUNTDOWN TICK INTERVAL
  // ================================================================

  /**
   * Start a 1-second interval whenever any building is currently PRODUCING.
   * The interval increments `tick`, which triggers a re-render, which causes
   * getRemainingSeconds() to be called fresh with the current Date.now().
   *
   * The effect re-runs whenever `buildings` changes (e.g., after a collect
   * resets a building to IDLE). If no buildings are PRODUCING, the interval
   * is not created — no unnecessary ticking when everything is idle.
   *
   * The cleanup function (clearInterval) runs:
   *   a) Before each re-run of this effect (React cleans up before re-applying)
   *   b) When the component unmounts — prevents memory leaks / state updates
   *      on unmounted components
   */
  useEffect(() => {
    const hasProducing = buildings.some((b) => b.status === 'PRODUCING');
    if (!hasProducing) return;

    const interval = setInterval(() => {
      setTick((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [buildings]);

  /**
   * Background polling — re-fetches buildings + inventory every 10 seconds.
   *
   * WHY POLL?
   *   Production jobs complete server-side on a timer. Without polling, a player
   *   who leaves the tab open would not see that their building finished until
   *   they manually refresh. 10-second polling keeps the state reasonably fresh
   *   without hammering the server.
   *
   * WHY NOT USE WEBSOCKETS?
   *   Simpler infrastructure. 10 s is good enough for a casual game loop.
   *   Websockets can be added later if latency requirements tighten.
   *
   * silentRefresh is stable (useCallback with empty deps), so this effect
   * only runs once on mount and its cleanup clears the interval on unmount.
   */
  useEffect(() => {
    const interval = setInterval(() => {
      void silentRefresh();
    }, 10_000);

    return () => clearInterval(interval);
  }, [silentRefresh]);

  // ================================================================
  // ACTIONS
  // ================================================================

  const handleStartProduction = async (buildingId: string): Promise<void> => {
    if (actionInProgress === buildingId) return;

    setActionInProgress(buildingId);
    setBuildingErrors((prev) => ({ ...prev, [buildingId]: '' }));

    // Read the quality selection for this building (default 0 if not set).
    const selectedQuality = qualitySelections[buildingId] ?? 0;

    try {
      await apiRequest('/production/start', {
        method: 'POST',
        body:   JSON.stringify({ building_id: buildingId, quality: selectedQuality }),
      });

      // Re-fetch buildings to get the confirmed PRODUCING state from the server.
      // Server-authoritative: we don't optimistically flip status locally.
      await fetchBuildings();

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('Unauthorized') || message.includes('expired')) {
        logout();
        return;
      }

      setBuildingErrors((prev) => ({ ...prev, [buildingId]: message }));
    } finally {
      setActionInProgress(null);
    }
  };

  const handleCollect = async (buildingId: string): Promise<void> => {
    if (actionInProgress === buildingId) return;

    setActionInProgress(buildingId);
    setBuildingErrors((prev) => ({ ...prev, [buildingId]: '' }));

    try {
      await apiRequest('/production/collect', {
        method: 'POST',
        body:   JSON.stringify({ building_id: buildingId }),
      });

      // Re-fetch both buildings (reset to IDLE) and inventory (new resource amounts).
      // We fetch both in parallel for efficiency — they are independent requests.
      await Promise.all([fetchBuildings(), fetchInventory()]);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('Unauthorized') || message.includes('expired')) {
        logout();
        return;
      }

      setBuildingErrors((prev) => ({ ...prev, [buildingId]: message }));
    } finally {
      setActionInProgress(null);
    }
  };

  // ================================================================
  // UPGRADE HANDLER
  // ================================================================

  const handleUpgrade = async (buildingId: string): Promise<void> => {
    if (upgradingId === buildingId) return;

    setUpgradingId(buildingId);
    setUpgradeErrors((prev) => ({ ...prev, [buildingId]: '' }));

    try {
      await apiRequest('/buildings/upgrade', {
        method: 'POST',
        body:   JSON.stringify({ user_building_id: buildingId }),
      });

      // Re-fetch buildings to show the new level, and inventory to show the
      // reduced Sestertius balance. Fetch in parallel for efficiency.
      await Promise.all([fetchBuildings(), fetchInventory()]);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('Unauthorized') || message.includes('expired')) {
        logout();
        return;
      }

      setUpgradeErrors((prev) => ({ ...prev, [buildingId]: message }));
    } finally {
      setUpgradingId(null);
    }
  };

  // ================================================================
  // BUILD HANDLER (Phase 7: generic for any buildable building type)
  // ================================================================

  /**
   * Constructs a new building of the given type.
   *
   * Replaces the Phase 6 handleBuildMill() with a generic handler that works
   * for all buildable types: PISTRINUM, HORREUM, ACADEMIA.
   *
   * @param bldgType - Building type string (e.g., 'PISTRINUM', 'HORREUM').
   */
  const handleBuild = async (bldgType: string): Promise<void> => {
    if (buildingType === bldgType) return;

    setBuildingType(bldgType);
    setBuildErrors((prev)    => ({ ...prev, [bldgType]: '' }));
    setBuildSuccesses((prev) => ({ ...prev, [bldgType]: '' }));

    try {
      const data = await apiRequest<{ message: string }>('/buildings/build', {
        method: 'POST',
        body:   JSON.stringify({ building_type: bldgType }),
      });

      setBuildSuccesses((prev) => ({ ...prev, [bldgType]: data.message }));
      // Re-fetch buildings (new building appears) and inventory (Sestertius deducted).
      await Promise.all([fetchBuildings(), fetchInventory()]);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('Unauthorized') || message.includes('expired')) {
        logout();
        return;
      }

      setBuildErrors((prev) => ({ ...prev, [bldgType]: message }));
    } finally {
      setBuildingType(null);
    }
  };

  // ================================================================
  // RENDER
  // ================================================================

  // Suppress unused-variable warning for `tick` — it is used implicitly
  // to trigger re-renders via setTick, but its value is never read in JSX.
  void tick;

  // ---- Derived HUD values (needed in both sticky bar and production view) ----
  const hudUsed = ALL_RESOURCES
    .filter((r) => !WEIGHTLESS_RESOURCES.has(r))
    .reduce((sum, r) => sum + (inventory[r] ?? 0), 0);

  const hudHorreaBonus = buildings
    .filter((b) => b.building_type === 'HORREUM')
    .reduce((sum, b) => sum + b.level * 500, 0);

  const hudMaxStorage = 500 + hudHorreaBonus;
  const hudFillPct    = Math.min(100, Math.round((hudUsed / hudMaxStorage) * 100));
  const hudCritical   = hudFillPct >= 90;

  return (
    /*
     * PHASE 2 LAYOUT
     * The outer div is full-screen. Inside it we have two zones:
     *   1. A sticky dark navigation bar (full viewport width) — always visible.
     *   2. A centred content area (max-w-7xl) — scrolls below the nav.
     *
     * This replaces the old max-w-2xl single-column layout with a wider,
     * management-game-style UI.
     */
    <div className="min-h-screen">

      {/* ================================================================ */}
      {/* ROMAN NAVIGATION BAR                                             */}
      {/* ================================================================ */}
      {/*
       * Sticky dark header (bg-roman-dark) with three horizontal zones:
       *   Left   — OPES brand + player greeting
       *   Centre — HUD: Sestertius, storage bar, resource counts
       *   Right  — language selector + logout
       *
       * A second row below the brand row holds the five navigation tabs.
       * The active tab gets a gold bottom border and gold text.
       */}
      <div className="sticky top-0 z-20 bg-roman-dark shadow-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">

          {/* ---- Top row: brand | HUD | controls ---- */}
          <div className="flex items-center justify-between h-14 border-b border-white/10">

            {/* Left: brand */}
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-roman-gold font-bold text-xl tracking-widest uppercase">
                OPES
              </span>
              {/* Vertical divider — hidden on narrow screens */}
              <span className="hidden sm:block h-4 w-px bg-roman-gold/30" />
              <span className="hidden sm:block text-roman-marble/40 text-xs tracking-widest uppercase">
                {t('dashboard.greeting', { username: user?.username ?? '' })}
              </span>
            </div>

            {/* Centre: HUD (hidden while data loads to avoid flashing zeros) */}
            {!isLoadingInv && !isLoadingBldgs && (
              <div className="flex items-center gap-3 text-sm">

                {/* Sestertius balance pill */}
                <div className="flex items-center gap-1.5 px-3 py-1 bg-roman-gold/10 border border-roman-gold/30 rounded-full text-roman-gold font-bold">
                  <ResourceIcon resourceId="SESTERTIUS" className="w-4 h-4 object-contain" />
                  <span>{inventory.SESTERTIUS.toLocaleString()}</span>
                </div>

                {/* Storage mini-bar — hidden on small screens */}
                <div className="hidden sm:flex items-center gap-1.5">
                  <span className={`text-xs font-bold ${hudCritical ? 'text-red-400' : 'text-roman-marble/50'}`}>
                    {hudUsed}/{hudMaxStorage}
                  </span>
                  <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${hudCritical ? 'bg-red-500' : 'bg-roman-gold'}`}
                      style={{ width: `${hudFillPct}%` }}
                    />
                  </div>
                </div>

                {/* Physical resource counts — hidden on small/medium screens */}
                {(['LIGNUM', 'FRUMENTUM', 'FARINA'] as const).map((r) => (
                  <div key={r} className="hidden md:flex items-center gap-1 text-roman-marble/60">
                    <ResourceIcon resourceId={r} className="w-4 h-4 object-contain" />
                    <span className="text-xs">{inventory[r]}</span>
                  </div>
                ))}

                {/* RESEARCH — only show when the player has some */}
                {inventory.RESEARCH > 0 && (
                  <div className="hidden md:flex items-center gap-1 text-roman-marble/60">
                    <ResourceIcon resourceId="RESEARCH" className="w-4 h-4" />
                    <span className="text-xs">{inventory.RESEARCH}</span>
                  </div>
                )}
              </div>
            )}

            {/* Right: controls */}
            <div className="flex items-center gap-2 shrink-0">
              <LanguageSelector />
              <button
                onClick={logout}
                className="px-3 py-1.5 border border-roman-gold/50 text-roman-gold rounded text-xs cursor-pointer hover:bg-roman-gold hover:text-roman-dark transition-colors duration-150"
              >
                {t('auth.logoutButton')}
              </button>
            </div>
          </div>

          {/* ---- Tab navigation row ---- */}
          {/*
           * Tabs sit on the dark background with a gold underline on the active tab.
           * Using border-b-2 on each button + border-transparent on inactive ones
           * creates a flush underline effect without any visible gap.
           */}
          <nav className="flex">
            {(['production', 'market', 'contracts', 'bank', 'senate'] as const).map((view) => (
              <button
                key={view}
                onClick={() => setActiveView(view)}
                className={[
                  'px-5 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-colors duration-150 cursor-pointer bg-transparent',
                  activeView === view
                    ? 'border-roman-gold text-roman-gold'
                    : 'border-transparent text-roman-marble/50 hover:text-roman-marble',
                ].join(' ')}
              >
                {view === 'production' ? t('market.tabProduction')
                  : view === 'market'    ? t('market.tabMarket')
                  : view === 'contracts' ? t('market.tabContracts')
                  : view === 'bank'      ? t('market.tabBank')
                  :                        t('market.tabSenate')}
              </button>
            ))}
          </nav>

        </div>
      </div>
      {/* end sticky nav */}

      {/* ================================================================ */}
      {/* MAIN CONTENT AREA                                                */}
      {/* ================================================================ */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">

        {/* ---- EMPIRE EVENT BANNER (Module 2) ----
         * Shown on all tabs EXCEPT 'market', where Market.tsx renders
         * its own banner (to avoid showing the same banner twice).
         * The banner is purely informational: it does not block any action. */}
        {currentEvent && activeView !== 'market' && (() => {
          // Per-event Tailwind classes. Defined inline so the full class strings
          // are present in source (Tailwind's JIT purger scans for complete strings).
          const STYLES: Record<string, { bg: string; border: string; accent: string; tag: string; icon: string }> = {
            PAX_ROMANA:  { bg: 'bg-roman-gold/10', border: 'border-roman-gold/30', accent: 'text-roman-gold',  tag: 'bg-roman-gold/10 border-roman-gold/30 text-roman-gold',  icon: '🕊️' },
            WAR_IN_GAUL: { bg: 'bg-red-50',        border: 'border-roman-red/40',  accent: 'text-roman-red',   tag: 'bg-red-50 border-roman-red/40 text-roman-red',            icon: '⚔️' },
            FAMINE:      { bg: 'bg-amber-50',      border: 'border-amber-400',     accent: 'text-amber-700',   tag: 'bg-amber-50 border-amber-400 text-amber-700',             icon: '🌾' },
          };
          const s = STYLES[currentEvent.id];
          if (!s) return null;
          return (
            <div className={`mb-6 px-4 py-3 rounded-xl border ${s.bg} ${s.border} flex items-center gap-3 flex-wrap`}>
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

        {/* ---- PRODUCTION VIEW ---- */}
        {activeView === 'production' && (
          <>

            {/* ---- Storage capacity bar ---- */}
            {/*
             * Computed client-side:
             *   used     = sum of physical resources (SESTERTIUS and RESEARCH excluded)
             *   capacity = 500 base + sum(HORREUM.level × 500)
             * The server enforces the actual cap; this is a visual affordance only.
             */}
            {(() => {
              const usedStorage = ALL_RESOURCES
                .filter((r) => !WEIGHTLESS_RESOURCES.has(r))
                .reduce((sum, r) => sum + (inventory[r] ?? 0), 0);
              const horreaBonus = buildings
                .filter((b) => b.building_type === 'HORREUM')
                .reduce((sum, b) => sum + b.level * 500, 0);
              const maxStorage = 500 + horreaBonus;
              const fillPct    = Math.min(100, Math.round((usedStorage / maxStorage) * 100));
              const isCritical = fillPct >= 90;

              return (
                <div className="mb-6 p-4 bg-roman-ivory rounded-xl border border-roman-gold/20 shadow-sm">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-roman-dark uppercase tracking-wider">
                      {t('dashboard.storageLabel')}
                    </span>
                    <span className={`text-xs font-bold ${isCritical ? 'text-roman-red' : 'text-roman-gold'}`}>
                      {usedStorage} / {maxStorage}
                    </span>
                  </div>
                  <div className="w-full h-2 bg-roman-gold/10 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${isCritical ? 'bg-roman-red' : 'bg-roman-gold'}`}
                      style={{ width: `${fillPct}%` }}
                    />
                  </div>
                </div>
              );
            })()}

            {/* ================================================================ */}
            {/* BUILDINGS SECTION                                                */}
            {/* ================================================================ */}
            <section className="mb-8">

              {/* Section header: label + decorative horizontal rule */}
              <div className="flex items-center gap-3 mb-4">
                <h3 className="text-sm font-bold text-roman-dark uppercase tracking-widest whitespace-nowrap">
                  {t('buildings.title')}
                </h3>
                <div className="flex-1 h-px bg-roman-gold/20" />
              </div>

              {isLoadingBldgs && (
                <p className="text-gray-400 italic text-sm">{t('buildings.loading')}</p>
              )}
              {buildingsError && (
                <p role="alert" className="text-roman-red text-sm">{buildingsError}</p>
              )}

              {!isLoadingBldgs && !buildingsError && (
                /*
                 * 2-column grid on medium screens and wider.
                 * Each building gets its own card with a coloured top-stripe
                 * that indicates its current state at a glance.
                 */
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {buildings.map((building) => {
                    const isActing    = actionInProgress === building.id;
                    const isUpgrading = upgradingId === building.id;
                    const bldgError   = buildingErrors[building.id];
                    const upgradeErr  = upgradeErrors[building.id];
                    const isProducing = building.status === 'PRODUCING';
                    const cfg         = BUILDING_DISPLAY_CONFIG[building.building_type];
                    const isPassive   = cfg?.passive === true;

                    const remaining = isProducing && building.job
                      ? getRemainingSeconds(building.job.end_time)
                      : 0;
                    const isReady = isProducing && remaining === 0;

                    const prodDisplay = getProductionDisplay(building.building_type, building.level);
                    const upgradeCost = getUpgradeCost(building.building_type, building.level);

                    const selectedQuality  = qualitySelections[building.id] ?? 0;
                    const canSelectQuality = !isPassive && cfg?.output !== 'RESEARCH';
                    const researchCost     = canSelectQuality ? selectedQuality * 2 : 0;

                    /*
                     * Top accent stripe colour:
                     *   gold    — building is actively producing
                     *   blue    — passive storage building (HORREUM)
                     *   faint   — idle production building
                     */
                    const accentColor = isProducing
                      ? 'bg-roman-gold'
                      : isPassive
                        ? 'bg-blue-400'
                        : 'bg-roman-gold/20';

                    return (
                      <div
                        key={building.id}
                        className="bg-roman-ivory rounded-xl shadow-sm border border-roman-gold/20 overflow-hidden"
                      >
                        {/* Coloured top stripe — visual state indicator */}
                        <div className={`h-1 ${accentColor}`} />

                        <div className="p-4">
                          {/* Row 1: building name + badges */}
                          <div className="flex justify-between items-start mb-3">
                            <span className="font-bold text-roman-dark text-base">
                              {t(`buildings.${building.building_type}`)}
                            </span>
                            <div className="flex gap-1.5 items-center flex-wrap justify-end">
                              <span className="text-xs px-2 py-0.5 rounded-full bg-roman-marble border border-roman-gold/40 text-roman-dark font-bold">
                                {t('buildings.level', { level: building.level })}
                              </span>
                              <span
                                className={[
                                  'text-xs px-2 py-0.5 rounded-full border',
                                  isPassive
                                    ? 'bg-indigo-100 text-indigo-800 border-indigo-300'
                                    : isProducing
                                      ? 'bg-yellow-100 text-yellow-800 border-yellow-400'
                                      : 'bg-green-100 text-green-800 border-green-400',
                                ].join(' ')}
                              >
                                {isPassive
                                  ? t('buildings.passive')
                                  : isProducing
                                    ? t('buildings.statusProducing')
                                    : t('buildings.statusIdle')}
                              </span>
                            </div>
                          </div>

                          {/* Row 2: info (left) + action buttons (right) */}
                          <div className="flex justify-between items-start gap-3">

                            {/* Left: status / production info */}
                            <div className="text-sm text-gray-500 flex-1">
                              {isPassive ? (
                                <div>
                                  {t('buildings.storageBonus')}:{' '}
                                  <strong className="text-roman-dark">
                                    +{building.level * 500} {t('buildings.storageUnits')}
                                  </strong>
                                </div>
                              ) : isProducing && building.job ? (
                                <>
                                  {isReady
                                    ? <span className="text-green-700 font-bold">✓ {t('buildings.readyToCollect')}</span>
                                    : t('buildings.secondsLeft', { seconds: remaining })}
                                  {building.job.quality > 0 && (
                                    <span className="ml-1.5 text-xs text-roman-gold">
                                      Q{building.job.quality}
                                    </span>
                                  )}
                                </>
                              ) : (
                                <>
                                  <div className="flex items-center gap-1 flex-wrap">
                                    {t('buildings.produces')}:{' '}
                                    <strong className="text-roman-dark flex items-center gap-1">
                                      <ResourceIcon resourceId={BUILDING_RESOURCE_MAP[building.building_type] ?? ''} />
                                      {t(`dashboard.resources.${BUILDING_RESOURCE_MAP[building.building_type] ?? ''}`)}
                                    </strong>
                                    {prodDisplay && (
                                      <span className="text-gray-400">
                                        ({t('buildings.yield')}: {prodDisplay.yield})
                                      </span>
                                    )}
                                  </div>
                                  {prodDisplay && (
                                    <div className="mt-0.5 text-gray-400 flex items-center gap-1 flex-wrap">
                                      {t('buildings.cost')}: {prodDisplay.wages}{' '}
                                      <ResourceIcon resourceId="SESTERTIUS" />
                                      {t('buildings.sestLabel')}
                                      {prodDisplay.inputs.map((inp) => (
                                        <span key={inp.resource} className="flex items-center gap-1">
                                          {','}&nbsp;{inp.amount}{' '}
                                          <ResourceIcon resourceId={inp.resource} />
                                          {t(`dashboard.resources.${inp.resource}`)}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  {canSelectQuality && selectedQuality > 0 && (
                                    <div className="mt-0.5 text-purple-700 text-xs">
                                      + {researchCost} {t('dashboard.resources.RESEARCH')}
                                      {' '}({t('buildings.qualityCost')})
                                    </div>
                                  )}
                                </>
                              )}
                            </div>

                            {/* Right: buttons */}
                            <div className="flex flex-col items-end gap-1.5 shrink-0">

                              {/* Quality dropdown — idle, non-passive, non-RESEARCH buildings only */}
                              {!isPassive && !isProducing && canSelectQuality && (
                                <div className="flex items-center gap-1">
                                  <label className="text-xs text-gray-400">
                                    {t('buildings.qualityLabel')}:
                                  </label>
                                  <select
                                    value={selectedQuality}
                                    onChange={(e) => setQualitySelections((prev) => ({
                                      ...prev,
                                      [building.id]: parseInt(e.target.value, 10),
                                    }))}
                                    className="p-0.5 border border-roman-gold/60 rounded text-xs bg-roman-marble cursor-pointer"
                                  >
                                    <option value={0}>Q0</option>
                                    <option value={1}>Q1 (-{2} R)</option>
                                    <option value={2}>Q2 (-{4} R)</option>
                                  </select>
                                </div>
                              )}

                              {/* START PRODUCTION — idle non-passive buildings */}
                              {!isPassive && !isProducing && (
                                <button
                                  onClick={() => void handleStartProduction(building.id)}
                                  disabled={isActing}
                                  className="px-3 py-1.5 bg-roman-gold text-white rounded text-xs whitespace-nowrap cursor-pointer disabled:bg-gray-300 disabled:cursor-not-allowed hover:opacity-90 transition-opacity border-none"
                                >
                                  {isActing ? t('buildings.starting') : t('buildings.startButton')}
                                </button>
                              )}

                              {/* COLLECT — producing non-passive buildings */}
                              {!isPassive && isProducing && (
                                <button
                                  onClick={() => void handleCollect(building.id)}
                                  disabled={!isReady || isActing}
                                  className={[
                                    'px-3 py-1.5 text-white rounded text-xs min-w-[80px] whitespace-nowrap transition-opacity border-none',
                                    isReady && !isActing
                                      ? 'bg-green-700 cursor-pointer hover:opacity-90'
                                      : 'bg-gray-300 cursor-not-allowed',
                                  ].join(' ')}
                                >
                                  {isActing
                                    ? t('buildings.collecting')
                                    : isReady
                                      ? t('buildings.collectButton')
                                      : `${remaining}s`}
                                </button>
                              )}

                              {/* UPGRADE — idle or passive buildings */}
                              {(isPassive || !isProducing) && (
                                <button
                                  onClick={() => void handleUpgrade(building.id)}
                                  disabled={isUpgrading || isActing}
                                  title={t('buildings.upgradeTooltip', { cost: upgradeCost, nextLevel: building.level + 1 })}
                                  className="px-2.5 py-1 bg-transparent text-roman-gold border border-roman-gold/60 rounded text-xs whitespace-nowrap cursor-pointer disabled:text-gray-400 disabled:border-gray-300 disabled:cursor-not-allowed hover:bg-roman-gold hover:text-white transition-colors duration-150"
                                >
                                  {isUpgrading
                                    ? t('buildings.upgrading')
                                    : t('buildings.upgradeButton', { cost: upgradeCost, nextLevel: building.level + 1 })}
                                </button>
                              )}

                              {bldgError && (
                                <span role="alert" className="text-xs text-roman-red max-w-[160px] text-right">
                                  {bldgError}
                                </span>
                              )}
                              {upgradeErr && (
                                <span role="alert" className="text-xs text-roman-red max-w-[160px] text-right">
                                  {upgradeErr}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* ================================================================ */}
            {/* BUILD SECTION — construct new buildings                          */}
            {/* ================================================================ */}
            {/*
             * PISTRINUM: unique — hidden once the player owns one.
             * HORREUM, ACADEMIA: repeatable — always visible.
             */}
            {(() => {
              const BUILDABLE_TYPES = ['PISTRINUM', 'HORREUM', 'ACADEMIA', 'DOGANA'] as const;
              // Hide one-of-a-kind buildings once already owned.
              const ownsPistrinum = buildings.some((b) => b.building_type === 'PISTRINUM');
              const ownsDogana    = buildings.some((b) => b.building_type === 'DOGANA');
              const visible = BUILDABLE_TYPES.filter((type) =>
                (type !== 'PISTRINUM' || !ownsPistrinum) &&
                (type !== 'DOGANA'    || !ownsDogana)
              );

              if (visible.length === 0) return null;

              return (
                <section className="mb-8">
                  <div className="flex items-center gap-3 mb-4">
                    <h3 className="text-sm font-bold text-roman-dark uppercase tracking-widest whitespace-nowrap">
                      {t('buildings.constructTitle')}
                    </h3>
                    <div className="flex-1 h-px bg-roman-gold/20" />
                  </div>

                  {/* 3-column grid — each buildable type gets its own card */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {visible.map((bldgType) => {
                      const cfg         = BUILDING_DISPLAY_CONFIG[bldgType]!;
                      const isBuilding  = buildingType === bldgType;
                      const bldgError   = buildErrors[bldgType];
                      const bldgSuccess = buildSuccesses[bldgType];

                      return (
                        <div
                          key={bldgType}
                          className="bg-roman-ivory rounded-xl shadow-sm border border-roman-gold/20 p-4 flex flex-col"
                        >
                          {/* Card header */}
                          <div className="flex justify-between items-start mb-3">
                            <span className="font-bold text-roman-dark">
                              {t(`buildings.${bldgType}`)}
                            </span>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-800 border border-blue-300 shrink-0 ml-2">
                              {t('buildings.constructable')}
                            </span>
                          </div>

                          {/* Card body: description + cost */}
                          <div className="text-sm text-gray-500 mb-4 flex-1">
                            {cfg.passive ? (
                              <div>
                                {t('buildings.storageBonus')}:{' '}
                                <strong className="text-roman-dark">+500 {t('buildings.storageUnits')}</strong>
                                {' '}{t('buildings.perLevel')}
                              </div>
                            ) : (
                              <div className="flex items-center gap-1 flex-wrap">
                                {t('buildings.produces')}:{' '}
                                <strong className="text-roman-dark flex items-center gap-1">
                                  <ResourceIcon resourceId={cfg.output} />
                                  {t(`dashboard.resources.${cfg.output}`)}
                                </strong>
                                {' '}({t('buildings.yield')}: {cfg.base_yield})
                              </div>
                            )}
                            <div className="mt-1 flex items-center gap-1 flex-wrap">
                              {t('buildings.cost')}:{' '}
                              <strong className="text-roman-dark flex items-center gap-1">
                                {cfg.build_cost}
                                <ResourceIcon resourceId="SESTERTIUS" />
                              </strong>
                              {' '}{t('buildings.sestLabel')}
                              {/* Resource costs (e.g., LIGNUM for DOGANA) */}
                              {cfg.build_cost_resources?.map((r) => (
                                <span key={r.resource} className="flex items-center gap-0.5">
                                  {' + '}
                                  <strong className="text-roman-dark flex items-center gap-1">
                                    {r.amount}
                                    <ResourceIcon resourceId={r.resource} />
                                  </strong>
                                </span>
                              ))}
                            </div>
                          </div>

                          {/* Card footer: button + feedback */}
                          <div className="flex flex-col gap-1.5">
                            <button
                              onClick={() => void handleBuild(bldgType)}
                              disabled={isBuilding}
                              className="w-full px-3 py-2 bg-roman-purple text-white rounded text-xs cursor-pointer disabled:bg-gray-300 disabled:cursor-not-allowed hover:opacity-90 transition-opacity border-none font-bold"
                            >
                              {isBuilding ? t('buildings.building') : t('buildings.buildButton')}
                            </button>
                            {bldgError && (
                              <span role="alert" className="text-xs text-roman-red">{bldgError}</span>
                            )}
                            {bldgSuccess && (
                              <span className="text-xs text-green-700">{bldgSuccess}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })()}

            {/* ================================================================ */}
            {/* INVENTORY SECTION                                                */}
            {/* ================================================================ */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <h3 className="text-sm font-bold text-roman-dark uppercase tracking-widest whitespace-nowrap">
                  {t('dashboard.inventoryTitle')}
                </h3>
                <div className="flex-1 h-px bg-roman-gold/20" />
              </div>

              {isLoadingInv && (
                <p className="text-gray-400 italic text-sm">{t('dashboard.loadingInventory')}</p>
              )}
              {inventoryError && (
                <p role="alert" className="text-roman-red text-sm">{inventoryError}</p>
              )}

              {!isLoadingInv && !inventoryError && (
                /*
                 * 5-column resource grid (2 on mobile, 3 on sm, 5 on lg).
                 * Each resource gets an icon, a large number, and a label.
                 */
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  {ALL_RESOURCES.map((resourceId) => (
                    <div
                      key={resourceId}
                      className="bg-roman-ivory rounded-xl shadow-sm border border-roman-gold/20 p-4 flex flex-col items-center gap-2 text-center"
                    >
                      <ResourceIcon resourceId={resourceId} className="w-8 h-8 object-contain" />
                      <span className="text-2xl font-bold text-roman-gold">
                        {inventory[resourceId]}
                      </span>
                      <span className="text-xs text-roman-stone uppercase tracking-wide">
                        {t(`dashboard.resources.${resourceId}`)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

          </>
        )} {/* end activeView === 'production' */}

        {/* ---- MARKET VIEW ---- */}
        {activeView === 'market' && <Market />}

        {/* ---- CONTRACTS VIEW ---- */}
        {activeView === 'contracts' && <Contracts />}

        {/* ---- BANK VIEW ---- */}
        {activeView === 'bank' && <Bank />}

        {/* ---- SENATE VIEW ---- */}
        {activeView === 'senate' && <Senate />}

      </div>
      {/* end max-w-7xl content area */}

    </div>
  );
};

export default Dashboard;
