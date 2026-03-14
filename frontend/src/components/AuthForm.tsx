/**
 * @file src/components/AuthForm.tsx
 * @description Login and Registration form component.
 *
 * This single component handles BOTH login and register flows by toggling
 * between two "modes". The UI is nearly identical for both, so this avoids
 * duplicating code in two separate components.
 *
 * STATE MACHINE:
 *   mode: 'login'    → Shows login form, "Login" button, link to switch to register
 *   mode: 'register' → Shows register form, "Register" button, link to switch to login
 *
 * ON SUCCESS:
 *   Calls context.login(token, user), which updates the global AuthContext.
 *   App.tsx observes isAuthenticated === true and renders <Dashboard /> instead.
 *
 * ON FAILURE:
 *   Shows the error message returned by the server directly in the form.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { apiRequest } from '../api/client';
import type { AuthUser } from '../context/AuthContext';

// ================================================================
// API RESPONSE TYPES
// ================================================================

/**
 * Shape of the response from both /auth/login and /auth/register.
 * The server returns the same structure for both endpoints.
 */
interface AuthApiResponse {
  message: string;
  token:   string;
  user:    AuthUser;
}

// ================================================================
// COMPONENT
// ================================================================

interface AuthFormProps {
  /**
   * True when the browser has offered a PWA install event.
   * When set, a prominent install button is shown above the login form
   * so first-time mobile visitors see it immediately.
   * Only fires on Chrome/Edge on Android and desktop — not iOS Safari.
   */
  canInstall?: boolean;
  /** Call this to trigger the native OS install dialog. */
  onInstall?:  () => void;
}

