# GRAFFILAND — Location-Bound 3D Voxel Graffiti & Virtual Land

GRAFFILAND is a standalone full-stack web application where mobile artists use their phone's live camera, gyroscope, and GPS as a 3D brush & voxel stacker to sculpt location-bound 3D graffiti tied to physical **Virtual Land** parcels, preview nearby phone-made sculptures in AR, pair live with a desktop 3D workbench, pin full metadata to **IPFS**, and mint gas-sponsored **ERC-721** NFTs (with a **5% ERC-2981 resale fee**) directly to their wallet on **Robinhood Chain**.

## Live Deployment Architecture
- **Frontend (GitHub Pages)**: `https://maximusmaximus.github.io/graffiland/` (static React + Three.js + Leaflet + Xero Emoji SPA served over HTTPS for mobile Camera, Gyroscope, and GPS access).
- **Serverless API & Real-Time Pairing (Cloudflare Workers)**: `https://graffiland-api.maxinfeld-artshow.workers.dev`
  - **Cloudflare D1**: SQLite persistence for users, sculptures, and Virtual Land parcels (`worker/schema.sql`).
  - **Cloudflare Durable Objects (`PairCoordinator`)**: Low-latency WebSocket `/ws` pairing rooms for Desktop ↔ Mobile 3D sculpting.
  - **Cloudflare KV (`IPFS_KV`) / Pinata**: Content-addressed CIDv1 fallback storage served at `/ipfs/:cid` (automatically upgrades to Pinata when `PINATA_JWT` is set).

## Secret Keys & Security Model
Because this repository is public, **private keys and API secrets are never committed to git**. Instead:
- **Cloudflare Worker Secrets** hold runtime secrets (`SESSION_SECRET`, `WALLET_ENCRYPTION_KEY`, `ADMIN_EMAILS`, and optional `PINATA_JWT`, `GOOGLE_CLIENT_ID`, `ROBINHOOD_RELAYER_PRIVATE_KEY`, `ROBINHOOD_CONTRACT_ADDRESS`).
- **GitHub Repository Secrets / Variables** can mirror CI/CD keys without exposing them in source files.

To configure production Google OAuth, Pinata IPFS, or live Robinhood Chain minting on the Worker:
```bash
npx wrangler secret put GOOGLE_CLIENT_ID --config worker/wrangler.toml
npx wrangler secret put PINATA_JWT --config worker/wrangler.toml
npx wrangler secret put ROBINHOOD_RELAYER_PRIVATE_KEY --config worker/wrangler.toml
npx wrangler secret put ROBINHOOD_CONTRACT_ADDRESS --config worker/wrangler.toml
```

## Local Development

1. Copy `.env.example` to `.env` (local dev fallbacks work out of the box):
   ```bash
   cp .env.example .env
   ```
2. Run both local Express/WS server (`:3001`) and HTTPS Vite client (`:5173`):
   ```bash
   npm run dev
   ```
3. Open `https://localhost:5173` on desktop or `https://<your-lan-ip>:5173` on mobile.

## Deploying Updates

```bash
# Build GitHub Pages static bundle targeting the Cloudflare Worker API
npm run build:pages

# Deploy Cloudflare Worker + Durable Object + D1 updates
npm run deploy:worker:db
npm run deploy:worker

# Deploy ERC-721 + ERC-2981 (5% royalty) contract to Robinhood Chain Testnet (46630) or Mainnet (4663)
npm run contract:compile
npm run contract:deploy
```

## Verification & Tests

```bash
npm run build
npm test
```

## Credits
- Icons: **Xero Emoji** by Max Infeld (`xeroemoji`, CC BY 4.0)
