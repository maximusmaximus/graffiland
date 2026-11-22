import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import {
  buildParcelShareUrl,
  resolveLandDisplayName
} from '../../../shared/landVolume.mjs';
import { api } from '../utils/api.js';
import { getSculptureChainLinks } from '../utils/chainLinks.js';
import {
  buildSculptureShareUrl,
  copyToClipboard
} from '../utils/clipboard.js';
import {
  formatLandDimensions,
  formatLandExpiration,
  formatSculptureAssetMeta,
  formatShortDate,
  isLandOwnedByUser
} from '../utils/landMapHelpers.js';
import { EmojiInput, EmojiTextarea } from './EmojiField.jsx';
import UserHandleBadge from './UserHandleBadge.jsx';
import XeroIcon from './XeroIcon.jsx';
import MobileIsometricMap from './studio/MobileIsometricMap.jsx';

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Unified Isometric Plot Link Showcase used on BOTH Desktop and Mobile whenever
 * a user visits a direct link to a Virtual Land plot (?parcel=..., /land/<slug>).
 *
 * - Automatically opens in 3D Isometric mode with glowing land wireframe + floating Land Label
 *   and left/right side callout labels with glowing elbow pointers aimed at every 3D artwork.
 * - Clicking the Land Label, any Side Artwork Label, or any 3D artwork cleanly selects it
 *   and expands its detailed drawer below.
 * - When logged in, surfaces contextual owner/contributor management controls for the
 *   selected land or artwork right inside the expanded drawer.
 */
