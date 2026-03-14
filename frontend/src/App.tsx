/**
 * @file App.tsx
 * @description The root React component of the Opes application.
 *
 * ================================================================
 * ARCHITECTURE
 * ================================================================
 *
 *   App          → renders <AuthProvider> (sets up context)
 *   AppContent   → rendered inside <AuthProvider>, reads auth state,
 *                  manages the PWA install prompt, and decides whether
 *                  to show <AuthForm> or <Dashboard>.
 *
 * WHY AppContent IS SEPARATE:
 *   useAuth() must be called inside a child of <AuthProvider>, not in
 *   the same component that renders the Provider (React processes the
 *   tree top-down, so the context isn't ready yet at that level).
 *
 * ================================================================
 * PWA INSTALL PROMPT STRATEGY
 * ================================================================
 *
 * Chrome/Edge on Android (and desktop) fire `beforeinstallprompt`
 * when the app meets the installability criteria. Safari/iOS does NOT
 * fire this event — iOS users install via the share-sheet "Add to
 * Home Screen" button, which we cannot automate.
 *
 * Our strategy:
 *
 *   1. LOGIN PAGE
 *      A prominent gold call-to-action button is shown INSIDE the
 *      AuthForm card (above the input fields) so a first-time visitor
 *      on mobile sees it immediately. Prop `canInstall` controls
 *      whether AuthForm renders this button.
 *
 *   2. DASHBOARD
 *      A full-width gold banner is pinned just above the mobile bottom
 *      nav bar (bottom-14 on mobile, bottom-0 on desktop). It's
 *      impossible to miss without being a blocking modal.
 *
 *   3. DISMISS PERSISTENCE
 *      Dismissal is stored in sessionStorage so the banner doesn't
 *      reappear if the component tree remounts within the same session.
 *      Once the app is installed, the browser stops firing the event
 *      entirely, so no permanent storage is needed.
 *
 *   4. AFTER INSTALL DIALOG
 *      Whether the player accepts or dismisses the OS dialog, we clear
 *      the deferred event and hide our banner — calling .prompt() a
 *      second time on the same event would throw.
 */

import React, { useEffect, useRef, useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import AuthForm  from './components/AuthForm';
import Dashboard from './components/Dashboard';

// ================================================================
// TYPES
// ================================================================

/**
 * `beforeinstallprompt` is non-standard and absent from TypeScript's
 * DOM lib. We declare the minimal shape we actually use.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// ================================================================
// AppContent
// ================================================================

const AppContent: React.FC = () => {
  const { isAuthenticated } = useAuth();

  const [showBanner,     setShowBanner]     = useState(false);
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);

  // ---- Capture the browser's deferred install event ----
  useEffect(() => {
    // Don't re-show if the player already dismissed this session.
    if (sessionStorage.getItem('pwa-dismissed') === '1') return;

    const handler = (e: Event) => {
      // Suppress the browser's own mini-infobar so our UI is the only prompt.
      e.preventDefault();
      deferredPrompt.current = e as BeforeInstallPromptEvent;
      setShowBanner(true);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // ---- Trigger the native OS install dialog ----
  const handleInstall = async (): Promise<void> => {
    if (!deferredPrompt.current) return;
    // prompt() can only be called once per event — always clean up after.
    await deferredPrompt.current.prompt();
    deferredPrompt.current = null;
    setShowBanner(false);
  };

  // ---- Dismiss without installing ----
  const handleDismiss = (): void => {
    sessionStorage.setItem('pwa-dismissed', '1');
    setShowBanner(false);
  };

  return (
    <>
      {/* ---- Main content ---- */}
      {isAuthenticated
        ? <Dashboard />
        : (
          <AuthForm
            canInstall={showBanner}
            onInstall={() => void handleInstall()}
          />
        )
      }

      {/* ================================================================ */}
      {/* DASHBOARD INSTALL BANNER                                         */}
      {/* ================================================================ */}
      {/*
       * Shown when the player is logged in AND the browser has offered
       * an install event. Pinned above the mobile bottom nav bar.
       *
       * Layout:
       *   bottom-14   → clears the 56px mobile bottom nav (md:bottom-0 on desktop)
       *   z-40        → above content (z-0) and bottom nav (z-30), below the
       *                 install card if somehow both show at once (z-50)
       *
       * The gold background makes it unmissable without being a modal.
       */}
      {showBanner && isAuthenticated && (
        <div
          role="banner"
          className="fixed bottom-14 md:bottom-0 left-0 right-0 z-40 bg-roman-gold shadow-[0_-2px_20px_rgba(212,175,55,0.5)]"
        >
          <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center gap-3">
            <span className="text-xl shrink-0" aria-hidden="true">📲</span>

            <p className="flex-1 text-roman-dark text-sm font-bold leading-tight m-0">
              Play Opes like a native App!
              <span className="hidden sm:inline font-normal"> — Install for fullscreen play, no browser bar.</span>
            </p>

            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => void handleInstall()}
                className="px-4 py-1.5 bg-roman-dark text-roman-gold rounded-lg text-xs font-bold uppercase tracking-wider cursor-pointer hover:opacity-90 transition-opacity border-none whitespace-nowrap"
              >
                Install App
              </button>
              <button
                onClick={handleDismiss}
                aria-label="Dismiss install prompt"
                className="p-1.5 text-roman-dark/60 hover:text-roman-dark transition-colors cursor-pointer bg-transparent border-none text-lg leading-none"
              >
                ×
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

// ================================================================
// App — Root, sets up providers
// ================================================================

const App: React.FC = () => (
  <AuthProvider>
    <div className="min-h-screen font-roman bg-roman-marble text-roman-dark">
      <AppContent />
    </div>
  </AuthProvider>
);

export default App;
