/**
 * @file vite.config.ts
 * @description Vite build tool and development server configuration for Opes.
 *
 * Vite (French for "fast") is a modern build tool that provides:
 *
 *   DEVELOPMENT:
 *     - Extremely fast start-up: Vite serves files as native ES Modules.
 *       There is NO bundling step on startup — the browser imports files directly.
 *       Large projects that took 30+ seconds to start with webpack start in < 1s.
 *
 *     - Hot Module Replacement (HMR): When you save a file, only that module
 *       is updated in the browser. React state is preserved (e.g., form inputs
 *       don't reset). This makes UI iteration very fast.
 *
 *   PRODUCTION:
 *     - Uses Rollup under the hood to produce optimized, minified bundles.
 *     - Code splitting: the app bundle is split into smaller chunks that
 *       are loaded on demand, improving initial page load performance.
 *     - Asset hashing: output filenames include a content hash (e.g., App.a3f2b1.js)
 *       so browsers can cache assets indefinitely and only re-download changed ones.
 *
 * ================================================================
 * MODULE 5: PWA SETUP (VitePWA plugin)
 * ================================================================
 *
 * The VitePWA plugin does three things automatically:
 *   1. Generates a service worker (using Workbox) that caches assets
 *      so the app loads instantly even on slow connections.
 *   2. Injects a <link rel="manifest"> into index.html pointing to the
 *      generated web app manifest (opes.webmanifest).
 *   3. Injects the <meta name="theme-color"> tag.
 *
 * registerType: 'prompt'
 *   The service worker will NOT silently update. Instead, our App.tsx
 *   listens for the `beforeinstallprompt` event and shows a banner.
 *   This gives players control over when the app updates.
 *
 * ICONS: drop your PNG files into public/icons/ before running a
 * production build. The manifest references icon-192.png and icon-512.png.
 * See public/icons/README.md for size and format requirements.
 */
import { defineConfig } from 'vite';
import react           from '@vitejs/plugin-react';
import { VitePWA }     from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    /**
     * The official Vite React plugin. Configures:
     *   - JSX/TSX transformation using Babel (for compatibility and plugin ecosystem).
     *   - React Fast Refresh for HMR in development.
     *   - Automatic React import (no need for 'import React from "react"' in every file).
     */
    react(),

    /**
     * Progressive Web App plugin — generates a service worker + web manifest.
     *
     * Once built and deployed, players on mobile can tap "Add to Home Screen"
     * and launch Opes in standalone mode (no browser UI bar).
     */
    VitePWA({
      registerType: 'prompt',

      /**
       * Assets Vite-PWA should pre-cache so the app shell loads offline.
       * Icons are included so the home-screen icon is available immediately.
       */
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],

      /**
       * Web App Manifest — tells the browser how to present the app when
       * installed (name, colours, orientation, icons).
       *
       * theme_color    : #2C2A29 = roman-dark (status bar colour on Android)
       * background_color: #FDFCF7 = roman-ivory (splash screen background)
       */
      manifest: {
        name:             'Opes: Roman Empire',
        short_name:       'Opes',
        description:      'A multiplayer economic simulation set in Ancient Rome & Greece.',
        theme_color:      '#2C2A29',
        background_color: '#FDFCF7',
        display:          'standalone',
        orientation:      'portrait',
        start_url:        '/',
        icons: [
          {
            // SVG icon — scales to any size, works on Android Chrome and
            // modern desktop browsers. "any" means "use at any resolution".
            src:     '/icons/icon.svg',
            sizes:   'any',
            type:    'image/svg+xml',
          },
          {
            // PNG fallbacks — drop icon-192.png and icon-512.png into
            // public/icons/ before a production build (see README.md).
            // These are needed for full Android/Samsung browser compatibility.
            src:   '/icons/icon-192.png',
            sizes: '192x192',
            type:  'image/png',
          },
          {
            src:   '/icons/icon-512.png',
            sizes: '512x512',
            type:  'image/png',
          },
          {
            // "maskable" purpose lets Android crop the icon into a circle
            // or squircle — the artwork stays inside the central 80% safe zone.
            src:     '/icons/icon-512.png',
            sizes:   '512x512',
            type:    'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],

  server: {
    /**
     * The port for the Vite development server.
     * We use 3000 for the frontend, leaving 3001 for the Express backend.
     */
    port: 3000,

    /**
     * API PROXY — This is one of the most important settings for full-stack dev.
     *
     * PROBLEM: The frontend (http://localhost:3000) needs to talk to the backend
     * (http://localhost:3001). Browsers block this by default due to CORS —
     * they are different origins (different ports = different origin).
     *
     * SOLUTION: Proxy requests through the Vite dev server.
     * Any request from the frontend to a URL starting with '/api' is
     * transparently forwarded by Vite to http://localhost:3001.
     *
     * From the browser's perspective, the request goes to:
     *   http://localhost:3000/api/v1/players
     * Vite secretly forwards it to:
     *   http://localhost:3001/api/v1/players
     *
     * The browser only sees localhost:3000 — same origin, no CORS issue.
     *
     * WHY THIS MATTERS FOR PRODUCTION PARITY:
     * In production, you'll use nginx or a cloud load balancer to forward
     * /api/* requests to the Node.js server. The proxy here mirrors that
     * exact behavior, so frontend code written in development works in
     * production without any URL changes.
     */
    proxy: {
      '/api': {
        target:       'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