export default function PlotVisitView({
  variant = 'mobile', // 'mobile' | 'desktop'
  parcel,
  sculptures = [],
  allParcels = [],
  user = null,
  ownedParcelIds = [],
  config = null,
  userLocation = null,
  loading = false,
  error = '',
  onRefreshLocation = null,
  onViewInAR = null,
  onMakeArt = null,
  onSelectSculpture = null,
  onSelectNeighborParcel = null,
  onOpenManageLand = null,
  onOpenAddLandItem = null,
  onOpenProfile = null,
  onModifyInCanvas = null,
  onRequestLogin = null,
  onPlotUpdated = null,
  onClose
}) {
  const mapHostRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  // Automatically enter Isometric 3D mode whenever a user visits a plot link
  const [mapDimensionMode, setMapDimensionMode] = useState('3d'); // '3d' | '2d'
  const [isMapFull, setIsMapFull] = useState(false);

  // Interactive selection & expandable details panel below the isometric viewport
  const [selectedTarget, setSelectedTarget] = useState('land'); // 'land' | 'artwork'
  const [selectedSculptureId, setSelectedSculptureId] = useState('');
  const [detailsExpanded, setDetailsExpanded] = useState(true);

  // Local optimistic copies so inline management edits update labels & details instantaneously
  const [localParcel, setLocalParcel] = useState(parcel);
  const [localSculptures, setLocalSculptures] = useState(sculptures);
  const [fetchedNeighbors, setFetchedNeighbors] = useState([]);

  // Inline land management states
  const [editingLand, setEditingLand] = useState(false);
  const [landNameDraft, setLandNameDraft] = useState('');
  const [landDescDraft, setLandDescDraft] = useState('');
  const [landBusy, setLandBusy] = useState('');

  // Inline artwork management states
  const [editingArtworkId, setEditingArtworkId] = useState('');
  const [artTitleDraft, setArtTitleDraft] = useState('');
  const [artDescDraft, setArtDescDraft] = useState('');
  const [artBusy, setArtBusy] = useState('');
  const [confirmRemoveId, setConfirmRemoveId] = useState('');

  // Status feedback
  const [statusBanner, setStatusBanner] = useState({ text: '', isError: false });

  useEffect(() => {
    setLocalParcel(parcel);
  }, [parcel]);

  useEffect(() => {
    setLocalSculptures(Array.isArray(sculptures) ? sculptures : []);
  }, [sculptures]);

  const activeParcel = localParcel || parcel;

  // Ensure neighboring lands are available for clickable directional edge arrows on direct plot visits
  useEffect(() => {
    if (Array.isArray(allParcels) && allParcels.length > 1) return undefined;
    let cancelled = false;
    api
      .listParcels()
      .then((res) => {
        if (!cancelled && Array.isArray(res?.parcels)) {
          setFetchedNeighbors(res.parcels);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [allParcels]);

  const stageParcels = useMemo(() => {
    if (!activeParcel?.parcelId) return [];
    const out = [activeParcel];
    const seen = new Set([activeParcel.parcelId]);
    const pool = Array.isArray(allParcels) && allParcels.length > 0 ? allParcels : fetchedNeighbors;
    for (const p of pool || []) {
      if (p?.parcelId && !seen.has(p.parcelId)) {
        seen.add(p.parcelId);
        out.push(p);
      }
    }
    return out;
  }, [activeParcel, allParcels, fetchedNeighbors]);

  const handleSelectNeighborOnMap = useCallback(
    async (targetParcel) => {
      if (!targetParcel?.parcelId) return;
      if (targetParcel.parcelId === activeParcel?.parcelId) {
        setSelectedTarget('land');
        setSelectedSculptureId('');
        setEditingArtworkId('');
        setConfirmRemoveId('');
        setDetailsExpanded(true);
        setIsMapFull(false);
        return;
      }
      if (typeof onSelectNeighborParcel === 'function') {
        onSelectNeighborParcel(targetParcel);
        return;
      }
      try {
        const res = await api.getLandDetail(targetParcel.parcelId);
        if (res?.parcel) {
          setLocalParcel(res.parcel);
          setLocalSculptures(res.sculptures || []);
          setSelectedTarget('land');
          setSelectedSculptureId('');
          setEditingLand(false);
          setEditingArtworkId('');
          setConfirmRemoveId('');
          setDetailsExpanded(true);
        }
      } catch {
        // ignore transient error
      }
    },
    [activeParcel?.parcelId, onSelectNeighborParcel]
  );
  const activeSculptures = useMemo(
    () => (localSculptures || []).filter((s) => s && s.id),
    [localSculptures]
  );
  const visibleSculptures = useMemo(
    () => activeSculptures.filter((s) => !s.hidden),
    [activeSculptures]
  );

  const selectedArtwork = useMemo(() => {
    if (selectedTarget !== 'artwork' || !selectedSculptureId) return null;
    return activeSculptures.find((s) => s.id === selectedSculptureId) || null;
  }, [activeSculptures, selectedSculptureId, selectedTarget]);

  // If the selected artwork was deleted/removed, fall back cleanly to Land details
  useEffect(() => {
    if (selectedTarget === 'artwork' && selectedSculptureId && !selectedArtwork) {
      setSelectedTarget('land');
      setSelectedSculptureId('');
    }
  }, [selectedArtwork, selectedSculptureId, selectedTarget]);

  const centerLat = Number(
    activeParcel?.volume?.centerLat ?? activeParcel?.centerLat ?? activeParcel?.bounds?.center?.[0]
  );
  const centerLng = Number(
    activeParcel?.volume?.centerLng ?? activeParcel?.centerLng ?? activeParcel?.bounds?.center?.[1]
  );
  const hasCenter = Number.isFinite(centerLat) && Number.isFinite(centerLng);
  const isFrozen = Boolean(activeParcel?.frozen || activeParcel?.settings?.frozen);

  const landDisplayName = resolveLandDisplayName(
    {
      ...activeParcel,
      firstSculptureTitle: visibleSculptures[0]?.title || activeSculptures[0]?.title || ''
    },
    { defaultName: 'Virtual Land' }
  );
  const landDimensions = formatLandDimensions(activeParcel);
  const landExpiration = formatLandExpiration(activeParcel);

  const userWallets = useMemo(() => {
    const out = new Set();
    for (const raw of [user?.walletAddress, user?.customPayoutAddress, user?.activeMintRecipient]) {
      if (raw) out.add(String(raw).toLowerCase());
    }
    return out;
  }, [user]);

  const isLandOwner = useMemo(
    () => Boolean(user && activeParcel && isLandOwnedByUser(activeParcel, { user, ownedParcelIds })),
    [activeParcel, ownedParcelIds, user]
  );

  const isSelectedArtworkOwner = useMemo(() => {
    if (!user || !selectedArtwork) return false;
    if (user.id && selectedArtwork.creatorSub && selectedArtwork.creatorSub === user.id) return true;
    const ownerAddr = String(
      selectedArtwork.recipientAddress || selectedArtwork.ownerAddress || ''
    ).toLowerCase();
    return Boolean(ownerAddr && userWallets.has(ownerAddr));
  }, [selectedArtwork, user, userWallets]);

  const canManageSelectedArtwork = Boolean(
    user &&
      selectedArtwork &&
      (isLandOwner || isSelectedArtworkOwner || selectedArtwork.viewerCanEdit)
  );

  const distanceMeters = useMemo(() => {
    if (
      !hasCenter ||
      !userLocation ||
      !Number.isFinite(Number(userLocation.lat)) ||
      !Number.isFinite(Number(userLocation.lng))
    ) {
      return null;
    }
    return haversineMeters(
      Number(userLocation.lat),
      Number(userLocation.lng),
      centerLat,
      centerLng
    );
  }, [hasCenter, userLocation, centerLat, centerLng]);

  const nearThresholdMeters = useMemo(() => {
    const w = Number(activeParcel?.volume?.widthMeters || 14);
    const d = Number(activeParcel?.volume?.depthMeters || 14);
    return Math.max(75, Math.hypot(w / 2, d / 2) + 35);
  }, [activeParcel]);

  const isNearProperty = distanceMeters !== null && distanceMeters <= nearThresholdMeters;

  const directionsUrl = hasCenter
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
        `${centerLat.toFixed(6)},${centerLng.toFixed(6)}`
      )}`
    : '';

  function flashStatus(text, isError = false) {
    setStatusBanner({ text, isError });
    if (!isError) {
      setTimeout(() => {
        setStatusBanner((cur) => (cur.text === text ? { text: '', isError: false } : cur));
      }, 3200);
    }
  }

  const handleSelectLandTarget = useCallback(() => {
    setSelectedTarget('land');
    setSelectedSculptureId('');
    setEditingArtworkId('');
    setConfirmRemoveId('');
    setDetailsExpanded(true);
    setIsMapFull(false);
  }, []);

  const handleSelectArtworkTarget = useCallback((sc) => {
    if (!sc?.id) return;
    setSelectedTarget('artwork');
    setSelectedSculptureId(sc.id);
    setEditingLand(false);
    setEditingArtworkId('');
    setConfirmRemoveId('');
    setDetailsExpanded(true);
    setIsMapFull(false);
  }, []);

  // Optional 2D Leaflet fallback when user explicitly toggles 3D -> 2D
  useEffect(() => {
    if (mapDimensionMode !== '2d' || !mapHostRef.current || !hasCenter || mapRef.current) {
      return undefined;
    }

    const map = L.map(mapHostRef.current, {
      center: [centerLat, centerLng],
      zoom: 19,
      maxZoom: 21.5,
      zoomControl: false,
      attributionControl: true
    });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxNativeZoom: 19,
      maxZoom: 21.5
    }).addTo(map);

    const layer = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerRef.current = layer;

    let observer = null;
    if (typeof ResizeObserver === 'function' && mapHostRef.current) {
      observer = new ResizeObserver(() => {
        map.invalidateSize({ animate: false, pan: false });
      });
      observer.observe(mapHostRef.current);
    }

    const t = setTimeout(() => map.invalidateSize(), 100);
    return () => {
      clearTimeout(t);
      observer?.disconnect();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [hasCenter, centerLat, centerLng, mapDimensionMode]);

  useEffect(() => {
    if (mapDimensionMode !== '2d') return undefined;
    const map = mapRef.current;
    if (!map) return undefined;
    const t = setTimeout(() => map.invalidateSize({ animate: false, pan: false }), 80);
    return () => clearTimeout(t);
  }, [isMapFull, mapDimensionMode]);

  useEffect(() => {
    if (mapDimensionMode !== '2d') return;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer || !hasCenter) return;

    layer.clearLayers();
    map.invalidateSize();

    const stroke = isFrozen ? '#7dd3fc' : '#00f5d4';
    const corners = Array.isArray(activeParcel?.volume?.corners) ? activeParcel.volume.corners : [];

    let parcelLayer = null;
    if (corners.length >= 4) {
      const latLngs = corners.slice(0, 4).map(([lng, lat]) => [Number(lat), Number(lng)]);
      parcelLayer = L.polygon(latLngs, {
        color: stroke,
        weight: 3,
        fillColor: stroke,
        fillOpacity: 0.25
      })
        .on('click', () => handleSelectLandTarget())
        .addTo(layer);
    } else if (activeParcel?.bounds?.sw && activeParcel?.bounds?.ne) {
      parcelLayer = L.rectangle([activeParcel.bounds.sw, activeParcel.bounds.ne], {
        color: stroke,
        weight: 3,
        fillColor: stroke,
        fillOpacity: 0.25
      })
        .on('click', () => handleSelectLandTarget())
        .addTo(layer);
    }

    L.circleMarker([centerLat, centerLng], {
      radius: 6,
      color: '#ffffff',
      weight: 2,
      fillColor: isFrozen ? '#38bdf8' : '#ffd166',
      fillOpacity: 1
    })
      .bindTooltip(landDisplayName)
      .on('click', () => handleSelectLandTarget())
      .addTo(layer);

    for (const sc of visibleSculptures) {
      const sLat = Number(sc.lat);
      const sLng = Number(sc.lng);
      if (!Number.isFinite(sLat) || !Number.isFinite(sLng)) continue;
      L.circleMarker([sLat, sLng], {
        radius: sc.id === selectedSculptureId ? 7 : 5,
        color: '#04101a',
        weight: 1.5,
        fillColor: sc.id === selectedSculptureId ? '#ffd166' : '#ff3e7f',
        fillOpacity: 0.95
      })
        .bindTooltip(sc.title || '3D Artwork')
        .on('click', () => handleSelectArtworkTarget(sc))
        .addTo(layer);
    }

    if (
      userLocation &&
      Number.isFinite(Number(userLocation.lat)) &&
      Number.isFinite(Number(userLocation.lng))
    ) {
      L.circleMarker([Number(userLocation.lat), Number(userLocation.lng)], {
        radius: 7,
        color: '#ffffff',
        weight: 2.5,
        fillColor: '#00bbf9',
        fillOpacity: 1
      })
        .bindTooltip('You are here')
        .addTo(layer);
    }

    if (parcelLayer && typeof parcelLayer.getBounds === 'function') {
      map.fitBounds(parcelLayer.getBounds(), { padding: [44, 44], maxZoom: 21 });
    } else {
      map.setView([centerLat, centerLng], 19);
    }
  }, [
    activeParcel,
    visibleSculptures,
    selectedSculptureId,
    userLocation,
    hasCenter,
    centerLat,
    centerLng,
    isFrozen,
    landDisplayName,
    mapDimensionMode,
    handleSelectLandTarget,
    handleSelectArtworkTarget
  ]);

  async function handleCopyShareLink() {
    if (!activeParcel?.parcelId) return;
    const shareUrl = buildParcelShareUrl({
      origin: window.location.origin,
      pathname: window.location.pathname,
      parcelId: activeParcel.parcelId,
      customName: activeParcel.customName || '',
      compact: true
    });
    const ok = await copyToClipboard(shareUrl);
    flashStatus(ok ? `Copied share link for "${landDisplayName}"!` : shareUrl);
  }

  function startEditLand() {
    setLandNameDraft(String(activeParcel?.customName || ''));
    setLandDescDraft(String(activeParcel?.description || activeParcel?.curationNote || ''));
    setEditingLand(true);
    setStatusBanner({ text: '', isError: false });
  }

  async function handleSaveLandDetails(e) {
    e.preventDefault();
    if (!activeParcel?.parcelId || landBusy) return;
    const nextName = String(landNameDraft || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 48);
    const nextDesc = String(landDescDraft || '').trim().slice(0, 240);
    setLandBusy('save');
    setStatusBanner({ text: '', isError: false });
    try {
      const res = await api.updateLandParcel(activeParcel.parcelId, {
        customName: nextName,
        description: nextDesc,
        curationNote: nextDesc
      });
      const updatedParcel = {
        ...activeParcel,
        customName: res?.parcel?.customName ?? nextName,
        displayName: res?.parcel?.displayName || nextName || landDisplayName,
        description: res?.parcel?.description ?? nextDesc,
        curationNote: res?.parcel?.curationNote ?? nextDesc,
        slug: res?.parcel?.slug || activeParcel.slug
      };
      setLocalParcel(updatedParcel);
      setEditingLand(false);
      flashStatus(`Saved details for "${updatedParcel.displayName || updatedParcel.customName}"!`);
      onPlotUpdated?.({ parcel: updatedParcel, sculptures: activeSculptures });
    } catch (err) {
      flashStatus(err?.message || 'Could not save land details.', true);
    } finally {
      setLandBusy('');
    }
  }

  async function handleToggleFreezeLand() {
    if (!activeParcel?.parcelId || landBusy) return;
    const nextFrozen = !isFrozen;
    setLandBusy('freeze');
    setStatusBanner({ text: '', isError: false });
    try {
      const res = await api.updateLandSettings(activeParcel.parcelId, { frozen: nextFrozen });
      const actualFrozen = Boolean(res?.settings?.frozen ?? nextFrozen);
      const updatedParcel = {
        ...activeParcel,
        frozen: actualFrozen,
        settings: { ...(activeParcel.settings || {}), frozen: actualFrozen }
      };
      setLocalParcel(updatedParcel);
      flashStatus(
        actualFrozen
          ? `Frozen "${landDisplayName}" — placements paused.`
          : `Unfrozen "${landDisplayName}" — placements open.`
      );
      onPlotUpdated?.({ parcel: updatedParcel, sculptures: activeSculptures });
    } catch (err) {
      flashStatus(err?.message || 'Could not update freeze status.', true);
    } finally {
      setLandBusy('');
    }
  }

  function startEditArtwork(sc) {
    if (!sc) return;
    setEditingArtworkId(sc.id);
    setArtTitleDraft(String(sc.title || ''));
    setArtDescDraft(String(sc.description || ''));
    setStatusBanner({ text: '', isError: false });
  }

  async function handleSaveArtworkEdit(e, sc) {
    e.preventDefault();
    if (!sc?.id || artBusy) return;
    const nextTitle = String(artTitleDraft || '').trim().slice(0, 48);
    const nextDesc = String(artDescDraft || '').trim().slice(0, 240);
    setArtBusy('save');
    setStatusBanner({ text: '', isError: false });
    try {
      const res = await api.updateSculpture(sc.id, {
        title: nextTitle,
        description: nextDesc
      });
      const updatedSc = res?.sculpture ? { ...sc, ...res.sculpture } : { ...sc, title: nextTitle, description: nextDesc };
      const nextList = activeSculptures.map((item) => (item.id === sc.id ? updatedSc : item));
      setLocalSculptures(nextList);
      setEditingArtworkId('');
      flashStatus(`Updated "${updatedSc.title}"!`);
      onPlotUpdated?.({ parcel: activeParcel, sculptures: nextList });
    } catch (err) {
      flashStatus(err?.message || 'Could not update artwork.', true);
    } finally {
      setArtBusy('');
    }
  }

  async function handleToggleArtworkVisibility(sc) {
    if (!sc?.id || artBusy) return;
    const nextHidden = !sc.hidden;
    setArtBusy('visibility');
    setStatusBanner({ text: '', isError: false });
    try {
      const res = await api.setSculptureVisibility(sc.id, {
        hidden: nextHidden,
        reason: nextHidden ? 'Hidden by Virtual Land owner' : ''
      });
      const updatedSc = res?.sculpture ? { ...sc, ...res.sculpture } : { ...sc, hidden: nextHidden };
      const nextList = activeSculptures.map((item) => (item.id === sc.id ? updatedSc : item));
      setLocalSculptures(nextList);
      flashStatus(
        nextHidden
          ? `Hidden "${sc.title}" from public feeds.`
          : `Restored "${sc.title}" to public feeds.`
      );
      onPlotUpdated?.({ parcel: activeParcel, sculptures: nextList });
    } catch (err) {
      flashStatus(err?.message || 'Could not update artwork visibility.', true);
    } finally {
      setArtBusy('');
    }
  }

  async function handleRemoveArtwork(sc) {
    if (!sc?.id || artBusy) return;
    setArtBusy('delete');
    setStatusBanner({ text: '', isError: false });
    try {
      await api.deleteSculpture(sc.id);
      const nextList = activeSculptures.filter((item) => item.id !== sc.id);
      setLocalSculptures(nextList);
      setConfirmRemoveId('');
      setSelectedTarget('land');
      setSelectedSculptureId('');
      flashStatus(`Removed "${sc.title}" from "${landDisplayName}".`);
      onPlotUpdated?.({ parcel: activeParcel, sculptures: nextList });
    } catch (err) {
      flashStatus(err?.message || 'Could not remove artwork.', true);
    } finally {
      setArtBusy('');
    }
  }

  const stewardHandle = activeParcel?.stewardUsername || activeParcel?.ownerSub || '';

  const isDesktop = variant === 'desktop';

  return (
    <div
      className={`mobile-parcel-visit-overlay plot-visit-shell ${
        isDesktop ? 'is-desktop' : 'is-mobile'
      }`}
      role="dialog"
      aria-modal={!isDesktop}
      aria-label={`Inspect ${landDisplayName}`}
      data-testid={isDesktop ? 'desktop-plot-visit-view' : 'mobile-parcel-visit-view'}
      data-plot-parcel-id={activeParcel?.parcelId || ''}
      data-selected-target={selectedTarget}
    >
      {/* Top Bar */}
      <header className="mobile-parcel-header plot-visit-header">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <h1 className="mobile-parcel-title">
              {loading ? 'Loading Land…' : landDisplayName}
            </h1>
            {activeParcel && (
              <span
                className={`badge ${isFrozen ? 'badge-error' : 'teal'}`}
                style={{ fontSize: 10 }}
              >
                {isFrozen ? '❄️ Frozen' : '✅ Open'}
              </span>
            )}
            {isLandOwner && (
              <span className="badge gold" style={{ fontSize: 10 }} data-testid="plot-owner-badge">
                👑 Your Land
              </span>
            )}
          </div>
          {activeParcel && (
            <div className="mono plot-visit-subhead">
              {landDimensions && <span>{landDimensions}</span>}
              <span>
                {landDimensions ? ' · ' : ''}
                {visibleSculptures.length} artwork{visibleSculptures.length === 1 ? '' : 's'}
              </span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
          {!user && onRequestLogin && (
            <button
              type="button"
              className="btn btn-sm btn-outline"
              data-testid="plot-signin-btn"
              onClick={onRequestLogin}
              title="Sign in to manage your land or artworks"
            >
              <XeroIcon emoji="🔐" size={12} /> Sign In
            </button>
          )}
          {activeParcel && (
            <button
              type="button"
              className="btn btn-sm"
              aria-label="Copy parcel share link"
              title="Copy share link"
              onClick={handleCopyShareLink}
            >
              🔗
            </button>
          )}
          {isDesktop ? (
            <button
              type="button"
              className="btn btn-sm"
              aria-label="Explore full world map"
              onClick={onClose}
            >
              🗺️ Full Map
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              aria-label="Close parcel visit view"
              onClick={onClose}
            >
              <XeroIcon emoji="✕" size={14} />
            </button>
          )}
        </div>
      </header>

      {statusBanner.text && (
        <div
          className={`status-banner ${statusBanner.isError ? 'status-banner-error' : ''}`}
          role={statusBanner.isError ? 'alert' : 'status'}
          style={{ margin: '0 14px 8px' }}
        >
          {statusBanner.text}
        </div>
      )}

      {error ? (
        <div className="mobile-parcel-body">
          <div className="card" style={{ padding: 16, textAlign: 'center' }}>
            <p style={{ margin: '0 0 10px', fontSize: 14 }}>{error}</p>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              {isDesktop ? 'Return to World Map' : 'Open GRAFFILAND Studio'}
            </button>
          </div>
        </div>
      ) : loading || !activeParcel ? (
        <div
          className="mobile-parcel-body"
          style={{ alignItems: 'center', justifyContent: 'center' }}
        >
          <span className="mono" style={{ fontSize: 13, color: 'var(--muted)' }}>
            Loading isometric plot showcase…
          </span>
        </div>
      ) : (
        <>
          {/* Centerpiece Isometric Stage with Floating Land Label + Side Artwork Labels & Pointers */}
          <div
            className={`mobile-parcel-map-frame plot-visit-stage ${
              isMapFull ? 'is-fullscreen' : ''
            } ${!detailsExpanded ? 'is-expanded-view' : ''}`}
            data-map-mode={mapDimensionMode}
          >
            {mapDimensionMode === '3d' ? (
              <MobileIsometricMap
                parcels={stageParcels}
                sculptures={visibleSculptures}
                userLocation={userLocation}
                selectedParcelId={activeParcel.parcelId}
                selectedSculptureId={selectedTarget === 'artwork' ? selectedSculptureId : ''}
                isFullExpanded={isMapFull}
                showcaseMode
                landSelected={selectedTarget === 'land'}
                onToggle2D={() => setMapDimensionMode('2d')}
                onToggleFullMap={() => setIsMapFull((v) => !v)}
                onSelectLand={handleSelectLandTarget}
                onSelectParcel={handleSelectNeighborOnMap}
                onSelectSculpture={handleSelectArtworkTarget}
              />
            ) : (
              <>
                <div ref={mapHostRef} className="mobile-parcel-map-canvas" />
                <div
                  className="map-compact-fab-row"
                  onPointerDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="btn map-recenter-fab map-mode-toggle-fab"
                    data-testid="mobile-map-3d-toggle-btn"
                    aria-label="Switch to 3D isometric map"
                    title="View this land in 3D isometric mode"
                    onClick={() => setMapDimensionMode('3d')}
                  >
                    <XeroIcon emoji="🧊" size={13} /> 3D
                  </button>
                  <button
                    type="button"
                    className="btn map-recenter-fab"
                    data-testid="mobile-map-fullscreen-btn"
                    aria-label={isMapFull ? 'Exit full map' : 'Expand full map'}
                    title={isMapFull ? 'Exit full-screen map' : 'Expand map full-screen'}
                    onClick={() => setIsMapFull((v) => !v)}
                  >
                    {isMapFull ? '⤡' : '⤢'}
                  </button>
                </div>
                <div className="mobile-parcel-map-pill mono">
                  {hasCenter
                    ? `${centerLat.toFixed(5)}, ${centerLng.toFixed(5)}`
                    : landDisplayName}
                </div>
              </>
            )}
          </div>

          {/* Interactive Expandable Details & Management Drawer Below the Isometric Stage */}
          {!isMapFull && (
            <div className="plot-visit-drawer-wrap" data-testid="plot-details-drawer">
              {/* Selector Pill Bar (Land Label + Each Artwork + Expand/Collapse) */}
              <div className="plot-visit-selector-bar">
                <div className="plot-visit-selector-pills" role="tablist" aria-label="Plot items">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selectedTarget === 'land'}
                    className={`plot-selector-pill ${selectedTarget === 'land' ? 'is-active' : ''}`}
                    data-testid="plot-tab-land"
                    onClick={handleSelectLandTarget}
                  >
                    <span>📍 {landDisplayName}</span>
                  </button>
                  {activeSculptures.map((sc) => {
                    const active = selectedTarget === 'artwork' && selectedSculptureId === sc.id;
                    return (
                      <button
                        key={sc.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className={`plot-selector-pill ${active ? 'is-active' : ''} ${
                          sc.hidden ? 'is-hidden-art' : ''
                        }`}
                        data-testid="plot-tab-artwork"
                        data-sculpture-id={sc.id}
                        onClick={() => handleSelectArtworkTarget(sc)}
                      >
                        <span>
                          {sc.hidden ? '🙈 ' : '🧊 '}
                          {sc.title || '3D Artwork'}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="btn btn-xs plot-details-toggle-btn"
                  data-testid="plot-details-toggle"
                  aria-expanded={detailsExpanded}
                  onClick={() => setDetailsExpanded((v) => !v)}
                >
                  {detailsExpanded ? '▾ Hide Details' : '▴ Expand Details'}
                </button>
              </div>

              {detailsExpanded && (
                <div className="mobile-parcel-body plot-visit-body">
                  {selectedTarget === 'artwork' && selectedArtwork ? (
                    /* ================= ARTWORK DETAILS + MANAGEMENT ================= */
                    <div className="plot-detail-card" data-testid="plot-artwork-details">
                      <div className="plot-detail-head">
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <h2 className="plot-detail-title">{selectedArtwork.title}</h2>
                            <span className="badge teal" style={{ fontSize: 10 }}>
                              {selectedArtwork.layerRole === 'steward_stage'
                                ? '🏛️ Stage'
                                : '🎨 Artwork'}
                            </span>
                            {selectedArtwork.hidden && (
                              <span className="badge badge-error" style={{ fontSize: 10 }}>
                                🙈 Hidden
                              </span>
                            )}
                          </div>
                          <div className="plot-detail-meta-chips">
                            <span className="mobile-sc-chip">
                              <XeroIcon
                                emoji={selectedArtwork.modelType === 'custom-3d' ? '📦' : '🧱'}
                                size={10}
                              />{' '}
                              {formatSculptureAssetMeta(selectedArtwork)}
                            </span>
                            {(selectedArtwork.creatorUsername || selectedArtwork.creatorName) && (
                              <span className="mobile-sc-chip">
                                <UserHandleBadge
                                  user={{
                                    id: selectedArtwork.creatorSub,
                                    username: selectedArtwork.creatorUsername,
                                    creatorName: selectedArtwork.creatorName,
                                    avatarImage: selectedArtwork.creatorAvatar
                                  }}
                                  fallback="Creator"
                                  size="xs"
                                  onClick={
                                    onOpenProfile &&
                                    (selectedArtwork.creatorUsername || selectedArtwork.creatorSub)
                                      ? () =>
                                          onOpenProfile(
                                            selectedArtwork.creatorUsername ||
                                              selectedArtwork.creatorSub
                                          )
                                      : null
                                  }
                                />
                              </span>
                            )}
                            {Number.isFinite(Number(selectedArtwork.polScore)) &&
                              Number(selectedArtwork.polScore) > 0 && (
                                <span className="mobile-sc-chip">
                                  <XeroIcon emoji="🛡️" size={10} /> PoL{' '}
                                  {Math.round(Number(selectedArtwork.polScore))}
                                </span>
                              )}
                            {selectedArtwork.currentRev && (
                              <span className="mobile-sc-chip">v{selectedArtwork.currentRev}</span>
                            )}
                            {formatShortDate(selectedArtwork.createdAt) && (
                              <span className="mobile-sc-chip">
                                📅 {formatShortDate(selectedArtwork.createdAt)}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-xs"
                          onClick={handleSelectLandTarget}
                        >
                          ← Land
                        </button>
                      </div>

                      {selectedArtwork.description && (
                        <p className="mobile-parcel-desc">{selectedArtwork.description}</p>
                      )}

                      <div className="plot-detail-actions">
                        {onSelectSculpture && (
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            data-testid="plot-open-artwork-viewer-btn"
                            onClick={() => onSelectSculpture(selectedArtwork)}
                          >
                            <XeroIcon emoji="🧊" size={13} /> Inspect Full 3D &amp; Chat
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={async () => {
                            const url = buildSculptureShareUrl(selectedArtwork.id);
                            const ok = await copyToClipboard(url);
                            flashStatus(ok ? `Copied link for "${selectedArtwork.title}"!` : url);
                          }}
                        >
                          🔗 Copy Artwork Link
                        </button>
                        {(() => {
                          const links = getSculptureChainLinks(selectedArtwork, config);
                          return links.txUrl ? (
                            <a
                              className="btn btn-sm"
                              href={links.txUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              ⛓️ View On-Chain
                            </a>
                          ) : null;
                        })()}
                      </div>

                      {/* Logged-In Artwork Management Panel */}
                      {canManageSelectedArtwork && (
                        <div
                          className="card plot-mgmt-section"
                          data-testid="plot-artwork-management"
                        >
                          <div className="plot-mgmt-header">
                            <span className="plot-mgmt-title">
                              <XeroIcon emoji="⚙️" size={13} />{' '}
                              {isLandOwner || isSelectedArtworkOwner
                                ? 'Artwork Management'
                                : 'Contributor Edit Access'}
                            </span>
                            <span className="badge gold" style={{ fontSize: 10 }}>
                              {isLandOwner && !isSelectedArtworkOwner
                                ? 'Land Owner'
                                : isSelectedArtworkOwner
                                ? 'Owner'
                                : 'Contributor'}
                            </span>
                          </div>

                          {editingArtworkId === selectedArtwork.id ? (
                            <form
                              className="plot-inline-form"
                              data-testid="plot-artwork-edit-form"
                              onSubmit={(e) => handleSaveArtworkEdit(e, selectedArtwork)}
                            >
                              <label className="land-name-field">
                                <span>Artwork Title</span>
                                <EmojiInput
                                  className="input"
                                  aria-label="Edit artwork title"
                                  maxLength={48}
                                  value={artTitleDraft}
                                  disabled={artBusy !== ''}
                                  onChange={(e) => setArtTitleDraft(e.target.value)}
                                />
                              </label>
                              <label className="land-name-field">
                                <span>Description</span>
                                <EmojiTextarea
                                  className="textarea"
                                  aria-label="Edit artwork description"
                                  rows={2}
                                  maxLength={240}
                                  value={artDescDraft}
                                  disabled={artBusy !== ''}
                                  onChange={(e) => setArtDescDraft(e.target.value)}
                                />
                              </label>
                              <div className="plot-inline-form-actions">
                                <button
                                  type="submit"
                                  className="btn btn-xs btn-primary"
                                  disabled={artBusy !== ''}
                                  data-testid="plot-artwork-save-btn"
                                >
                                  {artBusy === 'save' ? 'Saving…' : '✓ Save Changes'}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-xs"
                                  disabled={artBusy !== ''}
                                  onClick={() => setEditingArtworkId('')}
                                >
                                  Cancel
                                </button>
                              </div>
                            </form>
                          ) : (
                            <div className="plot-mgmt-btn-row">
                              <button
                                type="button"
                                className="btn btn-xs"
                                data-testid="plot-artwork-edit-btn"
                                disabled={artBusy !== ''}
                                onClick={() => startEditArtwork(selectedArtwork)}
                              >
                                ✏️ Edit Title &amp; Info
                              </button>

                              {(isLandOwner || isSelectedArtworkOwner) && (
                                <button
                                  type="button"
                                  className="btn btn-xs"
                                  data-testid="plot-artwork-visibility-btn"
                                  disabled={artBusy !== ''}
                                  onClick={() => handleToggleArtworkVisibility(selectedArtwork)}
                                >
                                  {artBusy === 'visibility'
                                    ? 'Updating…'
                                    : selectedArtwork.hidden
                                    ? '👁️ Unhide Artwork'
                                    : '🙈 Hide Artwork'}
                                </button>
                              )}

                              {onModifyInCanvas && selectedArtwork.modelType !== 'custom-3d' && (
                                <button
                                  type="button"
                                  className="btn btn-xs"
                                  onClick={() => {
                                    onClose?.();
                                    onModifyInCanvas(selectedArtwork);
                                  }}
                                >
                                  🖌️ Edit in AR Canvas
                                </button>
                              )}

                              {onSelectSculpture && (
                                <button
                                  type="button"
                                  className="btn btn-xs btn-outline"
                                  onClick={() => onSelectSculpture(selectedArtwork)}
                                >
                                  ⚙️ Offset, Revisions &amp; Transfer
                                </button>
                              )}

                              {(isLandOwner || isSelectedArtworkOwner) &&
                                (confirmRemoveId === selectedArtwork.id ? (
                                  <span style={{ display: 'inline-flex', gap: 4 }}>
                                    <button
                                      type="button"
                                      className="btn btn-xs btn-danger"
                                      data-testid="plot-artwork-confirm-remove-btn"
                                      disabled={artBusy !== ''}
                                      onClick={() => handleRemoveArtwork(selectedArtwork)}
                                    >
                                      {artBusy === 'delete' ? 'Removing…' : 'Confirm Remove'}
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-xs"
                                      disabled={artBusy !== ''}
                                      onClick={() => setConfirmRemoveId('')}
                                    >
                                      Cancel
                                    </button>
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    className="btn btn-xs btn-danger"
                                    data-testid="plot-artwork-remove-btn"
                                    disabled={artBusy !== ''}
                                    onClick={() => setConfirmRemoveId(selectedArtwork.id)}
                                  >
                                    🗑️ Remove
                                  </button>
                                ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    /* ================= LAND DETAILS + MANAGEMENT ================= */
                    <div className="plot-detail-card" data-testid="plot-land-details">
                      {activeParcel.description && (
                        <p className="mobile-parcel-desc">{activeParcel.description}</p>
                      )}

                      <div className="plot-detail-meta-chips">
                        {landDimensions && (
                          <span className="mobile-sc-chip">📐 {landDimensions}</span>
                        )}
                        {onOpenProfile && stewardHandle ? (
                          <button
                            type="button"
                            className="mobile-sc-chip is-clickable"
                            onClick={() => onOpenProfile(stewardHandle)}
                          >
                            <UserHandleBadge
                              user={{
                                id: activeParcel.ownerSub || activeParcel.stewardSub,
                                username: activeParcel.stewardUsername,
                                stewardName: activeParcel.stewardName,
                                stewardType: activeParcel.stewardType,
                                avatarImage: activeParcel.stewardAvatar
                              }}
                              fallback={
                                activeParcel.stewardType === 'agent' ? 'AI Steward' : 'Land Holder'
                              }
                              size="xs"
                            />
                          </button>
                        ) : (
                          <span className="mobile-sc-chip">
                            <UserHandleBadge
                              user={{
                                id: activeParcel.ownerSub || activeParcel.stewardSub,
                                username: activeParcel.stewardUsername,
                                stewardName: activeParcel.stewardName,
                                stewardType: activeParcel.stewardType,
                                avatarImage: activeParcel.stewardAvatar
                              }}
                              fallback={
                                activeParcel.stewardType === 'agent' ? 'AI Steward' : 'Land Holder'
                              }
                              size="xs"
                            />
                          </span>
                        )}
                        <span className="mobile-sc-chip">
                          {landExpiration.state === 'permanent' ? '♾️' : '⏳'}{' '}
                          {landExpiration.badgeText}
                        </span>
                        {hasCenter && (
                          <span className="mobile-sc-chip mono">
                            📍 {centerLat.toFixed(4)}, {centerLng.toFixed(4)}
                          </span>
                        )}
                      </div>

                      {/* Mobile Proximity & AR Actions */}
                      {!isDesktop && (
                        <>
                          <div className="mobile-parcel-distance-row">
                            {isNearProperty ? (
                              <span className="badge teal" data-testid="parcel-proximity-near">
                                📍 You are at this property ({formatDistance(distanceMeters)} away)
                              </span>
                            ) : distanceMeters !== null ? (
                              <span className="badge gold" data-testid="parcel-proximity-far">
                                📍 {formatDistance(distanceMeters)} away
                              </span>
                            ) : (
                              <span className="badge" data-testid="parcel-proximity-unknown">
                                📡 Checking GPS distance…
                              </span>
                            )}
                            {onRefreshLocation && !isNearProperty && (
                              <button
                                type="button"
                                className="btn btn-xs"
                                onClick={onRefreshLocation}
                              >
                                Refresh GPS
                              </button>
                            )}
                          </div>

                          <div className="mobile-parcel-actions" data-testid="mobile-parcel-actions">
                            {isNearProperty ? (
                              <>
                                <button
                                  type="button"
                                  className="btn btn-primary mobile-parcel-cta"
                                  onClick={() => onViewInAR?.(activeParcel, visibleSculptures)}
                                >
                                  <XeroIcon emoji="👁️" size={18} /> View in AR
                                </button>

                                {!isFrozen ? (
                                  <button
                                    type="button"
                                    className="btn mobile-parcel-cta is-make-art"
                                    onClick={() => onMakeArt?.(activeParcel)}
                                  >
                                    <XeroIcon emoji="🎨" size={18} /> Make Art on This Property
                                  </button>
                                ) : (
                                  <div className="mobile-parcel-frozen-note" role="status">
                                    ❄️ This property is frozen by the owner — viewing in AR only.
                                  </div>
                                )}
                              </>
                            ) : (
                              <>
                                {directionsUrl && (
                                  <a
                                    href={directionsUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="btn btn-primary mobile-parcel-cta"
                                  >
                                    <XeroIcon emoji="🧭" size={18} /> Get Directions
                                  </a>
                                )}
                                <div className="mobile-parcel-hint">
                                  {isFrozen
                                    ? 'Walk near this property to unlock View in AR (placements are frozen).'
                                    : 'Walk near this property to unlock View in AR and Make Art on This Property.'}
                                </div>
                              </>
                            )}
                          </div>
                        </>
                      )}

                      {/* Desktop Quick Links */}
                      {isDesktop && (
                        <div className="plot-detail-actions">
                          {directionsUrl && (
                            <a
                              href={directionsUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="btn btn-sm"
                            >
                              🧭 Google Maps
                            </a>
                          )}
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={handleCopyShareLink}
                          >
                            🔗 Copy Share Link
                          </button>
                        </div>
                      )}

                      {/* Logged-In Land Management Controls */}
                      {isLandOwner && (
                        <div className="card plot-mgmt-section" data-testid="plot-land-management">
                          <div className="plot-mgmt-header">
                            <span className="plot-mgmt-title">
                              <XeroIcon emoji="⚙️" size={13} /> Land Management
                            </span>
                            <span className="badge gold" style={{ fontSize: 10 }}>
                              Owner Controls
                            </span>
                          </div>

                          {editingLand ? (
                            <form
                              className="plot-inline-form"
                              data-testid="plot-land-edit-form"
                              onSubmit={handleSaveLandDetails}
                            >
                              <label className="land-name-field">
                                <span>Land Name</span>
                                <EmojiInput
                                  className="input"
                                  aria-label="Edit land name"
                                  maxLength={48}
                                  value={landNameDraft}
                                  disabled={landBusy !== ''}
                                  onChange={(e) => setLandNameDraft(e.target.value)}
                                  placeholder="Name your land… (type : for emojis)"
                                />
                              </label>
                              <label className="land-name-field">
                                <span>Description</span>
                                <EmojiTextarea
                                  className="textarea"
                                  aria-label="Edit land description"
                                  rows={2}
                                  maxLength={240}
                                  value={landDescDraft}
                                  disabled={landBusy !== ''}
                                  onChange={(e) => setLandDescDraft(e.target.value)}
                                  placeholder="Describe this plot for visitors & agents…"
                                />
                              </label>
                              <div className="plot-inline-form-actions">
                                <button
                                  type="submit"
                                  className="btn btn-xs btn-primary"
                                  disabled={landBusy !== ''}
                                  data-testid="plot-land-save-btn"
                                >
                                  {landBusy === 'save' ? 'Saving…' : '✓ Save Land Info'}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-xs"
                                  disabled={landBusy !== ''}
                                  onClick={() => setEditingLand(false)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </form>
                          ) : (
                            <div className="plot-mgmt-btn-row">
                              <button
                                type="button"
                                className="btn btn-xs"
                                data-testid="plot-land-edit-btn"
                                disabled={landBusy !== ''}
                                onClick={startEditLand}
                              >
                                ✏️ Rename &amp; Edit Info
                              </button>
                              <button
                                type="button"
                                className={`btn btn-xs ${isFrozen ? 'btn-primary' : ''}`}
                                data-testid="plot-land-freeze-btn"
                                disabled={landBusy !== ''}
                                onClick={handleToggleFreezeLand}
                              >
                                {landBusy === 'freeze'
                                  ? 'Saving…'
                                  : isFrozen
                                  ? '🔓 Unfreeze Land'
                                  : '❄️ Freeze Land'}
                              </button>
                              {onOpenAddLandItem && (
                                <button
                                  type="button"
                                  className="btn btn-xs btn-primary"
                                  data-testid="plot-land-add-item-btn"
                                  onClick={() => onOpenAddLandItem(activeParcel.parcelId)}
                                >
                                  + Add 3D Item
                                </button>
                              )}
                              {onOpenManageLand && (
                                <button
                                  type="button"
                                  className="btn btn-xs btn-outline"
                                  data-testid="plot-land-full-manage-btn"
                                  onClick={() => onOpenManageLand(activeParcel.parcelId)}
                                >
                                  ⚙️ Full Land Settings
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Artworks Directory on This Plot */}
                      {activeSculptures.length > 0 && (
                        <div className="mobile-parcel-art-section">
                          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                            3D Artworks Here ({activeSculptures.length}) — tap any label or artwork to inspect
                          </div>
                          <div className="mobile-parcel-art-strip">
                            {activeSculptures.map((sc) => (
                              <button
                                key={sc.id}
                                type="button"
                                className={`mobile-parcel-art-chip ${
                                  selectedSculptureId === sc.id ? 'is-selected' : ''
                                }`}
                                onClick={() => handleSelectArtworkTarget(sc)}
                              >
                                <strong>
                                  {sc.hidden ? '🙈 ' : ''}
                                  {sc.title}
                                </strong>
                                <span className="mono">{formatSculptureAssetMeta(sc)}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
