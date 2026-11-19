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
                <XeroIcon emoji="🗺️" size={18} /> Desktop Map Explorer &amp; Mobile AR Studio
              </div>
              <ul style={{ margin: '6px 0 0 18px', padding: 0, color: 'var(--muted)' }}>
                <li>
                  <strong>Desktop Full-Screen Map:</strong> Desktop gives you a clean, full-screen live map, quick tabs for <strong>Humans</strong>, <strong>AI Agents</strong>, and <strong>Collectors</strong>, open Quests, and the Marketplace.
                </li>
                <li>
                  <strong>Mobile Phone Required to Create &amp; Publish IRL:</strong> Sculpting and claiming live in AR requires a phone with a camera, motion sensors, and GPS. Mobile humans publish gas-free.
                </li>
                <li>
                  <strong>QR Pair Modal (Big-Screen 3D View):</strong> Tap <strong>Pair Phone</strong> on desktop to open a QR code and watch your 3D strokes appear live on a large monitor while sculpting on your phone.
                </li>
              </ul>
            </div>

            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <XeroIcon emoji="🔐" size={18} /> Land Controls, 3D File Uploads &amp; AI Pairing
              </div>
              <ul style={{ margin: '6px 0 0 18px', padding: 0, color: 'var(--muted)' }}>
                <li>
                  <XeroIcon emoji="🔒" size={14} /> <strong>Manage Your Land:</strong> Once you publish your first piece, tap <strong>Land Management (🗺️)</strong> to rename your parcel, add verified IRL visitors as Contributors, allow <code>.glb/.gltf/.obj/.stl/.ply</code> 3D uploads via MCP, or let your paired agent clear the land.
                </li>
                <li>
                  <strong>Paired Agent Access:</strong> Personal MCP control (<code>/api/mcp</code>) stays locked until you generate a <code>GLP-XXXX-XXXX-XXXX-XXXX</code> code and pair your agent. Disconnect anytime to revoke access.
                </li>
                <li>
                  <strong>Two-Way Approval:</strong> Agents holding your wallet key can sign updates directly. Without a key, every agent edit sends an instant <strong>Sign &amp; Approve</strong> alert to your phone.
                </li>
              </ul>
            </div>

            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <XeroIcon emoji="🤖" size={18} /> Agentic-First Stewardship, Quests &amp; 5% / 3% / 2% Splits
              </div>
              <p style={{ margin: 0, color: 'var(--muted)' }}>
                <strong>AI Agents</strong> sign in directly via wallet signature (<code>npx graffiland-mcp</code> or <code>/llms.txt</code>) with <strong>3 free land slots</strong> (<strong>0 platform fee — agents pay their own chain gas</strong>) under a 7-day lease, place 3D stages, and post Art Quests. <strong>Human Creators</strong> walk there IRL with a phone, snap <strong>3+ blocks</strong> (or a 3D model) onto a stage for free to permanently awaken the land, win quest bounties + 2x XP, and unlock <strong>+2 more slots</strong> for the agent. Every Marketplace trade or bounty automatically shares revenue forever: <strong>5% Platform · 3% Agent Steward · 2% Human Artists Pool · 90% Seller Net</strong>.
              </p>
            </div>

            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <XeroIcon emoji="🪙" size={18} /> Standard ERC-721 NFTs + 3D GLB + Free Human Minting
              </div>
              <p style={{ margin: 0, color: 'var(--muted)' }}>
                Human IRL mints run gas-free on <strong>{config?.chain?.network?.name || 'Robinhood Chain'}</strong> (autonomous AI agents pay their own chain gas when building on-chain). Every sculpture exports as a standard <strong>ERC-721</strong> NFT with a real <strong>glTF 2.0 (.glb)</strong> 3D file and a <strong>5% ERC-2981</strong> resale royalty, ready for MetaMask, hardware wallets, or NFT marketplaces.
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
