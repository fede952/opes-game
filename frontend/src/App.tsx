/**
 * @file App.tsx
 * @description The root React component of the Opes application.
 *
 * ================================================================
 * ARCHITECTURE: Provider Pattern + Conditional Rendering
 * ================================================================
 *
 * This file is responsible for two things:
 *
 *   1. PROVIDING GLOBAL CONTEXT
 *      <AuthProvider> wraps the entire app so every component in the tree
 *      can access authentication state via the useAuth() hook.
 *
 *   2. TOP-LEVEL ROUTING (authentication gate)
 *      If the player is authenticated (isAuthenticated === true), show Dashboard.
 *      If not, show AuthForm (Login / Register screen).
 *
 * ================================================================
 * MODULE 5: PWA INSTALL PROMPT (Task 3)
 * ================================================================
 *
 * Browsers fire a `beforeinstallprompt` event when the app meets the PWA
 * installability criteria (HTTPS, service worker, valid manifest).
 *
 * We intercept this event to:
 *   1. Prevent the browser's default mini-infobar (which is hard to style).
 *   2. Show our own Roman-themed install banner at the bottom of the screen.
 *   3. When the player clicks "Install", call deferredPrompt.prompt() to
 *      trigger the native install dialog.
 *   4. When the player clicks "Dismiss", hide the banner for the session.
 *      (We do NOT persist the dismissal to localStorage — the browser will
 *      stop firing the event once the app is installed, so the banner
 *      disappears naturally after installation.)
 *
 * WHY useRef INSTEAD OF useState FOR deferredPrompt?
 *   The event object is large and mutable. Storing it in useState would
 *   trigger a re-render every time it changes, and React would try to
 *   diff an event object (which it can't meaningfully do). useRef stores
 *   the value without causing re-renders.
 *
 * ================================================================
 * WHY AppContent IS A SEPARATE COMPONENT
 * ================================================================
 *
 * The useAuth() hook READS from AuthContext. It must be called INSIDE a
 * component that is a CHILD of <AuthProvider>. You cannot call useContext
 * in the same component that renders the Provider — React processes the
 * tree top-down, so the Provider hasn't finished mounting when the same
 * component tries to read from it.
 *
 * Solution: Split into two components:
 *   App         → renders <AuthProvider> (sets up the context)
 *   AppContent  → rendered INSIDE <AuthProvider>, calls useAuth() safely
 */

import React, { useEffect, useRef, useState } from 'react';
import { AuthProvider } from './context/AuthContext';
import AuthForm  from './components/AuthForm';
import Dashboard from './components/Dashboard';
import { useAuth } from './context/AuthContext';

// ================================================================
// TYPES
// ================================================================

/**
 * The `beforeinstallprompt` event is a non-standard browser event.
 * TypeScript's DOM lib doesn't include it, so we define the shape here.
 * See: https://developer.mozilla.org/en-US/docs/Web/API/BeforeInstallPromptEvent
 */
interface BeforeInstallPromptEvent extends Event {
  /** Shows the install dialog. Returns a promise resolving to { outcome: 'accepted' | 'dismissed' } */
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// ================================================================
// AppContent — Consumes AuthContext, decides what to render
// ================================================================

/**
 * The inner shell of the application.
 * This component is always rendered inside <AuthProvider>, so useAuth() is safe.
 *
 * Also manages the PWA install banner — placed here (rather than inside
 * Dashboard) so the banner is visible on both the AuthForm and the Dashboard.
 */
const AppContent: React.FC = () => {
  const { isAuthenticated } = useAuth();

  // ---- PWA INSTALL PROMPT STATE ----

  /**
   * Whether the install banner is currently visible.
   * Set to true when `beforeinstallprompt` fires; false when dismissed or installed.
   */
  const [showInstallBanner, setShowInstallBanner] = useState(false);

  /**
   * Stores the deferred browser install event so we can call .prompt() later.
   * useRef is used (not useState) because we don't need a re-render when the
   * event is captured — only the banner visibility state triggers a render.
   */
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      // Prevent the browser's built-in mini-infobar so ours shows instead.
      e.preventDefault();
      deferredPrompt.current = e as BeforeInstallPromptEvent;
      setShowInstallBanner(true);
    };

