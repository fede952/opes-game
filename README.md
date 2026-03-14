<div align="center">

# 🏛 Opes: The Roman Economy MMO

### *Build your Empire. Corner the Market. Dominate the Senate.*

**An open-source, browser-based multiplayer economic simulation set in Ancient Rome & Greece.**

[![License: MIT](https://img.shields.io/badge/License-MIT-D4AF37.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev)
[![Node.js](https://img.shields.io/badge/Node.js-20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://neon.tech)
[![PWA Ready](https://img.shields.io/badge/PWA-Ready-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white)](https://opes.federicosella.com)

<br/>

### 🎮 [**Play Now at opes.federicosella.com**](https://opes.federicosella.com)

*Installable as a native app on Android and iOS — no App Store required.*

<br/>

</div>

---

## ⚔️ What is Opes?

**Opes** (*Latin for "wealth, power, resources"*) is a **real-time, player-driven economy simulator** in the mold of classic browser MMOs — but built on a modern full-stack TypeScript architecture.

You start as a humble citizen in the Roman Empire with 1,000 Sestertii and a plot of land. From there, you must:

- 🌾 **Build a production empire** — lumber camps, grain farms, flour mills, warehouses, academies, and customs offices.
- ⚖️ **Trade in the Forum** — list resources for sale, undercut your rivals, and snap up deals on the player-driven P2P market.
- 🏦 **Play the financial markets** — issue bonds, invest in other players' ventures, and collect interest.
- 📜 **Negotiate private contracts** — trade directly with allies or rivals at prices you both agree on.
- 👑 **Climb the Senate leaderboard** — the top 50 wealthiest citizens are ranked by total net worth in real time.

The entire economy is **server-authoritative** — no client-side cheating, no fake numbers. Every Sestertius is tracked in PostgreSQL.

> **Target audience:** Fans of browser MMOs, idle games, and economic simulations. Developers interested in full-stack TypeScript, real-time game architecture, and PWA development.

---

## 🌟 Core Features

### 🏭 Production System
- Six building types, each with upgradeable levels (scaling yield and cost)
- Time-based production runs with animated countdown progress bars
- **Quality system** — Standard (Q0), Fine (Q1), or ★ High Quality (Q2, requires Academy Lv.2)
- Q2 goods take 50% longer to produce but sell for 2× NPC price

### ⚖️ Player-to-Player Market (The Forum)
- List any resource at any price — the market sets itself
- Quality is visible on every listing: Q2 listings get a gold ★ badge
- 7-day FRUMENTUM price trend chart (recharts AreaChart, Roman gold palette)

### 🏛️ Dynamic NPC Empire (The Empire)
- Empire-wide **events** rotate every 24 hours:
  - 🕊️ **Pax Romana** — Normal prices
  - ⚔️ **War in Gaul** — Wood & Grain +50%, Flour +20%
  - 🌾 **Famine** — Grain & Flour +100%, Wood −20%
- Event banner displayed prominently on every tab
- NPC market locked until you build a **Dogana (Customs Office)**

### 📜 Private Contracts
- Send a direct trade offer to any player by username
- Resources held in escrow until accepted or cancelled
- Full incoming / outgoing contract dashboard

### 🏦 Bond Market (The Bank)
- Issue bonds with a custom principal, interest rate, and duration
- Other players can invest — funds transfer immediately
- Bond market table with issuer, buyer, rate, repayment, and status columns

### 👑 Senate Leaderboard
- Top 50 players ranked by real-time net worth
- Net Worth = Cash + (Inventory × NPC price × quality multiplier) + (Buildings × upgrade cost × level)
- Your row is highlighted in gold

### 📱 Mobile-First PWA
- Responsive bottom navigation bar on mobile (replaces top tabs)
- Installable on Android and iOS — plays in fullscreen standalone mode
- `beforeinstallprompt` banner wired to native OS install dialog
- SVG icon committed; PNG instructions in `public/icons/README.md`

### 🌍 Internationalisation (i18n)
- Full UI in **English**, **Italian**, and **Portuguese (Brazil)**
- Language selector in the navbar; preference persisted across sessions

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend framework** | [React 18](https://react.dev) + [TypeScript 5](https://www.typescriptlang.org) |
| **Build tool** | [Vite 5](https://vitejs.dev) |
| **Styling** | [Tailwind CSS v3](https://tailwindcss.com) with a custom Roman colour palette |
| **Charts** | [Recharts 3](https://recharts.org) |
| **Internationalisation** | [i18next](https://www.i18next.com) + browser language detector |
| **PWA** | [vite-plugin-pwa](https://vite-pwa-org.netlify.app) (Workbox service worker) |
| **Backend framework** | [Express 4](https://expressjs.com) + [TypeScript 5](https://www.typescriptlang.org) |
| **Database** | [PostgreSQL](https://www.postgresql.org) (hosted on [Neon](https://neon.tech)) |
| **Authentication** | [JSON Web Tokens](https://jwt.io) + [bcrypt](https://github.com/kelektiv/node.bcrypt.js) (cost factor 12) |
| **Database client** | [node-postgres (pg)](https://node-postgres.com) with connection pooling |
| **Deployment** | [Cloudflare Pages](https://pages.cloudflare.com) (frontend) + [Render](https://render.com) (backend) |

### Architecture decisions worth noting

- **Server-authoritative economy** — all game logic (production, trades, escrow, net worth) runs on the backend. The client is a display layer only.
- **Deadlock-safe transactions** — all multi-row inventory locks are acquired in alphabetical resource-ID order across every route, eliminating cross-route PostgreSQL deadlocks.
- **Deterministic event rotation** — empire events use `GAME_EVENTS[Math.floor(Date.now() / 86_400_000) % 3]`. No DB table, no in-memory state, consistent across every server instance and restart.
- **3-column inventory PK** — `(user_id, resource_id, quality)` lets Q0, Q1, and Q2 goods coexist as separate rows with zero schema changes.

---

## 🚀 Quick Start — Local Setup

### Prerequisites

- **Node.js** 20+ and **npm** 9+
- A **PostgreSQL** database (local, Docker, or a free [Neon](https://neon.tech) serverless instance)
- Git

### 1 — Clone the repository

```bash
git clone https://github.com/your-username/opes.git
cd opes
```

### 2 — Install all dependencies (monorepo root)

```bash
npm install
```

This installs dependencies for both `backend/` and `frontend/` workspaces in one command.

### 3 — Configure environment variables

**Backend** — create `backend/.env`:

```bash
cp backend/.env.example backend/.env   # if an example file exists, otherwise create manually
```

Edit `backend/.env` with your values:

```env
# Server
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:3000

# PostgreSQL — local or Neon connection string
DB_HOST=localhost
DB_PORT=5432
DB_NAME=opes
DB_USER=postgres
DB_PASSWORD=your_password_here
DB_MAX_CONNECTIONS=10

# JWT — generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=your_64_char_random_hex_here

# Production duration override (optional — shortens cycles for testing)
# PRODUCTION_DURATION_SECONDS=30
```

> **Neon users:** Set `DB_HOST` to your Neon hostname, `DB_PORT=5432`, and add `?sslmode=require` to your connection if using a full connection string.

**Frontend** — no `.env` needed for local development. The Vite dev server proxies all `/api/*` requests to `http://localhost:3001` automatically.

### 4 — Set up the database schema

Run the full schema against your PostgreSQL instance:

```bash
psql -h localhost -U postgres -d opes -f backend/src/db/opes_full_schema.sql
```

Or paste the contents of `backend/src/db/opes_full_schema.sql` into your Neon SQL editor.

### 5 — Run both servers

Open two terminals (or use a tool like [concurrently](https://github.com/open-cli-tools/concurrently)):

```bash
# Terminal 1 — backend (http://localhost:3001)
npm run dev:backend

# Terminal 2 — frontend (http://localhost:3000)
npm run dev:frontend
```

The game is now running at **http://localhost:3000**. Register an account and start building.

### Useful scripts

```bash
# TypeScript type-check both workspaces at once
npm run typecheck

# Production build (outputs to backend/dist and frontend/dist)
npm run build

# Simulate NPC market price fluctuations (optional background job)
npm run simulate --workspace=backend
```

---

## 🗂️ Project Structure

```
opes/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   │   ├── gameConfig.ts       # Building definitions, costs, yields
│   │   │   └── gameEvents.ts       # Empire event rotation logic
│   │   ├── db/
│   │   │   ├── connection.ts       # pg Pool + withTransaction helper
│   │   │   └── opes_full_schema.sql
│   │   ├── middleware/
│   │   │   └── authMiddleware.ts   # JWT verification
│   │   ├── routes/
│   │   │   ├── auth.ts             # /register, /login
│   │   │   ├── buildings.ts        # /build, /upgrade
│   │   │   ├── production.ts       # /start, /collect
│   │   │   ├── npcMarket.ts        # /prices, /sell, /event
│   │   │   ├── p2pMarket.ts        # /list, /buy, /cancel
│   │   │   ├── contracts.ts        # /send, /accept, /cancel
│   │   │   ├── bonds.ts            # /issue, /buy, /repay
│   │   │   ├── inventory.ts        # GET /inventory
│   │   │   └── leaderboard.ts      # GET /senate
│   │   └── server.ts
│   └── package.json
│
└── frontend/
    ├── public/
    │   ├── assets/                 # Background images, resource icons
    │   └── icons/                  # PWA icons (icon.svg committed; add PNG files)
    ├── src/
    │   ├── components/
    │   │   ├── AuthForm.tsx
    │   │   ├── Dashboard.tsx       # Main game view + navigation
    │   │   ├── Market.tsx          # NPC + P2P market
    │   │   ├── Contracts.tsx
    │   │   ├── Bank.tsx
    │   │   └── Senate.tsx
    │   ├── i18n/locales/           # en.json, it.json, pt.json
    │   ├── context/AuthContext.tsx
    │   └── App.tsx                 # PWA install prompt logic
    └── package.json
```

---

## 🎮 Gameplay Progression

```
New player (1,000 ⚙)
    │
    ├─ Build CASTRA_LIGNATORUM (Lumber Camp) → produce LIGNUM
    ├─ Build FUNDUS_FRUMENTI (Grain Farm)    → produce FRUMENTUM
    │
    ├─ Build PISTRINUM (Mill)                → convert FRUMENTUM → FARINA
    ├─ Build HORREUM (Warehouse)             → expand storage capacity
    │
    ├─ Build ACADEMIA (School)               → produce RESEARCH
    │   └─ Upgrade to Lv. 2                  → unlock ★ High Quality production
    │
    └─ Build DOGANA (Customs Office)         → unlock NPC Empire market
        │
        ├─ Sell to NPC Empire (dynamic event prices)
        ├─ List on P2P Forum (set your own price)
        ├─ Send private contracts to allies
        ├─ Issue / invest in bonds
        └─ Climb the Senate leaderboard
```

---

## 🤝 Contributing

Contributions are welcome! This project is a great playground for learning full-stack TypeScript, PostgreSQL transaction patterns, and PWA development.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes and run `npm run typecheck` to verify types
4. Commit: `git commit -m "feat: add my feature"`
5. Open a Pull Request

**Good first issues to explore:**
- Adding new building types or resources to `backend/src/config/gameConfig.ts`
- Adding a new locale to `frontend/src/i18n/locales/`
- Improving the recharts market visualization with real historical trade data
- Adding a new empire event type

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

You are free to fork, modify, and deploy your own instance. A credit back to this repository is appreciated but not required.

---

## 👤 Author

**Federico Sella**

- 🌐 [federicosella.com](https://federicosella.com)
- 🎮 [opes.federicosella.com](https://opes.federicosella.com)

---

<div align="center">

*"Pecunia non olet."* — Vespasian, Roman Emperor (money does not smell)

**[⭐ Star this repo](https://github.com/your-username/opes) if you find it interesting!**

</div>
