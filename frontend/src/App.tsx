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
 *      As the game grows, additional providers will be added here:
 *        <AuthProvider>
 *          <GameStateProvider>
 *            <ThemeProvider>
 *              <AppContent />
 *            </ThemeProvider>
 *          </GameStateProvider>
 *        </AuthProvider>
 *
 *   2. TOP-LEVEL ROUTING (authentication gate)
 *      If the player is authenticated (isAuthenticated === true), show Dashboard.
 *      If not, show AuthForm (Login / Register screen).
 *      This replaces a dedicated router for Phase 1. In a future phase,
 *      React Router will be introduced with proper URL-based navigation.
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

import React from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import AuthForm  from './components/AuthForm';
import Dashboard from './components/Dashboard';

// ================================================================
// AppContent — Consumes AuthContext, decides what to render
// ================================================================

/**
 * The inner shell of the application.
 * This component is always rendered inside <AuthProvider>, so useAuth() is safe.
 */
const AppContent: React.FC = () => {
  const { isAuthenticated } = useAuth();

  // Simple authentication gate:
  //   Logged in  → show the game dashboard
  //   Logged out → show the login/register form
  //
  // In a future phase, React Router will replace this with proper URL routing:
  //   <Route path="/login"     element={<AuthForm />} />
  //   <Route path="/dashboard" element={<PrivateRoute><Dashboard /></PrivateRoute>} />
  return isAuthenticated ? <Dashboard /> : <AuthForm />;
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
