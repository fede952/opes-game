/**
 * @file main.tsx
 * @description The JavaScript entry point of the Opes React application.
 *
 * This is the first file executed by the browser (referenced in index.html).
 * It has two responsibilities:
 *   1. Initialize the i18n (internationalization) system.
 *   2. Mount the React application into the DOM.
 *
 * ORDER OF IMPORTS IS CRITICAL HERE.
 * The i18n import MUST come before React and App imports. Here is why:
 *
 *   When React renders the <App /> component, it will encounter
 *   'useTranslation()' hooks that call i18next's 't()' function immediately.
 *   If i18next hasn't been initialized yet (no language loaded, no resources
 *   registered), those 't()' calls return the raw key strings (e.g.,
 *   "common.welcome" instead of "Welcome to Opes!").
 *
 *   This is called "Flash of Untranslated Content" (FOTUC) — the user sees
 *   raw key strings for a split second before translations load.
 *
 *   By importing the i18n module FIRST (as a side-effect import), we ensure
 *   i18next is fully configured before any component ever attempts to render.
 */

// Side-effect import: importing this module runs the i18n initialization code
// in src/i18n/index.ts as a side effect, configuring the i18next singleton.
// The './i18n' module exports nothing we use here — we only care that it runs.
import './i18n';

// Global CSS — must come after i18n but before React so Tailwind's base reset
// is applied before any component renders.  This file contains the three
// @tailwind directives that PostCSS expands into actual CSS at build time.
import './index.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// ================================================================
// FIND THE ROOT DOM ELEMENT
// ================================================================

const rootElement = document.getElementById('root');

/**
 * We validate that the root element exists before trying to mount React into it.
 *
 * Why not just use 'document.getElementById("root")!' with a non-null assertion?
 * Because if someone accidentally removes the <div id="root"> from index.html,
 * the application would fail silently or with a cryptic "Cannot read property
 * of null" error. This explicit check throws a clear, descriptive error
 * that makes the problem immediately obvious.
 */
if (!rootElement) {
  throw new Error(
    '[Opes] Fatal: Could not find a DOM element with id="root". ' +
    'Check that index.html contains <div id="root"></div>.'
  );
}

// ================================================================
// MOUNT THE REACT APPLICATION
// ================================================================

/**
 * ReactDOM.createRoot() uses React 18's "Concurrent Mode" renderer.
 * Key benefits over the legacy ReactDOM.render():
 *
 *   - Concurrent rendering: React can interrupt, pause, and resume rendering
 *     work to keep the UI responsive under heavy load.
 *   - Automatic batching: Multiple state updates in the same event handler
 *     are batched into a single re-render for better performance.
 *   - Transition API support: Allows marking some state updates as
 *     "transitions" (lower priority) to keep the UI responsive.
 *
 * These features will be increasingly useful as Opes grows more complex
 * (e.g., a live marketplace with many simultaneous price updates).
 */
ReactDOM.createRoot(rootElement).render(
  /**
   * React.StrictMode is a development-only tool that intentionally:
   *
   *   1. Invokes certain functions TWICE (render, useState initializer, etc.)
   *      to expose functions that produce different results on repeated calls
   *      (i.e., functions with unintentional side effects in the render phase).
   *
   *   2. Warns about deprecated React API usage.
   *
   *   3. Detects unexpected side effects in useEffect by running effects
   *      and their cleanup functions twice.
   *
   * This has ZERO impact on the production build — Strict Mode is automatically
   * stripped out. Enable it during development to catch bugs early.
   */
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
