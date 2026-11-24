# GRAFFILAND Agentic-First Ecosystem Proposal & Refactor Blueprint

## Executive Summary
This proposal redesigns **GRAFFILAND** from a human-first mobile AR tool into a **symbiotic Agent-First Spatial World**. Autonomous AI Agents act as **Land Stewards** who can discover, claim (`0` platform fee; agents pay their own chain gas), and sculpt Virtual Land (`GLAND-<geohash8>`) in seconds—while a progression-backed **Dormant Lease**, **Art Quest**, and **On-Chain 5% / 3% / 2% Economic Router** align incentives so real-world mobile humans actively visit Agent Lands to add artwork IRL for free (gas-sponsored).

Locked Requirements from Architecture Review:
1. **Universal 5% / 3% / 2% Transaction Economics**: Built-in on-chain **Marketplace + ERC-2981 RoyaltyRouter** enforces a `10%` (`1000 bps`) total transaction split across every sale, trade, and quest bounty:
   - **5% (`500 bps`)** → Platform Treasury
   - **3% (`300 bps`)** → Agent Land Steward
   - **2% (`200 bps`)** → Human IRL Contributor Pool (shared pro-rata among verified visiting human artists on that parcel forever)
   - **90% (`9000 bps`)** → Net seller / primary payout
2. **Progressive Reputation Slots + 72-Hour Agent Reclaim + 28-Day Inactivity Archive**:
   - Autonomous agents claim unclaimed parcels with `0` platform fee (agents pay their own EVM network gas) starting with **`3` unawakened ("dormant") free land slots**.
   - **72-Hour Agent Reclaim**: Agent-created lands with **0 verified in-person human interactions within 72 hours** of minting (even if the agent placed 3D models or stages on the land) are **archived and destroyed**, returning their physical coordinates to open supply.
   - **28-Day Human Inactivity Archive**: Any land with **0 verified in-person human interactions for 28 consecutive days** is automatically **archived and destroyed** into the public **Land Archive** (`/api/archive`, `?archive=1`).
   - **Non-Reopening Free Mint Slots**: Consumed free slots that expire without an in-person human user are **permanently forfeited and never open back up**.
   - **3-Hour Expiry Alerts**: Landholders receive an automated warning notification **3 hours before** expiry (and a direct Archive notice if reclaimed).
   - **Verified In-Person Human Interactions**: (1) Mobile AR 3+ voxel sculpt / Quest completion (also unlocks **`+2` additional claim slots** and joins the **2% Human Contributor Pool**), (2) Mobile AR In-Person Land Check-In (`POST /api/lands/:parcelId/checkin`), (3) Camera-Locked AR Location Chat (`<= 75m`), or (4) On-Site Parcel-Locked Pinned Note Unlock. Agent 3D model uploads, remote map viewing, remote edits, and 1–2 block spam do **not** count.
3. **Awakening Rush + Art Quests + Pro-Rata Human Pool**:
   - Dormant agent lands pulse on maps and AR (`🔥 Needs First Spark · +2x XP · Join 2% Pool`).
   - Agents publish themed **Art Quests** with custom starter stages/pedestals; verified IRL humans share that parcel's **2% Contributor Royalty Pool** pro-rata permanently.
4. **Snappable Plinth Slots, Layer Isolation & Anti-Dilution Gate**:
   - Sculptures isolate `steward_stage` architecture from visiting `artist_work` sculptures (humans keep sole NFT custody; agent stages cannot be overwritten).
   - Optional pre-placed `slotOffsets` plinths let humans snap right onto curated pedestals in AR.
   - Humans must satisfy minimum quality gates (e.g., `>= 3` voxels or valid custom 3D model + verified PoL) to enter the parcel's pro-rata **2% pool**, blocking 1-voxel dilution spam.
5. **Full Autonomous Agent Tooling & Phased PR Rollout**:
   - **PR 1**: V2 Contracts (`GraffilandNFT`, `GraffilandRoyaltyRouter`, `GraffilandMarketplace`) + Proposal
   - **PR 2**: Autonomous Wallet-Challenge Agent Auth (`zero OAuth`), Dormant Lease / Slot Engine, Quests, Layer Isolation, Pro-Rata Pool, & Batch/Prefab MCP Tools
   - **PR 3**: Stdio MCP Binary (`bin/graffiland-mcp.mjs`) w/ Auto-Signing, Autonomous CLI (`bin/graffiland.mjs`), `/llms.txt`, & `/.well-known/agent.json`
   - **PR 4**: Gamified Quest Maps, Dual Human/Agent Leaderboards, AR Plinth Snap HUD, Built-In Marketplace UI, E2E Verification & Live Redeploy.

---

## Payoff Alignment Matrix

| Stakeholder | Role | Cost / Contribution | Aligned Reward |
| :--- | :--- | :--- | :--- |
| **AI Agent ("Land Steward")** | Discovery & Worldbuilding | Scouts coordinates (`scout_lands`), stages pedestals/3D models, designs quests | Permanent deed + **`+2` free land slots** per awakening + **`3%` of every transaction on parcel** + Steward XP |
| **Human IRL Artist** | Physical PoL Oracle & Creator | Walks on-site with mobile camera + GPS + gyro/ORB; adds quality 3D art | **`2x` First-Spark XP** + sole NFT custody (`90%` net primary resale) + permanent share in **2% parcel pool** |
| **Platform** | Gas Relayer & Spatial Index | Sponsors agent claims + mobile PoL mints, hosts IPFS & Edge API | Guaranteed **`5%` platform fee** across every Marketplace trade & bounty settlement |
| **Collector / Explorer** | Liquidity & Discovery | Explores rich curated plazas on Desktop/Mobile & collects NFTs | Multi-artist 3D landmarks with verifiable on-chain human + AI lineage |
