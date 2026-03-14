/**
 * @file src/components/Contracts.tsx
 * @description B2B Private Contracts: send, accept, and cancel direct player-to-player trades.
 *
 * ================================================================
 * HOW CONTRACTS WORK (for the junior developer)
 * ================================================================
 *
 * 1. Player A (Sender) fills out the form: pick a receiver by username,
 *    choose a resource + quality + amount, and set a price per unit.
 *    On submit → POST /contracts/send.
 *    The server IMMEDIATELY deducts the resources into escrow.
 *
 * 2. Player B (Receiver) sees the contract appear in their "Incoming" list.
 *    They click "Accept" → POST /contracts/accept.
 *    The server transfers Sestertius from B to A and delivers the resource to B.
 *
 * 3. Either player can click "Cancel" → POST /contracts/cancel.
 *    The server returns the escrowed resources to the sender.
 *
 * ================================================================
 * SERVER-AUTHORITATIVE NOTE
 * ================================================================
 *
 * The frontend never computes the total cost for settlement — it only displays
 * a preview from locally held data. The server recomputes everything on accept.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth }        from '../context/AuthContext';
import { apiRequest }     from '../api/client';

// ================================================================
// TYPES
// ================================================================

interface Contract {
  id:               string;
  sender_id:        string;
  receiver_id:      string;
  resource_id:      string;
  amount:           number;
  quality:          number;
  price_per_unit:   number;
  status:           string;
  created_at:       string;
  sender_username:  string;
  receiver_username: string;
}

interface ContractsApiResponse {
  contracts: Contract[];
}

interface InventoryRow {
  resource_id: string;
  quality:     number;
  amount:      number;
}

interface InventoryApiResponse {
  inventory: InventoryRow[];
}

// ================================================================
// CONSTANTS
// ================================================================

const CONTRACTABLE_RESOURCES = ['FARINA', 'FRUMENTUM', 'LIGNUM'] as const;
type ContractResource = (typeof CONTRACTABLE_RESOURCES)[number];

// ================================================================
// COMPONENT
// ================================================================

const Contracts: React.FC = () => {
  const { t }            = useTranslation();
  const { user, logout } = useAuth();

  // ---- CONTRACTS LIST ----
  const [contracts,        setContracts]        = useState<Contract[]>([]);
  const [isLoading,        setIsLoading]        = useState<boolean>(true);
  const [loadError,        setLoadError]        = useState<string | null>(null);

  // ---- INVENTORY (for Max button) ----
  // We only need total per resource (all quality tiers summed) for the Max hint.
  const [resourceAmounts, setResourceAmounts]  = useState<Record<string, number>>({
    LIGNUM: 0, FRUMENTUM: 0, FARINA: 0,
  });

  // ---- SEND FORM ----
  const [sendReceiver,     setSendReceiver]     = useState<string>('');
  const [sendResource,     setSendResource]     = useState<ContractResource>('LIGNUM');
  const [sendQuality,      setSendQuality]      = useState<number>(0);
  const [sendAmount,       setSendAmount]       = useState<string>('');
  const [sendPrice,        setSendPrice]        = useState<string>('');
  const [sendLoading,      setSendLoading]      = useState<boolean>(false);
  const [sendError,        setSendError]        = useState<string | null>(null);
  const [sendSuccess,      setSendSuccess]      = useState<string | null>(null);

  // ---- PER-CONTRACT ACTION STATE ----
  const [actionId,         setActionId]         = useState<string | null>(null);
  const [actionErrors,     setActionErrors]     = useState<Record<string, string>>({});

  // ================================================================
  // DATA FETCHING
  // ================================================================

  const fetchContracts = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const data = await apiRequest<ContractsApiResponse>('/contracts');
      setContracts(data.contracts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Unauthorized') || message.includes('expired')) {
        logout();
        return;
      }
      setLoadError(message);
    } finally {
      setIsLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchInventory = useCallback(async (): Promise<void> => {
    try {
      const data = await apiRequest<InventoryApiResponse>('/inventory');
      const map = data.inventory.reduce<Record<string, number>>((acc, row) => {
        acc[row.resource_id] = (acc[row.resource_id] ?? 0) + row.amount;
        return acc;
      }, {});
      setResourceAmounts({
        LIGNUM:    map['LIGNUM']    ?? 0,
        FRUMENTUM: map['FRUMENTUM'] ?? 0,
        FARINA:    map['FARINA']    ?? 0,
      });
    } catch {
      // Silently degrade — Max button just shows 0, the server validates on submit.
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void fetchContracts();
    void fetchInventory();
  }, [fetchContracts, fetchInventory]);

  // ================================================================
  // HANDLERS
  // ================================================================

  const handleSend = async (): Promise<void> => {
    setSendError(null);
    setSendSuccess(null);

    const parsedAmount = parseInt(sendAmount, 10);
    const parsedPrice  = parseInt(sendPrice,  10);

    if (!sendReceiver.trim()) {
      setSendError(t('contracts.errors.receiverRequired'));
      return;
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setSendError(t('contracts.errors.invalidAmount'));
      return;
    }
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      setSendError(t('contracts.errors.invalidPrice'));
      return;
    }

    setSendLoading(true);
    try {
      const data = await apiRequest<{ message: string }>('/contracts/send', {
        method: 'POST',
        body:   JSON.stringify({
          receiver_username: sendReceiver.trim(),
          resource_id:       sendResource,
          amount:            parsedAmount,
          quality:           sendQuality,
          price_per_unit:    parsedPrice,
        }),
      });
      setSendSuccess(data.message);
      setSendReceiver('');
      setSendAmount('');
      setSendPrice('');
      setSendQuality(0);
      await fetchContracts();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Unauthorized') || message.includes('expired')) { logout(); return; }
      setSendError(message);
    } finally {
      setSendLoading(false);
    }
  };

  const handleAccept = async (contractId: string): Promise<void> => {
    if (actionId === contractId) return;
    setActionId(contractId);
    setActionErrors((prev) => ({ ...prev, [contractId]: '' }));
    try {
      await apiRequest('/contracts/accept', {
        method: 'POST',
        body:   JSON.stringify({ contract_id: contractId }),
      });
      await fetchContracts();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Unauthorized') || message.includes('expired')) { logout(); return; }
      setActionErrors((prev) => ({ ...prev, [contractId]: message }));
    } finally {
      setActionId(null);
    }
  };

  const handleCancel = async (contractId: string): Promise<void> => {
    if (actionId === contractId) return;
    setActionId(contractId);
    setActionErrors((prev) => ({ ...prev, [contractId]: '' }));
    try {
      await apiRequest('/contracts/cancel', {
        method: 'POST',
        body:   JSON.stringify({ contract_id: contractId }),
      });
      await fetchContracts();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Unauthorized') || message.includes('expired')) { logout(); return; }
      setActionErrors((prev) => ({ ...prev, [contractId]: message }));
    } finally {
      setActionId(null);
    }
  };

  // ================================================================
  // DERIVED DATA
  // ================================================================

  const incoming = contracts.filter((c) => c.receiver_id === user?.id);
  const outgoing = contracts.filter((c) => c.sender_id   === user?.id);

  // ================================================================
  // RENDER HELPERS
  // ================================================================

  // Shared Tailwind classes for form inputs and selects.
  const inputCls  = 'px-2.5 py-1.5 border border-roman-gold/60 rounded text-sm bg-amber-50/50 text-roman-dark w-full focus:outline-none focus:ring-1 focus:ring-roman-gold';
  const selectCls = `${inputCls} cursor-pointer`;

  // Table header class helpers
  const thL = 'p-2 px-3 text-left font-bold text-xs border-b-2 border-roman-gold bg-amber-100 text-roman-dark';
  const thR = `${thL} text-right`;
  const tdL = 'py-2.5 px-3 text-sm';
  const tdR = `${tdL} text-right`;

  /** Renders a table of contracts with Accept and/or Cancel buttons. */
  const renderContractTable = (rows: Contract[], showAccept: boolean) => {
    if (rows.length === 0) {
      return (
        <p className="text-gray-400 italic text-sm">{t('contracts.noContracts')}</p>
      );
    }

    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm border border-roman-gold/30">
          <thead>
            <tr>
              <th className={thL}>{showAccept ? t('contracts.colFrom') : t('contracts.colTo')}</th>
              <th className={thL}>{t('contracts.colResource')}</th>
              <th className={thR}>{t('contracts.colAmount')}</th>
              <th className={thR}>{t('contracts.colPricePerUnit')}</th>
              <th className={thR}>{t('contracts.colTotal')}</th>
              <th className={thR}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((contract) => {
              const isActing   = actionId === contract.id;
              const actionErr  = actionErrors[contract.id];
              const totalCost  = contract.amount * contract.price_per_unit;
              const counterparty = showAccept
                ? contract.sender_username
                : contract.receiver_username;
              const qualityLabel = contract.quality > 0
                ? <span className="text-xs text-roman-gold ml-1">Q{contract.quality}</span>
                : null;

              return (
                <React.Fragment key={contract.id}>
                  <tr className="bg-white border-b border-roman-gold/20">
                    <td className={tdL}>{counterparty}</td>
                    <td className={tdL}>
                      {t(`dashboard.resources.${contract.resource_id}`)}
                      {qualityLabel}
                    </td>
                    <td className={tdR}>{contract.amount}</td>
                    <td className={tdR}>{contract.price_per_unit}</td>
                    <td className={`${tdR} font-bold text-roman-dark`}>{totalCost}</td>
                    <td className={tdR}>
                      <div className="flex gap-1.5 justify-end">
                        {showAccept && (
                          <button
                            onClick={() => void handleAccept(contract.id)}
                            disabled={isActing}
                            className="px-3 py-1 bg-roman-gold text-white border-none rounded text-xs cursor-pointer hover:opacity-90 transition-opacity disabled:bg-gray-300 disabled:cursor-not-allowed whitespace-nowrap"
                          >
                            {isActing ? '...' : t('contracts.acceptButton')}
                          </button>
                        )}
                        <button
                          onClick={() => void handleCancel(contract.id)}
                          disabled={isActing}
                          className="px-3 py-1 bg-red-600 text-white border-none rounded text-xs cursor-pointer hover:opacity-90 transition-opacity disabled:bg-gray-300 disabled:cursor-not-allowed whitespace-nowrap"
                        >
                          {isActing ? '...' : t('contracts.cancelButton')}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {actionErr && (
                    <tr className="bg-red-50">
                      <td colSpan={6} role="alert" className="py-1 px-3 text-red-600 text-xs">
                        {actionErr}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  // ================================================================
  // RENDER
  // ================================================================

  return (
    <div className="flex flex-col gap-8">

      {/* ---- SEND FORM ---- */}
      <section>
        <h3 className="text-roman-gold m-0 mb-1 text-base font-bold">
          {t('contracts.sendTitle')}
        </h3>
        <p className="text-gray-500 text-sm mb-4 mt-0">
          {t('contracts.sendSubtitle')}
        </p>

        <div className="p-4 bg-amber-50 border border-roman-gold/30 rounded-md">
          <div className="flex gap-3 flex-wrap items-end">

            {/* Receiver username */}
            <div className="flex flex-col gap-1 min-w-[150px] flex-1">
              <label className="text-xs text-gray-500">{t('contracts.receiverLabel')}</label>
              <input
                type="text"
                value={sendReceiver}
                onChange={(e) => setSendReceiver(e.target.value)}
                placeholder={t('contracts.receiverPlaceholder')}
                className={inputCls}
              />
            </div>

            {/* Resource */}
            <div className="flex flex-col gap-1 min-w-[140px]">
              <label className="text-xs text-gray-500">{t('contracts.resourceLabel')}</label>
              <select value={sendResource} onChange={(e) => setSendResource(e.target.value as ContractResource)} className={selectCls}>
                {CONTRACTABLE_RESOURCES.map((r) => (
                  <option key={r} value={r}>{t(`dashboard.resources.${r}`)}</option>
                ))}
              </select>
            </div>

            {/* Quality */}
            <div className="flex flex-col gap-1 min-w-[100px]">
              <label className="text-xs text-gray-500">{t('buildings.qualityLabel')}</label>
              <select value={sendQuality} onChange={(e) => setSendQuality(parseInt(e.target.value, 10))} className={selectCls}>
                <option value={0}>Q0</option>
                <option value={1}>Q1</option>
                <option value={2}>Q2</option>
              </select>
            </div>

            {/* Amount */}
            <div className="flex flex-col gap-1 min-w-[110px]">
              <label className="text-xs text-gray-500">
                {t('contracts.amountLabel')}
                {' '}({t('market.available')}: {resourceAmounts[sendResource]})
              </label>
              <div className="flex gap-1">
                <input type="number" min={1} value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} placeholder="e.g. 10" className={inputCls} />
                <button
                  type="button"
                  onClick={() => setSendAmount(String(resourceAmounts[sendResource]))}
                  className="px-2 py-1 text-xs bg-roman-gold/20 text-roman-dark border border-roman-gold/50 rounded hover:bg-roman-gold/40 transition-colors whitespace-nowrap"
                >
                  Max
                </button>
              </div>
            </div>

            {/* Price per unit */}
            <div className="flex flex-col gap-1 min-w-[130px]">
              <label className="text-xs text-gray-500">{t('contracts.priceLabel')}</label>
              <input type="number" min={1} value={sendPrice} onChange={(e) => setSendPrice(e.target.value)} placeholder="e.g. 5" className={inputCls} />
            </div>

            {/* Submit button */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-transparent">&nbsp;</label>
              <button
                onClick={() => void handleSend()}
                disabled={sendLoading}
                className="px-5 py-2 bg-roman-gold text-white border-none rounded text-sm font-roman cursor-pointer hover:opacity-90 transition-opacity disabled:bg-gray-300 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {sendLoading ? t('contracts.sending') : t('contracts.sendButton')}
              </button>
            </div>
          </div>

          {sendError && (
            <p role="alert" className="text-red-600 text-sm mt-3">{sendError}</p>
          )}
          {sendSuccess && (
            <p className="text-green-700 text-sm mt-3">{sendSuccess}</p>
          )}
        </div>
      </section>

      {/* ---- LOADING / ERROR ---- */}
      {isLoading && <p className="text-gray-400 italic">{t('contracts.loading')}</p>}
      {loadError && <p role="alert" className="text-red-600">{loadError}</p>}

      {/* ---- INCOMING CONTRACTS ---- */}
      {!isLoading && !loadError && (
        <section>
          <h3 className="text-roman-gold m-0 mb-3 text-base font-bold flex items-center gap-2">
            {t('contracts.incomingTitle')}
            {incoming.length > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-800 border border-yellow-400">
                {incoming.length}
              </span>
            )}
          </h3>
          {renderContractTable(incoming, true)}
        </section>
      )}

      {/* ---- OUTGOING CONTRACTS ---- */}
      {!isLoading && !loadError && (
        <section>
          <h3 className="text-roman-gold m-0 mb-3 text-base font-bold">
            {t('contracts.outgoingTitle')}
          </h3>
          {renderContractTable(outgoing, false)}
        </section>
      )}
    </div>
  );
};

export default Contracts;
