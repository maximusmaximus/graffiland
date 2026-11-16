import QRCode from 'qrcode';
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../utils/api.js';
import { getMobileLaunchUrl } from '../utils/device.js';
import AdminPanel from './AdminPanel.jsx';
import GoogleLoginGate from './GoogleLoginGate.jsx';
import InfoTermsModal from './InfoTermsModal.jsx';
import MapView from './MapView.jsx';
import PairWorkbench3D from './PairWorkbench3D.jsx';
import SculptureModal from './SculptureModal.jsx';
import SculptureViewer3D from './SculptureViewer3D.jsx';
import XeroIcon from './XeroIcon.jsx';

export default function DesktopHub({ config, user, onUserUpdate, onLogout }) {
  const [tab, setTab] = useState('map'); // 'map' | 'gallery' | 'drafts' | 'pair' | 'admin'
  const [sculptures, setSculptures] = useState([]);
  const [parcels, setParcels] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [mobileModalOpen, setMobileModalOpen] = useState(false);
  const [mobileQr, setMobileQr] = useState('');

  const refreshData = useCallback(async () => {
    try {
      const [sRes, pRes] = await Promise.all([api.listSculptures(), api.listParcels()]);
      setSculptures(sRes.sculptures || []);
      setParcels(pRes.parcels || []);
    } catch {
      // ignore transient error
    }
  }, []);

  const refreshDrafts = useCallback(async () => {
    if (!user?.id) {
      setDrafts([]);
      return;
    }
    setDraftsLoading(true);
    try {
      const res = await api.listDrafts();
      setDrafts(res.drafts || []);
    } catch {
      // ignore transient error
    } finally {
      setDraftsLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  useEffect(() => {
    refreshDrafts();
  }, [refreshDrafts]);

  useEffect(() => {
    const url = getMobileLaunchUrl();
    QRCode.toDataURL(url, {
      width: 220,
      margin: 1,
      color: { dark: '#00f5d4', light: '#0b101b' }
    })
      .then(setMobileQr)
      .catch(() => {});
  }, []);

  return (
    <div className="desktop-shell">
      <header className="desktop-nav">
        <div className="brand">
          <XeroIcon emoji="🧊" size={26} />
          <span>GRAFFILAND</span>
          <span className="badge teal">3D AR · IPFS · Robinhood Chain</span>
        </div>

        <nav className="nav-tabs">
          <button
            className={`nav-tab ${tab === 'map' ? 'active' : ''}`}
            onClick={() => setTab('map')}
          >
            <XeroIcon emoji="🗺️" size={17} /> Map View
          </button>
          <button
            className={`nav-tab ${tab === 'gallery' ? 'active' : ''}`}
            onClick={() => setTab('gallery')}
          >
            <XeroIcon emoji="🧱" size={17} /> Contributions ({sculptures.length})
          </button>
          <button
            className={`nav-tab ${tab === 'drafts' ? 'active' : ''}`}
            onClick={() => setTab('drafts')}
          >
            <XeroIcon emoji="💾" size={17} /> Drafts{user ? ` (${drafts.length})` : ''}
          </button>
          <button
            className={`nav-tab ${tab === 'pair' ? 'active' : ''}`}
            onClick={() => setTab('pair')}
          >
            <XeroIcon emoji="🔗" size={17} /> 3D Pair Studio
          </button>
          <button
            className={`nav-tab ${tab === 'admin' ? 'active' : ''}`}
            onClick={() => setTab('admin')}
          >
            <XeroIcon emoji="🛡️" size={17} /> Admin
          </button>
        </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn" onClick={() => setMobileModalOpen(true)}>
            <XeroIcon emoji="📱" size={16} /> Sculpt on Phone
          </button>
          <button className="btn" onClick={() => setInfoOpen(true)} title="Info & Terms">
            <XeroIcon emoji="ℹ️" size={16} />
          </button>
          {user ? (
            <button className="btn btn-primary" onClick={() => setInfoOpen(true)}>
              <XeroIcon emoji="👤" size={16} /> {user.name}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => setLoginOpen(true)}>
              <XeroIcon emoji="🔐" size={16} /> Google Sign-In
            </button>
          )}
        </div>
      </header>

      <main className="desktop-main">
        {tab === 'map' && (
          <MapView
            sculptures={sculptures}
            parcels={parcels}
            selectedSculptureId={selected?.id || ''}
            config={config}
            onSelectSculpture={setSelected}
          />
        )}

        {tab === 'gallery' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <XeroIcon emoji="🧱" size={22} />
                <strong>All Location-Anchored 3D Sculptures</strong>
              </div>
              <button className="btn" onClick={refreshData}>
                <XeroIcon emoji="🔄" size={14} /> Refresh
              </button>
            </div>

            {sculptures.length === 0 ? (
              <div className="card" style={{ textAlign: 'center', padding: 40 }}>
                <XeroIcon emoji="📱" size={34} />
                <h3>No Sculptures Published Yet</h3>
                <p style={{ color: 'var(--muted)', maxWidth: 460, margin: '8px auto 16px' }}>
                  Drawing &amp; minting sculptures requires a mobile device with camera, gyroscope, and GPS.
                  Open GRAFFILAND on your phone or use <strong>3D Pair Studio</strong>!
                </p>
                <button className="btn btn-primary" onClick={() => setTab('pair')}>
                  <XeroIcon emoji="🔗" size={16} /> Open 3D Pair Studio
                </button>
              </div>
            ) : (
              <div className="grid-cards">
                {sculptures.map((sc) => (
                  <div
                    key={sc.id}
                    className="card"
                    style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                  >
                    <SculptureViewer3D voxels={sc.voxels || []} height={210} autoRotate />
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <strong style={{ fontSize: 15 }}>{sc.title}</strong>
                      <span className="badge gold">PoL {sc.polScore}</span>
                    </div>
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>
                      {sc.description}
                    </p>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <span className="badge teal">
                        <XeroIcon emoji="📍" size={12} /> {sc.parcelId}
                      </span>
                      <span className="badge pink">
                        <XeroIcon emoji="🪙" size={12} /> 5% Resale
                      </span>
                    </div>
                    <button className="btn" onClick={() => setSelected(sc)}>
                      <XeroIcon emoji="🔍" size={14} /> Inspect Metadata &amp; On-Chain Deed
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'drafts' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <XeroIcon emoji="💾" size={22} />
                <strong>Saved Sculpture Drafts (Unpublished Work)</strong>
              </div>
              {user && (
                <button className="btn" onClick={refreshDrafts} disabled={draftsLoading}>
                  <XeroIcon emoji="🔄" size={14} /> Refresh
                </button>
              )}
            </div>

            {!user ? (
              <div className="card" style={{ textAlign: 'center', padding: 40 }}>
                <XeroIcon emoji="🔐" size={34} />
                <h3>Sign In to View Saved Cloud Drafts</h3>
                <p style={{ color: 'var(--muted)', maxWidth: 460, margin: '8px auto 16px' }}>
                  Unfinished work auto-saves locally on your phone and syncs here automatically when
                  you sign in with Google.
                </p>
                <button className="btn btn-primary" onClick={() => setLoginOpen(true)}>
                  <XeroIcon emoji="🔐" size={16} /> Google Sign-In
                </button>
              </div>
            ) : drafts.length === 0 ? (
              <div className="card" style={{ textAlign: 'center', padding: 40 }}>
                <XeroIcon emoji="💾" size={34} />
                <h3>No Cloud Drafts Saved Yet</h3>
                <p style={{ color: 'var(--muted)', maxWidth: 460, margin: '8px auto 16px' }}>
                  Start sculpting on your phone — your work is automatically saved as a draft until
                  you publish it on-chain.
                </p>
                <button className="btn btn-primary" onClick={() => setMobileModalOpen(true)}>
                  <XeroIcon emoji="📱" size={16} /> Launch Mobile Studio
                </button>
              </div>
            ) : (
              <div className="grid-cards">
                {drafts.map((d) => (
                  <div
                    key={d.id}
                    className="card"
                    style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                  >
                    <SculptureViewer3D voxels={d.voxels || []} height={210} autoRotate />
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <strong style={{ fontSize: 15 }}>{d.title || 'Untitled Draft'}</strong>
                      <span className="badge teal">{d.voxelCount} blocks</span>
                    </div>
                    {d.description && (
                      <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.45 }}>
                        {d.description}
                      </p>
                    )}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {d.parcelId && (
                        <span className="badge">
                          <XeroIcon emoji="📍" size={12} /> {d.parcelId}
                        </span>
                      )}
                      <span className="mono" style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center' }}>
                        Updated {d.updatedAt ? new Date(d.updatedAt).toLocaleString() : ''}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        className="btn btn-primary"
                        style={{ flex: 1 }}
                        onClick={() => setMobileModalOpen(true)}
                        title="Open GRAFFILAND on your phone to continue editing or publish"
                      >
                        <XeroIcon emoji="📱" size={14} /> Resume on Phone
                      </button>
                      <button
                        className="btn btn-pink"
                        onClick={async () => {
                          await api.deleteDraft(d.id).catch(() => {});
                          setDrafts((prev) => prev.filter((item) => item.id !== d.id));
                        }}
                        aria-label={`Delete draft ${d.title || d.id}`}
                      >
                        <XeroIcon emoji="🗑️" size={14} /> Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'pair' && <PairWorkbench3D />}

        {tab === 'admin' && (
          <AdminPanel
            user={user}
            config={config}
            onModerationChange={refreshData}
            onSelectSculpture={setSelected}
          />
        )}
      </main>

      {mobileModalOpen && (
        <div className="modal-backdrop" onClick={() => setMobileModalOpen(false)}>
          <div className="modal-card" style={{ maxWidth: 420, textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                <XeroIcon emoji="📱" size={22} /> Mobile Required for Sculpting
              </h3>
              <button className="btn" onClick={() => setMobileModalOpen(false)}>
                <XeroIcon emoji="❌" size={15} />
              </button>
            </div>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>
              Creating 3D graffiti uses your phone&apos;s live camera, gyroscope brush, and GPS Proof of Location.
              Scan this QR code on your phone to launch the full-screen 3D brush:
            </p>
            {mobileQr && (
              <img
                src={mobileQr}
                alt="Mobile QR"
                style={{ width: 200, height: 200, borderRadius: 12, marginBottom: 10 }}
              />
            )}
            <div className="mono" style={{ fontSize: 11, color: 'var(--accent)', wordBreak: 'break-all' }}>
              {getMobileLaunchUrl()}
            </div>
          </div>
        </div>
      )}

      {selected && (
        <SculptureModal
          sculpture={selected}
          user={user}
          config={config}
          onSculptureUpdated={(updated) => {
            setSelected(updated);
            setSculptures((prev) =>
              prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s))
            );
          }}
          onClose={() => setSelected(null)}
        />
      )}

      {infoOpen && (
        <InfoTermsModal
          config={config}
          user={user}
          onUserUpdate={onUserUpdate}
          onLogout={() => {
            onLogout();
            setInfoOpen(false);
          }}
          onRequestLogin={() => {
            setInfoOpen(false);
            setLoginOpen(true);
          }}
          onClose={() => setInfoOpen(false)}
        />
      )}

      {loginOpen && (
        <GoogleLoginGate
          config={config}
          onSuccess={(u) => {
            onUserUpdate(u);
            setLoginOpen(false);
          }}
          onClose={() => setLoginOpen(false)}
        />
      )}
    </div>
  );
}
