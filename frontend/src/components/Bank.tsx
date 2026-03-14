/**
 * @file src/components/Bank.tsx
 * @description Financial Bonds: issue debt, invest in others' bonds, repay loans.
 *
 * ================================================================
 * HOW BONDS WORK (for the junior developer)
 * ================================================================
 *
 * 1. ISSUE: Player A needs capital. They issue a bond with a principal
 *    amount and an interest rate. The bond appears on the market.
 *    No money moves yet — it's just an offer.
 *
 * 2. BUY: Player B sees the bond and decides to invest.
 *    → POST /bonds/buy
 *    The principal transfers immediately from B to A.
 *    A now has the capital and owes B the repayment.
 *
 * 3. REPAY: Player A repays when ready.
 *    → POST /bonds/repay
 *    total = principal + FLOOR(principal × rate / 100)
 *    The total transfers from A back to B.
 *
 * ================================================================
 * SERVER-AUTHORITATIVE NOTE
 * ================================================================
 *
 * The repayment preview shown in the UI is client-side only.
 * The server recomputes the exact total on repay.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth }        from '../context/AuthContext';
import { apiRequest }     from '../api/client';

// ================================================================
// TYPES
// ================================================================

interface Bond {
  id:                       string;
  issuer_id:                string;
  buyer_id:                 string | null;
  principal_amount:         number;
  interest_rate_percentage: number;
  status:                   string;
  created_at:               string;
  issuer_username:          string;
  buyer_username:           string | null;
}

interface BondsApiResponse {
  market:         Bond[];
  my_issued:      Bond[];
  my_investments: Bond[];
}

// ================================================================
// HELPERS
// ================================================================

/** Computes total repayment for display preview. Mirrors the server formula. */
const calcRepayment = (principal: number, ratePct: number): number =>
  principal + Math.floor(principal * ratePct / 100);

/**
 * Returns Tailwind class string for the colored bond status badge.
 * Maps each status value to a background / text / border color set.
 */
const statusBadgeCls = (status: string): string => {
  const map: Record<string, string> = {
    ISSUED:    'bg-green-100 text-green-800 border-green-400',
    BOUGHT:    'bg-yellow-100 text-yellow-800 border-yellow-400',
    REPAID:    'bg-stone-200 text-roman-dark border-roman-gold/60',
    DEFAULTED: 'bg-red-100 text-red-700 border-red-400',
  };
  const colors = map[status] ?? map['ISSUED'];
  return `text-xs px-2 py-0.5 rounded-full border whitespace-nowrap ${colors}`;
};

// ================================================================
// COMPONENT
// ================================================================

