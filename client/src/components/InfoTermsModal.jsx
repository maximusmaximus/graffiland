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
                Hold the main brush trigger (or touch) and move your phone through physical space.
                Your gyroscope steers the 3D cursor in front of the live camera:
              </p>
              <ul style={{ margin: '8px 0 0 18px', padding: 0, color: 'var(--text)' }}>
                <li>
                  <XeroIcon emoji="🖌️" size={14} /> <strong>Brush Mode:</strong> Sweep continuous 3D graffiti voxels along your phone&apos;s path.
                </li>
                <li>
                  <XeroIcon emoji="🧱" size={14} /> <strong>Stack Mode:</strong> Aim at an existing voxel face to snap &amp; stack new blocks directly onto it.
                </li>
                <li>
                  <XeroIcon emoji="👁️" size={14} /> <strong>AR Preview Mode:</strong> See nearby sculptures built by real phones anchored at their exact physical coordinates and altitude, complete with solar shadows, live camera reflections, and real-time foreground occlusion.
                </li>
                <li>
                  <XeroIcon emoji="💬" size={14} /> <strong>Camera-Locked Encrypted Chat Boards:</strong> Tap any sculpture you see through your live AR camera to enter its private location chat &amp; past history. Secured client-side with AES-256-GCM &amp; ECDH P-256 — neither desktop browsers nor our server can read any chat messages.
                </li>
                <li>
                  <XeroIcon emoji="🪞" size={14} /> <strong>Foreground Occlusion:</strong> Objects or hands passing close in front of the lens naturally occlude your anchored 3D art (toggleable via the mirror icon).
                </li>
                <li>
                  <XeroIcon emoji="🔗" size={14} /> <strong>Desktop Pair:</strong> Enter a 6-letter code from the Desktop app to view your entire 3D sculpture live on a big screen while sculpting!
                </li>
              </ul>
            </div>

            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <XeroIcon emoji="📍" size={18} /> Proof of Location (Camera + GPS)
              </div>
              <p style={{ margin: 0, color: 'var(--muted)' }}>
                Every sculpture verifies physical presence using GPS stability, solar sky-luminance match,
                environmental palette fingerprinting, and real-time <strong>Camera Optical-Flow vs. Gyroscope Correlation</strong>.
                Publishing claims the surrounding ~12m &times; 12m Geohash Virtual Land parcel on IPFS &amp; Robinhood Chain.
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
