/**
 * @file src/context/AuthContext.tsx
 * @description React Context for global authentication state.
 *
 * ================================================================
 * WHAT IS REACT CONTEXT?
 * ================================================================
 *
 * Normally, data in React flows "down" from parent to child via props.
 * If many components at different levels need the same data (e.g., "who is
 * logged in?"), you'd have to pass it as props through every level in between
 * — even components that don't use it. This is called "prop drilling" and
 * it makes code messy and hard to maintain.
 *
 * React Context solves this by creating a "global store" that ANY component
 * in the tree can read directly, without props being passed through intermediaries.
 *
 * HOW IT WORKS (3 steps):
 *   1. CREATE a Context object with createContext().
 *   2. PROVIDE the context value by wrapping a subtree with <AuthProvider>.
 *      All components inside can now read the context.
 *   3. CONSUME the context value with the useAuth() hook.
 *
 * ================================================================
 * WHAT THIS CONTEXT MANAGES
 * ================================================================
 *
 * The AuthContext manages the player's session state:
 *   - user: the authenticated player's id and username (or null if logged out)
 *   - isAuthenticated: a convenience boolean (true when user is not null)
 *   - login(): stores the JWT + user object, updates React state
 *   - logout(): clears the JWT + user object, resets React state
 *
 * This state is initialized from localStorage, so the player stays logged
 * in across page refreshes (until their token expires).
 */

import React, { createContext, useContext, useState } from 'react';
import {
  getToken,
  setToken,
  removeToken,
  getStoredUser,
  setStoredUser,
  removeStoredUser,
  isTokenExpired,
  type StoredUser,
} from '../api/client';

// ================================================================
// TYPES
// ================================================================

/**
 * The shape of the authenticated user object held in context.
 * Matches the 'user' field returned by the login/register API responses.
 */
export interface AuthUser {
  id:       string;
  username: string;
}

/**
 * The full set of values exposed by the AuthContext.
 * Every component that calls useAuth() receives an object of this shape.
 */
interface AuthContextValue {
  /** The currently logged-in player, or null if no session is active. */
  user:            AuthUser | null;

  /** True when a player is logged in, false otherwise. A convenience boolean. */
  isAuthenticated: boolean;

  /**
   * Call this after a successful login or registration API response.
   * Stores the token and user in localStorage and updates React state.
   *
   * @param token - The JWT string returned by the server.
   * @param user  - The user object returned by the server.
   */
  login:  (token: string, user: AuthUser) => void;

  /**
   * Call this when the player clicks "Logout" or when their token is rejected (401).
   * Clears localStorage and resets React state, which causes <App> to render
   * the login form instead of the dashboard.
   */
  logout: () => void;
}

// ================================================================
// CONTEXT CREATION
// ================================================================

/**
 * The context object itself.
 *
 * We initialize it with 'undefined' and handle the undefined case in useAuth()
 * below. This is safer than providing a fake default value, because it will
 * throw a clear error if useAuth() is accidentally called outside of <AuthProvider>.
 */
const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// ================================================================
// PROVIDER COMPONENT
// ================================================================

/**
 * AuthProvider wraps the part of the React tree that needs access to auth state.
 * In our case, it wraps the entire application in App.tsx.
 *
 * It is responsible for:
 *   1. Reading the existing session from localStorage on first render.
 *   2. Providing login() and logout() functions to child components.
 *   3. Keeping state in sync with localStorage.
 */
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {

  /**
   * Initialize user state from localStorage.
   *
   * We use a "lazy initializer" function (the callback passed to useState).
   * React calls this function ONCE on the initial render — not on every re-render.
   * This is more efficient than calling getStoredUser() outside of useState,
   * which would run on every render even though the initial value is only needed once.
   *
   * Logic:
   *   1. Check if a token exists in localStorage.
   *   2. Check if the token has expired (client-side, no network request needed).
   *   3. If valid: return the stored user (restore the session).
   *   4. If expired or missing: clear storage and return null (force re-login).
   */
  const [user, setUser] = useState<AuthUser | null>(() => {
    const token = getToken();

    if (!token || isTokenExpired(token)) {
      // Clean up any stale data from localStorage.
      removeToken();
      removeStoredUser();
      return null;
    }

    // Token is valid — restore the session from localStorage.
    const storedUser = getStoredUser();
    return storedUser;
  });

  // ---- login() ----
  /**
   * Stores the JWT and user in localStorage and updates React state.
   * After calling this, isAuthenticated becomes true and the dashboard renders.
   */
  const login = (token: string, newUser: AuthUser): void => {
    setToken(token);
    setStoredUser(newUser as StoredUser);
    setUser(newUser);
  };

  // ---- logout() ----
  /**
   * Clears the session from localStorage and React state.
   * After calling this, isAuthenticated becomes false and the login form renders.
   *
   * Note: We do NOT call a server-side logout endpoint because JWTs are stateless.
   * The token continues to be technically valid until it expires, but since the
   * frontend no longer sends it, it effectively ends the session. A fully
   * secure implementation would maintain a server-side token blocklist.
   */
  const logout = (): void => {
    removeToken();
    removeStoredUser();
    setUser(null);
  };

  // The value object is recreated on every render where user changes.
  // React memoization (useMemo) could optimize this, but is unnecessary
  // at this scale — auth state changes are rare events.
  const contextValue: AuthContextValue = {
    user,
    isAuthenticated: user !== null,
    login,
    logout,
  };

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};

// ================================================================
// CONSUMER HOOK
// ================================================================

/**
 * Custom hook to access the authentication context.
 *
 * Usage in any component inside <AuthProvider>:
 *   const { user, isAuthenticated, login, logout } = useAuth();
 *
 * WHY A CUSTOM HOOK instead of using useContext(AuthContext) directly?
 *   1. SAFETY: The custom hook enforces that it's called inside <AuthProvider>.
 *      useContext(AuthContext) would silently return undefined if called outside,
 *      leading to confusing runtime errors. This hook throws a clear message.
 *   2. CONVENIENCE: Consumers import { useAuth } instead of both
 *      { useContext, AuthContext }.
 *   3. ENCAPSULATION: If we ever change the context implementation (e.g., switch
 *      to Zustand or Redux), we only update this file — not every component.
 *
 * @throws Error if called outside of an AuthProvider.
 */
export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);

  if (context === undefined) {
    throw new Error(
      'useAuth() was called outside of <AuthProvider>. '
      + 'Wrap your component tree with <AuthProvider> in App.tsx.'
    );
  }

  return context;
};
