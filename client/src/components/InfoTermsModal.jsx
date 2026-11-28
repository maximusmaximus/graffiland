import React, { useEffect, useMemo, useState } from 'react';
import { isAddress } from 'ethers';
import {
  IN_PERSON_HUMAN_INTERACTIONS,
  LAND_VOLUME_LIMITS,
  NON_QUALIFYING_INTERACTIONS,
  POLICY as DEFAULT_POLICY,
  STEWARD_DEFAULTS
} from '../../../shared/constants.mjs';
import {
  buildAutonomousAgentPrompt,
  buildPropertyOwnerPrompt,
  buildStdioMcpSnippet
} from '../../../shared/landSignatureMessage.mjs';
import { buildPayoutLinkMessage } from '../../../shared/payoutLinkMessage.mjs';
import { api, API_BASE } from '../utils/api.js';
import { copyToClipboard } from '../utils/clipboard.js';
import {
  isWebAuthnSupported,
  registerHardwarePasskey,
  requestPasskeyAssertion
} from '../utils/passkeyClient.js';
import { notifySettingsSaved } from '../utils/toastNotice.js';
import ArTrackingSettings from './ArTrackingSettings.jsx';
import BrandLogo from './BrandLogo.jsx';
import InfoTip from './InfoTip.jsx';
import MeasurementUnitSetting from './MeasurementUnitSetting.jsx';
import { GlobalNotificationBell } from './NotificationCenter.jsx';
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
  mcpState = null,
  onMcpStateChange = null,
  initialTab = 'guide',
  initialViewportGuide = '',
  onUserUpdate,
  onOpenProfile = null,
  onOpenArchive = null,
  onOpenPair = null,
  onOpenWelcome = null,
  onStartMapMint = null,
  onStartMobileDraw = null,
  onOpenMobileMap = null,
  onLogout,
  onRequestLogin,
  webxrSupported = null,
  webxrActive = false,
  onEnableWebxr = null,
  onDisableWebxr = null,
  onClose
}) {
  const [tab, setTab] = useState(initialTab);
  useEffect(() => {
    setTab(initialTab || 'guide');
  }, [initialTab]);
  const [viewportGuide, setViewportGuide] = useState(
    () => initialViewportGuide || detectInitialViewportTab()
  );
  useEffect(() => {
    if (initialViewportGuide) {
      setViewportGuide(initialViewportGuide);
    }
  }, [initialViewportGuide]);
  const [agentPromptPreview, setAgentPromptPreview] = useState(''); // '' | 'owner' | 'autonomous'
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentCopyFeedback, setAgentCopyFeedback] = useState('');
  const [payoutInput, setPayoutInput] = useState(user?.customPayoutAddress || '');
  const [savingPayout, setSavingPayout] = useState(false);
  const [exportedKey, setExportedKey] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [needsPasskey, setNeedsPasskey] = useState(false);

  const apiOrigin =
    API_BASE ||
    (typeof window !== 'undefined'
      ? window.location.origin
      : 'https://graffiland-api.maxinfeld-artshow.workers.dev');

  const autonomousPrompt = useMemo(
    () =>
      buildAutonomousAgentPrompt({
        apiOrigin,
        publicUrl:
          typeof window !== 'undefined' ? window.location.origin : 'https://spray.land'
      }),
    [apiOrigin]
  );

  const stdioConfigJson = useMemo(() => buildStdioMcpSnippet({ apiOrigin }), [apiOrigin]);

  const ownerPromptPreview = useMemo(
    () =>
      buildPropertyOwnerPrompt({
        apiOrigin,
        pairingCode:
          mcpState?.activePairing?.code ||
          mcpState?.pairings?.[0]?.code ||
          '<YOUR_GLP_PAIRING_CODE>',
        ownerAddress: user?.activeMintRecipient || user?.walletAddress || '<YOUR_WALLET_ADDRESS>'
      }),
    [apiOrigin, mcpState, user]
  );

  function flashAgentCopy(msg) {
    setAgentCopyFeedback(msg);
    setTimeout(() => {
      setAgentCopyFeedback((cur) => (cur === msg ? '' : cur));
    }, 3400);
  }

  async function handleCopyAutonomousPrompt() {
    const ok = await copyToClipboard(autonomousPrompt);
    flashAgentCopy(
      ok
        ? 'Copied Autonomous Agent Prompt! Paste into your AI agent.'
        : 'Clipboard unavailable — open Preview Prompt to copy.'
    );
  }

  async function handleCopyStdioConfig() {
    const ok = await copyToClipboard(stdioConfigJson);
    flashAgentCopy(ok ? 'Copied graffiland-mcp JSON config!' : 'Clipboard unavailable.');
  }

  async function handleCopyPropertyOwnerPrompt() {
    if (!user?.id) {
      const ok = await copyToClipboard(ownerPromptPreview);
      flashAgentCopy(
        ok
          ? 'Copied Property-Agent Prompt! Sign in to insert your personal GLP code.'
          : 'Sign in first to generate your personal GLP code.'
      );
      return;
    }
    setAgentBusy(true);
    try {
      let code =
        mcpState?.activePairing?.code ||
        mcpState?.pairings?.find((p) => p.status === 'pending')?.code;
      let prompt = '';
      if (!code) {
        const created = await api.createMcpPairing({ apiOrigin });
        const refreshed = await api.listMcpPairings().catch(() => null);
        if (refreshed) onMcpStateChange?.(refreshed);
        code = created?.pairing?.code || '<YOUR_GLP_PAIRING_CODE>';
        prompt =
          created?.ownerPrompt ||
          buildPropertyOwnerPrompt({
            apiOrigin,
            pairingCode: code,
            ownerAddress: user.activeMintRecipient || user.walletAddress
          });
      } else {
        prompt = buildPropertyOwnerPrompt({
          apiOrigin,
          pairingCode: code,
          ownerAddress: user.activeMintRecipient || user.walletAddress
        });
      }
      const ok = await copyToClipboard(prompt);
      flashAgentCopy(ok ? `Copied Property-Agent Prompt (${code})!` : `Generated ${code}.`);
    } catch (err) {
      flashAgentCopy(err?.message || 'Could not generate pairing prompt.');
    } finally {
      setAgentBusy(false);
    }
  }

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
      const savedMsg = address
        ? 'Mint recipient address saved.'
        : 'Reverted mint recipient to your embedded wallet.';
      setStatusMsg(savedMsg);
      notifySettingsSaved(savedMsg);
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
      const pkMsg = 'Passkey registered. Click Export Embedded Key to unlock.';
      setStatusMsg(pkMsg);
      notifySettingsSaved('Wallet export passkey saved.');
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
      <div className="modal-card info-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="info-modal-top">
          <div className="modal-header info-modal-header">
            <h2 className="modal-title" style={{ gap: 8 }}>
              <BrandLogo variant="lockup" height={26} />
              <span className="badge teal">Guide &amp; Terms</span>
            </h2>
            <div className="modal-header-actions">
              <GlobalNotificationBell compact testId="info-modal-notif-bell-btn" />
              <button className="btn btn-sm" onClick={onClose} aria-label="Close info">
                <XeroIcon emoji="✕" size={14} />
              </button>
            </div>
          </div>

          <div className="info-main-tabs" role="navigation" aria-label="Help sections">
            <button
              type="button"
              aria-pressed={tab === 'guide'}
              className={`btn btn-xs ${tab === 'guide' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setTab('guide')}
            >
              <XeroIcon emoji="📘" size={13} /> Guide
            </button>
            <button
              type="button"
              aria-pressed={tab === 'mint'}
              className={`btn btn-xs ${tab === 'mint' ? 'btn-primary' : 'btn-outline'}`}
              data-testid="info-mint-tab"
              onClick={() => setTab('mint')}
            >
              <XeroIcon emoji="🏗️" size={13} /> How to Mint
            </button>
            <button
              type="button"
              aria-pressed={tab === 'terms'}
              className={`btn btn-xs ${tab === 'terms' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setTab('terms')}
            >
              <XeroIcon emoji="📜" size={13} /> Terms &amp; Virtual Land
            </button>
            <button
              type="button"
              aria-pressed={tab === 'account'}
              className={`btn btn-xs ${tab === 'account' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setTab('account')}
            >
              <XeroIcon emoji="⚙️" size={15} /> Account &amp; Settings
            </button>
          </div>
        </div>

        <div className="info-modal-body">
          {tab === 'mint' && (
            <div className="info-tab-stack" data-testid="info-mint-guide">
              <div className="info-lead-note">
                <strong>MINT FREE LAND by making art!</strong> Pick the easiest path for where you
                are right now — all human mints are <strong>gas-free</strong>:
              </div>

              <div
                className="card info-simple-card"
                style={{ borderColor: 'rgba(0, 245, 212, 0.38)' }}
              >
                <div className="info-simple-title">
                  <XeroIcon emoji="📱" size={15} />
                  <strong>1. Draw Art Outdoors in Mobile AR (Fastest · Permanent)</strong>
                </div>
                <p>
                  Open SPRAY.LAND on your phone outside, tap a real surface, draw your 3D art, and
                  tap <strong>Publish</strong>. Your art and Virtual Land mint together on the spot —{' '}
                  <strong>permanent ownership, no expiry timer, and no starter slot limit</strong>.
                </p>
                {typeof onStartMobileDraw === 'function' && (
                  <div className="info-card-actions">
                    <button
                      type="button"
                      className="btn btn-xs btn-primary"
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
                  <XeroIcon emoji="🗺️" size={15} />
                  <strong>
                    2. Draw a 3D Box on the Map First (Desktop ·{' '}
                    {LAND_VOLUME_LIMITS.starterFreeHumanClaims} Free Starter Slots)
                  </strong>
                </div>
                <p>
                  Use <strong>Draw Land</strong> on the Desktop 3D Map to outline and mint a plot
                  first. It starts with a{' '}
                  <strong>{STEWARD_DEFAULTS.inactivityArchiveDays}-day timer</strong> — visit it in
                  person on Mobile AR and add art before time runs out to make it permanently yours
                  (the timer disappears forever).
                </p>
                {(typeof onStartMapMint === 'function' || typeof onOpenMobileMap === 'function') && (
                  <div className="info-card-actions">
                    {typeof onStartMapMint === 'function' && (
                      <button
                        type="button"
                        className="btn btn-xs btn-primary"
                        data-testid="info-mint-start-map-btn"
                        onClick={() => onStartMapMint()}
                      >
                        <XeroIcon emoji="🏗️" size={13} /> Draw &amp; Mint 3D Land
                      </button>
                    )}
                    {typeof onOpenMobileMap === 'function' && (
                      <button
                        type="button"
                        className="btn btn-xs"
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
                  <XeroIcon emoji="✨" size={15} />
                  <strong>3. Unlock More Slots Anytime</strong>
                </div>
                <p>
                  Used all {LAND_VOLUME_LIMITS.starterFreeHumanClaims} free starter map slots? Visit
                  one of your empty plots in person on Mobile AR and publish art on it to free up a
                  slot — or walk to any dormant AI agent plot and add{' '}
                  {STEWARD_DEFAULTS.minHumanPoolVoxels}+ blocks to awaken it and earn contributor
                  royalties.
                </p>
                <div className="info-footnote">
                  Note: Map plots that expire with zero in-person human interaction are archived and
                  their starter slot does not reopen.
                </div>
              </div>
            </div>
          )}

          {tab === 'guide' && (
            <div className="info-tab-stack">
              <div className="welcome-info-hint-pill info-guide-tip-strip" data-testid="info-guide-tip-callout">
                <InfoTip title="How Info Icons Work">
                  Click any <strong>i</strong> icon next to a feature or tool anywhere in SPRAY.LAND
                  to see step-by-step controls, limits, and technical notes.
                </InfoTip>
                <span>
                  Tap any <strong>i</strong> icon for controls, shortcuts &amp; technical details.
                </span>
              </div>

              {/* Clean 3-up Segmented Viewport Menu */}
              <div className="info-viewport-menu" role="tablist" aria-label="Choose device guide">
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewportGuide === 'desktop'}
                  className={`btn btn-xs ${viewportGuide === 'desktop' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setViewportGuide('desktop')}
                >
                  <XeroIcon emoji="🖥️" size={13} /> Desktop Map &amp; 3D Land
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewportGuide === 'mobile'}
                  className={`btn btn-xs ${viewportGuide === 'mobile' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setViewportGuide('mobile')}
                >
                  <XeroIcon emoji="📱" size={13} /> Mobile AR Studio
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewportGuide === 'agents'}
                  data-testid="info-guide-agents-tab"
                  className={`btn btn-xs ${viewportGuide === 'agents' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setViewportGuide('agents')}
                >
                  <XeroIcon emoji="🤖" size={13} /> AI Agents &amp; Collectors
                </button>
              </div>

              {viewportGuide === 'desktop' ? (
                <div key="desktop" className="info-guide-grid" data-testid="info-guide-desktop">
                  <div className="card info-simple-card">
                    <div className="info-simple-title">
                      <XeroIcon emoji="🗺️" size={15} />
                      <strong>3D Map, Zoom &amp; Live Search</strong>
                      <InfoTip title="Map Camera, Zoom & Search">
                        Desktop opens in 3D with real OpenFreeMap buildings &amp; terrain enabled (2D
                        hides 3D buildings for a clean top-down view). Search any street
                        intersection (e.g., <em>Market &amp; 5th</em>), business, address,
                        coordinates, or named land. Use scroll wheel, zoom/compass buttons, or{' '}
                        <strong>📐 Fit Draft</strong> to frame the full height and top rectangle of
                        any land. Switch 2D/3D, Fit Lands, and the 📍 location pin directly on the
                        map.
                      </InfoTip>
                    </div>
                    <p>
                      Explore 3D buildings, jump to any address, and frame tall land volumes.
                    </p>
                  </div>

                  <div className="card info-simple-card">
                    <div className="info-simple-title">
                      <XeroIcon emoji="🏗️" size={15} />
                      <strong>Draw, Shape &amp; Mint 3D Land</strong>
                      <InfoTip title="3D Box Controls, Shortcuts & Limits">
                        Open <strong>Mint Land</strong> (or hold down on the map) and drag to place
                        a 3D box. Drag <strong>top rim bars</strong> or the <strong>↕ orb</strong>{' '}
                        up/down to set height (auto-zooms up to 250m), <strong>corner balls</strong>{' '}
                        to scale, <strong>bottom side bars</strong> to stretch edges,{' '}
                        <strong>gold vertical bars</strong> to rotate, or the center to move.
                        Shortcuts: <strong>Esc</strong> removes a drawn draft,{' '}
                        <strong>Ctrl+Z / Cmd+Z</strong> undoes, <strong>Delete / Backspace</strong>{' '}
                        removes an unminted draft, and <strong>Ctrl+C / Ctrl+V</strong> duplicates.
                        <strong>Neon Pink</strong> lands are permanent; <strong>Amber</strong> lands
                        need IRL Mobile AR art before their timer expires. Limits: 4–120m sides, max
                        5,000 m² area, 4–250m height, max 500,000 m³ volume,{' '}
                        {LAND_VOLUME_LIMITS.starterFreeHumanClaims} free human starter claims
                        (28-day timer until in-person AR art makes it permanent).
                      </InfoTip>
                    </div>
                    <p>
                      Shape corners, edges, rotation &amp; height on canvas, press Esc/Undo, and
                      mint up to {LAND_VOLUME_LIMITS.starterFreeHumanClaims} free starter plots.
                    </p>
                  </div>

                  <div className="card info-simple-card">
                    <div className="info-simple-title">
                      <XeroIcon emoji="🔍" size={15} />
                      <strong>Search to Add 3D Items</strong>
                      <InfoTip title="9,000+ Ready-to-Place 3D Assets">
                        Click <strong>+</strong> (or <strong>🔍</strong> on open public-add lands)
                        to open <strong>Add 3D Item</strong> and browse 9,000+ ready-made{' '}
                        <code>.glb</code> props from <strong>SimReady Pile</strong>,{' '}
                        <strong>Pixels Atlas</strong>, and <strong>XeroEmoji Pile</strong>. Scroll
                        through 6 fresh picks with your mouse wheel and place one item at a time.
                        After placing, Modify &amp; Scale opens automatically with ghost previews of
                        other scene items — click any ghost to save and switch live, use Undo/Redo,
                        or press <strong>Esc</strong> to exit without saving. AI agents can call MCP{' '}
                        <code>search_3d_catalog</code> too.
                      </InfoTip>
                    </div>
                    <p>
                      Search 9,000+ SimReady, Pixels &amp; XeroEmoji props and place them one at a
                      time.
                    </p>
                  </div>

                  <div className="card info-simple-card">
                    <div className="info-simple-title">
                      <XeroIcon emoji="🖼️" size={15} />
                      <strong>Gallery, Details &amp; Previews</strong>
                      <InfoTip title="Inspecting Art & Approving Mints">
                        Browse live 3D thumbnails in the <strong>Gallery</strong> tab and click any
                        thumbnail to load that sculpture and zoom into its land. Click any minted
                        land label or 3D boundary on the map to inspect it. Pending agent sculpture
                        mints show a temporary <strong>Preview</strong> label and can be approved or
                        rejected straight from <strong>Notifications</strong>.
                      </InfoTip>
                    </div>
                    <p>
                      Click 3D Gallery thumbnails, inspect minted lands, and approve pending art in
                      Notifications.
                    </p>
                  </div>

                  <div className="card info-simple-card is-full-span">
                    <div className="info-simple-title">
                      <XeroIcon emoji="🤖" size={15} />
                      <strong>AI Agents, Pairing &amp; Land Management</strong>
                      <InfoTip title="Agent Pairing, MCP & Royalty Split">
                        Open <strong>Pairing</strong> to copy your persistent pairing code for Phone
                        AR mirroring or AI Agent MCP (<code>GLP-...</code>). Once paired,{' '}
                        <strong>Land Management</strong> unlocks so you can rename parcels, invite
                        contributors, allow <code>.glb/.gltf/.obj/.stl/.ply</code> uploads, and let
                        your paired agent read or update your profile (<code>@username</code>,{' '}
                        <code>bio</code>, avatar, banner) via MCP <code>get_my_profile</code> &amp;{' '}
                        <code>update_profile</code>. Autonomous agents connect with a wallet via{' '}
                        <code>npx graffiland-mcp</code> or <code>/llms.txt</code> (
                        {STEWARD_DEFAULTS.starterDormantSlots} starter slots,{' '}
                        {STEWARD_DEFAULTS.dormantLeaseTtlHours}h visit timer, +2 slots per awakened
                        land). Sales split 90% Seller · 5% Platform · 3% AI Agent · 2% Human
                        Artists.
                      </InfoTip>
                    </div>
                    <p>
                      Pair your phone via QR or invite AI agents with a GLP code to unlock Land
                      Management and 3D uploads.
                    </p>
                  </div>
                </div>
              ) : viewportGuide === 'agents' ? (
                <div key="agents" className="info-simple-list" data-testid="info-guide-agents">
                  <div className="card info-simple-card" style={{ borderColor: 'rgba(0, 245, 212, 0.34)' }}>
                    <div className="info-simple-title">
                      <XeroIcon emoji="🧑" size={15} />
                      <strong>Pair a Personal Helper Agent to Your Lands</strong>
                      <InfoTip title="Property-Agent Pairing, Profile Sync & 3D Asset Search">
                        Copy a <code>GLP-...</code> pairing prompt so your personal AI helper can
                        search 9,000+ ready-made 3D models &amp; emojis via MCP{' '}
                        <code>search_3d_catalog</code> (SimReady Pile, Pixels Atlas, XeroEmoji
                        Pile), generate &amp; place custom 3D art on lands you own, and inspect or
                        update your public profile (<code>@username</code>, <code>bio</code>,
                        avatar, banner) via MCP <code>get_my_profile</code> &amp;{' '}
                        <code>update_profile</code>, with two-way approval on your phone or desktop
                        notifications.
                      </InfoTip>
                    </div>
                    <p>
                      Give your AI assistant a ready-to-paste prompt linked to your account to build
                      3D models and stages on your lands.
                    </p>
                    <div className="info-card-actions">
                      <button
                        type="button"
                        className="btn btn-xs btn-primary"
                        onClick={handleCopyPropertyOwnerPrompt}
                        disabled={agentBusy}
                      >
                        <XeroIcon emoji="📋" size={13} />{' '}
                        {agentBusy ? 'Generating...' : 'Copy Property-Agent Prompt'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs"
                        onClick={() =>
                          setAgentPromptPreview((cur) => (cur === 'owner' ? '' : 'owner'))
                        }
                      >
                        <XeroIcon emoji="👀" size={12} />{' '}
                        {agentPromptPreview === 'owner' ? 'Hide Prompt' : 'Preview Prompt'}
                      </button>
                      {typeof onOpenPair === 'function' && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          onClick={() => {
                            onClose?.();
                            onOpenPair();
                          }}
                        >
                          <XeroIcon emoji="🔗" size={12} /> Pairing
                        </button>
                      )}
                      {!user && typeof onRequestLogin === 'function' && (
                        <button type="button" className="btn btn-xs" onClick={onRequestLogin}>
                          Sign In
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="card info-simple-card" style={{ borderColor: 'rgba(255, 62, 127, 0.32)' }}>
                    <div className="info-simple-title">
                      <XeroIcon emoji="🤖" size={15} />
                      <strong>Autonomous AI Agents (Wallet / MCP Auth)</strong>
                      <InfoTip title="Zero-OAuth Autonomous Login & Incentives">
                        Sign an EIP-191 challenge at <code>/api/agents/challenge</code> or run{' '}
                        <code>npx graffiland-mcp</code>. Start with{' '}
                        {STEWARD_DEFAULTS.starterDormantSlots} free land slots ($0 platform claim
                        fee; agents pay own chain network gas). When an IRL human adds{' '}
                        {STEWARD_DEFAULTS.minHumanPoolVoxels}+ blocks on your land, it locks in
                        permanently, unlocks +{STEWARD_DEFAULTS.slotsPerAwakenedLand} more slots,
                        and earns 3% of sales forever.
                      </InfoTip>
                    </div>
                    <p>
                      Zero-OAuth wallet or MCP login · Agents pay own gas · Earn 3% steward
                      royalties forever when humans visit &amp; add art.
                    </p>
                    <div className="info-card-actions">
                      <button
                        type="button"
                        className="btn btn-xs btn-primary"
                        onClick={handleCopyAutonomousPrompt}
                      >
                        <XeroIcon emoji="📋" size={13} /> Copy Autonomous Agent Prompt
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs"
                        onClick={handleCopyStdioConfig}
                      >
                        <XeroIcon emoji="⚙️" size={15} /> MCP Config
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs"
                        onClick={() =>
                          setAgentPromptPreview((cur) => (cur === 'autonomous' ? '' : 'autonomous'))
                        }
                      >
                        <XeroIcon emoji="👀" size={12} />{' '}
                        {agentPromptPreview === 'autonomous' ? 'Hide Prompt' : 'Preview Prompt'}
                      </button>
                      <a
                        className="btn btn-xs"
                        href={`${apiOrigin}/llms.txt`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        /llms.txt
                      </a>
                      <a
                        className="btn btn-xs"
                        href={`${apiOrigin}/.well-known/agent.json`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        agent.json
                      </a>
                    </div>
                  </div>

                  {agentCopyFeedback && (
                    <div className="mono desktop-intro-feedback" role="status" aria-live="polite">
                      ✅ {agentCopyFeedback}
                    </div>
                  )}

                  {agentPromptPreview && (
                    <textarea
                      readOnly
                      className="input mono"
                      rows={5}
                      style={{ width: '100%', fontSize: 11, lineHeight: 1.45 }}
                      aria-label="Agent connection prompt preview"
                      value={agentPromptPreview === 'autonomous' ? autonomousPrompt : ownerPromptPreview}
                    />
                  )}

                  <div className="card info-simple-card">
                    <div className="info-simple-title">
                      <XeroIcon emoji="💎" size={15} />
                      <strong>Collectors, Chat Access &amp; Verified IRL 3D NFTs</strong>
                      <InfoTip title="Proof of Real Presence, Land Chat Permissions & Revenue Split">
                        Every human piece is verified via live phone camera, motion sensors, and
                        GPS, and stored as a standard ERC-721 + 3D <code>.glb</code> asset. Every
                        marketplace trade splits 90% Seller · 5% Platform · 3% AI Agent Steward · 2%
                        verified IRL Human Artists. Encrypted Land Chat is mobile in-person only
                        (within 75m) and open to the land holder &amp; any contributor to that land
                        by default — land holders can manage <strong>Land Chat Access</strong>{' '}
                        (Contributors, Everyone On Site, Whitelist Only, or Off) and the{' '}
                        <strong>Chat Whitelist</strong> anytime in <strong>Land Management</strong>{' '}
                        or via paired MCP tools.
                      </InfoTip>
                    </div>
                    <p>
                      Collect verified 3D NFTs (90% / 5% / 3% / 2% split) and manage Land Chat
                      access (Contributors default, Whitelist Only, Open, or Off) in Land
                      Management.
                    </p>
                  </div>
                </div>
              ) : (
                <div key="mobile" className="info-guide-grid" data-testid="info-guide-mobile">
                  <div className="card info-simple-card">
                    <div className="info-simple-title">
                      <XeroIcon emoji="📡" size={15} />
                      <strong>1. Aim, Scan &amp; Lock Surface</strong>
                      <InfoTip title="Surface Scan, Calibration & Multi-Sensor AR">
                        Allow Camera, GPS, Compass, and Gyroscope. Sweep your phone until the
                        calibration scan reaches <strong>100%</strong> so Proof of Location locks
                        your spot and shrinks into the compact dock right above the bottom tool
                        selector, then choose Draw, Paint, or Add 3D Model. Press and{' '}
                        <strong>hold the center circle</strong> to lock your start surface and draw
                        right at that location; <strong>tap the circle again</strong> anytime to
                        unlock and move to a new spot. SPRAY.LAND fuses
                        True-North compass (WMM declination), 60Hz gyroscope, Kalman GPS, off-thread
                        ORB landmarks, and automatic 6-DoF ARCore calibration when supported by your
                        device (toggleable anytime in Profile ⚙️ Settings). Pro tip: slipping off
                        your phone case (especially magnetic or thick cases) often gives much
                        cleaner compass &amp; AR calibration — and if calibration is still playing
                        hard to get, just hand the prompt to your AI sidekick and let your bot drop
                        fresh 3D models onto the land for you!
                      </InfoTip>
                    </div>
                    <p>
                      Allow Camera, GPS &amp; Gyroscope — once calibrated to 100%, hold the center
                      circle to lock &amp; draw at that spot, or tap it again to change location.
                    </p>
                    <div
                      className="guide-calibration-pro-tip"
                      data-testid="guide-calibration-case-ai-tip"
                    >
                      <XeroIcon emoji="💡" size={13} />
                      <span>
                        <strong>Calibration Trick:</strong> Many users get way sharper calibration
                        by taking off their phone case! Still fighting a stubborn calibration? Let
                        your AI sidekick flex — send the prompt and have your bot drop crisp 3D
                        models straight onto the land for you! 🤖✨
                      </span>
                    </div>
                  </div>

                  <div className="card info-simple-card">
                    <div className="info-simple-title">
                      <XeroIcon emoji="🖌️" size={15} />
                      <strong>2. Paint Freely &amp; Lock/Scale With 3D Bars</strong>
                      <InfoTip title="Spray Brush, 3D Manipulator Bars & Mobile Gestures">
                        Hold and sweep your phone freely like a real spray can (no 10 ft origin
                        lockout!), or tap inside the center tool/block-diameter reticle circle on
                        Brush/Pencil. Open the <strong>🎨</strong> dock for colors, S/M/L/XL sizes,
                        and Matte/Neon/Glass finishes, or swipe to <strong>Stack</strong> (hold to
                        build off faces). In <strong>Lock &amp; Scale</strong>, drag the Land-style{' '}
                        <strong>3D wireframe bars &amp; corner orbs</strong> directly (cyan bottom
                        bars move, gold vertical bars rotate, top bars/elevator lift, corner orbs
                        scale) — or use <strong>2 fingers up/down to Z-pivot</strong>,{' '}
                        <strong>2 fingers left/right to rotate</strong>, and pinch to scale. Drawing
                        tools automatically fade existing land art so strokes stay clear (3D
                        collision stays active). Tap bottom-right{' '}
                        <strong>Copy Agent Prompt (🤖)</strong> (camera hides cleanly) to let your
                        AI agent add art, claim land, or update your profile. Access your lands and
                        ⚙️ Settings anytime from your account name.
                      </InfoTip>
                    </div>
                    <p>
                      Paint freely with no 10 ft limit, drag Land-style 3D bars or 2-finger Z-pivot
                      &amp; rotate in Lock &amp; Scale, or open Copy Agent Prompt.
                    </p>
                  </div>

                  <div className="card info-simple-card">
                    <div className="info-simple-title">
                      <XeroIcon emoji="🔍" size={15} />
                      <strong>3. Search &amp; Place 3D Items in AR</strong>
                      <InfoTip title="Mobile Search to Place & 3D Wireframe Scale">
                        Tap the floating <strong>🔍 (3-blocks)</strong> search button directly above
                        the bottom-left Map icon (or in the bottom carousel — the camera pauses
                        cleanly while you browse) to search SimReady Pile, Pixels Atlas, and
                        XeroEmoji Pile. Placing an item opens a live 3D preview in{' '}
                        <strong>Lock &amp; Scale</strong> with Land-style 3D bars and 2-finger
                        Z-pivot/rotate/pinch gestures — then tap <strong>✅ Draw</strong> to paint
                        or <strong>🚀 Publish</strong> to mint.
                      </InfoTip>
                    </div>
                    <p>
                      Tap 🔍 (blocks badge) above Map to place 3D props &amp; emojis, shape with 3D
                      bars or 2-finger gestures, and resume drawing or minting.
                    </p>
                  </div>

                  <div className="card info-simple-card">
                    <div className="info-simple-title">
                      <XeroIcon emoji="🪙" size={15} />
                      <strong>4. Claim Permanent Land &amp; AR Chat</strong>
                      <InfoTip title="ERC-721, IPFS, GLB & Encrypted Chat">
                        Publishing in person IRL pins your 3D art to IPFS and mints gas-free on{' '}
                        <strong>{config?.chain?.network?.name || 'Robinhood Chain'}</strong> as an
                        ERC-721 NFT + <code>.glb</code> file with permanent land ownership (no
                        expiry timer) and a 5% ERC-2981 royalty. By default, the land holder and{' '}
                        <strong>any user contributor to that land</strong> can join camera-locked
                        AES-256-GCM AR Land Chat within 75m to unlock pinned notes (and get a Bell
                        🔔 notification when on a land with live chat). Land holders can switch chat
                        anytime in <strong>Land Management</strong> (or via paired MCP) to{' '}
                        <strong>Contributors (Default)</strong>, <strong>Everyone On Site</strong>,{' '}
                        <strong>Whitelist Only</strong>, or <strong>Off</strong>. If chat is locked,
                        tap the <strong>i</strong> beside the greyed-out 🔒 Land Chat button to see
                        why.
                      </InfoTip>
                    </div>
                    <p>
                      Publish IRL to IPFS for permanent gas-free land (5% royalty) &amp; pinned
                      notes. Land contributors can chat by default within 75m; land holders can
                      switch to Whitelist Only, Open, or Off in Land Management.
                    </p>
                  </div>

                  <div className="card info-simple-card is-full-span">
                    <div className="info-simple-title">
                      <XeroIcon emoji="🗺️" size={15} />
                      <strong>5. Area Map, Nearest Lands &amp; Approvals</strong>
                      <InfoTip title="3D Map, Directions & Pending Mints">
                        Open the bottom-left Map to explore nearby lands in 2D or 3D (expandable
                        full screen), get walking directions, preview pending agent mints marked{' '}
                        <strong>Preview</strong>, and approve them directly from Notifications.
                      </InfoTip>
                    </div>
                    <p>
                      Explore nearby lands in 2D/3D, get walking directions, or approve AI agent art
                      from Notifications.
                    </p>
                  </div>
                </div>
              )}

              <div className="welcome-split-pill mono info-split-bar">
                Sale Split: <strong>90% Seller</strong> · <strong>5% Platform</strong> ·{' '}
                <strong>3% AI Agent</strong> · <strong>2% Human Artists</strong>
              </div>

              <div
                className="card info-simple-card info-lifecycle-card"
                data-testid="info-land-lifecycle-card"
              >
                <div className="info-simple-title">
                  <XeroIcon emoji="⏳" size={15} />
                  <strong>Permanent Land vs. Pre-Claimed Timers &amp; Archive</strong>
                  <InfoTip title="Art-Minted Permanent Land vs. 72h / 28-Day Timers">
                    Manual IRL Mobile AR art mints land permanently with no expiry timer — it will
                    never expire or get recycled. Timers apply only to land made first without
                    in-person human interaction: {STEWARD_DEFAULTS.inactivityArchiveDays} days for
                    human map-drawn plots and {STEWARD_DEFAULTS.dormantLeaseTtlHours} hours for AI
                    agent plots (even with 3D models placed). Visit in person on Mobile AR and add
                    art to clear the timer forever. Alerts fire{' '}
                    {STEWARD_DEFAULTS.expiryWarningHours} hours before expiry; expired free slots do
                    not reopen.
                  </InfoTip>
                </div>

                <div className="info-lifecycle-grid">
                  <div className="info-lifecycle-box is-permanent">
                    <strong>No Timer — Permanent</strong>
                    <p>
                      Manual IRL Mobile AR art mints permanently — lands{' '}
                      <strong>never expire or get recycled</strong>.
                    </p>
                  </div>
                  <div className="info-lifecycle-box is-timed">
                    <strong>Land Made First (Needs IRL Visit)</strong>
                    <p>
                      Map-drawn (<strong>28-day timer</strong>) &amp; AI agent (
                      <strong>72-hour timer</strong>) lands need an IRL Mobile AR visit + art.
                      Alerts fire <strong>3 hours before</strong> expiry; expired free slots{' '}
                      <strong>do not reopen</strong>.
                    </p>
                  </div>
                </div>

                <div className="info-interactions-block">
                  <div className="info-interactions-label">
                    Qualifying In-Person Interactions (Mobile Camera + GPS):
                  </div>
                  <div className="info-interactions-grid">
                    {(policy?.inPersonHumanInteractions || IN_PERSON_HUMAN_INTERACTIONS).map(
                      (way) => (
                        <div key={way.id} className="info-interaction-chip">
                          <strong>{way.title}</strong>
                          <span>{way.summary}</span>
                        </div>
                      )
                    )}
                  </div>
                  <div className="info-footnote">
                    <strong>Does not count:</strong>{' '}
                    {(policy?.nonQualifyingInteractions || NON_QUALIFYING_INTERACTIONS).join(' ')}
                  </div>
                </div>

                <div className="info-archive-row">
                  <a
                    href="?archive=1"
                    className="btn btn-xs btn-primary"
                    data-testid="info-open-archive-link"
                    onClick={(e) => {
                      if (typeof onOpenArchive === 'function') {
                        e.preventDefault();
                        onClose?.();
                        onOpenArchive('');
                      }
                    }}
                  >
                    <XeroIcon emoji="🗄️" size={12} /> Open Land Archive
                  </a>
                  <span className="info-footnote">
                    Browse archived &amp; reclaimed lands with preserved 3D snapshots.
                  </span>
                </div>
              </div>

              <div
                className="card info-simple-card info-security-strip"
                style={{ borderColor: 'rgba(255, 209, 102, 0.25)' }}
              >
                <div className="info-simple-title">
                  <XeroIcon emoji="🛡️" size={14} />
                  <strong>Proof of Location Threat Model</strong>
                  <InfoTip title="Transparency & Security Details">
                    {policy?.threatModelSummary ||
                      'SPRAY.LAND combines live camera frames, optical flow, gyroscope motion, GPS/geohash checks, server-verified binary ORB landmarks, and optional ES256 WebAuthn Passkeys. Client sensors remain vulnerable to dedicated hardware replay rigs on public plots; enable Passkeys and ORB checks on high-value parcels.'}
                  </InfoTip>
                </div>
                <p>
                  Camera, motion, GPS, ORB landmarks &amp; optional Passkeys verify physical
                  presence (tap <strong>i</strong> for full security notes).
                </p>
              </div>

              <div className="info-guide-footer">
                {typeof onOpenWelcome === 'function' && (
                  <button
                    type="button"
                    className="btn btn-xs"
                    data-testid="info-reopen-intro-btn"
                    onClick={() => {
                      onClose?.();
                      onOpenWelcome();
                    }}
                  >
                    <XeroIcon emoji="👋" size={12} /> Intro Walkthrough
                  </button>
                )}
                <span className="info-footnote">
                  SPRAY.LAND Voxel Spray Can · Audiowide (SIL OFL 1.1) · Xero Emoji by Max Infeld
                  (CC BY 4.0)
                </span>
              </div>
            </div>
          )}

          {tab === 'terms' && (
            <div className="info-tab-stack">
              <div className="badge teal" style={{ alignSelf: 'flex-start' }}>
                <XeroIcon emoji="📜" size={14} /> Version {policy?.termsVersion || DEFAULT_POLICY.termsVersion}
              </div>
              <div
                className="card terms-safety-warning-card"
                data-testid="terms-experimental-safety-card"
                role="note"
              >
                <div className="terms-safety-warning-head">
                  <XeroIcon emoji="⚠️" size={15} />
                  <strong>Experimental Tech, Battery Drain &amp; Physical Safety Disclaimer</strong>
                </div>
                <p>
                  {policy?.experimentalSafetyDisclaimer || DEFAULT_POLICY.experimentalSafetyDisclaimer}
                </p>
              </div>
              {(policy?.termsText?.length ? policy.termsText : DEFAULT_POLICY.termsText).map((line, i) => (
                <div key={i} className="card" style={{ padding: '10px 12px', color: 'var(--text)' }}>
                  {line}
                </div>
              ))}
              <div className="card" style={{ padding: '10px 12px', color: 'var(--muted)', fontSize: 12 }}>
                <strong>Limited Terms Rules:</strong> Title {policy?.titleMin}–{policy?.titleMax}{' '}
                chars; Description {policy?.descriptionMin}–{policy?.descriptionMax} chars (max{' '}
                {policy?.descriptionMaxWords} words); max {policy?.maxVoxels} voxels. No URLs,
                scams, or hate speech.
              </div>
              <div className="card" style={{ padding: '10px 12px', color: 'var(--muted)', fontSize: 12 }}>
                <strong>Marketplace &amp; Co-Creation Royalty Economics (5% / 3% / 2%):</strong>{' '}
                Every sale allocates <strong>5% Platform</strong>, <strong>3% Land Steward</strong>,{' '}
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
              <div className="card" style={{ padding: '10px 12px', color: 'var(--muted)', fontSize: 12 }}>
                <strong>Prohibited Content, Takedown &amp; Virtual Land Dispute Process:</strong>{' '}
                {Array.isArray(policy?.takedownAndDisputePolicy)
                  ? policy.takedownAndDisputePolicy.join(' ')
                  : policy?.takedownAndDisputePolicy ||
                    'SPRAY.LAND prohibits illegal content, harassment, impersonation, and unsafe physical-site lures. Verified property owners or safety reporters can request moderation review; admins suppress offending sculptures via visibility controls while preserving immutable on-chain history.'}
              </div>
            </div>
          )}

          {tab === 'account' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
              <MeasurementUnitSetting />
              <ArTrackingSettings
                webxrSupported={webxrSupported}
                webxrActive={webxrActive}
                onEnableWebxr={onEnableWebxr}
                onDisableWebxr={onDisableWebxr}
              />

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
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        gap: 8,
                        flexWrap: 'wrap'
                      }}
                    >
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
                          Leave blank to use your embedded wallet. Saving an external address asks
                          your wallet to sign a free message proving you control it (no gas, no
                          transaction). For already-minted NFTs, open any sculpture you own to
                          transfer it or download its <code>.glb</code> file.
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
                      <div
                        className="mono settings-inline-saved"
                        data-testid="account-settings-saved"
                        role="status"
                      >
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
    </div>
  );
}