    window.addEventListener('beforeinstallprompt', handler);

    // Clean up on unmount (though AppContent never unmounts in practice).
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async (): Promise<void> => {
    if (!deferredPrompt.current) return;
    const result = await deferredPrompt.current.prompt();
    // Whether accepted or dismissed by the OS dialog, clear our state.
    // The browser will not fire `beforeinstallprompt` again after this.
    deferredPrompt.current = null;
    if (result.outcome === 'accepted') {
      setShowInstallBanner(false);
    }
  };

  const handleDismiss = (): void => {
    setShowInstallBanner(false);
    // We intentionally do NOT clear deferredPrompt — the player could change
    // their mind and we have no other way to re-trigger the install dialog.
  };

  return (
    <>
      {/* ---- Main app content ---- */}
      {isAuthenticated ? <Dashboard /> : <AuthForm />}

      {/* ================================================================ */}
      {/* PWA INSTALL BANNER (Module 5, Task 3)                           */}
      {/* ================================================================ */}
      {/*
       * Only shown when:
       *   - The browser fired `beforeinstallprompt` (Chrome/Edge on Android
       *     and desktop; NOT shown on iOS Safari, which has its own mechanism).
       *   - The player has not dismissed it this session.
       *   - The app is not already installed (once installed, the browser
       *     stops firing the event).
       *
       * Positioned as a fixed bottom-right card so it doesn't block content.
       * On mobile, it sits just above the bottom navigation bar (mb-16).
       */}
      {showInstallBanner && (
        <div
          role="banner"
          className="fixed bottom-4 right-4 z-50 max-w-xs w-[calc(100vw-2rem)] bg-roman-dark text-roman-marble rounded-xl shadow-2xl border border-roman-gold/40 p-4 flex flex-col gap-3 md:bottom-6 md:right-6"
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xl" aria-hidden="true">🏛</span>
              <span className="font-bold text-sm text-roman-gold uppercase tracking-wider">
                Install Opes
              </span>
            </div>
            <button
              onClick={handleDismiss}
              aria-label="Dismiss install prompt"
              className="text-roman-marble/40 hover:text-roman-marble/80 transition-colors text-lg leading-none cursor-pointer bg-transparent border-none p-0"
            >
              ×
            </button>
          </div>

          {/* Body */}
          <p className="text-xs text-roman-marble/70 leading-relaxed">
            For the best experience, install Opes as an App on your device.
            Play in fullscreen — no browser bar.
          </p>

          {/* Actions */}
          <div className="flex gap-2">
            <button
              onClick={() => void handleInstall()}
              className="flex-1 px-3 py-2 bg-roman-gold text-roman-dark rounded-lg text-xs font-bold uppercase tracking-wider cursor-pointer hover:opacity-90 transition-opacity border-none"
            >
              Install App
            </button>
            <button
              onClick={handleDismiss}
              className="px-3 py-2 text-roman-marble/50 text-xs rounded-lg cursor-pointer hover:text-roman-marble transition-colors bg-transparent border border-roman-marble/20"
            >
              Not now
            </button>
          </div>
        </div>
      )}
    </>
  );
};

// ================================================================
// App — Root component, sets up providers and global shell
// ================================================================

const App: React.FC = () => (
  /**
   * <AuthProvider> must wrap everything that needs authentication state.
   * It initializes from localStorage on first render, so returning players
   * are recognized immediately without a round-trip to the server.
   */
  <AuthProvider>
    {/*
      min-h-screen  — fills the full viewport height so the marble
                       background never leaves a gap at the bottom.
      font-roman    — Georgia serif defined in tailwind.config.js.
      bg-roman-marble / text-roman-dark — our custom theme colours.
    */}
    <div className="min-h-screen font-roman bg-roman-marble text-roman-dark">
      <AppContent />
    </div>
  </AuthProvider>
);

export default App;