const AuthForm: React.FC<AuthFormProps> = ({ canInstall, onInstall }) => {
  const { t }    = useTranslation();
  const { login } = useAuth();

  // ---- LOCAL STATE ----

  /** Toggles between 'login' and 'register' modes. */
  const [mode, setMode] = useState<'login' | 'register'>('login');

  /** Controlled input values. */
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');

  /** Error message to display to the player (from server or client-side validation). */
  const [error, setError] = useState<string>('');

  /**
   * True while the API request is in-flight.
   * Used to disable the submit button and show a loading state,
   * preventing the player from submitting multiple simultaneous requests.
   */
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // ---- EVENT HANDLERS ----

  /**
   * Switches the form between login and register mode.
   * Also clears the error message so stale errors don't persist after switching.
   */
  const handleToggleMode = (): void => {
    setMode((prev) => (prev === 'login' ? 'register' : 'login'));
    setError('');
  };

  /**
   * Handles the form submission for both login and register.
   *
   * e.preventDefault() is critical — without it, the browser would perform
   * a full page reload on submit (the default HTML form behavior), which would
   * wipe the React app's state.
   */
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      // Both endpoints share the same request shape and response shape.
      const endpoint = mode === 'login' ? '/auth/login' : '/auth/register';

      const data = await apiRequest<AuthApiResponse>(endpoint, {
        method: 'POST',
        // JSON.stringify serializes the object to a JSON string for the request body.
        body: JSON.stringify({ username: username.trim(), password }),
      });

      // On success: store the token and user in context + localStorage.
      // This triggers a re-render of App.tsx, which will switch to <Dashboard />.
      login(data.token, data.user);

    } catch (err) {
      // apiRequest throws an Error with the server's message on non-2xx responses.
      // We display it directly to the player.
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      // Always re-enable the form, whether the request succeeded or failed.
      setIsLoading(false);
    }
  };

  // ================================================================
  // RENDER
  // ================================================================

  return (
    /*
     * Full-viewport wrapper with the hero background image.
     *
     * Layer order (back → front):
     *   1. bg-login.jpg  — the atmospheric background photo (bg-cover bg-center)
     *   2. bg-black/60   — semi-transparent dark overlay for readability
     *   3. Form card     — the actual content (relative z-10)
     *
     * Both image and overlay layers are `absolute inset-0` children of this
     * `relative` container so the stacking context is isolated here and
     * doesn't leak to sibling components.
     */
    <div className="relative min-h-screen flex flex-col items-center justify-center p-8 font-roman">

      {/* Layer 1 — background image */}
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: "url('/assets/bg-login.jpg')" }}
        aria-hidden="true"
      />

      {/* Layer 2 — dark scrim so white form text is always legible */}
      <div className="absolute inset-0 bg-black/60" aria-hidden="true" />

      {/* Layer 3 — form card (sits above the two background layers) */}
      <div className="relative z-10 w-full max-w-sm bg-roman-marble/90 backdrop-blur-sm rounded-xl shadow-2xl px-8 py-10 flex flex-col items-center gap-6">

        {/* Game title above the form */}
        <div className="text-center">
          <h1 className="text-3xl font-bold text-roman-gold tracking-wide m-0">
            {t('common.gameTitle')}
          </h1>
          <p className="text-roman-dark/70 text-sm mt-1 mb-0">
            {t('common.subtitle')}
          </p>
        </div>

        {/* ---- PWA install call-to-action ---- */}
        {/*
         * Only rendered when Chrome/Edge has offered the `beforeinstallprompt`
         * event (i.e., the app is installable but not yet installed).
         * Positioned between the game subtitle and the login form so it's the
         * first interactive element a mobile visitor sees after the branding.
         *
         * The ring-offset + shadow give it a "coin" feel consistent with the
         * Roman theme. `animate-pulse` subtly draws the eye without being
         * as jarring as a full animation.
         */}
        {canInstall && onInstall && (
          <button
            type="button"
            onClick={onInstall}
            className={[
              'w-full py-3 px-4 rounded-xl border-2 border-roman-gold',
              'bg-roman-gold/10 text-roman-dark',
              'flex items-center justify-center gap-2.5',
              'cursor-pointer transition-all duration-200',
              'hover:bg-roman-gold hover:text-white',
              'shadow-[0_0_16px_rgba(212,175,55,0.4)]',
              'animate-pulse hover:animate-none',
            ].join(' ')}
          >
            <span className="text-xl" aria-hidden="true">📲</span>
            <span className="font-bold text-sm leading-tight text-left">
              Play Opes like a native App!
              <span className="block font-normal text-xs opacity-70 mt-0.5">
                Tap here to install — no App Store needed.
              </span>
            </span>
          </button>
        )}

        {/* Form title changes based on mode */}
        <h2 className="text-roman-purple text-xl font-bold m-0">
          {mode === 'login' ? t('auth.loginTitle') : t('auth.registerTitle')}
        </h2>

        {/*
          We use a <form> element (not a <div>) for proper semantics and
          accessibility — screen readers announce it as a form, and pressing
          Enter in an input field submits it naturally.
        */}
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 w-full"
        >
          {/* Username field */}
          <div className="flex flex-col gap-1">
            <label htmlFor="auth-username" className="text-sm text-roman-dark/80 font-bold">
              {t('auth.username')}
            </label>
            <input
              id="auth-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete={mode === 'register' ? 'username' : 'username'}
              required
              minLength={3}
              maxLength={50}
              disabled={isLoading}
              className="px-3 py-2 rounded border border-roman-gold/40 bg-white/80 text-roman-dark text-base focus:outline-none focus:ring-2 focus:ring-roman-gold disabled:bg-gray-100 disabled:cursor-not-allowed"
            />
          </div>

          {/* Password field */}
          <div className="flex flex-col gap-1">
            <label htmlFor="auth-password" className="text-sm text-roman-dark/80 font-bold">
              {t('auth.password')}
            </label>
            <input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required
              minLength={8}
              disabled={isLoading}
              className="px-3 py-2 rounded border border-roman-gold/40 bg-white/80 text-roman-dark text-base focus:outline-none focus:ring-2 focus:ring-roman-gold disabled:bg-gray-100 disabled:cursor-not-allowed"
            />
          </div>

          {/*
            Error message area.
            role="alert" causes screen readers to announce the error immediately
            when it appears — an important accessibility requirement.
            We render the container unconditionally (min-h) to prevent the
            form from "jumping" when an error appears.
          */}
          <p
            role="alert"
            className="text-red-600 text-sm min-h-[1.25rem] m-0"
          >
            {error}
          </p>

          {/* Submit button — disabled while loading to prevent duplicate submissions */}
          <button
            type="submit"
            disabled={isLoading}
            className="py-2.5 bg-roman-gold text-white rounded font-roman text-base cursor-pointer hover:opacity-90 transition-opacity disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {isLoading
              ? t('auth.submitting')
              : mode === 'login'
                ? t('auth.loginButton')
                : t('auth.registerButton')
            }
          </button>
        </form>

        {/* Mode toggle link */}
        <button
          onClick={handleToggleMode}
          disabled={isLoading}
          className="bg-transparent border-none text-roman-purple text-sm cursor-pointer underline hover:text-roman-gold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mode === 'login' ? t('auth.switchToRegister') : t('auth.switchToLogin')}
        </button>
      </div>
    </div>
  );
};

export default AuthForm;
