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
  formatDistanceMeters,
  formatLandDimensions,
  formatLandExpiration,
  formatSculptureAssetMeta,
  formatShortDate,
  isLandOwnedByUser
} from '../utils/landMapHelpers.js';
import { computeSideArtworkCallouts } from '../utils/map3dLabelOverlay.js';
import { useMeasurementUnits } from '../utils/measurementUnits.js';
import { getLeafletTileConfig, useMapTheme } from '../utils/mapTheme.js';
import { buildPendingPreviewSculptures } from '../utils/pendingApprovalPreview.js';
import { notifySettingsSaved } from '../utils/toastNotice.js';
import { recordUserAction } from '../utils/userHistory.js';
import { EmojiInput, EmojiTextarea } from './EmojiField.jsx';
import InfoTip from './InfoTip.jsx';
import UserHandleBadge from './UserHandleBadge.jsx';
import XeroIcon from './XeroIcon.jsx';
import MobileIsometricMap from './studio/MobileIsometricMap.jsx';

function formatDistance(meters, unitSystem = 'metric') {
  return formatDistanceMeters(meters, unitSystem);
}

function formatCompactViewCount(value) {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function formatApprovalExpiresIn(iso) {
  if (!iso) return '';
  const ts = Date.parse(String(iso));
  if (!Number.isFinite(ts)) return '';
  const remainMin = Math.max(0, Math.ceil((ts - Date.now()) / 60000));
  if (remainMin === 0) return 'expiring soon';
  return `${remainMin}m left`;
}

function getApprovalActionEmoji(action = '') {
  if (action === 'create_sculpture' || action === 'publish_sculpture') return '🎨';
  if (action === 'update_sculpture' || action === 'rollback_sculpture_revision') return '🛠️';
  if (action === 'set_sculpture_visibility') return '👁️';
  if (action === 'delete_sculpture' || action === 'erase_land') return '🗑️';
  if (action === 'update_land_settings') return '❄️';
  if (action === 'update_land_volume') return '📐';
  if (action === 'update_parcel') return '🏷️';
  return '✍️';
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
const EMPTY_ARRAY = [];

export default function PlotVisitView({
  variant = 'mobile', // 'mobile' | 'desktop'
  parcel,
  sculptures = EMPTY_ARRAY,
  allParcels = EMPTY_ARRAY,
  user = null,
  ownedParcelIds = EMPTY_ARRAY,
  config = null,
  userLocation = null,
  loading = false,
  error = '',
  onViewInAR = null,
  onMakeArt = null,
  onSelectSculpture = null,
  onSelectNeighborParcel = null,
  onOpenManageLand = null,
  onOpenAddLandItem = null,
  onOpenPair = null,
  onOpenProfile = null,
  onModifyInCanvas = null,
  onRequestLogin = null,
  onPlotUpdated = null,
  onClose
}) {
  const mapHostRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const tileLayerRef = useRef(null);
  const map2dParcelLayerRef = useRef(null);
  const { mapTheme, isDarkMap } = useMapTheme();
  const mapThemeRef = useRef(mapTheme);
  useEffect(() => {
    mapThemeRef.current = mapTheme;
  }, [mapTheme]);
  const map2dUserMovedRef = useRef(false);
  const map2dInitialFittedRef = useRef(false);
  const sharedViewportRef = useRef(null);

  // Automatically enter Isometric 3D mode whenever a user visits a plot link
  const [mapDimensionMode, setMapDimensionMode] = useState('3d'); // '3d' | '2d'
  const [isMapFull, setIsMapFull] = useState(false);
  const isMapFullRef = useRef(false);
  const [map2dOverlay, setMap2dOverlay] = useState({
    width: 0,
    height: 0,
    landTag: null,
    callouts: []
  });

  useEffect(() => {
    isMapFullRef.current = isMapFull;
    if (isMapFull) {
      map2dUserMovedRef.current = true;
    }
  }, [isMapFull]);

  // Interactive selection & expandable details panel below the isometric viewport
  const [selectedTarget, setSelectedTarget] = useState('land'); // 'land' | 'artwork'
  const [selectedSculptureId, setSelectedSculptureId] = useState('');
  const [detailsExpanded, setDetailsExpanded] = useState(true);

  // Local optimistic copies so inline management edits update labels & details instantaneously
  const [localParcel, setLocalParcel] = useState(parcel);
  const [localSculptures, setLocalSculptures] = useState(sculptures);
  const [fetchedNeighbors, setFetchedNeighbors] = useState([]);
  const [liveViewCounts, setLiveViewCounts] = useState(null);
  const recordedPageViewsRef = useRef(new Set());
  const recordedInPersonViewsRef = useRef(new Set());

  // Inline land management states
  const [editingLand, setEditingLand] = useState(false);
  const [landNameDraft, setLandNameDraft] = useState('');
  const [labelLinkCopied, setLabelLinkCopied] = useState(false);
  const labelLinkCopyTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (labelLinkCopyTimerRef.current) clearTimeout(labelLinkCopyTimerRef.current);
    };
  }, []);
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

  // Owner pending transaction approvals & pairing health on this land
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [approvalBusyId, setApprovalBusyId] = useState('');
  const [approvalErrors, setApprovalErrors] = useState({});
  const [expandedApprovalId, setExpandedApprovalId] = useState('');
  const [mcpRepairAlert, setMcpRepairAlert] = useState(null);

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

  const pendingPreviewSculptures = useMemo(
    () =>
      buildPendingPreviewSculptures(pendingApprovals, {
        parcels: stageParcels,
        existingSculptures: activeSculptures
      }),
    [pendingApprovals, stageParcels, activeSculptures]
  );

  const mapDisplaySculptures = useMemo(
    () => [...visibleSculptures, ...pendingPreviewSculptures],
    [visibleSculptures, pendingPreviewSculptures]
  );

  const selectedArtwork = useMemo(() => {
    if (selectedTarget !== 'artwork' || !selectedSculptureId) return null;
    return (
      activeSculptures.find((s) => s.id === selectedSculptureId) ||
      pendingPreviewSculptures.find((s) => s.id === selectedSculptureId) ||
      null
    );
  }, [activeSculptures, pendingPreviewSculptures, selectedSculptureId, selectedTarget]);

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
  const requiresApproval = Boolean(
    activeParcel?.requireApproval || activeParcel?.settings?.requireApproval
  );
  const { unitSystem } = useMeasurementUnits(
    userLocation,
    hasCenter ? { lat: centerLat, lng: centerLng } : null
  );

  const landDisplayName = resolveLandDisplayName(
    {
      ...activeParcel,
      firstSculptureTitle: visibleSculptures[0]?.title || activeSculptures[0]?.title || ''
    },
    { defaultName: 'Virtual Land' }
  );
  const landDimensions = formatLandDimensions(activeParcel, unitSystem);
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

  // Load & poll pending agent/land transactions for this land whenever signed in as the land holder
  const loadOwnerPendingAndPairing = useCallback(async () => {
    if (!user?.id || !isLandOwner || !activeParcel?.parcelId) {
      setPendingApprovals([]);
      setMcpRepairAlert(null);
      return;
    }
    const targetPid = String(activeParcel.parcelId).toUpperCase();
    try {
      const [sigRes, pairRes] = await Promise.all([
        api.listPendingSignatures().catch(() => null),
        api.listMcpPairings().catch(() => null)
      ]);
      if (sigRes && Array.isArray(sigRes.requests)) {
        const forThisLand = sigRes.requests.filter(
          (r) =>
            r &&
            r.status === 'pending' &&
            (!r.parcelId || String(r.parcelId).toUpperCase() === targetPid)
        );
        setPendingApprovals(forThisLand);
      }
      if (pairRes) {
        if (pairRes.needsRepair) {
          setMcpRepairAlert({
            reason: pairRes.repairReason || 'expired',
            code: pairRes.latestPairing?.code || '',
            agentName: pairRes.latestPairing?.agentName || ''
          });
        } else if (pairRes.expiringSoon) {
          setMcpRepairAlert({
            reason: 'expiring_soon',
            code: pairRes.activePairing?.code || '',
            agentName: pairRes.activePairing?.agentName || ''
          });
        } else {
          setMcpRepairAlert(null);
        }
      }
    } catch {
      // ignore transient polling failure
    }
  }, [user?.id, isLandOwner, activeParcel?.parcelId]);

  useEffect(() => {
    if (!user?.id || !isLandOwner || !activeParcel?.parcelId) {
      setPendingApprovals([]);
      setMcpRepairAlert(null);
      return undefined;
    }
    loadOwnerPendingAndPairing();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      loadOwnerPendingAndPairing();
    }, 12000);
    return () => clearInterval(timer);
  }, [user?.id, isLandOwner, activeParcel?.parcelId, loadOwnerPendingAndPairing]);

  async function handleApprovePendingTx(item, options = {}) {
    if (!item?.id || !user?.id || approvalBusyId) return;
    const autoFitScale = Boolean(options?.autoFitScale);
    setApprovalBusyId(item.id);
    setApprovalErrors((prev) => {
      if (!prev[item.id]) return prev;
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    try {
      let extSig = '';
      if (
        !autoFitScale &&
        user?.walletAddress &&
        item.ownerAddress &&
        user.walletAddress.toLowerCase() !== item.ownerAddress.toLowerCase() &&
        typeof window !== 'undefined' &&
        window.ethereum
      ) {
        extSig = await window.ethereum.request({
          method: 'personal_sign',
          params: [item.canonicalMessage, item.ownerAddress]
        });
      }
      const signPayload = {
        ...(extSig ? { signature: extSig } : {}),
        ...(autoFitScale ? { autoFitScale: true } : {})
      };
      const signRes = await api.mobileSignRequest(item.id, signPayload);
      setPendingApprovals((prev) => prev.filter((r) => r.id !== item.id));
      const title =
        item.summaryTitle ||
        String(item.action || 'Land Transaction')
          .replace(/_/g, ' ')
          .replace(/^\w/, (c) => c.toUpperCase());
      const fitSuffix = signRes?.autoFittedScale ? ` (auto-fitted to ${signRes.autoFittedScale}×)` : '';
      recordUserAction(user?.id, {
        type: 'approve_land_tx',
        icon: '✅',
        title: `Approved "${title}"${fitSuffix}`,
        detail: landDisplayName,
        parcelId: activeParcel?.parcelId || item.parcelId || '',
        sculptureId: signRes?.result?.sculpture?.id || item.sculptureId || '',
        linkLabel: 'Land'
      });
      const msg = `Approved & executed "${title}"${fitSuffix} on "${landDisplayName}"!`;
      flashStatus(msg);
      notifySettingsSaved(msg);
      let nextParcel = activeParcel;
      let nextSculptures = activeSculptures;
      if (activeParcel?.parcelId) {
        const refreshed = await api.getLandDetail(activeParcel.parcelId).catch(() => null);
        if (refreshed?.parcel) {
          nextParcel = refreshed.parcel;
          nextSculptures = refreshed.sculptures || [];
          setLocalParcel(nextParcel);
          setLocalSculptures(nextSculptures);
        }
      }
      onPlotUpdated?.({ parcel: nextParcel, sculptures: nextSculptures });
      loadOwnerPendingAndPairing();
    } catch (err) {
      const errMsg = err?.message || 'Could not approve transaction.';
      const maxSafe = Number(err?.data?.maxSafeScale ?? err?.data?.suggestedScale ?? 0);
      setApprovalErrors((prev) => ({
        ...prev,
        [item.id]: {
          message: errMsg,
          code: String(err?.data?.code || ''),
          maxSafeScale: Number.isFinite(maxSafe) && maxSafe > 0 ? maxSafe : null
        }
      }));
      flashStatus(errMsg, true);
      notifySettingsSaved(`⚠️ ${errMsg}`, { tone: 'error', durationMs: 6500 });
    } finally {
      setApprovalBusyId('');
    }
  }

  async function handleRejectPendingTx(item) {
    if (!item?.id || !user?.id || approvalBusyId) return;
    setApprovalBusyId(item.id);
    setApprovalErrors((prev) => {
      if (!prev[item.id]) return prev;
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    try {
      await api.rejectSignatureRequest(item.id);
      setPendingApprovals((prev) => prev.filter((r) => r.id !== item.id));
      const title = item.summaryTitle || String(item.action || 'Land Transaction').replace(/_/g, ' ');
      recordUserAction(user?.id, {
        type: 'reject_land_tx',
        icon: '❌',
        title: `Rejected "${title}"`,
        detail: landDisplayName,
        parcelId: activeParcel?.parcelId || item.parcelId || ''
      });
      flashStatus(`Rejected "${title}".`);
      loadOwnerPendingAndPairing();
    } catch (err) {
      flashStatus(err?.message || 'Could not reject transaction.', true);
    } finally {
      setApprovalBusyId('');
    }
  }

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

  const handleSelectArtworkTarget = useCallback(
    (sc) => {
      if (!sc?.id) return;
      // If this artwork label is already selected, clicking it again goes straight to the full 3D art view
      if (
        selectedTarget === 'artwork' &&
        selectedSculptureId === sc.id &&
        typeof onSelectSculpture === 'function'
      ) {
        onSelectSculpture(sc);
        return;
      }
      setSelectedTarget('artwork');
      setSelectedSculptureId(sc.id);
      setEditingLand(false);
      setEditingArtworkId('');
      setConfirmRemoveId('');
      setDetailsExpanded(true);
      setIsMapFull(false);
    },
    [onSelectSculpture, selectedSculptureId, selectedTarget]
  );

  const activeParcelRef = useRef(activeParcel);
  const visibleSculpturesRef = useRef(mapDisplaySculptures);
  const selectedSculptureIdRef = useRef(selectedSculptureId);
  const landDisplayNameRef = useRef(landDisplayName);

  useEffect(() => {
    activeParcelRef.current = activeParcel;
    visibleSculpturesRef.current = mapDisplaySculptures;
    selectedSculptureIdRef.current = selectedSculptureId;
    landDisplayNameRef.current = landDisplayName;
  }, [activeParcel, landDisplayName, mapDisplaySculptures, selectedSculptureId]);

  const recompute2dOverlay = useCallback(() => {
    const map = mapRef.current;
    const host = mapHostRef.current;
    const curParcel = activeParcelRef.current;
    if (!map || !host || !curParcel) return;

    const w = host.clientWidth || 0;
    const h = host.clientHeight || 0;
    if (w <= 0 || h <= 0) return;

    const corners = Array.isArray(curParcel?.volume?.corners) ? curParcel.volume.corners : [];
    let pts = [];
    if (corners.length >= 4) {
      pts = corners.slice(0, 4).map(([lng, lat]) => {
        const pt = map.latLngToContainerPoint([Number(lat), Number(lng)]);
        return { x: pt.x, y: pt.y };
      });
    } else if (curParcel?.bounds?.sw && curParcel?.bounds?.ne) {
      const [sLat, wLng] = curParcel.bounds.sw;
      const [nLat, eLng] = curParcel.bounds.ne;
      pts = [
        [nLat, wLng],
        [nLat, eLng],
        [sLat, eLng],
        [sLat, wLng]
      ].map(([lat, lng]) => {
        const pt = map.latLngToContainerPoint([Number(lat), Number(lng)]);
        return { x: pt.x, y: pt.y };
      });
    }

    let landTag = null;
    if (pts.length >= 4) {
      const topCenterX = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
      const topCenterY = Math.min(...pts.map((p) => p.y));
      const pillHeight = 28;
      const labelY = Math.max(w < 520 ? 52 : 44, topCenterY - pillHeight - 18);
      const clampedX = Math.max(76, Math.min(w - 76, topCenterX));
      if (topCenterX >= -80 && topCenterX <= w + 80 && topCenterY >= -60 && topCenterY <= h + 80) {
        landTag = {
          centerX: Math.round(clampedX),
          y: Math.round(labelY),
          fromX: Math.round(clampedX),
          fromY: Math.round(labelY + pillHeight),
          toX: Math.round(topCenterX),
          toY: Math.round(topCenterY)
        };
      }
    }

    const callouts = computeSideArtworkCallouts({
      sculptures: visibleSculpturesRef.current || [],
      volume: curParcel?.volume || null,
      viewportWidth: w,
      viewportHeight: h,
      selectedSculptureId: selectedSculptureIdRef.current || '',
      topInsetPx: w < 520 ? 74 : 64,
      bottomInsetPx: 42,
      marginPx: w < 520 ? 8 : 14,
      labelHeight: w < 520 ? 34 : 40,
      gapPx: 8,
      projectScreenPt: (lng, lat) => {
        const pt = map.latLngToContainerPoint([Number(lat), Number(lng)]);
        return { x: pt.x, y: pt.y };
      }
    });

    setMap2dOverlay({ width: w, height: h, landTag, callouts });
  }, []);

  const handleRecenter2D = useCallback(() => {
    const map = mapRef.current;
    if (!map || !hasCenter) return;
    const parcelLayer = map2dParcelLayerRef.current;
    if (parcelLayer && typeof parcelLayer.getBounds === 'function') {
      map.fitBounds(parcelLayer.getBounds(), { padding: [44, 44], maxZoom: 21, animate: true });
    } else {
      map.setView([centerLat, centerLng], 19, { animate: true });
    }
    map2dUserMovedRef.current = Boolean(isMapFullRef.current);
  }, [centerLat, centerLng, hasCenter]);

  // Reset initial 2D fit flag when navigating to a different parcel
  useEffect(() => {
    map2dInitialFittedRef.current = false;
    map2dUserMovedRef.current = Boolean(isMapFullRef.current);
  }, [activeParcel?.parcelId]);

  // Optional 2D Leaflet view when user explicitly toggles 3D -> 2D
  useEffect(() => {
    if (mapDimensionMode !== '2d' || !mapHostRef.current || !hasCenter || mapRef.current) {
      return undefined;
    }

    const saved = isMapFullRef.current ? sharedViewportRef.current : null;
    const hasSaved = Boolean(
      saved &&
        Number.isFinite(Number(saved.lat)) &&
        Number.isFinite(Number(saved.lng)) &&
        Number.isFinite(Number(saved.zoom))
    );
    const startCenter = hasSaved ? [Number(saved.lat), Number(saved.lng)] : [centerLat, centerLng];
    const startZoom = hasSaved ? Math.max(3, Math.min(21.5, Number(saved.zoom))) : 19;
    if (hasSaved || isMapFullRef.current) {
      map2dUserMovedRef.current = true;
      map2dInitialFittedRef.current = true;
    } else {
      map2dUserMovedRef.current = false;
      map2dInitialFittedRef.current = false;
    }

    const map = L.map(mapHostRef.current, {
      center: startCenter,
      zoom: startZoom,
      maxZoom: 21.5,
      zoomControl: false,
      attributionControl: true
    });

    if (mapHostRef.current) {
      mapHostRef.current.classList.toggle('is-map-light', mapThemeRef.current === 'light');
    }
    const tileCfg = getLeafletTileConfig(mapThemeRef.current);
    tileLayerRef.current = L.tileLayer(tileCfg.url, tileCfg.options).addTo(map);

    const markMoved = () => {
      map2dUserMovedRef.current = true;
    };
    const syncViewAndOverlay = () => {
      const c = map.getCenter();
      if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
        sharedViewportRef.current = {
          ...(sharedViewportRef.current || {}),
          lat: Number(c.lat.toFixed(6)),
          lng: Number(c.lng.toFixed(6)),
          zoom: Number(map.getZoom().toFixed(2))
        };
      }
      recompute2dOverlay();
    };

    map.on('dragstart', markMoved);
    map.on('zoomstart', markMoved);
    map.on('move', recompute2dOverlay);
    map.on('zoom', recompute2dOverlay);
    map.on('moveend', syncViewAndOverlay);

    const layer = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerRef.current = layer;

    let observer = null;
    if (typeof ResizeObserver === 'function' && mapHostRef.current) {
      observer = new ResizeObserver(() => {
        map.invalidateSize({ animate: false, pan: false });
        recompute2dOverlay();
      });
      observer.observe(mapHostRef.current);
    }

    const t = setTimeout(() => {
      map.invalidateSize({ animate: false, pan: false });
      recompute2dOverlay();
    }, 100);
    return () => {
      clearTimeout(t);
      observer?.disconnect();
      map.off('dragstart', markMoved);
      map.off('zoomstart', markMoved);
      map.off('move', recompute2dOverlay);
      map.off('zoom', recompute2dOverlay);
      map.off('moveend', syncViewAndOverlay);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      tileLayerRef.current = null;
      map2dParcelLayerRef.current = null;
    };
  }, [hasCenter, centerLat, centerLng, mapDimensionMode, recompute2dOverlay]);

  useEffect(() => {
    if (mapDimensionMode !== '2d') return;
    const map = mapRef.current;
    if (!map) return;
    if (mapHostRef.current) {
      mapHostRef.current.classList.toggle('is-map-light', !isDarkMap);
    }
    try {
      if (tileLayerRef.current) {
        map.removeLayer(tileLayerRef.current);
      }
      const nextCfg = getLeafletTileConfig(mapTheme);
      tileLayerRef.current = L.tileLayer(nextCfg.url, nextCfg.options).addTo(map);
      if (typeof tileLayerRef.current.bringToBack === 'function') {
        tileLayerRef.current.bringToBack();
      }
    } catch {
      // ignore during map teardown
    }
  }, [isDarkMap, mapDimensionMode, mapTheme]);

  useEffect(() => {
    if (mapDimensionMode !== '2d') return undefined;
    const map = mapRef.current;
    if (!map) return undefined;
    const t = setTimeout(() => {
      map.invalidateSize({ animate: false, pan: false });
      recompute2dOverlay();
    }, 80);
    return () => clearTimeout(t);
  }, [isMapFull, mapDimensionMode, recompute2dOverlay]);

  useEffect(() => {
    if (mapDimensionMode !== '2d') return;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer || !hasCenter) return;

    layer.clearLayers();
    map.invalidateSize({ animate: false, pan: false });

    // In Full View, render neighboring lands too so users can navigate freely across lands
    if (isMapFull) {
      for (const other of stageParcels) {
        if (!other?.parcelId || other.parcelId === activeParcel?.parcelId) continue;
        const otherFrozen = Boolean(other.frozen || other.settings?.frozen);
        const otherColor = otherFrozen ? '#7dd3fc' : '#ff4da6';
        const otherCorners = Array.isArray(other?.volume?.corners) ? other.volume.corners : [];
        let otherLayer = null;
        if (otherCorners.length >= 4) {
          otherLayer = L.polygon(
            otherCorners.slice(0, 4).map(([lng, lat]) => [Number(lat), Number(lng)]),
            { color: otherColor, weight: 2, fillColor: otherColor, fillOpacity: 0.16 }
          );
        } else if (other?.bounds?.sw && other?.bounds?.ne) {
          otherLayer = L.rectangle([other.bounds.sw, other.bounds.ne], {
            color: otherColor,
            weight: 2,
            fillColor: otherColor,
            fillOpacity: 0.16
          });
        }
        if (otherLayer) {
          otherLayer
            .bindTooltip(resolveLandDisplayName(other, { defaultName: 'Virtual Land' }))
            .on('click', () => handleSelectNeighborOnMap(other))
            .addTo(layer);
        }
      }
    }

    const stroke = isFrozen ? '#7dd3fc' : '#ff1f8f';
    const corners = Array.isArray(activeParcel?.volume?.corners) ? activeParcel.volume.corners : [];

    let parcelLayer = null;
    if (corners.length >= 4) {
      const latLngs = corners.slice(0, 4).map(([lng, lat]) => [Number(lat), Number(lng)]);
      parcelLayer = L.polygon(latLngs, {
        color: stroke,
        weight: 3,
        fillColor: stroke,
        fillOpacity: 0.22
      })
        .on('click', () => handleSelectLandTarget())
        .addTo(layer);
    } else if (activeParcel?.bounds?.sw && activeParcel?.bounds?.ne) {
      parcelLayer = L.rectangle([activeParcel.bounds.sw, activeParcel.bounds.ne], {
        color: stroke,
        weight: 3,
        fillColor: stroke,
        fillOpacity: 0.22
      })
        .on('click', () => handleSelectLandTarget())
        .addTo(layer);
    }
    map2dParcelLayerRef.current = parcelLayer;

    L.circleMarker([centerLat, centerLng], {
      radius: 6,
      color: '#ffffff',
      weight: 2,
      fillColor: isFrozen ? '#38bdf8' : '#ff1f8f',
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

    // Fit bounds ONLY once on initial compact 2D entry — NEVER snap back in Full View or after user panned/zoomed!
    if (!isMapFullRef.current && !map2dUserMovedRef.current && !map2dInitialFittedRef.current) {
      map2dInitialFittedRef.current = true;
      if (parcelLayer && typeof parcelLayer.getBounds === 'function') {
        map.fitBounds(parcelLayer.getBounds(), { padding: [44, 44], maxZoom: 21, animate: false });
      } else {
        map.setView([centerLat, centerLng], 19, { animate: false });
      }
    }
    recompute2dOverlay();
  }, [
    activeParcel,
    stageParcels,
    visibleSculptures,
    selectedSculptureId,
    userLocation,
    hasCenter,
    centerLat,
    centerLng,
    isFrozen,
    isMapFull,
    landDisplayName,
    mapDimensionMode,
    handleSelectLandTarget,
    handleSelectArtworkTarget,
    handleSelectNeighborOnMap,
    recompute2dOverlay
  ]);

  async function handleCopyShareLink() {
    if (!activeParcel?.parcelId) return false;
    const shareUrl = buildParcelShareUrl({
      origin: window.location.origin,
      pathname: window.location.pathname,
      parcelId: activeParcel.parcelId,
      customName: activeParcel.customName || '',
      compact: true
    });
    const ok = await copyToClipboard(shareUrl);
    if (ok) {
      setLabelLinkCopied(true);
      if (labelLinkCopyTimerRef.current) clearTimeout(labelLinkCopyTimerRef.current);
      labelLinkCopyTimerRef.current = setTimeout(() => setLabelLinkCopied(false), 1800);
    }
    flashStatus(ok ? `Copied share link for "${landDisplayName}"!` : shareUrl);
    return ok;
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
      const detailSavedMsg = `Saved settings for "${updatedParcel.displayName || updatedParcel.customName}"!`;
      flashStatus(detailSavedMsg);
      notifySettingsSaved(detailSavedMsg);
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
      const freezeSavedMsg = actualFrozen
        ? `Frozen "${landDisplayName}" — placements paused.`
        : `Unfrozen "${landDisplayName}" — placements open.`;
      flashStatus(freezeSavedMsg);
      notifySettingsSaved(freezeSavedMsg);
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

  // Record a deduplicated Land Page view on mount / parcel switch
  useEffect(() => {
    const pid = activeParcel?.parcelId;
    if (!pid || loading) return undefined;
    if (recordedPageViewsRef.current.has(pid)) return undefined;
    recordedPageViewsRef.current.add(pid);
    let cancelled = false;
    api
      .recordLandView(pid, { viewType: 'page' })
      .then((res) => {
        if (cancelled || !res?.ok) return;
        setLiveViewCounts({
          parcelId: pid,
          pageViews: Math.max(0, Number(res.pageViews || 0)),
          inPersonViews: Math.max(0, Number(res.inPersonViews || 0))
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeParcel?.parcelId, loading]);

  // Also record an In-Person view when a mobile user opens this land page while physically standing at the property
  useEffect(() => {
    const pid = activeParcel?.parcelId;
    if (isDesktop || !isNearProperty || !pid || loading) return undefined;
    const uLat = Number(userLocation?.lat);
    const uLng = Number(userLocation?.lng);
    if (!Number.isFinite(uLat) || !Number.isFinite(uLng)) return undefined;
    if (recordedInPersonViewsRef.current.has(pid)) return undefined;
    recordedInPersonViewsRef.current.add(pid);
    let cancelled = false;
    api
      .recordLandView(pid, { viewType: 'in_person', lat: uLat, lng: uLng })
      .then((res) => {
        if (cancelled || !res?.ok) return;
        setLiveViewCounts({
          parcelId: pid,
          pageViews: Math.max(0, Number(res.pageViews || 0)),
          inPersonViews: Math.max(0, Number(res.inPersonViews || 0))
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeParcel?.parcelId, isDesktop, isNearProperty, loading, userLocation?.lat, userLocation?.lng]);

  const hasMatchingLiveViews = Boolean(
    liveViewCounts && activeParcel?.parcelId && liveViewCounts.parcelId === activeParcel.parcelId
  );
  const pageViewsCount = hasMatchingLiveViews
    ? liveViewCounts.pageViews
    : Math.max(0, Number(activeParcel?.pageViews || 0));
  const inPersonViewsCount = hasMatchingLiveViews
    ? liveViewCounts.inPersonViews
    : Math.max(0, Number(activeParcel?.inPersonViews || 0));
  const landCreatedDate = formatShortDate(
    activeParcel?.createdAt ||
      visibleSculptures[0]?.createdAt ||
      activeSculptures[0]?.createdAt ||
      activeParcel?.latestAt ||
      ''
  );

  const renderLandInfoTip = () => (
    <span className="mobile-parcel-directions-info" data-testid="parcel-directions-info">
      <InfoTip title="Land Details" mode="popover" align="left">
        <div className="plot-info-popover-content" data-testid="plot-info-popover-content">
          <div className="plot-info-row mono" data-testid="plot-info-in-person-views">
            <span>🚶 In-Person Views</span>
            <strong>{inPersonViewsCount}</strong>
          </div>
          <div className="plot-info-row mono" data-testid="plot-info-page-views">
            <span>👁️ Page Views</span>
            <strong>{pageViewsCount}</strong>
          </div>
          {hasCenter && (
            <div className="plot-info-row mono" data-testid="plot-info-coords">
              <span>📍 Location</span>
              <strong>
                {centerLat.toFixed(4)}, {centerLng.toFixed(4)}
              </strong>
            </div>
          )}
          {landDimensions && (
            <div className="plot-info-row mono" data-testid="plot-info-dimensions">
              <span>📐 Dimensions</span>
              <strong>{landDimensions}</strong>
            </div>
          )}
          <div className="plot-info-row mono" data-testid="plot-info-artworks">
            <span>🧊 Artworks</span>
            <strong>
              {visibleSculptures.length} artwork{visibleSculptures.length === 1 ? '' : 's'}
            </strong>
          </div>
          {Number(activeParcel?.humanContributorCount || 0) > 0 && (
            <div className="plot-info-row mono">
              <span>👥 Artists</span>
              <strong>{Number(activeParcel.humanContributorCount)}</strong>
            </div>
          )}
          {landExpiration.state !== 'permanent' && (
            <div className="plot-info-row mono" data-testid="plot-info-expiration">
              <span>{landExpiration.state === 'expired' ? '⏱️ Status' : '⏳ Timer'}</span>
              <strong>{landExpiration.badgeText}</strong>
            </div>
          )}
          {activeParcel?.parcelId && (
            <div className="plot-info-row mono">
              <span>🏷️ Parcel</span>
              <strong>{activeParcel.parcelId}</strong>
            </div>
          )}
          <div className="plot-info-note">
            {isDesktop
              ? isFrozen
                ? 'Walk near this property on mobile to unlock View in AR (placements are frozen).'
                : 'Walk near this property on mobile to unlock View in AR and Make Art on This Property.'
              : isNearProperty
              ? isFrozen
                ? 'You are at this property — View in AR is unlocked (placements are frozen).'
                : 'You are at this property — View in AR and Make Art on This Property are unlocked.'
              : isFrozen
              ? 'Walk near this property to unlock View in AR (placements are frozen).'
              : 'Walk near this property to unlock View in AR and Make Art on This Property.'}
          </div>
        </div>
      </InfoTip>
    </span>
  );

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
      {/* Top Bar: Land Name, Status Tag, In-Person & Page Views Counter, Share, and Close */}
      <header className="mobile-parcel-header plot-visit-header" data-testid="plot-visit-header">
        <div className="plot-visit-header-main">
          <h1 className="mobile-parcel-title">
            {loading ? 'Loading Land…' : landDisplayName}
          </h1>
          {activeParcel && (
            <div className="plot-visit-title-tags">
              <span
                className={`badge ${isFrozen ? 'badge-error' : 'teal'}`}
                data-testid="plot-status-badge"
                style={{ fontSize: 10, flexShrink: 0 }}
              >
                {isFrozen ? '❄️ Frozen' : '✅ Open'}
              </span>
              {!isFrozen && requiresApproval && (
                <span
                  className="badge gold"
                  data-testid="plot-approval-required-badge"
                  style={{ fontSize: 10, flexShrink: 0 }}
                  title="The land holder enabled Require Approval — guest submissions wait for owner approval"
                >
                  🛡️ Approval Required
                </span>
              )}
              <span
                className="plot-views-counter mono"
                data-testid="plot-views-counter"
                aria-label={`${inPersonViewsCount} in-person views, ${pageViewsCount} page views`}
                title={`${inPersonViewsCount} in-person views · ${pageViewsCount} page views`}
              >
                <span className="plot-views-item is-irl" data-testid="plot-in-person-views">
                  <XeroIcon emoji="🚶" size={11} />
                  <strong>{formatCompactViewCount(inPersonViewsCount)}</strong>
                  <span>IRL</span>
                </span>
                <span className="plot-views-dot" aria-hidden="true">·</span>
                <span className="plot-views-item is-page" data-testid="plot-page-views">
                  <XeroIcon emoji="👁️" size={11} />
                  <strong>{formatCompactViewCount(pageViewsCount)}</strong>
                  <span>views</span>
                </span>
              </span>
            </div>
          )}
        </div>

        <div className="plot-visit-header-actions">
          {activeParcel && (
            <button
              type="button"
              className="btn btn-sm"
              data-testid="plot-share-btn"
              aria-label="Copy parcel share link"
              title="Copy share link"
              onClick={handleCopyShareLink}
            >
              🔗
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            data-testid="plot-close-btn"
            aria-label={isDesktop ? 'Close land view' : 'Close parcel visit view'}
            title="Close"
            onClick={onClose}
          >
            <XeroIcon emoji="✕" size={14} />
          </button>
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
              {isDesktop ? 'Return to World Map' : 'Open SPRAY.LAND Studio'}
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
                sculptures={mapDisplaySculptures}
                userLocation={userLocation}
                selectedParcelId={activeParcel.parcelId}
                selectedSculptureId={selectedTarget === 'artwork' ? selectedSculptureId : ''}
                isFullExpanded={isMapFull}
                showcaseMode
                landSelected={selectedTarget === 'land'}
                initialView={isMapFull ? sharedViewportRef.current : null}
                onViewportChange={(vp) => {
                  sharedViewportRef.current = vp;
                }}
                onToggle2D={() => setMapDimensionMode('2d')}
                onToggleFullMap={() => setIsMapFull((v) => !v)}
                onSelectLand={handleSelectLandTarget}
                onCopyLandShareLink={handleCopyShareLink}
                onSelectParcel={handleSelectNeighborOnMap}
                onSelectSculpture={handleSelectArtworkTarget}
                onOpenSculptureView={onSelectSculpture}
              />
            ) : (
              <>
                <div ref={mapHostRef} className="mobile-parcel-map-canvas" />
                {map2dOverlay.width > 0 && map2dOverlay.height > 0 && (
                  <svg
                    className="mobile-iso-wire-canvas"
                    viewBox={`0 0 ${map2dOverlay.width} ${map2dOverlay.height}`}
                    width="100%"
                    height="100%"
                    aria-hidden="true"
                  >
                    {map2dOverlay.landTag && (
                      <g>
                        <line
                          data-testid="plot-land-leader-line"
                          data-target="top-center"
                          x1={map2dOverlay.landTag.fromX}
                          y1={map2dOverlay.landTag.fromY}
                          x2={map2dOverlay.landTag.toX}
                          y2={map2dOverlay.landTag.toY}
                          stroke={isFrozen ? '#7dd3fc' : '#ff1f8f'}
                          strokeWidth="1.5"
                        />
                        <circle
                          cx={map2dOverlay.landTag.toX}
                          cy={map2dOverlay.landTag.toY}
                          r="2.8"
                          fill="#ffffff"
                        />
                      </g>
                    )}
                    {map2dOverlay.callouts.map((c) => (
                      <g
                        key={c.sculptureId}
                        data-testid="plot-artwork-leader-line"
                        data-sculpture-id={c.sculptureId}
                      >
                        <polyline
                          points={`${c.fromX},${c.fromY} ${c.elbowX},${c.elbowY} ${c.targetX},${c.targetY}`}
                          fill="none"
                          stroke="rgba(4, 10, 20, 0.78)"
                          strokeWidth={c.isSelected ? '3.4' : '2.6'}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                        <polyline
                          points={`${c.fromX},${c.fromY} ${c.elbowX},${c.elbowY} ${c.targetX},${c.targetY}`}
                          fill="none"
                          stroke={c.isPendingPreview || c.isSelected ? '#ffd166' : '#00f5d4'}
                          strokeWidth={c.isPendingPreview || c.isSelected ? '1.8' : '1.25'}
                          strokeDasharray={c.isPendingPreview ? '5 3' : undefined}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                        <circle
                          cx={c.targetX}
                          cy={c.targetY}
                          r={c.isPendingPreview || c.isSelected ? '3.2' : '2.4'}
                          fill={c.isPendingPreview || c.isSelected ? '#ffd166' : '#eafffc'}
                        />
                      </g>
                    ))}
                  </svg>
                )}
                <div
                  className="plot-iso-callout-layer"
                  data-testid="plot-iso-callout-layer"
                  onPointerDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {map2dOverlay.landTag && (() => {
                    const isEmptyLand = visibleSculptures.length === 0;
                    return (
                      <div
                        className={`plot-iso-land-label-pill ${
                          selectedTarget === 'land' ? 'is-selected' : ''
                        } ${isEmptyLand ? 'is-empty-land' : ''}`}
                        data-empty-land={isEmptyLand ? 'true' : 'false'}
                        style={{
                          left: `${map2dOverlay.landTag.centerX}px`,
                          top: `${map2dOverlay.landTag.y}px`,
                          transform: 'translateX(-50%)'
                        }}
                      >
                        <button
                          type="button"
                          className={`plot-iso-land-label-btn ${
                            selectedTarget === 'land' ? 'is-selected' : ''
                          }`}
                          data-testid="plot-land-label"
                          onClick={handleSelectLandTarget}
                          title={`Inspect ${landDisplayName}`}
                        >
                          <span className="plot-iso-land-dot" aria-hidden="true" />
                          <span>{landDisplayName}</span>
                        </button>
                        <button
                          type="button"
                          className={`plot-iso-land-copy-btn ${labelLinkCopied ? 'is-copied' : ''}`}
                          data-testid="plot-land-label-copy-btn"
                          aria-label={`Copy share link for ${landDisplayName}`}
                          title={`Copy share link for ${landDisplayName}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyShareLink();
                          }}
                        >
                          {labelLinkCopied
                            ? isEmptyLand
                              ? '✓ Copied'
                              : '✓'
                            : isEmptyLand
                              ? '🔗 Copy Link'
                              : '🔗'}
                        </button>
                      </div>
                    );
                  })()}
                  {map2dOverlay.callouts.map((c) => (
                    <div
                      key={c.sculptureId}
                      className={`plot-iso-artwork-callout is-${c.side} ${
                        c.isSelected ? 'is-selected' : ''
                      } ${c.isPendingPreview ? 'is-pending-preview' : ''}`.trim()}
                      data-callout-side={c.side}
                      data-pending-preview={c.isPendingPreview ? 'true' : undefined}
                      data-request-id={c.pendingRequestId || undefined}
                      style={{
                        left: `${c.x}px`,
                        top: `${c.y}px`,
                        width: `${c.width}px`
                      }}
                    >
                      <button
                        type="button"
                        className="plot-iso-callout-main"
                        data-testid={c.isPendingPreview ? 'plot-preview-label' : 'plot-artwork-label'}
                        data-sculpture-id={c.sculptureId}
                        data-callout-side={c.side}
                        onClick={() => handleSelectArtworkTarget(c.sculpture)}
                        title={
                          c.isPendingPreview
                            ? `Preview (Pending Approval) — "${c.title}"`
                            : `Inspect "${c.title}"`
                        }
                      >
                        <span className="plot-iso-callout-title-row">
                          {c.isPendingPreview && (
                            <span className="map-preview-pill" data-testid="map-preview-badge">
                              Preview
                            </span>
                          )}
                          <span className="plot-iso-callout-title">{c.title}</span>
                        </span>
                        <span className="plot-iso-callout-meta mono">{c.subtitle}</span>
                      </button>
                      {c.isPendingPreview ? (
                        <button
                          type="button"
                          className="plot-iso-callout-open-btn"
                          data-testid="plot-preview-open-btn"
                          data-sculpture-id={c.sculptureId}
                          aria-label={`Open 3D preview for ${c.title}`}
                          title={`Open 3D preview & approve "${c.title}"`}
                          onClick={(e) => {
                            e.stopPropagation();
                            (onSelectSculpture || handleSelectArtworkTarget)(c.sculpture);
                          }}
                        >
                          👁️
                        </button>
                      ) : (
                        <a
                          href={c.sculptureUrl}
                          className="plot-iso-callout-open-btn"
                          data-testid="plot-artwork-view-btn"
                          data-sculpture-id={c.sculptureId}
                          aria-label={`Open 3D art link for ${c.title}`}
                          title={`Open link for "${c.title}" (${c.sculptureUrl})`}
                          onClick={(e) => {
                            const openHandler = onSelectSculpture || handleSelectArtworkTarget;
                            if (
                              openHandler &&
                              !e.metaKey &&
                              !e.ctrlKey &&
                              !e.shiftKey &&
                              !e.altKey &&
                              e.button === 0
                            ) {
                              e.preventDefault();
                              e.stopPropagation();
                              openHandler(c.sculpture);
                            }
                          }}
                        >
                          ↗
                        </a>
                      )}
                    </div>
                  ))}
                </div>
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
                    aria-label="Switch to 3D map"
                    title="View this land in 3D mode"
                    onClick={() => setMapDimensionMode('3d')}
                  >
                    <XeroIcon emoji="🧊" size={13} /> 3D
                  </button>
                  <button
                    type="button"
                    className="btn map-recenter-fab"
                    data-testid="mobile-map-fit-btn"
                    aria-label="Recenter 2D map on land"
                    title="Recenter map on this land"
                    onClick={handleRecenter2D}
                  >
                    <XeroIcon emoji="🎯" size={13} /> Fit
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
                    {isLandOwner && pendingApprovals.length > 0 && (
                      <span
                        className="plot-pending-count-pill"
                        data-testid="plot-pending-pill"
                        title={`${pendingApprovals.length} pending transaction approval${
                          pendingApprovals.length === 1 ? '' : 's'
                        }`}
                      >
                        ✍️ {pendingApprovals.length}
                      </span>
                    )}
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
                  {pendingPreviewSculptures.map((sc) => {
                    const active = selectedTarget === 'artwork' && selectedSculptureId === sc.id;
                    return (
                      <button
                        key={sc.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className={`plot-selector-pill is-pending-preview ${active ? 'is-active' : ''}`}
                        data-testid="plot-tab-preview"
                        data-sculpture-id={sc.id}
                        data-request-id={sc.pendingRequestId}
                        onClick={() => handleSelectArtworkTarget(sc)}
                      >
                        <span className="map-preview-pill">Preview</span>
                        <span>{sc.title || 'Pending Artwork'}</span>
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
                  {selectedTarget === 'artwork' && selectedArtwork?.isPendingPreview ? (
                    /* ================= PENDING PREVIEW SCULPTURE APPROVAL ================= */
                    (() => {
                      const reqItem = selectedArtwork.pendingRequest;
                      const busy = approvalBusyId === reqItem?.id;
                      const itemError = approvalErrors?.[reqItem?.id] || null;
                      const canAutoFit =
                        itemError?.code === 'exceeds_land_bounds' &&
                        Number(itemError?.maxSafeScale) >= 0.001;
                      return (
                        <div className="plot-detail-card" data-testid="plot-preview-artwork-details">
                          <div className="plot-detail-head">
                            <div style={{ minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <span className="map-preview-pill">Preview</span>
                                <h2 className="plot-detail-title">{selectedArtwork.title}</h2>
                                <span className="badge gold" style={{ fontSize: 10 }}>
                                  ⏳ Needs Approval
                                </span>
                              </div>
                              <div className="plot-detail-meta-chips">
                                <span className="mobile-sc-chip">
                                  🤖 {selectedArtwork.pendingAgentName || 'Paired Agent'}
                                </span>
                                <span className="mobile-sc-chip">
                                  {selectedArtwork.modelType === 'custom-3d'
                                    ? `📦 ${String(selectedArtwork.customModel?.format || '3D').toUpperCase()} · ${Number(
                                        selectedArtwork.customModel?.scale || 1
                                      )}×`
                                    : `🧱 ${selectedArtwork.voxelCount || selectedArtwork.voxels?.length || 0} blocks`}
                                </span>
                                {reqItem?.expiresAt && (
                                  <span className="mobile-sc-chip mono">
                                    {formatApprovalExpiresIn(reqItem.expiresAt)}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <p className="mobile-parcel-desc" style={{ marginTop: 6 }}>
                            {selectedArtwork.description ||
                              `Temporary preview on "${landDisplayName}". Approve below to mint and place it permanently on your land.`}
                          </p>

                          {itemError?.message && (
                            <div
                              className="approval-inline-error"
                              data-testid="plot-approval-error"
                              role="alert"
                            >
                              <div className="approval-inline-error-msg">⚠️ {itemError.message}</div>
                              {canAutoFit && reqItem && (
                                <button
                                  type="button"
                                  className="btn btn-xs btn-primary"
                                  data-testid="plot-autofit-approve-btn"
                                  disabled={Boolean(approvalBusyId)}
                                  onClick={() =>
                                    handleApprovePendingTx(reqItem, { autoFitScale: true })
                                  }
                                >
                                  {busy
                                    ? 'Fitting & Placing…'
                                    : `📐 Auto-Fit (${itemError.maxSafeScale}×) & Approve`}
                                </button>
                              )}
                            </div>
                          )}

                          <div className="plot-pending-item-actions" style={{ marginTop: 10 }}>
                            {reqItem && (
                              <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                data-testid="plot-preview-approve-btn"
                                disabled={Boolean(approvalBusyId)}
                                onClick={() => handleApprovePendingTx(reqItem)}
                              >
                                {busy ? 'Approving…' : '✅ Approve & Mint'}
                              </button>
                            )}
                            {reqItem && (
                              <button
                                type="button"
                                className="btn btn-sm btn-danger"
                                data-testid="plot-preview-reject-btn"
                                disabled={Boolean(approvalBusyId)}
                                onClick={() => handleRejectPendingTx(reqItem)}
                              >
                                {busy ? 'Working…' : '✕ Reject'}
                              </button>
                            )}
                            {onSelectSculpture && (
                              <button
                                type="button"
                                className="btn btn-sm"
                                data-testid="plot-preview-3d-modal-btn"
                                onClick={() => onSelectSculpture(selectedArtwork)}
                              >
                                👁️ Full 3D Preview
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })()
                  ) : selectedTarget === 'artwork' && selectedArtwork ? (
                    /* ================= ARTWORK DETAILS + MANAGEMENT ================= */
                    <div className="plot-detail-card" data-testid="plot-artwork-details">
                      <div className="plot-detail-head">
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            {onSelectSculpture ? (
                              <button
                                type="button"
                                className="artwork-title-link-btn is-heading"
                                data-testid="plot-artwork-title-btn"
                                title={`Open 3D view of "${selectedArtwork.title}"`}
                                onClick={() => onSelectSculpture(selectedArtwork)}
                              >
                                <h2 className="plot-detail-title">{selectedArtwork.title}</h2>
                                <span className="artwork-title-link-arrow" aria-hidden="true">↗</span>
                              </button>
                            ) : (
                              <h2 className="plot-detail-title">{selectedArtwork.title}</h2>
                            )}
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
                          <div className="plot-author-meta-row" data-testid="plot-artwork-meta-row">
                            {(selectedArtwork.creatorUsername || selectedArtwork.creatorName) && (
                              <span className="plot-author-static">
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
                            {formatShortDate(selectedArtwork.createdAt) && (
                              <>
                                {(selectedArtwork.creatorUsername || selectedArtwork.creatorName) && (
                                  <span className="plot-author-sep" aria-hidden="true">·</span>
                                )}
                                <span className="plot-author-date mono">
                                  {formatShortDate(selectedArtwork.createdAt)}
                                </span>
                              </>
                            )}
                            <span data-testid="plot-artwork-info-tip">
                              <InfoTip title="Artwork Details" mode="popover" align="left">
                                <div className="plot-info-popover-content">
                                  <div className="plot-info-row mono">
                                    <span>
                                      {selectedArtwork.modelType === 'custom-3d' ? '📦 Model' : '🧱 Geometry'}
                                    </span>
                                    <strong>{formatSculptureAssetMeta(selectedArtwork)}</strong>
                                  </div>
                                  {Number.isFinite(Number(selectedArtwork.polScore)) &&
                                    Number(selectedArtwork.polScore) > 0 && (
                                      <div className="plot-info-row mono">
                                        <span>🛡️ Proof of Location</span>
                                        <strong>{Math.round(Number(selectedArtwork.polScore))}</strong>
                                      </div>
                                    )}
                                  {selectedArtwork.currentRev && (
                                    <div className="plot-info-row mono">
                                      <span>🔖 Revision</span>
                                      <strong>v{selectedArtwork.currentRev}</strong>
                                    </div>
                                  )}
                                  {formatShortDate(selectedArtwork.createdAt) && (
                                    <div className="plot-info-row mono">
                                      <span>📅 Created</span>
                                      <strong>{formatShortDate(selectedArtwork.createdAt)}</strong>
                                    </div>
                                  )}
                                </div>
                              </InfoTip>
                            </span>
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
                            <XeroIcon emoji="🧊" size={13} /> Inspect Full 3D
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
                      {/* Land Holder Pending Transaction Approvals */}
                      {isLandOwner && pendingApprovals.length > 0 && (
                        <div
                          className="card plot-pending-approvals-card"
                          data-testid="plot-pending-approvals"
                          role="region"
                          aria-label="Pending land transaction approvals"
                        >
                          <div className="plot-mgmt-header">
                            <span className="plot-mgmt-title">
                              <XeroIcon emoji="✍️" size={14} /> Pending Transaction
                              {pendingApprovals.length === 1 ? '' : 's'} ({pendingApprovals.length})
                            </span>
                            <span className="badge gold" style={{ fontSize: 10 }}>
                              Action Required
                            </span>
                          </div>

                          <div className="plot-pending-list">
                            {pendingApprovals.map((item) => {
                              const busy = approvalBusyId === item.id;
                              const isExpanded = expandedApprovalId === item.id;
                              const itemError = approvalErrors?.[item.id] || null;
                              const canAutoFit =
                                itemError?.code === 'exceeds_land_bounds' &&
                                Number(itemError?.maxSafeScale) >= 0.001;
                              const title =
                                item.summaryTitle ||
                                String(item.action || 'Land Transaction')
                                  .replace(/_/g, ' ')
                                  .replace(/^\w/, (c) => c.toUpperCase());
                              const desc =
                                item.summaryDescription ||
                                item.payload?.description ||
                                `Execute ${String(item.action || 'transaction').replace(/_/g, ' ')} on ${landDisplayName}.`;
                              return (
                                <div
                                  key={item.id}
                                  className="plot-pending-item"
                                  data-testid="plot-pending-approval-item"
                                  data-request-id={item.id}
                                >
                                  <div className="plot-pending-item-head">
                                    <strong className="plot-pending-item-title">
                                      <XeroIcon emoji={getApprovalActionEmoji(item.action)} size={13} />{' '}
                                      {title}
                                    </strong>
                                    <span className="mono plot-pending-item-expiry">
                                      {formatApprovalExpiresIn(item.expiresAt)}
                                    </span>
                                  </div>
                                  <div className="plot-pending-item-meta">
                                    🤖 {item.agentName || 'Paired Agent'} · {String(item.action || '').replace(/_/g, ' ')}
                                  </div>
                                  <p className="plot-pending-item-desc">{desc}</p>
                                  {itemError?.message && (
                                    <div
                                      className="approval-inline-error"
                                      data-testid="plot-approval-error"
                                      role="alert"
                                    >
                                      <div className="approval-inline-error-msg">
                                        ⚠️ {itemError.message}
                                      </div>
                                      {canAutoFit && (
                                        <button
                                          type="button"
                                          className="btn btn-xs btn-primary"
                                          data-testid="plot-autofit-approve-btn"
                                          disabled={Boolean(approvalBusyId)}
                                          onClick={() =>
                                            handleApprovePendingTx(item, { autoFitScale: true })
                                          }
                                        >
                                          {busy
                                            ? 'Fitting & Placing…'
                                            : `📐 Auto-Fit (${itemError.maxSafeScale}×) & Approve`}
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  {isExpanded && (
                                    <div className="mobile-approval-details mono">
                                      <div>Action: {item.action}</div>
                                      <div>Request: {item.id}</div>
                                      {item.sculptureId && <div>Sculpture: {item.sculptureId}</div>}
                                      {item.pairingCode && <div>Pair: {item.pairingCode}</div>}
                                    </div>
                                  )}
                                  <div className="plot-pending-item-actions">
                                    <button
                                      type="button"
                                      className="btn btn-xs btn-primary"
                                      data-testid="plot-approve-tx-btn"
                                      disabled={Boolean(approvalBusyId)}
                                      onClick={() => handleApprovePendingTx(item)}
                                    >
                                      {busy ? 'Approving…' : '✅ Approve & Execute'}
                                    </button>
                                    {(() => {
                                      const previewSc = pendingPreviewSculptures.find(
                                        (p) => p.pendingRequestId === item.id
                                      );
                                      if (!previewSc) return null;
                                      return (
                                        <button
                                          type="button"
                                          className="btn btn-xs"
                                          data-testid="plot-preview-tx-btn"
                                          onClick={() => {
                                            if (onSelectSculpture) {
                                              onSelectSculpture(previewSc);
                                            } else {
                                              handleSelectArtworkTarget(previewSc);
                                            }
                                          }}
                                        >
                                          👁️ Preview 3D
                                        </button>
                                      );
                                    })()}
                                    <button
                                      type="button"
                                      className="btn btn-xs btn-danger"
                                      data-testid="plot-reject-tx-btn"
                                      disabled={Boolean(approvalBusyId)}
                                      onClick={() => handleRejectPendingTx(item)}
                                    >
                                      {busy ? 'Working…' : '✕ Reject'}
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-xs btn-ghost"
                                      style={{ marginLeft: 'auto' }}
                                      onClick={() =>
                                        setExpandedApprovalId(isExpanded ? '' : item.id)
                                      }
                                    >
                                      {isExpanded ? 'Hide' : 'Details'}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {activeParcel.description && (
                        <p className="mobile-parcel-desc">{activeParcel.description}</p>
                      )}

                      <div className="plot-author-meta-row" data-testid="plot-author-meta-row">
                        {onOpenProfile && stewardHandle ? (
                          <button
                            type="button"
                            className="plot-author-link-btn"
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
                          <span className="plot-author-static">
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
                        {landCreatedDate && (
                          <>
                            <span className="plot-author-sep" aria-hidden="true">·</span>
                            <span className="plot-author-date mono" data-testid="plot-land-date">
                              {landCreatedDate}
                            </span>
                          </>
                        )}
                        {renderLandInfoTip()}
                        {!user && onRequestLogin && (
                          <button
                            type="button"
                            className="btn btn-xs btn-outline"
                            style={{ marginLeft: 'auto' }}
                            data-testid="plot-signin-btn"
                            onClick={onRequestLogin}
                            title="Sign in to manage your land or artworks"
                          >
                            <XeroIcon emoji="🔐" size={11} /> Sign In
                          </button>
                        )}
                      </div>

                      {/* Mobile Proximity & AR Actions */}
                      {!isDesktop && (
                        <>
                          {isNearProperty && (
                            <div className="mobile-parcel-distance-row">
                              <span className="badge teal" data-testid="parcel-proximity-near">
                                📍 You are at this property ({formatDistance(distanceMeters, unitSystem)} away)
                              </span>
                            </div>
                          )}

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
                              <div
                                className="mobile-parcel-directions-row"
                                data-testid="parcel-directions-row"
                              >
                                {distanceMeters !== null ? (
                                  <span
                                    className="badge gold mobile-parcel-distance-badge"
                                    data-testid="parcel-proximity-far"
                                  >
                                    📍 {formatDistance(distanceMeters, unitSystem)} away
                                  </span>
                                ) : (
                                  <span
                                    className="badge mobile-parcel-distance-badge"
                                    data-testid="parcel-proximity-unknown"
                                  >
                                    📡 Locating…
                                  </span>
                                )}
                                {directionsUrl && (
                                  <a
                                    href={directionsUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="btn btn-primary mobile-parcel-cta mobile-parcel-directions-btn"
                                  >
                                    <XeroIcon emoji="🧭" size={14} /> Navigate
                                  </a>
                                )}
                              </div>
                            )}
                          </div>
                        </>
                      )}

                      {/* Desktop Quick Links */}
                      {isDesktop && (
                        <div className="plot-detail-actions">
                          {distanceMeters !== null && (
                            <span
                              className="badge gold mobile-parcel-distance-badge"
                              data-testid="parcel-proximity-far"
                            >
                              📍 {formatDistance(distanceMeters, unitSystem)} away
                            </span>
                          )}
                          {directionsUrl && (
                            <a
                              href={directionsUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="btn btn-sm"
                            >
                              <XeroIcon emoji="🧭" size={13} /> Navigate
                            </a>
                          )}
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={handleCopyShareLink}
                          >
                            🔗 Copy Share Link
                          </button>
                          {!isLandOwner && !isFrozen && user && onOpenAddLandItem && (
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              data-testid="plot-guest-add-item-btn"
                              onClick={() => onOpenAddLandItem(activeParcel.parcelId)}
                            >
                              {requiresApproval ? '🎨 Propose 3D Art' : '+ Add 3D Art'}
                            </button>
                          )}
                        </div>
                      )}

                      {/* Logged-In Land Management Controls */}
                      {isLandOwner && (
                        <div className="card plot-mgmt-section" data-testid="plot-land-management">
                          <div className="plot-mgmt-header">
                            <span className="plot-mgmt-title">
                              <XeroIcon emoji="⚙️" size={13} /> Land Management
                            </span>
                            <span
                              className="badge gold"
                              style={{ fontSize: 10 }}
                              data-testid="plot-owner-badge"
                            >
                              👑 Your Land
                            </span>
                          </div>

                          {mcpRepairAlert && (
                            <div
                              className="plot-repair-banner"
                              data-testid="plot-repair-notice"
                              role="alert"
                            >
                              <span>
                                🔗{' '}
                                {mcpRepairAlert.reason === 'expiring_soon'
                                  ? `Your agent pairing (${mcpRepairAlert.agentName || mcpRepairAlert.code || 'MCP'}) expires soon — re-pair to stay connected.`
                                  : `Your agent pairing (${mcpRepairAlert.agentName || mcpRepairAlert.code || 'MCP'}) ${
                                      mcpRepairAlert.reason === 'disconnected' ? 'was disconnected' : 'expired'
                                    } — re-pair to let your agent submit actions.`}
                              </span>
                              {onOpenPair && (
                                <button
                                  type="button"
                                  className="btn btn-xs btn-primary"
                                  data-testid="plot-repair-btn"
                                  onClick={() => onOpenPair({ reason: mcpRepairAlert.reason })}
                                >
                                  Re-pair Now
                                </button>
                              )}
                            </div>
                          )}

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
