/**
 * @file src/components/Senate.tsx
 * @description The Senate Leaderboard: top 50 players ranked by net worth.
 *
 * ================================================================
 * NET WORTH BREAKDOWN (for the junior developer)
 * ================================================================
 *
 * Each player's net worth is computed server-side as:
 *
 *   Sestertius balance
 * + Physical inventory value  (amount × NPC price × quality multiplier)
 * + Building portfolio value  (upgrade_base_cost × level per building)
 *
 * The breakdown columns show where each player's wealth comes from.
 * This data is read-only — no actions are taken on this screen.
 *
 * The current player's row is highlighted in gold.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth }        from '../context/AuthContext';
import { apiRequest }     from '../api/client';

// ================================================================
// TYPES
// ================================================================

interface LeaderboardEntry {
  rank:            number;
  user_id:         string;
  username:        string;
  sestertius:      number;
  inventory_value: number;
  building_value:  number;
  net_worth:       number;
}

interface LeaderboardApiResponse {
  leaderboard: LeaderboardEntry[];
}

// ================================================================
// COMPONENT
// ================================================================

const Senate: React.FC = () => {
  const { t }   = useTranslation();
  const { user } = useAuth();

  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [isLoading,   setIsLoading]   = useState<boolean>(true);
  const [loadError,   setLoadError]   = useState<string | null>(null);

  const fetchLeaderboard = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const data = await apiRequest<LeaderboardApiResponse>('/leaderboard');
      setLeaderboard(data.leaderboard);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLoadError(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void fetchLeaderboard(); }, [fetchLeaderboard]);

  // ================================================================
  // RENDER
  // ================================================================

  // Table class helpers
  const thR = 'p-2 px-3 text-right font-bold text-xs border-b-2 border-roman-gold bg-roman-gold/10 text-roman-dark uppercase tracking-wider';
  const thL = 'p-2 px-3 text-left font-bold text-xs border-b-2 border-roman-gold bg-roman-gold/10 text-roman-dark uppercase tracking-wider';
  const tdR = 'py-2.5 px-3 text-sm text-right text-roman-stone';
  const tdL = 'py-2.5 px-3 text-sm';

  return (
    <div className="flex flex-col gap-6">

      {/* ---- HEADER ---- */}
      <div className="flex justify-between items-center">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h3 className="text-sm font-bold text-roman-dark uppercase tracking-widest m-0">
              {t('senate.title')}
            </h3>
            <div className="w-24 h-px bg-roman-gold/20" />
          </div>
          <p className="text-roman-stone text-sm m-0">{t('senate.subtitle')}</p>
        </div>
        <button
          onClick={() => void fetchLeaderboard()}
          disabled={isLoading}
          className="px-3.5 py-1.5 bg-transparent border border-roman-gold text-roman-gold rounded text-xs cursor-pointer hover:bg-roman-gold hover:text-roman-dark transition-colors duration-150 disabled:bg-gray-200 disabled:text-gray-400 disabled:border-gray-300 disabled:cursor-not-allowed font-roman"
        >
          {isLoading ? t('senate.refreshing') : t('senate.refreshButton')}
        </button>
      </div>

      {/* ---- LOADING / ERROR ---- */}
      {isLoading && (
        <p className="text-gray-400 italic">{t('senate.loading')}</p>
      )}
      {loadError && (
        <p role="alert" className="text-red-600">{loadError}</p>
      )}

      {/* ---- LEADERBOARD TABLE ---- */}
      {!isLoading && !loadError && leaderboard.length === 0 && (
        <p className="text-gray-400 italic">{t('senate.empty')}</p>
      )}

      {!isLoading && !loadError && leaderboard.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm border border-roman-gold/30">
            <thead>
              <tr>
                <th className={`${thR} w-12`}>{t('senate.colRank')}</th>
                <th className={thL}>{t('senate.colPlayer')}</th>
                <th className={thR}>{t('senate.colSestertius')}</th>
                <th className={thR}>{t('senate.colInventory')}</th>
                <th className={thR}>{t('senate.colBuildings')}</th>
                <th className={thR}>{t('senate.colNetWorth')}</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((entry) => {
                // Highlight the current player's own row.
                const isMe = entry.user_id === user?.id;

                return (
                  <tr
                    key={entry.user_id}
                    className={`border-b border-roman-gold/20 ${isMe ? 'bg-yellow-50 font-bold' : 'bg-white font-normal'}`}
                  >
                    {/* Rank — top 3 get medal decoration */}
                    <td className={`${tdR} text-gray-400`}>
                      {entry.rank === 1 ? '🥇' : entry.rank === 2 ? '🥈' : entry.rank === 3 ? '🥉' : entry.rank}
                    </td>

                    {/* Username — "(you)" tag for the current player */}
                    <td className={tdL}>
                      {entry.username}
                      {isMe && (
                        <span className="text-xs text-roman-gold ml-1.5">
                          ({t('senate.you')})
                        </span>
                      )}
                    </td>

                    {/* Sestertius balance */}
                    <td className={tdR}>{entry.sestertius.toLocaleString()}</td>

                    {/* Inventory value (NPC price × quality) */}
                    <td className={tdR}>{entry.inventory_value.toLocaleString()}</td>

                    {/* Building portfolio value */}
                    <td className={tdR}>{entry.building_value.toLocaleString()}</td>

                    {/* Total net worth — highlighted */}
                    <td className="py-2.5 px-3 text-right font-bold text-roman-gold text-base">
                      {entry.net_worth.toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- FORMULA LEGEND ---- */}
      <div className="p-3 px-4 bg-roman-ivory rounded-xl border border-roman-gold/20 text-xs text-roman-stone shadow-sm">
        {t('senate.formulaNote')}
      </div>
    </div>
  );
};

export default Senate;
