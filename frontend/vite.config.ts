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
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    /**
     * The official Vite React plugin. Configures:
     *   - JSX/TSX transformation using Babel (for compatibility and plugin ecosystem).
     *   - React Fast Refresh for HMR in development.
     *   - Automatic React import (no need for 'import React from "react"' in every file).
     */
    react(),
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
