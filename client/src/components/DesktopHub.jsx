import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import { buildPropertyOwnerPrompt } from '../../../shared/landSignatureMessage.mjs';
import { api, API_BASE } from '../utils/api.js';
import AdminPanel from './AdminPanel.jsx';
import GoogleLoginGate from './GoogleLoginGate.jsx';
import InfoTermsModal from './InfoTermsModal.jsx';
import LandManagementModal from './LandManagementModal.jsx';
import MapView from './MapView.jsx';
import PairWorkbench3D from './PairWorkbench3D.jsx';
import SculptureModal from './SculptureModal.jsx';
import XeroIcon from './XeroIcon.jsx';

const DESKTOP_SESSION_KEY = 'graffiland_desktop_session_v1';
const DESKTOP_NOTICE_SESSION_KEY = 'graffiland_desktop_notice_dismissed_v1';
const NEARBY_RADIUS_METERS = 5000;

function loadDesktopSession() {
  try {
    const raw = localStorage.getItem(DESKTOP_SESSION_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveDesktopSession(nextState) {
  try {
    localStorage.setItem(
      DESKTOP_SESSION_KEY,
      JSON.stringify({
        ...nextState,
        updatedAt: new Date().toISOString()
      })
    );
  } catch {
    // ignore storage quota errors
  }
}

function summarizeSculptureSnapshot(sc) {
  if (!sc || !sc.id) return null;
  return {
    id: sc.id,
    title: sc.title,
    description: sc.description,
    lat: sc.lat,
    lng: sc.lng,
    altitude: sc.altitude,
    parcelId: sc.parcelId,
    parcelBounds: sc.parcelBounds,
    voxelCount: sc.voxelCount,
    voxels: Array.isArray(sc.voxels) ? sc.voxels.slice(0, 4096) : [],
    polScore: sc.polScore,
    chain: sc.chain,
    ipfs: sc.ipfs,
    ownerAddress: sc.ownerAddress,
    ownerUserId: sc.ownerUserId,
    createdAt: sc.createdAt
  };
}

function formatDistanceLabel(meters) {
  if (!Number.isFinite(meters)) return '';
  if (meters < 1000) return `${Math.round(meters)}m away`;
  return `${(meters / 1000).toFixed(1)}km away`;
}

export default function DesktopHub({ config, user, onUserUpdate, onLogout }) {
  const initialSession = useMemo(() => loadDesktopSession(), []);

  const [sculptures, setSculptures] = useState([]);
  const [parcels, setParcels] = useState([]);
  const [userLocation, setUserLocation] = useState(null);
  const [areaFilter, setAreaFilter] = useState(() =>
    initialSession.areaFilter === 'all' ? 'all' : 'nearby'
  );
  const [mapViewport, setMapViewport] = useState(() => initialSession.mapViewport || null);
  const [lastSculpture, setLastSculpture] = useState(
    () => initialSession.lastSculptureSnapshot || null
  );
  const [selected, setSelected] = useState(() =>
    initialSession.activeView === 'sculpture' && initialSession.lastSculptureSnapshot
      ? initialSession.lastSculptureSnapshot
      : null
  );
  const [pairOpen, setPairOpen] = useState(() => initialSession.activeView === 'pair');
  const [infoOpen, setInfoOpen] = useState(() => initialSession.activeView === 'info');
  const [landManageOpen, setLandManageOpen] = useState(false);
  const [landManageParcelId, setLandManageParcelId] = useState('');
  const [myLands, setMyLands] = useState({ parcelCount: 0, parcels: [] });
  const [adminOpen, setAdminOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [mcpState, setMcpState] = useState({ mcpActive: false, activePairing: null, pairings: [] });
  const [mcpNotice, setMcpNotice] = useState('');
  const [mobileNoticeDismissed, setMobileNoticeDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DESKTOP_NOTICE_SESSION_KEY) === '1';
    } catch {
      return false;
    }
  });

  const activeView = selected
    ? 'sculpture'
    : pairOpen
    ? 'pair'
    : infoOpen
    ? 'info'
    : 'map';

  useEffect(() => {
    saveDesktopSession({
      areaFilter,
      mapViewport,
      lastSculptureId: lastSculpture?.id || '',
      lastSculptureSnapshot: summarizeSculptureSnapshot(lastSculpture),
      activeView
    });
  }, [areaFilter, mapViewport, lastSculpture, activeView]);

  const refreshData = useCallback(async () => {
    try {
      const [sRes, pRes] = await Promise.all([api.listSculptures(), api.listParcels()]);
      const nextList = sRes.sculptures || [];
      setSculptures(nextList);
      setParcels(pRes.parcels || []);
      setLastSculpture((prev) => {
        if (!prev?.id) return prev;
        const fresh = nextList.find((item) => item.id === prev.id);
        return fresh ? { ...prev, ...fresh } : prev;
      });
      setSelected((prev) => {
        if (!prev?.id) return prev;
        const fresh = nextList.find((item) => item.id === prev.id);
        return fresh ? { ...prev, ...fresh } : prev;
      });
    } catch {
      // ignore transient error
    }
  }, []);

  const refreshMyLands = useCallback(() => {
    if (!user?.id) {
      setMyLands({ parcelCount: 0, parcels: [] });
      return;
    }
    api
      .getMyLands()
      .then((res) => setMyLands(res || { parcelCount: 0, parcels: [] }))
      .catch(() => {});
  }, [user?.id]);

  useEffect(() => {
    refreshData();
    refreshMyLands();
  }, [refreshData, refreshMyLands]);

  useEffect(() => {
    if (!user?.id || !pairOpen) return;
    api
      .listMcpPairings()
      .then(setMcpState)
      .catch(() => {});
  }, [user?.id, pairOpen]);

  useEffect(() => {
    if (!navigator.geolocation) return undefined;
    let active = true;
    const onPos = (pos) => {
      if (!active) return;
      setUserLocation({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude
      });
    };
    navigator.geolocation.getCurrentPosition(onPos, () => {}, {
      enableHighAccuracy: false,
      maximumAge: 60000,
      timeout: 7000
    });
    const watchId = navigator.geolocation.watchPosition(onPos, () => {}, {
      enableHighAccuracy: false,
      maximumAge: 60000,
      timeout: 12000
    });
    return () => {
      active = false;
      navigator.geolocation.clearWatch?.(watchId);
    };
  }, []);

  const sculpturesSorted = useMemo(() => {
    const withDist = (sculptures || []).map((sc) => {
      const distanceMeters =
        userLocation &&
        Number.isFinite(Number(sc.lat)) &&
        Number.isFinite(Number(sc.lng))
          ? Math.round(haversineMeters(userLocation.lat, userLocation.lng, sc.lat, sc.lng))
          : null;
      return { ...sc, distanceMeters };
    });
    if (userLocation) {
      withDist.sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity));
    }
    return withDist;
  }, [sculptures, userLocation]);

  const nearbyMatches = useMemo(() => {
    if (!userLocation) return [];
    return sculpturesSorted.filter(
      (sc) => sc.distanceMeters !== null && sc.distanceMeters <= NEARBY_RADIUS_METERS
    );
  }, [sculpturesSorted, userLocation]);

  const displayedSculptures = useMemo(() => {
    if (areaFilter === 'nearby' && userLocation && nearbyMatches.length > 0) {
      return nearbyMatches;
    }
    return sculpturesSorted;
  }, [areaFilter, userLocation, nearbyMatches, sculpturesSorted]);

  const handleViewportChange = useCallback((vp) => {
    setMapViewport(vp);
  }, []);

  function openSculpture(sc) {
    if (!sc) return;
    setPairOpen(false);
    setInfoOpen(false);
    setSelected(sc);
    setLastSculpture(sc);
  }

  function openPairModal() {
    setSelected(null);
    setInfoOpen(false);
    setPairOpen(true);
  }

  function openInfoModal() {
    setSelected(null);
    setPairOpen(false);
    setInfoOpen(true);
  }

  function dismissMobileNotice() {
    setMobileNoticeDismissed(true);
    try {
      sessionStorage.setItem(DESKTOP_NOTICE_SESSION_KEY, '1');
    } catch {
      // ignore
    }
  }

  return (
    <div className="desktop-shell">
      <header className="desktop-nav">
        <div className="brand">
          <XeroIcon emoji="🧊" size={26} />
          <span>GRAFFILAND</span>
          <span className="badge teal">Desktop Map Explorer</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {lastSculpture && (
            <button
              type="button"
              className="btn"
              onClick={() => openSculpture(lastSculpture)}
              title={`Reopen last interacted sculpture: ${lastSculpture.title}`}
            >
              <XeroIcon emoji="🕒" size={15} /> Last Viewed: {lastSculpture.title}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={openPairModal}>
            <XeroIcon emoji="🔗" size={16} /> Pair Phone (QR · Large 3D View)
          </button>
          {(myLands.parcelCount > 0 || (myLands.parcels && myLands.parcels.length > 0)) && (
            <button
              type="button"
              className="btn"
              style={{ borderColor: 'rgba(255, 209, 102, 0.6)', color: 'var(--accent-gold)' }}
              onClick={() => {
                setLandManageParcelId('');
                setLandManageOpen(true);
              }}
              title="Manage owned lands, IRL contributors, 3D models & agent permissions"
            >
              <XeroIcon emoji="🗺️" size={16} /> Land Management ({myLands.parcelCount || myLands.parcels.length})
            </button>
          )}
          <button type="button" className="btn" onClick={openInfoModal} title="Info & Guide">
            <XeroIcon emoji="ℹ️" size={16} /> Info
          </button>
          {user?.isAdmin && (
            <button
              type="button"
              className="btn"
              onClick={() => setAdminOpen(true)}
              title="Admin Moderation"
            >
              <XeroIcon emoji="🛡️" size={15} /> Admin
            </button>
          )}
          {user ? (
            <button type="button" className="btn" onClick={openInfoModal}>
              <XeroIcon emoji="👤" size={16} /> {user.name}
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => setLoginOpen(true)}>
              <XeroIcon emoji="🔐" size={16} /> Sign In
            </button>
          )}
        </div>
      </header>

      <main className="desktop-main">
        {!mobileNoticeDismissed && (
          <div className="desktop-mobile-notice" role="status" aria-live="polite">
            <div className="desktop-mobile-notice-body">
              <XeroIcon emoji="📱" size={20} />
              <div>
                <strong>Mobile Required for Full Functionality</strong> — Desktop displays only the
                interactive map and large-screen viewing. Use a mobile device (camera, gyroscope
                &amp; GPS) to create/capture sculptures and publish them on-chain.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" className="btn btn-primary" onClick={openPairModal}>
                <XeroIcon emoji="🔗" size={14} /> Pair with QR Code
              </button>
              <button type="button" className="btn" onClick={openInfoModal}>
                <XeroIcon emoji="ℹ️" size={14} /> Learn More
              </button>
              <button
                type="button"
                className="btn"
                onClick={dismissMobileNotice}
                aria-label="Dismiss mobile notice"
                title="Dismiss notice"
              >
                <XeroIcon emoji="❌" size={13} />
              </button>
            </div>
          </div>
        )}

        <div className="desktop-map-layout">
          <div className="desktop-map-stage">
            <MapView
              sculptures={displayedSculptures}
              parcels={parcels}
              userLocation={userLocation}
              focusArea={areaFilter === 'nearby' && Boolean(userLocation) && nearbyMatches.length > 0}
              selectedSculptureId={selected?.id || lastSculpture?.id || ''}
              initialView={mapViewport}
              onViewportChange={handleViewportChange}
              config={config}
              onSelectSculpture={openSculpture}
            />
          </div>

          <aside className="card desktop-nearby-panel" aria-label="Sculptures around you">
            <div className="desktop-nearby-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700 }}>
                <XeroIcon emoji="📍" size={17} />
                <span>Sculptures Around You</span>
              </div>
              <button
                type="button"
                className="btn"
                style={{ padding: '5px 9px', fontSize: 11 }}
                onClick={refreshData}
                title="Refresh sculptures & parcels"
              >
                <XeroIcon emoji="🔄" size={12} />
              </button>
            </div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`btn ${areaFilter === 'nearby' ? 'btn-primary' : ''}`}
                style={{ padding: '5px 10px', fontSize: 12, flex: 1 }}
                onClick={() => setAreaFilter('nearby')}
              >
                Near Me {userLocation ? `(${nearbyMatches.length})` : ''}
              </button>
              <button
                type="button"
                className={`btn ${areaFilter === 'all' ? 'btn-primary' : ''}`}
                style={{ padding: '5px 10px', fontSize: 12, flex: 1 }}
                onClick={() => setAreaFilter('all')}
              >
                Global ({sculptures.length})
              </button>
            </div>

            {areaFilter === 'nearby' && userLocation && nearbyMatches.length === 0 && sculptures.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                No sculptures within 5km yet — showing all {sculptures.length} global sculptures sorted closest first.
              </div>
            )}

            {lastSculpture && (
              <button
                type="button"
                className="desktop-nearby-item is-last-viewed"
                onClick={() => openSculpture(lastSculpture)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, width: '100%' }}>
                  <strong style={{ fontSize: 12 }}>
                    <XeroIcon emoji="🕒" size={12} /> Last Viewed: {lastSculpture.title}
                  </strong>
                  <span className="badge gold" style={{ fontSize: 10 }}>
                    {lastSculpture.parcelId}
                  </span>
                </div>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Click to reopen 3D view, land parcel &amp; on-chain deed
                </span>
              </button>
            )}

            <div className="desktop-nearby-list">
              {displayedSculptures.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--muted)', padding: '12px 4px' }}>
                  No published sculptures on the map yet. Pair or open GRAFFILAND on your mobile phone to create the first piece nearby!
                </div>
              ) : (
                displayedSculptures.map((sc) => {
                  const isActive = (selected?.id || lastSculpture?.id) === sc.id;
                  return (
                    <button
                      key={sc.id}
                      type="button"
                      className={`desktop-nearby-item ${isActive ? 'is-selected' : ''}`}
                      onClick={() => openSculpture(sc)}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, width: '100%' }}>
                        <strong style={{ fontSize: 13, textAlign: 'left' }}>{sc.title}</strong>
                        {sc.distanceMeters !== null && (
                          <span className="badge teal" style={{ fontSize: 10 }}>
                            {formatDistanceLabel(sc.distanceMeters)}
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span className="badge" style={{ fontSize: 10 }}>
                          {sc.parcelId}
                        </span>
                        <span className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>
                          {sc.voxelCount || sc.voxels?.length || 0} blocks · PoL {sc.polScore}
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </aside>
        </div>
      </main>

      {pairOpen && (
        <div className="modal-backdrop" onClick={() => setPairOpen(false)}>
          <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">
                <XeroIcon emoji="🔗" size={22} /> Pair Phone via QR · Large 3D Drawing View
              </h2>
              <button
                type="button"
                className="btn"
                onClick={() => setPairOpen(false)}
                aria-label="Close pairing modal"
              >
                <XeroIcon emoji="❌" size={15} />
              </button>
            </div>
            <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--muted)' }}>
              Scan the QR code below with your mobile phone to draw &amp; create in AR while watching
              your sculpture build live in this larger 3D workspace. Remember: publishing on-chain is
              completed on mobile (or signed by your paired agent when initiated from mobile).
            </p>
            {user && (
              <div className="card" style={{ padding: 12, marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>Robust MCP Agent Pairing</span>
                    <span className={`badge ${mcpState.mcpActive ? 'teal' : 'gold'}`}>
                      {mcpState.mcpActive
                        ? mcpState.activePairing?.keyConnected
                          ? '🟢 MCP Active · Keys Connected'
                          : '🟢 MCP Active'
                        : '🟡 Inactive Until Connected'}
                    </span>
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                    {mcpState.activePairing?.code || mcpState.pairings?.[0]?.code || 'No active GLP pairing code yet'}
                  </div>
                  {mcpNotice && (
                    <div className="mono" style={{ fontSize: 11, color: 'var(--accent)', marginTop: 4 }}>
                      {mcpNotice}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={async () => {
                      const created = await api.createMcpPairing({
                        apiOrigin: API_BASE || window.location.origin
                      });
                      const updated = await api.listMcpPairings();
                      setMcpState(updated);
                      const prompt =
                        created.ownerPrompt ||
                        buildPropertyOwnerPrompt({
                          apiOrigin: API_BASE || window.location.origin,
                          pairingCode: created.pairing?.code,
                          ownerAddress: user.activeMintRecipient || user.walletAddress
                        });
                      await navigator.clipboard?.writeText(prompt);
                      setMcpNotice(`Generated ${created.pairing?.code} & copied Property Owner MCP Prompt.`);
                    }}
                  >
                    <XeroIcon emoji="🔑" size={14} /> New Robust Code &amp; Copy MCP Prompt
                  </button>
                  {mcpState.activePairing && (
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={async () => {
                        await api.disconnectMcpPairing(mcpState.activePairing.code);
                        const updated = await api.listMcpPairings();
                        setMcpState(updated);
                        setMcpNotice('Disconnected MCP pairing.');
                      }}
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              </div>
            )}
            <PairWorkbench3D inModal />
          </div>
        </div>
      )}

      {adminOpen && user?.isAdmin && (
        <div className="modal-backdrop" onClick={() => setAdminOpen(false)}>
          <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">
                <XeroIcon emoji="🛡️" size={20} /> Admin Moderation
              </h2>
              <button type="button" className="btn" onClick={() => setAdminOpen(false)}>
                <XeroIcon emoji="❌" size={15} />
              </button>
            </div>
            <AdminPanel
              user={user}
              config={config}
              onModerationChange={refreshData}
              onSelectSculpture={(sc) => {
                setAdminOpen(false);
                openSculpture(sc);
              }}
            />
          </div>
        </div>
      )}

      {selected && (
        <SculptureModal
          sculpture={selected}
          user={user}
          config={config}
          userLocation={userLocation}
          onSculptureUpdated={(updated) => {
            setSelected(updated);
            setLastSculpture(updated);
            setSculptures((prev) =>
              prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s))
            );
            refreshMyLands();
          }}
          onOpenLandManagement={(pid) => {
            setLandManageParcelId(pid || '');
            setLandManageOpen(true);
          }}
          onClose={() => {
            setSelected(null);
            refreshData();
            refreshMyLands();
          }}
        />
      )}

      {landManageOpen && user && (
        <LandManagementModal
          user={user}
          initialParcelId={landManageParcelId}
          onSelectSculpture={(sc) => openSculpture(sc)}
          onWorkspaceChanged={() => {
            refreshData();
            refreshMyLands();
          }}
          onClose={() => setLandManageOpen(false)}
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
