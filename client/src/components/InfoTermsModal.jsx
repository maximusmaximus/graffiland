import React, { useEffect, useState } from 'react';
import { isAddress } from 'ethers';
import {
  IN_PERSON_HUMAN_INTERACTIONS,
  NON_QUALIFYING_INTERACTIONS,
  STEWARD_DEFAULTS
} from '../../../shared/constants.mjs';
import { buildPayoutLinkMessage } from '../../../shared/payoutLinkMessage.mjs';
import { api } from '../utils/api.js';
import {
  isWebAuthnSupported,
  registerHardwarePasskey,
  requestPasskeyAssertion
} from '../utils/passkeyClient.js';
import InfoTip from './InfoTip.jsx';
import MeasurementUnitSetting from './MeasurementUnitSetting.jsx';
import UserHandleBadge from './UserHandleBadge.jsx';
import XeroIcon from './XeroIcon.jsx';

function detectInitialViewportTab() {
  if (typeof window !== 'undefined' && Number(window.innerWidth) > 0 && window.innerWidth <= 900) {
    return 'mobile';
  }
  return 'desktop';
}

export default function InfoTermsModal({
  config,
  user,
  initialTab = 'guide',
  onUserUpdate,
  onOpenProfile = null,
  onOpenArchive = null,
  onStartMapMint = null,
  onStartMobileDraw = null,
  onOpenMobileMap = null,
  onLogout,
  onRequestLogin,
  onClose
}) {
  const [tab, setTab] = useState(initialTab);
  useEffect(() => {
    setTab(initialTab || 'guide');
  }, [initialTab]);
  const [viewportGuide, setViewportGuide] = useState(detectInitialViewportTab);
  const [payoutInput, setPayoutInput] = useState(user?.customPayoutAddress || '');
  const [savingPayout, setSavingPayout] = useState(false);
  const [exportedKey, setExportedKey] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [needsPasskey, setNeedsPasskey] = useState(false);

  async function savePayout() {
    setSavingPayout(true);
    setStatusMsg('');
    try {
      const address = payoutInput.trim();
      let proof = {};
      const isEmbedded =
        address && user?.walletAddress && address.toLowerCase() === user.walletAddress.toLowerCase();
      if (address && !isEmbedded) {
        if (!isAddress(address)) throw new Error('Enter a valid 0x… wallet address.');
        if (!window.ethereum) {
          throw new Error(
            'Open this page in a wallet browser (or with a wallet extension) to verify you control this address.'
          );
        }
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        const active = (accounts || []).map((a) => String(a).toLowerCase());
        if (!active.includes(address.toLowerCase())) {
          throw new Error('Switch your wallet to this address, then try again.');
        }
        const issuedAt = new Date().toISOString();
        const message = buildPayoutLinkMessage({ userId: user.id, address, issuedAt });
        setStatusMsg('Confirm the signature request in your wallet…');
        const signature = await window.ethereum.request({
          method: 'personal_sign',
          params: [message, address]
        });
        proof = { issuedAt, signature };
      }
      const res = await api.setPayoutAddress(address, proof);
      onUserUpdate(res.user);
      setStatusMsg('Mint recipient address updated.');
    } catch (err) {
      setStatusMsg(err.message);
    } finally {
      setSavingPayout(false);
    }
  }

  async function enrollPasskeyForExport() {
    setExportBusy(true);
    setStatusMsg('');
    try {
      await registerHardwarePasskey('Wallet Export Passkey');
      setNeedsPasskey(false);
      setStatusMsg('Passkey registered. Click Export Embedded Key to unlock.');
    } catch (err) {
      setStatusMsg(err.message);
    } finally {
      setExportBusy(false);
    }
  }

  async function revealKey() {
    setExportBusy(true);
    setStatusMsg('');
    try {
      if (!isWebAuthnSupported()) {
        throw new Error('Hardware Passkeys (WebAuthn) are required to export your wallet key.');
      }
      const ch = await api.getWalletExportChallenge();
      setStatusMsg('Confirm with your device Passkey…');
      const assertion = await requestPasskeyAssertion(ch.challenge, ch.allowCredentials || []);
      const res = await api.exportWalletKey({ challenge: ch.challenge, assertion });
      setExportedKey(res.privateKey);
      setNeedsPasskey(false);
      setStatusMsg('');
    } catch (err) {
      if (err?.data?.code === 'PASSKEY_REQUIRED') {
        setNeedsPasskey(true);
      }
      setStatusMsg(err.message);
    } finally {
      setExportBusy(false);
    }
  }

  const policy = config?.policy;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">
            <XeroIcon emoji="ℹ️" size={22} />
            GRAFFILAND Guide &amp; Terms
          </h2>
          <button className="btn" onClick={onClose} aria-label="Close info">
            <XeroIcon emoji="✕" size={16} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn btn-sm ${tab === 'guide' ? 'btn-primary' : ''}`}
            onClick={() => setTab('guide')}
          >
            <XeroIcon emoji="📘" size={14} /> Guide
          </button>
          <button
            type="button"
            className={`btn btn-sm ${tab === 'mint' ? 'btn-primary' : ''}`}
            data-testid="info-mint-tab"
            onClick={() => setTab('mint')}
          >
            <XeroIcon emoji="🏗️" size={14} /> How to Mint
          </button>
          <button
            type="button"
            className={`btn btn-sm ${tab === 'terms' ? 'btn-primary' : ''}`}
            onClick={() => setTab('terms')}
          >
            <XeroIcon emoji="📜" size={14} /> Terms &amp; Virtual Land
          </button>
          <button
            type="button"
            className={`btn btn-sm ${tab === 'account' ? 'btn-primary' : ''}`}
            onClick={() => setTab('account')}
          >
            <XeroIcon emoji="⚙️" size={14} /> Account &amp; Settings
          </button>
        </div>

        {tab === 'mint' && (
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, lineHeight: 1.5 }}
            data-testid="info-mint-guide"
          >
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              Pick the easiest way for where you are right now — all human mints are{' '}
              <strong>gas-free</strong>:
            </div>

            <div
              className="card info-simple-card"
              style={{ borderColor: 'rgba(0, 245, 212, 0.38)' }}
            >
              <div className="info-simple-title">
                <XeroIcon emoji="📱" size={16} />
                <strong>1. Draw Art Outdoors in Mobile AR (Fastest · Permanent)</strong>
              </div>
              <p>
                Open GRAFFILAND on your phone outside, tap a real surface, draw your 3D art, and
                tap <strong>Publish</strong>. Your art and Virtual Land mint together on the spot —{' '}
                <strong>permanent ownership, no expiry timer, and no starter slot limit</strong>.
              </p>
              {typeof onStartMobileDraw === 'function' && (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    data-testid="info-mint-start-mobile-draw-btn"
                    onClick={() => onStartMobileDraw()}
                  >
                    <XeroIcon emoji="🖌️" size={13} /> Start Drawing in AR
                  </button>
                </div>
              )}
            </div>

            <div
              className="card info-simple-card"
              style={{ borderColor: 'rgba(255, 209, 102, 0.34)' }}
            >
              <div className="info-simple-title">
                <XeroIcon emoji="🗺️" size={16} />
                <strong>2. Draw a 3D Box on the Map First (Desktop · 3 Free Starter Slots)</strong>
              </div>
              <p>
                Use <strong>Draw Land</strong> on the Desktop 3D Map to outline and mint a plot
                first. It starts with a{' '}
                <strong>{STEWARD_DEFAULTS.inactivityArchiveDays}-day timer</strong> — visit it in
                person on Mobile AR and add art before time runs out to make it permanently yours
                (the timer disappears forever).
              </p>
              {(typeof onStartMapMint === 'function' || typeof onOpenMobileMap === 'function') && (
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {typeof onStartMapMint === 'function' && (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      data-testid="info-mint-start-map-btn"
                      onClick={() => onStartMapMint()}
                    >
                      <XeroIcon emoji="🏗️" size={13} /> Draw &amp; Mint 3D Land
                    </button>
                  )}
                  {typeof onOpenMobileMap === 'function' && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      data-testid="info-mint-open-map-btn"
                      onClick={() => onOpenMobileMap()}
                    >
                      <XeroIcon emoji="🗺️" size={13} /> Open Nearest Lands Map
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="card info-simple-card">
              <div className="info-simple-title">
                <XeroIcon emoji="✨" size={16} />
                <strong>3. Unlock More Slots Anytime</strong>
              </div>
              <p>
                Used all 3 free starter map slots? Visit one of your empty plots in person on
                Mobile AR and publish art on it to free up a slot — or walk to any dormant AI
                agent plot and add {STEWARD_DEFAULTS.minHumanPoolVoxels}+ blocks to awaken it and
                earn contributor royalties.
              </p>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                Note: Map plots that expire with zero in-person human interaction are archived and
                their starter slot does not reopen.
              </div>
            </div>
          </div>
        )}

        {tab === 'guide' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, lineHeight: 1.5 }}>
            {/* Clean Viewport Menu: Desktop vs Mobile */}
            <div className="info-viewport-menu" role="tablist" aria-label="Choose device guide">
              <button
                type="button"
                role="tab"
                aria-selected={viewportGuide === 'desktop'}
                className={`btn btn-sm ${viewportGuide === 'desktop' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setViewportGuide('desktop')}
              >
                <XeroIcon emoji="🖥️" size={14} /> Desktop Map &amp; 3D Land
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewportGuide === 'mobile'}
                className={`btn btn-sm ${viewportGuide === 'mobile' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setViewportGuide('mobile')}
              >
                <XeroIcon emoji="📱" size={14} /> Mobile AR Studio
              </button>
            </div>

            {viewportGuide === 'desktop' ? (
              <div key="desktop" className="info-simple-list" data-testid="info-guide-desktop">
                <div className="card info-simple-card">
                  <div className="info-simple-title">
                    <XeroIcon emoji="🗺️" size={16} />
                    <strong>Isometric 3D Map &amp; Live Search</strong>
                    <InfoTip title="Map Camera & Search">
                      Desktop starts in Isometric 3D with real OpenFreeMap buildings. Search any
                      street intersection (e.g., <em>Market &amp; 5th</em>), nearby business,
                      address, coordinates, or named Virtual Land. Switch between 2D,
                      3D, and Isometric anytime, tilt (0°–65°), rotate (±15°), or toggle Terrain.
                    </InfoTip>
                  </div>
                  <p>
                    Explore 3D buildings, jump to any intersection or business, and inspect nearby
                    sculptures, quests, and land parcels.
                  </p>
                </div>

                <div className="card info-simple-card">
                  <div className="info-simple-title">
                    <XeroIcon emoji="🏗️" size={16} />
                    <strong>Draw, Shape &amp; Mint 3D Land</strong>
                    <InfoTip title="3D Box Controls & Limits">
                      Click <strong>Draw Land</strong> and drag to place a plot matched to your map
                      angle. Hover any plot to select it: drag <strong>corner balls</strong> to
                      scale, drag <strong>side bars</strong> to stretch edges, hold &amp; drag{' '}
                      <strong>vertical corner bars</strong> to rotate, or drag the{' '}
                      <strong>center</strong> to move. Limits: 4–120m sides, max 5,000 m² area,
                      4–250m height, max 500,000 m³ volume, 3 free human starter claims. Plots
                      drawn on the map first start with a 28-day timer until a human visits in
                      person on Mobile AR and adds art to fully mint &amp; permanently own them
                      (land minted directly from manual Mobile AR art has no timer).
                    </InfoTip>
                  </div>
                  <p>
                    Draw a 3D box on the map, adjust corners, edges, rotation, and height right on
                    canvas, then mint or copy all plots for your AI agent.
                  </p>
                </div>

                <div className="card info-simple-card">
                  <div className="info-simple-title">
                    <XeroIcon emoji="🤖" size={16} />
                    <strong>AI Agents, Quests &amp; 5% / 3% / 2% Splits</strong>
                    <InfoTip title="Agentic Stewardship Economics">
                      AI Agents sign in directly with a wallet (<code>npx graffiland-mcp</code> or{' '}
                      <code>/llms.txt</code>) with {STEWARD_DEFAULTS.starterDormantSlots} starter
                      slots ($0 platform fee — agents pay own gas). Agent-created lands must receive
                      a verified in-person human interaction within{' '}
                      <strong>{STEWARD_DEFAULTS.dormantLeaseTtlHours} hours</strong> (even if the
                      agent adds 3D models) or they are archived &amp; destroyed and the consumed
                      free slot does not reopen. When an IRL human adds 3+ blocks, the land unlocks
                      +2 agent slots and every sale splits 90% Seller · 5% Platform · 3% Agent · 2%
                      Human Pool.
                    </InfoTip>
                  </div>
                  <p>
                    Connect an autonomous AI steward or pair a personal helper (<code>GLP-...</code>
                    ) to build stages, launch quests, and share sales.
                  </p>
                </div>

                <div className="card info-simple-card">
                  <div className="info-simple-title">
                    <XeroIcon emoji="🔗" size={16} />
                    <strong>Pair Phone &amp; Land Management</strong>
                    <InfoTip title="QR Mirroring & Parcel Controls">
                      Tap <strong>Pair Phone</strong> to watch phone AR strokes live on a big
                      screen. Open <strong>Land Management</strong> to rename owned parcels, add
                      IRL Contributors, or allow <code>.glb/.gltf/.obj/.stl/.ply</code> uploads.
                    </InfoTip>
                  </div>
                  <p>
                    Mirror mobile AR sculpting live over QR and manage permissions on parcels you
                    own.
                  </p>
                </div>
              </div>
            ) : (
              <div key="mobile" className="info-simple-list" data-testid="info-guide-mobile">
                <div className="card info-simple-card">
                  <div className="info-simple-title">
                    <XeroIcon emoji="🖌️" size={16} />
                    <strong>Tap Surface &amp; Paint 3D Voxels</strong>
                    <InfoTip title="Mobile Tool Carousel">
                      Tap any floor, wall, or table to anchor your grid, then swipe the bottom Key
                      Button: <strong>Brush → Pencil → Erase → Lock &amp; Scale (2-finger Z-rotate
                      &amp; sliders) → Stack → Preview → Agent Code → Publish</strong>. Supports 4x
                      precision (<code>0.05m</code> grid), matte/neon/glass finishes, up to 4,096
                      blocks, and auto-saved cloud drafts.
                    </InfoTip>
                  </div>
                  <p>
                    Point your phone camera outdoors, tap a real surface, and draw or stack glowing
                    3D blocks in space.
                  </p>
                </div>

                <div className="card info-simple-card">
                  <div className="info-simple-title">
                    <XeroIcon emoji="📡" size={16} />
                    <strong>Scene Scan &amp; Proof of Location</strong>
                    <InfoTip title="Hybrid WebXR, ORB & Passkeys">
                      Move your phone across angles to clear grayscale cells and lock GPS/altitude.
                      Binary ORB descriptors anchor art without uploading raw photos; landholders
                      can add hardware ES256 Passkeys for locked notes.
                    </InfoTip>
                  </div>
                  <p>
                    Sweep your phone around to clear grayscale areas and prove you are standing at
                    that real spot before publishing.
                  </p>
                </div>

                <div className="card info-simple-card">
                  <div className="info-simple-title">
                    <XeroIcon emoji="🪙" size={16} />
                    <strong>Free Gas Minting &amp; Local AR Chat</strong>
                    <InfoTip title="ERC-721, GLB & Encrypted Chat">
                      Human IRL mints run gas-free on{' '}
                      <strong>{config?.chain?.network?.name || 'Robinhood Chain'}</strong> as
                      standard ERC-721 NFTs with <code>.glb</code> 3D files and a 5% ERC-2981
                      royalty. Tap glowing AR bases outdoors to join camera-locked AES-256-GCM
                      chat or decrypt parcel-locked IPFS notes.
                    </InfoTip>
                  </div>
                  <p>
                    Publish gas-free 3D NFTs, unlock spot-locked encrypted chat outdoors, and earn
                    quest bounties + 2% royalties.
                  </p>
                </div>

                <div className="card info-simple-card">
                  <div className="info-simple-title">
                    <XeroIcon emoji="🗺️" size={16} />
                    <strong>Area Map, Navigation &amp; Agent Drafts</strong>
                    <InfoTip title="Navigate & Stage with AI">
                      Open the bottom-left Map to inspect nearby sculptures and launch Google Maps
                      directions. Generate a <code>GRF-...</code> code so an AI agent can stage a
                      3D draft at your GPS spot for you to review and publish.
                    </InfoTip>
                  </div>
                  <p>
                    Walk to nearby artworks with Google Maps or invite an AI agent to stage a 3D
                    draft right where you stand.
                  </p>
                </div>
              </div>
            )}

            <div
              className="card info-simple-card"
              style={{ borderColor: 'rgba(0, 245, 212, 0.28)' }}
              data-testid="info-land-lifecycle-card"
            >
              <div className="info-simple-title">
                <XeroIcon emoji="⏳" size={16} />
                <strong>Permanent Art-Minted Land vs. Pre-Claimed Land Timers &amp; Archive</strong>
                <InfoTip title="Art-Minted Permanent Land vs. 72h / 28-Day Timers">
                  When a human stands on-site in Mobile AR and manually draws art to mint land,
                  no expiry timer is needed or displayed and the land never expires or gets
                  recycled. Expiry counters apply only to land made first without physical human
                  art/interaction: {STEWARD_DEFAULTS.inactivityArchiveDays} days for human
                  map-drawn plots and {STEWARD_DEFAULTS.dormantLeaseTtlHours} hours for AI
                  agent-created plots (even if the agent adds 3D models). A human must visit in
                  person on Mobile AR and add art to fully mint &amp; permanently own it (clearing
                  the timer forever). Owners receive an alert{' '}
                  {STEWARD_DEFAULTS.expiryWarningHours} hours before expiry; free mint slots used
                  by lands that expire without in-person human users do not open back up.
                </InfoTip>
              </div>
              <p style={{ marginBottom: 6 }}>
                <strong>Land Minted From Manual Human Art (No Timer — Permanent):</strong> When a
                human draws manually in person on Mobile AR to create art and mint land,{' '}
                <strong>no countdown timer is needed or displayed</strong> — the land is{' '}
                <strong>fully minted and permanently owned</strong> and will never expire or get
                recycled.
              </p>
              <p style={{ marginBottom: 6 }}>
                <strong>Land Made First (Map-Drawn or AI Agent Land — Needs Physical Visit &amp; Art):</strong>{' '}
                The countdown counter applies only to land that has <strong>not had physical human interaction yet</strong>.{' '}
                If you create land first on the map (<strong>28-day timer</strong>) or an AI agent
                claims land first (<strong>72-hour timer</strong>, even with 3D models placed), a
                human must physically go to the land on Mobile AR and add art to{' '}
                <strong>fully mint and permanently own it</strong> (removing the timer forever).
              </p>
              <p style={{ marginBottom: 8 }}>
                <strong>Expiry, 3-Hour Alerts &amp; Free Slots:</strong> Unvisited pre-claimed
                lands send a warning <strong>3 hours before</strong> expiry and are{' '}
                <strong>archived, destroyed, and recycled</strong> when the timer runs out. Free
                mint slots used by lands that expire without in-person human users do not reopen.
              </p>
              <div style={{ fontSize: 12, marginBottom: 8 }}>
                <strong>Exact Ways a Human Interacts In Person (Mobile Camera + GPS):</strong>
                <ul style={{ margin: '5px 0 6px 18px', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {(policy?.inPersonHumanInteractions || IN_PERSON_HUMAN_INTERACTIONS).map((way) => (
                    <li key={way.id}>
                      <strong>{way.title}:</strong> {way.summary}
                    </li>
                  ))}
                </ul>
                <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                  <strong>Does not count:</strong>{' '}
                  {(policy?.nonQualifyingInteractions || NON_QUALIFYING_INTERACTIONS).join(' ')}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <a
                  href="?archive=1"
                  className="btn btn-sm btn-primary"
                  data-testid="info-open-archive-link"
                  onClick={(e) => {
                    if (typeof onOpenArchive === 'function') {
                      e.preventDefault();
                      onClose?.();
                      onOpenArchive('');
                    }
                  }}
                >
                  <XeroIcon emoji="🗄️" size={13} /> Open Land Archive
                </a>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  Browse all archived &amp; reclaimed lands and their preserved 3D snapshots.
                </span>
              </div>
            </div>

            <div className="card info-simple-card" style={{ borderColor: 'rgba(255, 209, 102, 0.25)' }}>
              <div className="info-simple-title">
                <XeroIcon emoji="🛡️" size={15} />
                <strong>Proof of Location Threat Model</strong>
                <InfoTip title="Transparency & Security Details">
                  {policy?.threatModelSummary ||
                    'GRAFFILAND combines live camera frames, optical flow, gyroscope motion, GPS/geohash checks, server-verified binary ORB landmarks, and optional ES256 WebAuthn Passkeys. Client sensors remain vulnerable to dedicated hardware replay rigs on public plots; enable Passkeys and ORB checks on high-value parcels.'}
                </InfoTip>
              </div>
              <p>
                Camera, motion, GPS, ORB landmarks, and optional Passkeys verify physical presence
                (click <strong>i</strong> for full security notes).
              </p>
            </div>

            <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', paddingTop: 2 }}>
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
              {policy?.descriptionMaxWords} words); max {policy?.maxVoxels} voxels. No URLs, scams,
              or hate speech.
            </div>
            <div className="card" style={{ padding: 11, color: 'var(--muted)', fontSize: 12 }}>
              <strong>Marketplace &amp; Co-Creation Royalty Economics (5% / 3% / 2%):</strong> Every
              sale allocates <strong>5% Platform</strong>, <strong>3% Land Steward</strong>,{' '}
              <strong>2% Human Contributor Pool</strong> (&ge;3 voxels IRL), and{' '}
              <strong>90% Net Seller</strong>. Lands minted from manual human Mobile AR art are
              permanently owned with no expiry timer and never recycle. Lands made first without
              physical human interaction carry a timer (<strong>72 hours</strong> for AI agent
              lands, even with 3D models placed; <strong>28 days</strong> for human map-drawn
              lands) until a human visits in person on Mobile AR and adds art to fully mint &amp;
              permanently own them. Unvisited lands are archived and destroyed when their timer
              expires, consumed free slots without human users do not reopen, and owners receive a
              notification <strong>3 hours</strong> before expiry.{' '}
              <a
                href="?archive=1"
                style={{ color: 'var(--accent)', fontWeight: 600 }}
                data-testid="terms-open-archive-link"
                onClick={(e) => {
                  if (typeof onOpenArchive === 'function') {
                    e.preventDefault();
                    onClose?.();
                    onOpenArchive('');
                  }
                }}
              >
                View Land Archive ↗
              </a>
            </div>
            <div className="card" style={{ padding: 11, color: 'var(--muted)', fontSize: 12 }}>
              <strong>Prohibited Content, Takedown &amp; Virtual Land Dispute Process:</strong>{' '}
              {Array.isArray(policy?.takedownAndDisputePolicy)
                ? policy.takedownAndDisputePolicy.join(' ')
                : policy?.takedownAndDisputePolicy ||
                  'GRAFFILAND prohibits illegal content, harassment, impersonation, and unsafe physical-site lures. Verified property owners or safety reporters can request moderation review; admins suppress offending sculptures via visibility controls while preserving immutable on-chain history.'}
            </div>
          </div>
        )}

        {tab === 'account' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
            <MeasurementUnitSetting />

            {!user ? (
              <div className="card" style={{ textAlign: 'center' }}>
                <p style={{ color: 'var(--muted)', marginTop: 0 }}>
                  Sign in with Google to receive minted land &amp; sculptures in your wallet.
                </p>
                <button type="button" className="btn btn-primary" onClick={onRequestLogin}>
                  <XeroIcon emoji="🔐" size={16} /> Sign in with Google
                </button>
              </div>
            ) : (
              <>
                <div className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>
                        <UserHandleBadge user={user} fallback="Creator" size="md" />
                      </div>
                      <div className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {user.email}
                      </div>
                    </div>
                    {onOpenProfile && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => {
                          onClose?.();
                          onOpenProfile();
                        }}
                      >
                        <XeroIcon emoji="👤" size={13} /> Edit Profile &amp; Public Page
                      </button>
                    )}
                  </div>
                  {user.bio && (
                    <div style={{ marginTop: 8, fontSize: 12.5, color: '#cbd5e1', lineHeight: 1.4 }}>
                      {user.bio}
                    </div>
                  )}
                  <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
                    Embedded Robinhood Chain Wallet:
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 12, wordBreak: 'break-all', color: 'var(--accent)' }}
                  >
                    {user.walletAddress}
                  </div>
                </div>

                <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div className="field-label">
                    <span>
                      Custom EVM Payout Address{' '}
                      <InfoTip title="External Payout Wallet">
                        Leave blank to use your embedded wallet. Saving an external address asks your wallet to sign a free message proving you control it (no gas, no transaction). For already-minted NFTs, open any
                        sculpture you own to transfer it or download its <code>.glb</code> file.
                      </InfoTip>
                    </span>
                  </div>
                  <input
                    className="input mono"
                    value={payoutInput}
                    onChange={(e) => setPayoutInput(e.target.value)}
                    placeholder="0x... (optional)"
                  />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={savingPayout}
                      onClick={savePayout}
                    >
                      <XeroIcon emoji="✅" size={15} /> Save Recipient
                    </button>
                    <button type="button" className="btn" disabled={exportBusy} onClick={revealKey}>
                      <XeroIcon emoji="🔑" size={15} /> Export Embedded Key
                    </button>
                    {needsPasskey && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={exportBusy}
                        onClick={enrollPasskeyForExport}
                      >
                        <XeroIcon emoji="🔐" size={15} /> Register Passkey
                      </button>
                    )}
                  </div>
                  {statusMsg && (
                    <div className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>
                      {statusMsg}
                    </div>
                  )}
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

                <button type="button" className="btn btn-danger" onClick={onLogout}>
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
