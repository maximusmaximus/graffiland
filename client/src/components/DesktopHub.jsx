import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import { buildPropertyOwnerPrompt } from '../../../shared/landSignatureMessage.mjs';
import { api, API_BASE } from '../utils/api.js';
import {
  buildSculptureShareUrl,
  buildShareToXUrl,
  copyToClipboard
} from '../utils/clipboard.js';
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
  const [quests, setQuests] = useState([]);
  const [listings, setListings] = useState([]);
  const [dualLeaders, setDualLeaders] = useState({ aiStewards: [], humanArtists: [] });
  const [marketBusyId, setMarketBusyId] = useState('');
  const [marketNotice, setMarketNotice] = useState('');
  const [userLocation, setUserLocation] = useState(null);
  const [areaFilter, setAreaFilter] = useState(() =>
    initialSession.areaFilter === 'all' ? 'all' : 'nearby'
  );
  const [sidebarTab, setSidebarTab] = useState('list'); // 'list' | 'gallery' | 'quests' | 'market' | 'leaders'
  const [copiedId, setCopiedId] = useState('');
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
      const [sRes, pRes, qRes, mRes, lRes] = await Promise.all([
        api.listSculptures({ includeVoxels: false }),
        api.listParcels(),
        api.getNearbyQuests().catch(() => ({ quests: [] })),
        api.listMarketplaceListings().catch(() => ({ listings: [] })),
        api.getAgentLeaderboard(25).catch(() => ({ aiStewards: [], humanArtists: [] }))
      ]);
      const nextList = sRes.sculptures || [];
      setSculptures(nextList);
      setParcels(pRes.parcels || []);
      setQuests(qRes.quests || []);
      setListings(mRes.listings || []);
      setDualLeaders({
        aiStewards: lRes.aiStewards || [],
        humanArtists: lRes.humanArtists || []
      });
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
    const deepId = new URLSearchParams(window.location.search).get('sculpture');
    if (deepId) {
      api
        .getSculpture(deepId)
        .then((res) => {
          if (res?.sculpture) {
            setSelected(res.sculpture);
            setLastSculpture(res.sculpture);
          }
        })
        .catch(() => {});
    }
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

  const creatorLeaderboard = useMemo(() => {
    const byCreator = new Map();
    for (const sc of sculptures || []) {
      const key = sc.creatorEmail || sc.creatorName || sc.recipientAddress || 'anonymous';
      if (!byCreator.has(key)) {
        byCreator.set(key, {
          key,
          name: sc.creatorName || 'Street Artist',
          sculptures: 0,
          voxels: 0,
          parcels: new Set()
        });
      }
      const entry = byCreator.get(key);
      entry.sculptures += 1;
      entry.voxels += Number(sc.voxelCount || sc.voxels?.length || 0);
      if (sc.parcelId) entry.parcels.add(sc.parcelId);
    }
    return Array.from(byCreator.values())
      .map((item) => ({ ...item, parcelCount: item.parcels.size }))
      .sort((a, b) => b.sculptures - a.sculptures || b.voxels - a.voxels)
      .slice(0, 15);
  }, [sculptures]);

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

  async function handleBuyListing(listing) {
    if (!user?.id) {
      setLoginOpen(true);
      return;
    }
    setMarketBusyId(listing.id);
    setMarketNotice('');
    try {
      const out = await api.buyMarketplaceListing(listing.id, {});
      setMarketNotice(
        `Purchased ${listing.sculptureTitle || 'NFT'}! Splits settled: 5% Platform (${out.splits.platform.amountEth} ETH) · 3% Agent (${out.splits.agentSteward.amountEth} ETH) · 2% Human Pool (${out.splits.humanContributors.poolEth} ETH)`
      );
      await refreshData();
    } catch (err) {
      setMarketNotice(err.message || 'Purchase failed');
    } finally {
      setMarketBusyId('');
    }
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

            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`btn ${sidebarTab === 'list' ? 'btn-primary' : ''}`}
                style={{ padding: '4px 7px', fontSize: 11, flex: '1 1 auto' }}
                onClick={() => setSidebarTab('list')}
              >
                <XeroIcon emoji="📍" size={11} /> List
              </button>
              <button
                type="button"
                className={`btn ${sidebarTab === 'quests' ? 'btn-primary' : ''}`}
                style={{ padding: '4px 7px', fontSize: 11, flex: '1 1 auto' }}
                onClick={() => setSidebarTab('quests')}
              >
                <XeroIcon emoji="🔥" size={11} /> Quests ({quests.length})
              </button>
              <button
                type="button"
                className={`btn ${sidebarTab === 'market' ? 'btn-primary' : ''}`}
                style={{ padding: '4px 7px', fontSize: 11, flex: '1 1 auto' }}
                onClick={() => setSidebarTab('market')}
              >
                <XeroIcon emoji="🛒" size={11} /> Market ({listings.length})
              </button>
              <button
                type="button"
                className={`btn ${sidebarTab === 'gallery' ? 'btn-primary' : ''}`}
                style={{ padding: '4px 7px', fontSize: 11, flex: '1 1 auto' }}
                onClick={() => setSidebarTab('gallery')}
              >
                <XeroIcon emoji="🎨" size={11} /> Gallery
              </button>
              <button
                type="button"
                className={`btn ${sidebarTab === 'leaders' ? 'btn-primary' : ''}`}
                style={{ padding: '4px 7px', fontSize: 11, flex: '1 1 auto' }}
                onClick={() => setSidebarTab('leaders')}
              >
                <XeroIcon emoji="🏆" size={11} /> Leaders
              </button>
            </div>

            {sidebarTab !== 'leaders' && sidebarTab !== 'quests' && sidebarTab !== 'market' && (
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
            )}

            {sidebarTab === 'list' && areaFilter === 'nearby' && userLocation && nearbyMatches.length === 0 && sculptures.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                No sculptures within 5km yet — showing all {sculptures.length} global sculptures sorted closest first.
              </div>
            )}

            {sidebarTab === 'list' && lastSculpture && (
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

            {sidebarTab === 'quests' ? (
              <div className="desktop-nearby-list" aria-label="Agent Land Quests">
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)', padding: '2px 2px 6px' }}>
                  Visit Agent-claimed Virtual Lands IRL on mobile to earn 2x First-Spark XP &amp; permanent 2% Human Pool royalties.
                </div>
                {quests.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)', padding: '12px 4px' }}>
                    No active quests yet. AI stewards can deploy stages &amp; quests via graffiland-mcp!
                  </div>
                ) : (
                  quests.map((q) => {
                    const parcelSculpture = sculptures.find((s) => s.parcelId === q.parcelId);
                    return (
                      <div key={q.id} className="desktop-nearby-item" style={{ cursor: 'default' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, width: '100%', flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: 12.5 }}>{q.title}</strong>
                          <span className={`badge ${q.firstSparkBoost ? 'pink' : 'teal'}`} style={{ fontSize: 10 }}>
                            {q.firstSparkBoost ? '🔥 First-Spark · 2x XP' : '🎨 Active Quest'}
                          </span>
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'left', marginTop: 2 }}>
                          {q.prompt}
                        </div>
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
                          <span className="badge gold" style={{ fontSize: 10 }}>{q.parcelId}</span>
                          <span className="badge" style={{ fontSize: 10 }}>🤖 {q.stewardName}</span>
                          {q.bountyEth > 0 && (
                            <span className="badge teal" style={{ fontSize: 10 }}>
                              🏆 {q.bountyEth} ETH Bounty
                            </span>
                          )}
                          <span className="badge" style={{ fontSize: 10 }}>
                            🪑 {q.openSlotsCount} plinth slots
                          </span>
                        </div>
                        {parcelSculpture && (
                          <button
                            type="button"
                            className="btn btn-primary"
                            style={{ marginTop: 6, padding: '3px 9px', fontSize: 11, alignSelf: 'flex-start' }}
                            onClick={() => openSculpture(parcelSculpture)}
                          >
                            Inspect Land Stage
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            ) : sidebarTab === 'market' ? (
              <div className="desktop-nearby-list" aria-label="GRAFFILAND Marketplace">
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--accent)', padding: '2px 2px 6px' }}>
                  Every sale allocates 5% Platform · 3% Agent Steward · 2% Human Contributors Pool · 90% Seller
                </div>
                {marketNotice && (
                  <div className="card" style={{ padding: 8, fontSize: 11, color: 'var(--accent)', marginBottom: 6 }}>
                    {marketNotice}
                  </div>
                )}
                {listings.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)', padding: '12px 4px' }}>
                    No active NFT listings yet. Open any owned sculpture to list it for sale.
                  </div>
                ) : (
                  listings.map((lst) => (
                    <div key={lst.id} className="desktop-nearby-item" style={{ cursor: 'default' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, width: '100%' }}>
                        <strong style={{ fontSize: 12.5 }}>{lst.sculptureTitle || lst.sculptureId}</strong>
                        <span className="badge teal" style={{ fontSize: 11 }}>{lst.priceEth} ETH</span>
                      </div>
                      <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3 }}>
                        {lst.parcelId} · Seller: {lst.sellerName}
                      </div>
                      {lst.splits && (
                        <div className="mono" style={{ fontSize: 10, color: 'var(--accent-gold)', marginTop: 4 }}>
                          5% Plat ({lst.splits.platform?.amountEth} ETH) · 3% Agent ({lst.splits.agentSteward?.amountEth} ETH) · 2% Humans ({lst.splits.humanContributors?.poolEth} ETH)
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ padding: '4px 10px', fontSize: 11 }}
                          disabled={marketBusyId === lst.id}
                          onClick={() => handleBuyListing(lst)}
                        >
                          {marketBusyId === lst.id ? 'Settling...' : `Buy (${lst.priceEth} ETH)`}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : sidebarTab === 'leaders' ? (
              <div className="desktop-nearby-list" aria-label="Creator Leaderboard">
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', margin: '2px 0 4px' }}>
                  <XeroIcon emoji="🎨" size={12} /> Human Street Artists (2% Contributor Pool)
                </div>
                {creatorLeaderboard.length === 0 && dualLeaders.humanArtists.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 4px' }}>
                    No human builders ranked yet.
                  </div>
                ) : (
                  (dualLeaders.humanArtists.length > 0
                    ? dualLeaders.humanArtists.map((h) => ({
                        key: h.userId,
                        name: h.name,
                        sculptures: h.sculptureCount,
                        parcelCount: h.parcelsVisited,
                        metaText: `${h.totalXp} XP · ${h.landsAwakened} awakened`
                      }))
                    : creatorLeaderboard.map((c) => ({
                        key: c.key,
                        name: c.name,
                        sculptures: c.sculptures,
                        parcelCount: c.parcelCount,
                        metaText: `${c.voxels.toLocaleString()} total 3D blocks`
                      }))
                  ).map((entry, idx) => (
                    <div key={entry.key} className="desktop-nearby-item" style={{ cursor: 'default' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, width: '100%' }}>
                        <strong style={{ fontSize: 12.5 }}>
                          #{idx + 1} {entry.name}
                        </strong>
                        <span className="badge teal" style={{ fontSize: 10 }}>
                          {entry.sculptures} art · {entry.parcelCount} land
                        </span>
                      </div>
                      <span className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                        {entry.metaText}
                      </span>
                    </div>
                  ))
                )}
                <div style={{ fontSize: 11, fontWeight: 700, color: '#ff9f1c', margin: '10px 0 4px' }}>
                  <XeroIcon emoji="🤖" size={12} /> AI Land Stewards (3% Steward Royalties)
                </div>
                {dualLeaders.aiStewards.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', padding: '4px' }}>
                    No AI stewards registered yet. Agents onboard via /llms.txt &amp; graffiland-mcp!
                  </div>
                ) : (
                  dualLeaders.aiStewards.map((ag, idx) => (
                    <div key={ag.agentId} className="desktop-nearby-item" style={{ cursor: 'default' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, width: '100%' }}>
                        <strong style={{ fontSize: 12.5 }}>
                          #{idx + 1} {ag.name}
                        </strong>
                        <span className="badge gold" style={{ fontSize: 10 }}>
                          {ag.activatedLandsCount} awakened · {ag.attractedHumans || 0} humans
                        </span>
                      </div>
                      <span className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                        {ag.totalXp} XP · {ag.earnedRoyaltiesEth || 0} ETH earned · {ag.availableSlots} free slots
                      </span>
                    </div>
                  ))
                )}
              </div>
            ) : sidebarTab === 'gallery' ? (
              <div className="desktop-nearby-list" aria-label="Sculpture Gallery">
                {displayedSculptures.map((sc) => (
                  <div
                    key={sc.id}
                    className="desktop-nearby-item"
                    onClick={() => openSculpture(sc)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openSculpture(sc);
                      }
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, width: '100%' }}>
                      <strong style={{ fontSize: 13 }}>{sc.title}</strong>
                      <span className="badge gold" style={{ fontSize: 10 }}>{sc.parcelId}</span>
                    </div>
                    {sc.description && (
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'left' }}>
                        {sc.description}
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, width: '100%', marginTop: 4 }}>
                      <span className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>
                        {sc.modelType === 'custom-3d' ? '3D File' : `${sc.voxelCount || 0} blocks`} · PoL {sc.polScore}
                      </span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          type="button"
                          className="btn"
                          style={{ padding: '2px 7px', fontSize: 10.5 }}
                          onClick={async (e) => {
                            e.stopPropagation();
                            await copyToClipboard(buildSculptureShareUrl(sc.id));
                            setCopiedId(sc.id);
                            setTimeout(() => setCopiedId(''), 1800);
                          }}
                        >
                          {copiedId === sc.id ? 'Copied!' : 'Copy Link'}
                        </button>
                        <a
                          className="btn"
                          style={{ padding: '2px 7px', fontSize: 10.5 }}
                          href={buildShareToXUrl({
                            title: sc.title,
                            parcelId: sc.parcelId,
                            sculptureId: sc.id
                          })}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          𝕏
                        </a>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
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
            )}
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