const Bank: React.FC = () => {
  const { t }            = useTranslation();
  const { user, logout } = useAuth();

  // ---- DATA ----
  const [market,        setMarket]        = useState<Bond[]>([]);
  const [myIssued,      setMyIssued]      = useState<Bond[]>([]);
  const [myInvestments, setMyInvestments] = useState<Bond[]>([]);
  const [isLoading,     setIsLoading]     = useState<boolean>(true);
  const [loadError,     setLoadError]     = useState<string | null>(null);

  // ---- ISSUE FORM ----
  const [issuePrincipal, setIssuePrincipal] = useState<string>('');
  const [issueRate,      setIssueRate]      = useState<string>('');
  const [issueDays,      setIssueDays]      = useState<string>('7');
  const [issueLoading,   setIssueLoading]   = useState<boolean>(false);
  const [issueError,     setIssueError]     = useState<string | null>(null);
  const [issueSuccess,   setIssueSuccess]   = useState<string | null>(null);

  // ---- PER-BOND ACTION STATE ----
  const [actionId,     setActionId]     = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  // ================================================================
  // DATA FETCHING
  // ================================================================

  const fetchBonds = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const data = await apiRequest<BondsApiResponse>('/bonds');
      setMarket(data.market);
      setMyIssued(data.my_issued);
      setMyInvestments(data.my_investments);
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

  useEffect(() => { void fetchBonds(); }, [fetchBonds]);

  // ================================================================
  // HANDLERS
  // ================================================================

  const handleIssue = async (): Promise<void> => {
    setIssueError(null);
    setIssueSuccess(null);

    const parsedPrincipal = parseInt(issuePrincipal, 10);
    const parsedRate      = parseInt(issueRate,      10);
    const parsedDays      = parseInt(issueDays,      10);

    if (!Number.isFinite(parsedPrincipal) || parsedPrincipal <= 0) {
      setIssueError(t('bonds.errors.invalidPrincipal'));
      return;
    }
    if (!Number.isFinite(parsedRate) || parsedRate < 0) {
      setIssueError(t('bonds.errors.invalidRate'));
      return;
    }
    if (!Number.isFinite(parsedDays) || parsedDays < 1) {
      setIssueError(t('bonds.errors.invalidDays'));
      return;
    }

    setIssueLoading(true);
    try {
      const data = await apiRequest<{ message: string }>('/bonds/issue', {
        method: 'POST',
        body:   JSON.stringify({
          principal_amount:         parsedPrincipal,
          interest_rate_percentage: parsedRate,
          duration_days:            parsedDays,
        }),
      });
      setIssueSuccess(data.message);
      setIssuePrincipal('');
      setIssueRate('');
      setIssueDays('7');
      await fetchBonds();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Unauthorized') || message.includes('expired')) { logout(); return; }
      setIssueError(message);
    } finally {
      setIssueLoading(false);
    }
  };

  const handleBuy = async (bondId: string): Promise<void> => {
    if (actionId === bondId) return;
    setActionId(bondId);
    setActionErrors((prev) => ({ ...prev, [bondId]: '' }));
    try {
      await apiRequest('/bonds/buy', {
        method: 'POST',
        body:   JSON.stringify({ bond_id: bondId }),
      });
      await fetchBonds();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Unauthorized') || message.includes('expired')) { logout(); return; }
      setActionErrors((prev) => ({ ...prev, [bondId]: message }));
    } finally {
      setActionId(null);
    }
  };

  const handleRepay = async (bondId: string): Promise<void> => {
    if (actionId === bondId) return;
    setActionId(bondId);
    setActionErrors((prev) => ({ ...prev, [bondId]: '' }));
    try {
      await apiRequest('/bonds/repay', {
        method: 'POST',
        body:   JSON.stringify({ bond_id: bondId }),
      });
      await fetchBonds();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Unauthorized') || message.includes('expired')) { logout(); return; }
      setActionErrors((prev) => ({ ...prev, [bondId]: message }));
    } finally {
      setActionId(null);
    }
  };

  // ================================================================
  // RENDER
  // ================================================================

  // Shared Tailwind classes for form inputs.
  const inputCls = 'px-2.5 py-1.5 border border-roman-gold/60 rounded text-sm bg-roman-marble text-roman-dark w-full focus:outline-none focus:ring-1 focus:ring-roman-gold';

  // Table class helpers — keeps table definitions concise.
  const thL = 'p-2 px-3 text-left font-bold text-xs border-b-2 border-roman-gold bg-roman-gold/10 text-roman-dark';
  const thR = `${thL} text-right`;
  const tdL = 'py-2.5 px-3 text-sm';
  const tdR = `${tdL} text-right`;

  // ---- Bond Market Table ----
  const renderMarketTable = () => {
    if (market.length === 0) {
      return <p className="text-gray-400 italic text-sm">{t('bonds.noMarketBonds')}</p>;
    }

    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm border border-roman-gold/30">
          <thead>
            <tr>
              <th className={thL}>{t('bonds.colIssuer')}</th>
              <th className={thR}>{t('bonds.colPrincipal')}</th>
              <th className={thR}>{t('bonds.colRate')}</th>
              <th className={thR}>{t('bonds.colRepayment')}</th>
              <th className={thR}></th>
            </tr>
          </thead>
          <tbody>
            {market.map((bond) => {
              const isActing   = actionId === bond.id;
              const actionErr  = actionErrors[bond.id];
              const repayment  = calcRepayment(bond.principal_amount, bond.interest_rate_percentage);

              return (
                <React.Fragment key={bond.id}>
                  <tr className="bg-white border-b border-roman-gold/20">
                    <td className={tdL}>{bond.issuer_username}</td>
                    <td className={tdR}>{bond.principal_amount}</td>
                    <td className={tdR}>{bond.interest_rate_percentage}%</td>
                    <td className={`${tdR} font-bold text-green-700`}>{repayment}</td>
                    <td className={tdR}>
                      <button
                        onClick={() => void handleBuy(bond.id)}
                        disabled={isActing}
                        className="px-3 py-1 bg-roman-gold text-white border-none rounded text-xs cursor-pointer hover:opacity-90 transition-opacity disabled:bg-gray-300 disabled:cursor-not-allowed whitespace-nowrap"
                      >
                        {isActing ? '...' : t('bonds.buyButton')}
                      </button>
                    </td>
                  </tr>
                  {actionErr && (
                    <tr className="bg-red-50">
                      <td colSpan={5} role="alert" className="py-1 px-3 text-red-600 text-xs">{actionErr}</td>
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

  // ---- My Issued Bonds Table ----
  const renderMyIssuedTable = () => {
    if (myIssued.length === 0) {
      return <p className="text-gray-400 italic text-sm">{t('bonds.noIssuedBonds')}</p>;
    }

    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm border border-roman-gold/30">
          <thead>
            <tr>
              <th className={thL}>{t('bonds.colStatus')}</th>
              <th className={thR}>{t('bonds.colPrincipal')}</th>
              <th className={thR}>{t('bonds.colRate')}</th>
              <th className={thR}>{t('bonds.colRepayment')}</th>
              <th className={thL}>{t('bonds.colBuyer')}</th>
              <th className={thR}></th>
            </tr>
          </thead>
          <tbody>
            {myIssued.map((bond) => {
              const isActing  = actionId === bond.id;
              const actionErr = actionErrors[bond.id];
              const repayment = calcRepayment(bond.principal_amount, bond.interest_rate_percentage);

              return (
                <React.Fragment key={bond.id}>
                  <tr className="bg-white border-b border-roman-gold/20">
                    <td className={tdL}>
                      <span className={statusBadgeCls(bond.status)}>{bond.status}</span>
                    </td>
                    <td className={tdR}>{bond.principal_amount}</td>
                    <td className={tdR}>{bond.interest_rate_percentage}%</td>
                    <td className={`${tdR} font-bold text-red-600`}>{repayment}</td>
                    <td className={tdL}>{bond.buyer_username ?? '—'}</td>
                    <td className={tdR}>
                      {bond.status === 'BOUGHT' && (
                        <button
                          onClick={() => void handleRepay(bond.id)}
                          disabled={isActing}
                          className="px-3 py-1 bg-roman-gold text-white border-none rounded text-xs cursor-pointer hover:opacity-90 transition-opacity disabled:bg-gray-300 disabled:cursor-not-allowed whitespace-nowrap"
                        >
                          {isActing ? '...' : t('bonds.repayButton')}
                        </button>
                      )}
                    </td>
                  </tr>
                  {actionErr && (
                    <tr className="bg-red-50">
                      <td colSpan={6} role="alert" className="py-1 px-3 text-red-600 text-xs">{actionErr}</td>
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

  // ---- My Investments Table ----
  const renderMyInvestmentsTable = () => {
    if (myInvestments.length === 0) {
      return <p className="text-gray-400 italic text-sm">{t('bonds.noInvestments')}</p>;
    }

    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm border border-roman-gold/30">
          <thead>
            <tr>
              <th className={thL}>{t('bonds.colIssuer')}</th>
              <th className={thL}>{t('bonds.colStatus')}</th>
              <th className={thR}>{t('bonds.colPrincipal')}</th>
              <th className={thR}>{t('bonds.colRate')}</th>
              <th className={thR}>{t('bonds.colRepayment')}</th>
            </tr>
          </thead>
          <tbody>
            {myInvestments.map((bond) => {
              const repayment = calcRepayment(bond.principal_amount, bond.interest_rate_percentage);
              return (
                <tr key={bond.id} className="bg-white border-b border-roman-gold/20">
                  <td className={tdL}>{bond.issuer_username}</td>
                  <td className={tdL}>
                    <span className={statusBadgeCls(bond.status)}>{bond.status}</span>
                  </td>
                  <td className={tdR}>{bond.principal_amount}</td>
                  <td className={tdR}>{bond.interest_rate_percentage}%</td>
                  <td className={`${tdR} font-bold text-green-700`}>{repayment}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  // Suppress unused variable: user is available via useAuth for future use
  void user;

  return (
    <div className="flex flex-col gap-8">

      {/* ---- ISSUE BOND FORM ---- */}
      <section>
        <div className="flex items-center gap-3 mb-1">
          <h3 className="text-sm font-bold text-roman-dark uppercase tracking-widest whitespace-nowrap m-0">
            {t('bonds.issueTitle')}
          </h3>
          <div className="flex-1 h-px bg-roman-gold/20" />
        </div>
        <p className="text-gray-500 text-sm mb-4">{t('bonds.issueSubtitle')}</p>

        <div className="p-4 bg-roman-ivory rounded-xl shadow-sm border border-roman-gold/20">
          <div className="flex gap-3 flex-wrap items-end">

            {/* Principal */}
            <div className="flex flex-col gap-1 min-w-[150px]">
              <label className="text-xs text-gray-500">{t('bonds.principalLabel')}</label>
              <input
                type="number" min={1}
                value={issuePrincipal}
                onChange={(e) => setIssuePrincipal(e.target.value)}
                placeholder="e.g. 200"
                className={inputCls}
              />
            </div>

            {/* Interest rate */}
            <div className="flex flex-col gap-1 min-w-[140px]">
              <label className="text-xs text-gray-500">{t('bonds.rateLabel')}</label>
              <input
                type="number" min={0}
                value={issueRate}
                onChange={(e) => setIssueRate(e.target.value)}
                placeholder="e.g. 10"
                className={inputCls}
              />
            </div>

            {/* Duration */}
            <div className="flex flex-col gap-1 min-w-[130px]">
              <label className="text-xs text-gray-500">{t('bonds.daysLabel')}</label>
              <input
                type="number" min={1}
                value={issueDays}
                onChange={(e) => setIssueDays(e.target.value)}
                placeholder="e.g. 7"
                className={inputCls}
              />
            </div>

            {/* Repayment preview */}
            {issuePrincipal && issueRate &&
              parseInt(issuePrincipal, 10) > 0 &&
              parseInt(issueRate, 10) >= 0 && (
              <div className="text-sm text-green-700 self-center pb-0.5">
                {t('bonds.repayPreview')}:{' '}
                <strong>
                  {calcRepayment(parseInt(issuePrincipal, 10), parseInt(issueRate, 10))}
                </strong>{' '}
                {t('dashboard.resources.SESTERTIUS')}
              </div>
            )}

            {/* Submit */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-transparent">&nbsp;</label>
              <button
                onClick={() => void handleIssue()}
                disabled={issueLoading}
                className="px-5 py-2 bg-roman-gold text-white border-none rounded text-sm font-roman cursor-pointer hover:opacity-90 transition-opacity disabled:bg-gray-300 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {issueLoading ? t('bonds.issuing') : t('bonds.issueButton')}
              </button>
            </div>
          </div>

          {issueError && (
            <p role="alert" className="text-red-600 text-sm mt-3">{issueError}</p>
          )}
          {issueSuccess && (
            <p className="text-green-700 text-sm mt-3">{issueSuccess}</p>
          )}
        </div>
      </section>

      {isLoading && <p className="text-gray-400 italic">{t('bonds.loading')}</p>}
      {loadError && <p role="alert" className="text-red-600">{loadError}</p>}

      {!isLoading && !loadError && (
        <>
          {/* ---- BOND MARKET ---- */}
          <section>
            <h3 className="text-sm font-bold text-roman-dark uppercase tracking-widest mb-3">{t('bonds.marketTitle')}</h3>
            {renderMarketTable()}
          </section>

          {/* ---- MY ISSUED BONDS ---- */}
          <section>
            <h3 className="text-sm font-bold text-roman-dark uppercase tracking-widest mb-3">{t('bonds.myIssuedTitle')}</h3>
            {renderMyIssuedTable()}
          </section>

          {/* ---- MY INVESTMENTS ---- */}
          <section>
            <h3 className="text-sm font-bold text-roman-dark uppercase tracking-widest mb-3">{t('bonds.myInvestmentsTitle')}</h3>
            {renderMyInvestmentsTable()}
          </section>
        </>
      )}
    </div>
  );
};

export default Bank;
