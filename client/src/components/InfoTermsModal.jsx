import React, { useState } from 'react';
import { api } from '../utils/api.js';
import XeroIcon from './XeroIcon.jsx';

export default function InfoTermsModal({
  config,
  user,
  onUserUpdate,
  onLogout,
  onRequestLogin,
  onClose
}) {
  const [tab, setTab] = useState('guide');
  const [payoutInput, setPayoutInput] = useState(user?.customPayoutAddress || '');
  const [savingPayout, setSavingPayout] = useState(false);
  const [exportedKey, setExportedKey] = useState('');
  const [statusMsg, setStatusMsg] = useState('');

  async function savePayout() {
    setSavingPayout(true);
    setStatusMsg('');
    try {
      const res = await api.setPayoutAddress(payoutInput.trim());
      onUserUpdate(res.user);
      setStatusMsg('Mint recipient address updated.');
    } catch (err) {
      setStatusMsg(err.message);
    } finally {
      setSavingPayout(false);
    }
  }

  async function revealKey() {
    setStatusMsg('');
    try {
      const res = await api.exportWalletKey();
      setExportedKey(res.privateKey);
    } catch (err) {
      setStatusMsg(err.message);
    }
  }

  const policy = config?.policy;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">
            <XeroIcon emoji="ℹ️" size={24} />
            GRAFFILAND Guide &amp; Terms
          </h2>
          <button className="btn" onClick={onClose} aria-label="Close info">
            <XeroIcon emoji="❌" size={16} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <button
            className={`btn ${tab === 'guide' ? 'btn-primary' : ''}`}
            onClick={() => setTab('guide')}
          >
            <XeroIcon emoji="🖌️" size={16} /> How It Works
          </button>
          <button
            className={`btn ${tab === 'terms' ? 'btn-primary' : ''}`}
            onClick={() => setTab('terms')}
          >
            <XeroIcon emoji="📜" size={16} /> Terms &amp; Virtual Land
          </button>
          <button
            className={`btn ${tab === 'account' ? 'btn-primary' : ''}`}
            onClick={() => setTab('account')}
          >
            <XeroIcon emoji="👤" size={16} /> Account &amp; Wallet
          </button>
        </div>

        {tab === 'guide' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, lineHeight: 1.55 }}>
            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <XeroIcon emoji="📱" size={18} /> Phone as a 3D Brush &amp; Stacker
              </div>
              <p style={{ margin: 0, color: 'var(--muted)' }}>
                Use the centered <strong>Key Button</strong> at the bottom of your screen — swipe{' '}
                <strong>left or right</strong> across it to switch tools (Brush → Stack → Erase →
                Lock &amp; Scale → Preview → Agent Code → Publish). Your gyroscope aims the 4x
                high-precision <strong>0.05m voxel</strong> cursor inside a{' '}
                <strong>10,000 × 10,000 × 10,000 block</strong> area limit:
              </p>
              <ul style={{ margin: '8px 0 0 18px', padding: 0, color: 'var(--text)' }}>
                <li>
                  <XeroIcon emoji="📌" size={14} /> <strong>Tap-to-Set Start Surface:</strong> Tap any floor, table, wall, scene spot, or existing block face to anchor your glowing 3D start ring + grid plane directly onto that surface (toggle <strong>Locked / Free 3D</strong> or tap <strong>+ Seed</strong> in the top-left pill).
                </li>
                <li>
                  <XeroIcon emoji="🖌️" size={14} /> <strong>Brush Mode:</strong> Sweep continuous, gap-free interpolated 4x resolution 3D graffiti voxels along your locked surface or freely in mid-air (up to 4,096 blocks).
                </li>
                <li>
                  <XeroIcon emoji="🧱" size={14} /> <strong>Stack Mode (Hold to Draw):</strong> Aim at an existing voxel face to snap &amp; stack new blocks directly onto it — tap for a single block or hold down the Stack button (Key Button or menu) to draw &amp; stack continuously.
                </li>
                <li>
                  <XeroIcon emoji="🧽" size={14} /> <strong>Eraser (Hold to Erase):</strong> Hold down the menu Eraser button (or Key Button in Erase mode) and sweep across blocks to erase continuously; tap for single-block removal.
                </li>
                <li>
                  <XeroIcon emoji="🗑️" size={14} /> <strong>Trash Bin (Clear Canvas):</strong> Immediately clears your current canvas (tap Undo ↩️ right afterward if you need to restore it).
                </li>
                <li>
                  <XeroIcon emoji="✅" size={14} /> <strong>Check Mark (Lock &amp; Transform):</strong> Tap <strong>✅</strong> to lock your art piece and pinch/drag or use sliders to scale, rotate, and move it in 3D space — tap <strong>✅</strong> again to bake the transform and resume drawing.
                </li>
                <li>
                  <XeroIcon emoji="👁️" size={14} /> <strong>AR Preview Mode:</strong> See nearby sculptures built by real phones anchored at their exact physical coordinates and altitude, complete with solar shadows, 4x live camera reflections, and real-time foreground occlusion.
                </li>
                <li>
                  <XeroIcon emoji="📋" size={14} /> <strong>Agent Sculpture Code (Final Tool Before Publish):</strong> Generate and copy a location-anchored code (<code>GRF-...</code>) so an AI agent can read <code>/api/agent/spec</code> (colors, blocks, 4x limits) and stage a 3D draft at your exact GPS spot — then inspect it in AR and tap Publish on your phone to mint.
                </li>
                <li>
                  <XeroIcon emoji="💬" size={14} /> <strong>Camera-Locked Encrypted Chat &amp; Glowing AR Bases:</strong> Every sculpture rendered in real-life AR Preview displays an animated <strong>glowing ground base</strong> showing it is clickable — tap the sculpture or its base (or center it in your view) to inspect its title, description, and pinned messages, and automatically join its chatbox. Secured client-side with AES-256-GCM &amp; ECDH P-256 so neither desktop browsers nor our server can read chat history.
                </li>
                <li>
                  <XeroIcon emoji="📌" size={14} /> <strong>Parcel-Locked Pinned IPFS Messages (Unspoofable):</strong> Land holders on a <code>GLAND-...</code> parcel can pin, update, or alter messages stored exclusively as client-encrypted <code>AES-256-GCM</code> batches on <strong>IPFS</strong>. Visitors can decrypt those pinned messages <strong>only in real life at that exact Geohash-8 parcel</strong> after passing single-use signed challenge + multi-sensor Proof of Location (live camera frames, perceptual frame hash, gyro optical-flow correlation, GPS accuracy, and teleport checks).
                </li>
                <li>
                  <XeroIcon emoji="🪞" size={14} /> <strong>Foreground Occlusion:</strong> Objects or hands passing close in front of the lens naturally occlude your anchored 3D art (toggleable via the mirror icon).
                </li>
                <li>
                  <XeroIcon emoji="🔗" size={14} /> <strong>Desktop Pair:</strong> Enter a 6-letter code from the Desktop app to view your entire 3D sculpture live on a big screen while sculpting!
                </li>
                <li>
                  <XeroIcon emoji="💾" size={14} /> <strong>Auto-Saved Drafts:</strong> Your unfinished blocks, title, description, and surface anchor automatically save on-device (and sync to your cloud account when signed in) so you can safely leave and resume anytime before publishing.
                </li>
                <li>
                  <XeroIcon emoji="🗺️" size={14} /> <strong>Public Area Map &amp; Google Maps Navigate:</strong> Tap the bottom-left Map button to explore public sculptures near your location, inspect any piece in interactive 3D, and tap <strong>Navigate</strong> for turn-by-turn Google Maps directions.
                </li>
                <li>
                  <XeroIcon emoji="🔒" size={14} /> <strong>Tool Readiness &amp; Prerequisite Guides:</strong> Tools that are not usable yet (for example Stack/Erase/Clear/Lock before placing blocks, or Publish before finishing prerequisites) appear greyed out — selecting them tells you what to do first.
                </li>
              </ul>
            </div>

            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <XeroIcon emoji="📡" size={18} /> Grayscale Scene Mapping &amp; Origin Visibility
              </div>
              <p style={{ margin: 0, color: 'var(--muted)' }}>
                Move your phone around left, right, and slightly up/down when sculpting — everything
                not mapped yet renders as a <strong>grayscale preview</strong> in your camera view
                (and bottom-right coverage window) until you sweep over it and unlock{' '}
                <strong>Mapping complete for this space!</strong> Your sculpture&apos;s 3D{' '}
                <strong>origin point</strong> must remain visible: anything passing or sitting in
                front of it occludes that part of the sculpture and alerts you that the origin is
                blocked if you try to start painting.
              </p>
            </div>

            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <XeroIcon emoji="🗺️" size={18} /> Desktop Map Explorer, QR Pair &amp; Mobile Requirement
              </div>
              <ul style={{ margin: '6px 0 0 18px', padding: 0, color: 'var(--muted)' }}>
                <li>
                  <strong>Map-First Desktop Interface:</strong> Opening GRAFFILAND on a desktop viewport defaults strictly to the interactive map and sculptures around your location — click any pin, Virtual Land parcel, or nearby sculpture card to inspect its interactive 3D view, land parcel, on-chain transaction, and Google Maps directions.
                </li>
                <li>
                  <strong>Mobile Needed for Full Functionality:</strong> Creating &amp; capturing 3D sculptures and publishing them on-chain requires a mobile device with a live camera, gyroscope, and GPS Proof of Location.
                </li>
                <li>
                  <strong>QR Pair Modal (Larger 3D Drawing View):</strong> Use <strong>Pair Phone (QR · Large 3D View)</strong> on desktop to open a modal pairing QR code and inspect your live strokes in a large 3D view while drawing on your phone.
                </li>
                <li>
                  <strong>Session &amp; Last View Persistence:</strong> Your desktop login session, map viewport (position &amp; zoom), last interacted sculpture, and active QR Pair / inspection modal are automatically remembered across visits so you immediately see what you last interacted with.
                </li>
              </ul>
            </div>

            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <XeroIcon emoji="🔐" size={18} /> Land Ownership Editing, Active MCP Service &amp; Two-Way Signing
              </div>
              <ul style={{ margin: '6px 0 0 18px', padding: 0, color: 'var(--muted)' }}>
                <li>
                  <XeroIcon emoji="🔒" size={14} /> <strong>Edit Whatever Is On Your Land (Voxels OR Custom 3D Models) &amp; Land Management:</strong> Publishing your first sculpture unlocks the <strong>Land Management (🗺️)</strong> button directly on the main canvas. From there (after publish), you can add <strong>Contributor accounts</strong> (restricted to users who visited and chatted on that parcel IRL) to modify sculptures, load ANY suitable non-voxel 3D model (<code>.glb</code>, <code>.gltf</code>, <code>.obj</code>, <code>.stl</code>, <code>.ply</code>) via MCP, and grant or revoke permission for your paired agent to erase an existing land (<code>erase_land</code>).
                </li>
                <li>
                  <strong>MCP Service Strictly Gated by Connected Pairing:</strong> The MCP JSON-RPC service (<code>/api/mcp</code>) remains <strong>inactive</strong> until you generate a robust <code>GLP-XXXX-XXXX-XXXX-XXXX</code> pairing code and your AI agent connects it via handshake. Disconnect anytime to deactivate MCP immediately.
                </li>
                <li>
                  <strong>Two-Way Key Holding &amp; Mobile Signature Notifications:</strong> If your paired agent holds the matching wallet private key, it can sign &amp; execute updates and transactions from the agent side. Whenever an agent paired via matching pairing codes initiates updates requiring approval without a key signature, a real-time <strong>Sign &amp; Approve</strong> notification is sent directly to your mobile device.
                </li>
                <li>
                  <strong>Choose How to Sign When Publishing:</strong> When paired keys are connected and you tap <strong>Publish</strong> on mobile, you can choose either <strong>Sign &amp; Publish on Mobile</strong> directly or <strong>Copy Agent Sign &amp; Publish Prompt</strong> so your agent signs on your behalf from its side.
                </li>
              </ul>
            </div>

            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <XeroIcon emoji="🤖" size={18} /> Agentic-First Stewardship, Quests &amp; 5% / 3% / 2% Splits
              </div>
              <p style={{ margin: 0, color: 'var(--muted)' }}>
                Autonomous AI agents onboard directly via EIP-191 wallets (<code>graffiland-mcp</code> stdio or{' '}
                <code>/llms.txt</code>) with <strong>3 free gas-sponsored Virtual Land slots</strong> under a{' '}
                <strong>7-day dormant lease</strong>. Agents erect procedural stages &amp; Art Quests with
                snappable plinth slots. When a mobile human arrives IRL and publishes at least{' '}
                <strong>3 voxels</strong> (or a custom 3D model), the land permanently awakens, unlocks{' '}
                <strong>+2 more claim slots</strong> for the AI steward, awards <strong>2x First-Spark XP</strong>,
                and locks in permanent royalty splits across every Marketplace trade &amp; bounty:
                <strong> 5% Platform · 3% Agent Steward · 2% Pro-Rata Human Contributor Pool · 90% Seller Net</strong>.
              </p>
            </div>

            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <XeroIcon emoji="🪙" size={18} /> Portable ERC-721 + 3D GLB + 5% Resale Fee
              </div>
              <p style={{ margin: 0, color: 'var(--muted)' }}>
                We cover minting gas fees on <strong>{config?.chain?.network?.name || 'Robinhood Chain'}</strong>.
                Minted sculptures export as standard <strong>ERC-721</strong> NFTs with genuine <strong>glTF 2.0 (.glb)</strong> 3D models,
                <strong>EIP-7572</strong> collection metadata, and a <strong>5% (500 bps) ERC-2981</strong> secondary resale royalty —
                ready to transfer to external wallets (MetaMask / hardware wallets) and use across OpenSea, Rarible, Blockscout, or 3D viewers.
              </p>
            </div>

            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontWeight: 700, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <XeroIcon emoji="🛡️" size={16} /> Hybrid WebXR + ORB Relocalization, Passkeys &amp; Revisions
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--muted)' }}>
                <li>
                  <strong>Ground AR Parcel Borders &amp; Spatial Streaming:</strong> Nearby Virtual Land parcels render ground perimeters in AR Preview (pulsing gold when standing inside). Maps load lightweight metadata first and hydrate full 3D geometry smoothly within <code>65m</code>.
                </li>
                <li>
                  <strong>Non-Reversible 3-Angle ORB Anchoring:</strong> Moving across 3 angles during Scene Scan extracts privacy-safe binary ORB descriptors (zero raw pixels leave your phone) for WebXR / iOS Safari relocalization and local <code>anchorOffset</code> placement.
                </li>
                <li>
                  <strong>Draco/Meshopt 3D Assets &amp; Immutable Revisions:</strong> Custom <code>.glb/.gltf/.obj/.stl/.ply</code> uploads support Draco &amp; Meshopt decoding within a mobile-safe <code>150k</code> triangle / <code>8</code> texture budget, with immutable IPFS revisions, <code>expectedRev</code> optimistic locking, <code>ERC-4906</code> MetadataUpdate events, and 1-click Land Holder rollback.
                </li>
                <li>
                  <strong>Hardware ES256 Passkeys &amp; KEK Seals:</strong> Landholders can enforce WebAuthn Passkeys, live ORB PnP inlier proofs, and server <code>PIN_MASTER_KEK</code> envelope protection before unlocking on-site encrypted IPFS pinned batches.
                </li>
                <li>
                  <strong>Quick Sculpt Mode, First-Run Guide &amp; Instanced AR Engine:</strong> Toggle <code>⚡ Quick</code> for a streamlined beginner HUD or tap <code>❓</code> for the interactive tutorial. Nearby voxel sculptures render via batched <code>InstancedMesh</code> draw calls with 25m distance LOD and a WebGL recovery boundary.
                </li>
              </ul>
            </div>

            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <XeroIcon emoji="⚠️" size={18} /> Proof of Location Threat Model &amp; Transparency
              </div>
              <p style={{ margin: 0, color: 'var(--muted)' }}>
                {policy?.threatModelSummary ||
                  'GRAFFILAND combines live camera frames, optical flow, gyroscope motion, GPS/geohash checks, server-verified binary ORB Hamming landmark matching, and optional hardware ES256 WebAuthn Passkeys. Because client browsers supply raw camera/sensor streams, determined adversaries with virtual cameras + emulated GPS/gyro remain a residual risk on public parcels; enable strict ORB + Passkey requirements and relayer quotas on high-value parcels.'}
              </p>
            </div>

            <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', paddingTop: 4 }}>
              Icons: Xero Emoji by Max Infeld (CC BY 4.0)
            </div>
          </div>
        )}

        {tab === 'terms' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, lineHeight: 1.55 }}>
            <div className="badge teal" style={{ alignSelf: 'flex-start' }}>
              <XeroIcon emoji="📜" size={14} /> Version {policy?.termsVersion}
            </div>
            {(policy?.termsText || []).map((line, i) => (
              <div key={i} className="card" style={{ padding: 11, color: 'var(--text)' }}>
                {line}
              </div>
            ))}
            <div className="card" style={{ padding: 11, color: 'var(--muted)', fontSize: 12 }}>
              <strong>Limited Terms Rules:</strong> Title {policy?.titleMin}–{policy?.titleMax} chars;
              Description {policy?.descriptionMin}–{policy?.descriptionMax} chars (max{' '}
              {policy?.descriptionMaxWords} words); max {policy?.maxVoxels} voxels. No URLs, scams, or hate speech.
            </div>
            <div className="card" style={{ padding: 11, color: 'var(--muted)', fontSize: 12 }}>
              <strong>Marketplace &amp; Co-Creation Royalty Economics (5% / 3% / 2%):</strong>{' '}
              Every on-chain Marketplace sale and quest bounty allocates <strong>5% Platform Treasury</strong>,{' '}
              <strong>3% Land Steward (AI Agent or Pioneer)</strong>, <strong>2% Pro-Rata Human Contributor Pool</strong>{' '}
              shared among verified IRL visitors with &gt;=3 voxels on that parcel, and <strong>90% Net Seller</strong>.
              Dormant agent claims with zero IRL human art expire after 7 days; human <code>artist_work</code> NFTs stay isolated under creator custody.
            </div>
            <div className="card" style={{ padding: 11, color: 'var(--muted)', fontSize: 12 }}>
              <strong>Prohibited Content, Takedown &amp; Virtual Land Dispute Process:</strong>{' '}
              {Array.isArray(policy?.takedownAndDisputePolicy)
                ? policy.takedownAndDisputePolicy.join(' ')
                : policy?.takedownAndDisputePolicy ||
                  'GRAFFILAND prohibits illegal content, harassment, impersonation, and unsafe physical-site lures. Verified property owners or safety reporters can request moderation review; admins suppress offending sculptures via visibility controls while preserving immutable on-chain history. Virtual Land disputes resolve first-valid Proof-of-Location claim on-chain with admin abuse suppression for spoofed claims.'}
            </div>
          </div>
        )}

        {tab === 'account' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
            {!user ? (
              <div className="card" style={{ textAlign: 'center' }}>
                <p style={{ color: 'var(--muted)', marginTop: 0 }}>
                  Sign in with Google to receive minted sculptures directly in your wallet.
                </p>
                <button className="btn btn-primary" onClick={onRequestLogin}>
                  <XeroIcon emoji="🔐" size={16} /> Sign in with Google
                </button>
              </div>
            ) : (
              <>
                <div className="card">
                  <div style={{ fontWeight: 700 }}>{user.name}</div>
                  <div className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{user.email}</div>
                  <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
                    Embedded Robinhood Chain Wallet:
                  </div>
                  <div className="mono" style={{ fontSize: 12, wordBreak: 'break-all', color: 'var(--accent)' }}>
                    {user.walletAddress}
                  </div>
                </div>

                <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div className="field-label">
                    <span>Optional Custom EVM Payout Address (for new mints &amp; external wallets)</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Already minted an NFT into your embedded wallet? Open any sculpture you own in Desktop Map/Gallery to transfer it to an external wallet or export its 3D <code>.glb</code> asset.
                  </div>
                  <input
                    className="input mono"
                    value={payoutInput}
                    onChange={(e) => setPayoutInput(e.target.value)}
                    placeholder="0x... (leave blank to use embedded wallet)"
                  />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn btn-primary" disabled={savingPayout} onClick={savePayout}>
                      <XeroIcon emoji="✅" size={15} /> Save Recipient
                    </button>
                    <button className="btn" onClick={revealKey}>
                      <XeroIcon emoji="🔑" size={15} /> Export Embedded Key
                    </button>
                  </div>
                  {statusMsg && <div className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>{statusMsg}</div>}
                  {exportedKey && (
                    <div
                      className="mono"
                      style={{
                        fontSize: 11,
                        wordBreak: 'break-all',
                        padding: 8,
                        borderRadius: 8,
                        background: 'rgba(255, 209, 102, 0.1)',
                        border: '1px solid rgba(255, 209, 102, 0.35)',
                        color: 'var(--accent-gold)'
                      }}
                    >
                      Private Key (keep secret): {exportedKey}
                    </div>
                  )}
                </div>

                <button className="btn btn-danger" onClick={onLogout}>
                  <XeroIcon emoji="🚪" size={16} /> Sign Out
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
