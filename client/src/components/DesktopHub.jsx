import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LAND_VOLUME_LIMITS } from '../../../shared/constants.mjs';
import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import {
  buildParcelShareUrl,
  computeOrientedFootprintLngLat,
  footprintsOverlap,
  normalizeRotationDeg,
  parseParcelParamFromLocation,
  resolveLandDisplayName,
  validateAndNormalizeLandVolume
} from '../../../shared/landVolume.mjs';
import { buildPropertyOwnerPrompt } from '../../../shared/landSignatureMessage.mjs';
import { parseProfileParamFromLocation } from '../../../shared/profileRules.mjs';
import { api, API_BASE } from '../utils/api.js';
import {
  buildSculptureShareUrl,
  buildShareToXUrl,
  copyToClipboard
} from '../utils/clipboard.js';
import {
  formatDistance,
  formatRadiusLabel,
  useMeasurementUnits
} from '../utils/measurementUnits.js';
import {
  cloneDrafts,
  createPastedDraftFromTemplate,
  DRAFT_EDIT_COALESCE_MS,
  draftSnapshotsEqual,
  extractLandCopyTemplate,
  getDraftUpdateFieldGroup,
  hasActiveTextSelection,
  isEditableKeyboardTarget,
  pruneDraftIdsFromHistory,
  pushDraftHistoryEntry
} from '../utils/draftLandHistory.js';
import {
  groupNearestLandsWithSculptures,
  isLandOwnedByUser,
  resolveLandCoords
} from '../utils/landMapHelpers.js';
import {
  buildPendingPreviewSculpture,
  buildPendingPreviewSculptures
} from '../utils/pendingApprovalPreview.js';
import { notifySettingsSaved } from '../utils/toastNotice.js';
import { recordLastViewedItem, recordUserAction } from '../utils/userHistory.js';
import AddLandItemModal from './AddLandItemModal.jsx';
import AdminPanel from './AdminPanel.jsx';
import BrandLogo from './BrandLogo.jsx';
import DesktopLandBuilderPanel from './DesktopLandBuilderPanel.jsx';
import GoogleLoginGate from './GoogleLoginGate.jsx';
import InfoTermsModal from './InfoTermsModal.jsx';
import LandArchiveModal from './LandArchiveModal.jsx';
import LandManagementModal from './LandManagementModal.jsx';
import MapView3D from './MapView3D.jsx';
import NotificationCenter, {
  GlobalNotificationBell,
  NotificationProvider
} from './NotificationCenter.jsx';
import PairWorkbench3D from './PairWorkbench3D.jsx';
import PlotVisitView from './PlotVisitView.jsx';
import ProfileModal from './ProfileModal.jsx';
import SculptureModal from './SculptureModal.jsx';
import SculptureThumbnail from './SculptureThumbnail.jsx';
import TitleLandModal from './TitleLandModal.jsx';
import UserHandleBadge from './UserHandleBadge.jsx';
import XeroIcon from './XeroIcon.jsx';

const DESKTOP_SESSION_KEY = 'graffiland_desktop_session_v1';
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
    parcelName: sc.parcelName || '',
    landDisplayName: sc.landDisplayName || '',
    modelType: sc.modelType || 'voxel',
    customModel: sc.customModel || null,
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

function formatDistanceLabel(meters, unitSystem = 'metric') {
  if (!Number.isFinite(meters)) return '';
  return `${formatDistance(meters, unitSystem, { compact: true })} away`;
}

function computeLandFocusZoom(land) {
  const w = Number(land?.volume?.widthMeters ?? land?.widthMeters ?? 0);
  const d = Number(land?.volume?.depthMeters ?? land?.depthMeters ?? 0);
  const maxSpan = Math.max(w, d);
  if (maxSpan >= 90) return 17.2;
  if (maxSpan >= 55) return 17.8;
  if (maxSpan >= 30) return 18.2;
  return 18.5;
}

export default function DesktopHub({
  config,
  user,
  onUserUpdate,
  onLogout,
  welcomeRequest = null,
  onOpenWelcome = null
}) {
  const initialSession = useMemo(() => loadDesktopSession(), []);

  const [sculptures, setSculptures] = useState([]);
  const [parcels, setParcels] = useState([]);
  const [listings, setListings] = useState([]);
  const [dualLeaders, setDualLeaders] = useState({ aiStewards: [], humanArtists: [] });
  const [marketBusyId, setMarketBusyId] = useState('');
  const [marketNotice, setMarketNotice] = useState('');
  const [userLocation, setUserLocation] = useState(null);
  const { unitSystem } = useMeasurementUnits(userLocation);
  const nearbyRadiusLabel = formatRadiusLabel(NEARBY_RADIUS_METERS, unitSystem);
  const [areaFilter, setAreaFilter] = useState(() =>
    initialSession.areaFilter === 'all' ? 'all' : 'nearby'
  );
  const [nearbyCategory, setNearbyCategory] = useState(() =>
    initialSession.nearbyDefaultVersion >= 2 && initialSession.nearbyCategory === 'sculptures'
      ? 'sculptures'
      : 'land'
  ); // 'land' | 'sculptures'
  const [selectedLandParcelId, setSelectedLandParcelId] = useState('');
  const [sidebarTab, setSidebarTab] = useState('list'); // 'list' | 'land' | 'gallery' | 'market' | 'leaders'
  const [drawMode, setDrawMode] = useState(false);
  const [viewMode, setViewMode] = useState('isometric'); // 'isometric' | '3d' | '2d'
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const [autoSwitchedHint, setAutoSwitchedHint] = useState(false);
  const [draftParcelsRaw, setDraftParcelsRaw] = useState([]);
  const [selectedDraftId, setSelectedDraftId] = useState('');
  const draftParcelsRawRef = useRef(draftParcelsRaw);
  draftParcelsRawRef.current = draftParcelsRaw;
  const selectedDraftIdRef = useRef(selectedDraftId);
  selectedDraftIdRef.current = selectedDraftId;
  const [draftUndoStack, setDraftUndoStack] = useState([]);
  const [draftRedoStack, setDraftRedoStack] = useState([]);
  const draftUndoStackRef = useRef(draftUndoStack);
  draftUndoStackRef.current = draftUndoStack;
  const draftRedoStackRef = useRef(draftRedoStack);
  draftRedoStackRef.current = draftRedoStack;
  const [copiedLandTemplate, setCopiedLandTemplate] = useState(null);
  const copiedLandTemplateRef = useRef(copiedLandTemplate);
  copiedLandTemplateRef.current = copiedLandTemplate;
  const pendingDraftGestureRef = useRef(null);
  const lastDraftCoalesceRef = useRef({ draftId: '', fieldGroup: '', ts: 0 });
  const [desktopPhonePaired, setDesktopPhonePaired] = useState(false);
  const prevUserIdForPairRef = useRef(user?.id || '');
  const [mintBusy, setMintBusy] = useState(false);
  const [landStatus, setLandStatus] = useState('');
  const [recentlyMintedParcels, setRecentlyMintedParcels] = useState([]);
  const [mintLimitError, setMintLimitError] = useState(null);
  const [notifRefreshSignal, setNotifRefreshSignal] = useState(0);
  const [agentPairExpanded, setAgentPairExpanded] = useState(true);
  const [agentPairPromptPreview, setAgentPairPromptPreview] = useState('');
  const [copiedMcpCode, setCopiedMcpCode] = useState(false);
  const copiedMcpCodeTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(copiedMcpCodeTimerRef.current), []);
  const draftCountRef = useRef(0);
  draftCountRef.current = draftParcelsRaw.length;
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
  const [infoInitialTab, setInfoInitialTab] = useState('guide');
  const [infoInitialViewport, setInfoInitialViewport] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      const p = new URLSearchParams(window.location.search).get('archive');
      return Boolean(p && p !== '0' && p !== 'false');
    } catch {
      return false;
    }
  });
  const [archiveInitialId, setArchiveInitialId] = useState(() => {
    if (typeof window === 'undefined') return '';
    try {
      const p = new URLSearchParams(window.location.search).get('archive') || '';
      return p && p !== '1' && p !== 'true' ? p : '';
    } catch {
      return '';
    }
  });
  const [profileHandle, setProfileHandle] = useState(() =>
    parseProfileParamFromLocation(typeof window !== 'undefined' ? window.location.search : '')
  );
  const [landManageOpen, setLandManageOpen] = useState(false);
  const [landManageParcelId, setLandManageParcelId] = useState('');
  const [addItemParcelId, setAddItemParcelId] = useState('');
  const [titleModalTarget, setTitleModalTarget] = useState(null); // { mode: 'draft'|'owned', parcel }
  const [visitedParcel, setVisitedParcel] = useState(null);
  const [mapFocusTarget, setMapFocusTarget] = useState(null);
  const [myLands, setMyLands] = useState({ parcelCount: 0, parcels: [] });
  const [adminOpen, setAdminOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [mcpState, setMcpState] = useState({
    mcpActive: false,
    activePairing: null,
    latestPairing: null,
    needsRepair: false,
    expiringSoon: false,
    repairReason: '',
    pairings: []
  });
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [pendingApprovalsLoaded, setPendingApprovalsLoaded] = useState(false);
  const [previewApprovalBusyId, setPreviewApprovalBusyId] = useState('');
  const [previewApprovalErrors, setPreviewApprovalErrors] = useState({});
  const notifiedRepairKeysRef = useRef(new Set());
  const [mcpNotice, setMcpNotice] = useState('');

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
      nearbyCategory,
      nearbyDefaultVersion: 2,
      mapViewport,
      lastSculptureId: lastSculpture?.id || '',
      lastSculptureSnapshot: summarizeSculptureSnapshot(lastSculpture),
      activeView
    });
  }, [areaFilter, nearbyCategory, mapViewport, lastSculpture, activeView]);

  const refreshData = useCallback(async () => {
    try {
      const [sRes, pRes, mRes, lRes] = await Promise.all([
        api.listSculptures({ includeVoxels: true }),
        api.listParcels(),
        api.listMarketplaceListings().catch(() => ({ listings: [] })),
        api.getAgentLeaderboard(25).catch(() => ({ aiStewards: [], humanArtists: [] }))
      ]);
      const nextList = sRes.sculptures || [];
      setSculptures(nextList);
      setParcels(pRes.parcels || []);
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
    const urlParams = new URLSearchParams(window.location.search);
    const deepId = urlParams.get('sculpture');
    const parsedParcel = parseParcelParamFromLocation(
      window.location.search,
      window.location.pathname
    );
    const deepParcel = parsedParcel.parcelId;
    const deepSlug = parsedParcel.slug;
    const rawDeepLat = urlParams.get('lat');
    const rawDeepLng = urlParams.get('lng');
    const deepLat = rawDeepLat !== null && rawDeepLat !== '' ? Number(rawDeepLat) : NaN;
    const deepLng = rawDeepLng !== null && rawDeepLng !== '' ? Number(rawDeepLng) : NaN;
    if (deepParcel || deepSlug) {
      const lookupToken = deepParcel || deepSlug;
      setVisitedParcel({ loading: true, parcel: null, sculptures: [], error: '' });
      api
        .getLandDetail(lookupToken)
        .then((res) => {
          if (res?.parcel) {
            setVisitedParcel({
              loading: false,
              parcel: res.parcel,
              sculptures: res.sculptures || [],
              error: ''
            });
            const cLat = Number(res.parcel.centerLat ?? res.parcel.volume?.centerLat);
            const cLng = Number(res.parcel.centerLng ?? res.parcel.volume?.centerLng);
            if (Number.isFinite(cLat) && Number.isFinite(cLng)) {
              setMapFocusTarget({ lat: cLat, lng: cLng, zoom: 17.8, ts: Date.now() });
              setMapViewport((prev) => ({ ...(prev || {}), lat: cLat, lng: cLng, zoom: 17.8 }));
            }
            setViewMode('isometric');
            return;
          }
          throw new Error('not-minted');
        })
        .catch(() => {
          if (deepParcel && Number.isFinite(deepLat) && Number.isFinite(deepLng)) {
            setVisitedParcel(null);
            const deepW = Number(urlParams.get('w')) || LAND_VOLUME_LIMITS.defaultWidthMeters;
            const deepD = Number(urlParams.get('d')) || LAND_VOLUME_LIMITS.defaultDepthMeters;
            const deepH = Number(urlParams.get('h')) || LAND_VOLUME_LIMITS.defaultHeightMeters;
            const deepRot = Number(urlParams.get('rot')) || 0;
            const deepName = urlParams.get('name') || '';
            const id = `draft-url-${deepParcel}`;
            setDraftParcelsRaw((prev) => {
              if (prev.some((d) => d.parcelId === deepParcel || d.id === id)) return prev;
              return [
                ...prev,
                {
                  id,
                  parcelId: deepParcel.toUpperCase(),
                  centerLat: deepLat,
                  centerLng: deepLng,
                  widthMeters: deepW,
                  depthMeters: deepD,
                  heightMeters: deepH,
                  zScale: Number((deepH / LAND_VOLUME_LIMITS.defaultHeightMeters).toFixed(3)),
                  rotationDeg: deepRot,
                  customName: deepName
                }
              ];
            });
            setSelectedDraftId(id);
            setSidebarTab('land');
            setViewMode('3d');
            setMapViewport((prev) => ({ ...(prev || {}), lat: deepLat, lng: deepLng, zoom: 17.5 }));
          } else {
            setVisitedParcel({
              loading: false,
              parcel: null,
              sculptures: [],
              error: 'Virtual Land plot not found.'
            });
          }
        });
    }
    if (deepId) {
      api
        .getSculpture(deepId)
        .then((res) => {
          if (res?.sculpture) {
            const sc = res.sculpture;
            setSelected(sc);
            setLastSculpture(sc);
            if (sc.parcelId) {
              setSelectedLandParcelId(sc.parcelId);
            }
            const b = sc.parcelBounds;
            const cLat =
              b && Number.isFinite(Number(b.minLat)) && Number.isFinite(Number(b.maxLat))
                ? (Number(b.minLat) + Number(b.maxLat)) / 2
                : Number(sc.lat);
            const cLng =
              b && Number.isFinite(Number(b.minLng)) && Number.isFinite(Number(b.maxLng))
                ? (Number(b.minLng) + Number(b.maxLng)) / 2
                : Number(sc.lng);
            if (Number.isFinite(cLat) && Number.isFinite(cLng)) {
              setMapFocusTarget({
                lat: cLat,
                lng: cLng,
                zoom: 18.2,
                parcelId: sc.parcelId || '',
                instant: true,
                ts: Date.now()
              });
              setMapViewport((prev) => ({ ...(prev || {}), lat: cLat, lng: cLng, zoom: 18.2 }));
            }
          }
        })
        .catch(() => {});
    }
  }, [refreshData, refreshMyLands]);

  const activeVisitedParcelId = visitedParcel?.parcel?.parcelId || '';
  const refreshVisitedParcelDetail = useCallback(
    async (parcelId = activeVisitedParcelId) => {
      if (!parcelId) return;
      try {
        const res = await api.getLandDetail(parcelId);
        if (!res?.parcel) return;
        setVisitedParcel((prev) =>
          prev?.parcel?.parcelId === parcelId
            ? {
                ...prev,
                loading: false,
                parcel: res.parcel,
                sculptures: res.sculptures || [],
                error: ''
              }
            : prev
        );
      } catch {
        // ignore transient refresh failure
      }
    },
    [activeVisitedParcelId]
  );

  // When auth changes while inspecting a plot link, refresh detail so owner/contributor permissions appear immediately
  useEffect(() => {
    if (!activeVisitedParcelId) return;
    refreshVisitedParcelDetail(activeVisitedParcelId);
  }, [activeVisitedParcelId, user?.id, refreshVisitedParcelDetail]);

  const refreshPairingAndApprovals = useCallback(async () => {
    if (!user?.id) {
      setMcpState({
        mcpActive: false,
        activePairing: null,
        latestPairing: null,
        needsRepair: false,
        expiringSoon: false,
        repairReason: '',
        pairings: []
      });
      setPendingApprovals([]);
      setPendingApprovalsLoaded(true);
      return;
    }
    try {
      const [pairRes, sigRes] = await Promise.all([
        api.listMcpPairings().catch(() => null),
        api.listPendingSignatures().catch(() => null)
      ]);
      if (pairRes) {
        setMcpState(pairRes);
        if (pairRes.needsRepair || pairRes.expiringSoon) {
          const code = pairRes.latestPairing?.code || pairRes.activePairing?.code || '';
          const reason = pairRes.needsRepair ? pairRes.repairReason || 'expired' : 'expiring_soon';
          const dedupeKey = `desk:${reason}:${code}`;
          if (!notifiedRepairKeysRef.current.has(dedupeKey)) {
            notifiedRepairKeysRef.current.add(dedupeKey);
            const msg =
              reason === 'expiring_soon'
                ? `🔗 Your AI agent pairing (${code || 'MCP'}) expires soon — open Pairing to re-pair.`
                : `🔗 Re-pair needed: your AI agent pairing (${code || 'MCP'}) ${
                    reason === 'disconnected' ? 'was disconnected' : 'expired'
                  }. Open Pairing to reconnect.`;
            notifySettingsSaved(msg, { tone: 'warning', durationMs: 6500 });
          }
        }
      }
      if (sigRes && Array.isArray(sigRes.requests)) {
        setPendingApprovals(sigRes.requests.filter((r) => r && r.status === 'pending'));
        setPendingApprovalsLoaded(true);
      }
    } catch {
      // ignore transient error
    }
  }, [user?.id]);

  useEffect(() => {
    setPendingApprovalsLoaded(false);
  }, [user?.id]);

  useEffect(() => {
    refreshPairingAndApprovals();
    if (!user?.id) return undefined;
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      refreshPairingAndApprovals();
    };
    const timer = setInterval(tick, 15000);
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        refreshPairingAndApprovals();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [user?.id, pairOpen, refreshPairingAndApprovals]);

  useEffect(() => {
    const nextUid = user?.id || '';
    if (prevUserIdForPairRef.current && prevUserIdForPairRef.current !== nextUid) {
      setDesktopPhonePaired(false);
    }
    prevUserIdForPairRef.current = nextUid;
  }, [user?.id]);

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

  const groupedLands = useMemo(
    () =>
      groupNearestLandsWithSculptures({
        parcels,
        sculptures,
        location: userLocation,
        filterMode: areaFilter === 'all' ? 'all' : 'nearby',
        radiusMeters: NEARBY_RADIUS_METERS,
        unitSystem
      }),
    [parcels, sculptures, userLocation, areaFilter, unitSystem]
  );

  const creatorLeaderboard = useMemo(() => {
    const byCreator = new Map();
    for (const sc of sculptures || []) {
      const key = sc.creatorSub || sc.creatorUsername || sc.recipientAddress || 'anonymous';
      if (!byCreator.has(key)) {
        byCreator.set(key, {
          key,
          profileId: sc.creatorUsername || sc.creatorSub || '',
          username: sc.creatorUsername || '',
          avatarImage: sc.creatorAvatar || '',
          creatorSub: sc.creatorSub || '',
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

  function focusLandForSculpture(sc) {
    if (!sc) return;
    const targetPid = String(sc.parcelId || '').toUpperCase();
    const matchedParcel = targetPid
      ? (groupedLands.allLands || []).find(
          (l) => String(l.parcelId || '').toUpperCase() === targetPid
        ) ||
        (parcels || []).find((p) => String(p.parcelId || '').toUpperCase() === targetPid) ||
        (myLands?.parcels || []).find(
          (p) => String(p.parcelId || '').toUpperCase() === targetPid
        ) ||
        null
      : null;

    const resolvedParcelId = matchedParcel?.parcelId || sc.parcelId || '';
    if (resolvedParcelId) {
      setSelectedLandParcelId(resolvedParcelId);
    }

    const parcelCoords = matchedParcel ? resolveLandCoords(matchedParcel) : null;
    let focusLat = parcelCoords?.lat;
    let focusLng = parcelCoords?.lng;

    if (!Number.isFinite(focusLat) || !Number.isFinite(focusLng)) {
      const b = sc.parcelBounds;
      if (
        b &&
        Number.isFinite(Number(b.minLat)) &&
        Number.isFinite(Number(b.maxLat)) &&
        Number.isFinite(Number(b.minLng)) &&
        Number.isFinite(Number(b.maxLng))
      ) {
        focusLat = (Number(b.minLat) + Number(b.maxLat)) / 2;
        focusLng = (Number(b.minLng) + Number(b.maxLng)) / 2;
      }
    }
    if (!Number.isFinite(focusLat) || !Number.isFinite(focusLng)) {
      const sLat = Number(sc.lat);
      const sLng = Number(sc.lng);
      if (Number.isFinite(sLat) && Number.isFinite(sLng)) {
        focusLat = sLat;
        focusLng = sLng;
      }
    }

    if (Number.isFinite(focusLat) && Number.isFinite(focusLng)) {
      const zoom = computeLandFocusZoom(matchedParcel);
      setMapFocusTarget({
        lat: focusLat,
        lng: focusLng,
        zoom,
        parcelId: resolvedParcelId,
        instant: true,
        ts: Date.now()
      });
      setMapViewport((prev) => ({
        ...(prev || {}),
        lat: focusLat,
        lng: focusLng,
        zoom
      }));
    }
  }

  function openSculpture(sc) {
    if (!sc) return;
    setPairOpen(false);
    setInfoOpen(false);
    focusLandForSculpture(sc);
    setSelected(sc);
    if (sc.isPendingPreview) return;
    setLastSculpture(sc);
    const landName = getLiveLandName(sc);
    recordLastViewedItem(user?.id, {
      kind: 'sculpture',
      id: sc.id,
      sculptureId: sc.id,
      parcelId: sc.parcelId || '',
      title: sc.title || 'Sculpture',
      subtitle: landName,
      snapshot: summarizeSculptureSnapshot(sc)
    });
    recordUserAction(user?.id, {
      type: 'view_sculpture',
      icon: '🧊',
      title: `Viewed "${sc.title || 'Sculpture'}"`,
      detail: landName,
      sculptureId: sc.id,
      parcelId: sc.parcelId || '',
      linkLabel: 'View'
    });
  }

  const pendingPreviewSculptures = useMemo(
    () =>
      buildPendingPreviewSculptures(pendingApprovals, {
        parcels,
        existingSculptures: sculptures
      }),
    [pendingApprovals, parcels, sculptures]
  );

  const mapViewSculptures = useMemo(
    () => [...displayedSculptures, ...pendingPreviewSculptures],
    [displayedSculptures, pendingPreviewSculptures]
  );

  function handleDesktopApprovalResolved({ requestId = '' } = {}) {
    if (requestId) {
      setPendingApprovals((prev) => prev.filter((r) => r.id !== requestId));
      setSelected((prev) =>
        prev?.isPendingPreview && prev.pendingRequestId === requestId ? null : prev
      );
    }
    refreshData();
    refreshMyLands();
    refreshPairingAndApprovals();
    refreshVisitedParcelDetail();
    setNotifRefreshSignal((n) => n + 1);
  }

  async function handleApprovePendingFromPreview(reqItem, options = {}) {
    if (!reqItem?.id || !user?.id || previewApprovalBusyId) return;
    const autoFitScale = Boolean(options?.autoFitScale);
    setPreviewApprovalBusyId(reqItem.id);
    setPreviewApprovalErrors((prev) => {
      if (!prev[reqItem.id]) return prev;
      const next = { ...prev };
      delete next[reqItem.id];
      return next;
    });
    try {
      let extSig = '';
      if (
        !autoFitScale &&
        reqItem.canonicalMessage &&
        reqItem.ownerAddress &&
        user?.walletAddress &&
        user.walletAddress.toLowerCase() !== reqItem.ownerAddress.toLowerCase() &&
        typeof window !== 'undefined' &&
        window.ethereum
      ) {
        extSig = await window.ethereum.request({
          method: 'personal_sign',
          params: [reqItem.canonicalMessage, reqItem.ownerAddress]
        });
      }
      const signPayload = {
        ...(extSig ? { signature: extSig } : {}),
        ...(autoFitScale ? { autoFitScale: true } : {})
      };
      const signRes = await api.mobileSignRequest(reqItem.id, signPayload);
      const title = reqItem.summaryTitle || reqItem.payload?.title || 'Sculpture';
      const fitSuffix = signRes?.autoFittedScale ? ` (auto-fitted to ${signRes.autoFittedScale}×)` : '';
      const landTitle = getLiveLandName({ parcelId: reqItem.parcelId }, reqItem.landDisplayName || 'your land');
      recordUserAction(user?.id, {
        type: 'approve_land_tx',
        icon: '✅',
        title: `Approved "${title}"${fitSuffix}`,
        detail: landTitle,
        parcelId: reqItem.parcelId || '',
        sculptureId: signRes?.result?.sculpture?.id || reqItem.sculptureId || '',
        linkLabel: 'Land'
      });
      const targetParcelId = String(
        signRes?.result?.sculpture?.parcelId ||
          signRes?.result?.parcel?.parcelId ||
          signRes?.request?.parcelId ||
          reqItem.parcelId ||
          ''
      ).trim();
      const quotedTitle = title.includes('"') ? title : `"${title}"`;
      notifySettingsSaved(
        `Approved & minted ${quotedTitle}${fitSuffix} on "${landTitle}"!`,
        targetParcelId
          ? {
              actionLabel: '📍 Go to Land →',
              onAction: () => {
                const localParcel =
                  (parcels || []).find(
                    (p) => String(p.parcelId || '').toUpperCase() === targetParcelId.toUpperCase()
                  ) || { parcelId: targetParcelId };
                openLandShowcase(localParcel);
              }
            }
          : undefined
      );
      handleDesktopApprovalResolved({ requestId: reqItem.id });
    } catch (err) {
      const errMsg = err?.message || 'Could not approve transaction.';
      const maxSafe = Number(err?.data?.maxSafeScale ?? err?.data?.suggestedScale ?? 0);
      setPreviewApprovalErrors((prev) => ({
        ...prev,
        [reqItem.id]: {
          message: errMsg,
          code: String(err?.data?.code || ''),
          maxSafeScale: Number.isFinite(maxSafe) && maxSafe > 0 ? maxSafe : null
        }
      }));
      notifySettingsSaved(`⚠️ ${errMsg}`, { tone: 'error', durationMs: 6500 });
    } finally {
      setPreviewApprovalBusyId('');
    }
  }

  async function handleRejectPendingFromPreview(reqItem) {
    if (!reqItem?.id || !user?.id || previewApprovalBusyId) return;
    setPreviewApprovalBusyId(reqItem.id);
    try {
      await api.rejectSignatureRequest(reqItem.id);
      const title = reqItem.summaryTitle || reqItem.payload?.title || 'Transaction';
      notifySettingsSaved(`Rejected "${title}".`);
      handleDesktopApprovalResolved({ requestId: reqItem.id });
    } catch (err) {
      notifySettingsSaved(`⚠️ ${err?.message || 'Could not reject transaction.'}`, {
        tone: 'error',
        durationMs: 5000
      });
    } finally {
      setPreviewApprovalBusyId('');
    }
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
      recordUserAction(user?.id, {
        type: 'buy_listing',
        icon: '🛒',
        title: `Purchased "${listing.sculptureTitle || 'NFT'}"`,
        detail: `${listing.priceEth} ETH`,
        sculptureId: listing.sculptureId || '',
        parcelId: listing.parcelId || '',
        linkLabel: 'Artwork'
      });
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
    setAgentPairExpanded(true);
    setPairOpen(true);
  }

  function openInfoModal() {
    setSelected(null);
    setPairOpen(false);
    setInfoInitialTab('guide');
    setInfoInitialViewport('');
    setInfoOpen(true);
  }

  function openMintLandMode() {
    setSidebarTab('land');
    setDrawMode(true);
  }

  function switchSidebarTab(nextTab) {
    setSidebarTab(nextTab);
    if (nextTab === 'land') {
      setDrawMode(true);
    } else {
      setDrawMode(false);
    }
  }

  function selectNearbyCategory(nextCategory) {
    setNearbyCategory(nextCategory === 'land' ? 'land' : 'sculptures');
    setSidebarTab('list');
    setDrawMode(false);
  }

  function focusLandOnMap(land) {
    if (!land?.parcelId) return;
    setSelectedLandParcelId(land.parcelId);
    const coords = resolveLandCoords(land);
    if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
      const zoom = computeLandFocusZoom(land);
      setMapFocusTarget({
        lat: coords.lat,
        lng: coords.lng,
        zoom,
        parcelId: land.parcelId,
        ts: Date.now()
      });
      setMapViewport((prev) => ({ ...(prev || {}), lat: coords.lat, lng: coords.lng, zoom }));
    }
    const title = getLiveLandName(land, land.displayName || 'Virtual Land');
    recordLastViewedItem(user?.id, {
      kind: 'land',
      id: land.parcelId,
      parcelId: land.parcelId,
      title,
      subtitle: land.compactDimensionsLabel || '',
      snapshot: {
        parcelId: land.parcelId,
        customName: land.customName || title,
        centerLat: coords?.lat ?? land.centerLat ?? null,
        centerLng: coords?.lng ?? land.centerLng ?? null,
        volume: land.volume || null
      }
    });
  }

  function openLandShowcase(land) {
    if (!land?.parcelId) return;
    const hadCoords = Boolean(resolveLandCoords(land));
    focusLandOnMap(land);
    const title = getLiveLandName(land, land.displayName || 'Virtual Land');
    recordUserAction(user?.id, {
      type: 'view_land',
      icon: '🗺️',
      title: `Inspected land "${title}"`,
      detail: land.compactDimensionsLabel || '3D Land Showcase',
      parcelId: land.parcelId,
      linkLabel: 'Land'
    });
    setPairOpen(false);
    setInfoOpen(false);
    setSelected(null);
    setVisitedParcel({
      loading: false,
      parcel: land,
      sculptures: Array.isArray(land.sculptures) ? land.sculptures : [],
      error: ''
    });
    api
      .getLandDetail(land.parcelId)
      .then((res) => {
        if (res?.parcel) {
          if (!hadCoords) {
            focusLandOnMap(res.parcel);
          }
          setVisitedParcel({
            loading: false,
            parcel: res.parcel,
            sculptures: res.sculptures || [],
            error: ''
          });
        }
      })
      .catch(() => {});
  }

  function dismissOverlaysForNotification({ keepPlot = false, keepSculpture = false } = {}) {
    setProfileHandle('');
    setLandManageOpen(false);
    setInfoOpen(false);
    setArchiveOpen(false);
    setAddItemParcelId('');
    setPairOpen(false);
    setAdminOpen(false);
    setTitleModalTarget(null);
    if (!keepSculpture) setSelected(null);
    if (!keepPlot) setVisitedParcel(null);
  }

  async function handleNotificationAction(item) {
    if (!item) return;
    if (item.actionType === 'open_pair_mobile') {
      dismissOverlaysForNotification();
      if (item.meta?.needsRepair) {
        setAgentPairExpanded(true);
      }
      openPairModal();
    } else if (item.actionType === 'preview_pending_sculpture') {
      dismissOverlaysForNotification({ keepPlot: true });
      const reqId = item.pendingRequest?.id || item.meta?.requestId || '';
      let matchedPreview =
        (reqId && pendingPreviewSculptures.find((p) => p.pendingRequestId === reqId)) ||
        (item.pendingRequest
          ? buildPendingPreviewSculpture(item.pendingRequest, {
              parcels,
              existingSculptures: sculptures,
              allowFallbackCoords: true
            })
          : null);
      if (!matchedPreview && reqId && typeof api.getSignatureRequest === 'function') {
        try {
          const sigRes = await api.getSignatureRequest(reqId);
          const fullReq = sigRes?.request || sigRes;
          if (fullReq?.id) {
            matchedPreview = buildPendingPreviewSculpture(fullReq, {
              parcels,
              existingSculptures: sculptures,
              allowFallbackCoords: true
            });
          }
        } catch {
          // Fall back to opening the land showcase below if hydration fails
        }
      }
      if (matchedPreview) {
        openSculpture(matchedPreview);
        return;
      }
      if (item.parcelId) {
        const localParcel =
          (parcels || []).find(
            (p) => String(p.parcelId || '').toUpperCase() === String(item.parcelId).toUpperCase()
          ) || { parcelId: item.parcelId };
        openLandShowcase(localParcel);
      }
    } else if (item.actionType === 'open_land_approval' && item.parcelId) {
      dismissOverlaysForNotification();
      const localParcel =
        (parcels || []).find(
          (p) => String(p.parcelId || '').toUpperCase() === String(item.parcelId).toUpperCase()
        ) || { parcelId: item.parcelId };
      openLandShowcase(localParcel);
    } else if (item.actionType === 'open_mint') {
      dismissOverlaysForNotification();
      setInfoInitialTab('mint');
      setInfoOpen(true);
    } else if (item.actionType === 'open_archive') {
      dismissOverlaysForNotification();
      setArchiveInitialId(String(item.meta?.archiveId || ''));
      setArchiveOpen(true);
    } else if (
      (item.actionType === 'open_sculpture' ||
        (item.sculptureId && item.actionType !== 'open_land')) &&
      item.sculptureId
    ) {
      dismissOverlaysForNotification({ keepPlot: true });
      const localMatch = (sculptures || []).find((s) => s.id === item.sculptureId);
      if (localMatch) {
        openSculpture(localMatch);
        return;
      }
      try {
        const res = await api.getSculpture(item.sculptureId);
        if (res?.sculpture) {
          openSculpture(res.sculpture);
          return;
        }
      } catch {
        // Fallback to opening land if sculpture fetch fails
      }
      if (item.parcelId) {
        setLandManageParcelId(item.parcelId);
        setLandManageOpen(true);
      }
    } else if (item.actionType === 'open_land' && item.parcelId) {
      dismissOverlaysForNotification();
      const localParcel =
        (parcels || []).find(
          (p) => String(p.parcelId || '').toUpperCase() === String(item.parcelId).toUpperCase()
        ) || { parcelId: item.parcelId };
      openLandShowcase(localParcel);
    }
  }

  const draftParcels = useMemo(() => {
    const existingVols = (parcels || []).map((p) => p?.volume || null).filter(Boolean);
    const validated = (draftParcelsRaw || []).map((raw) => {
      const centerLat = Number(raw.centerLat ?? raw.lat);
      const centerLng = Number(raw.centerLng ?? raw.lng);
      const res = validateAndNormalizeLandVolume({
        parcelId: raw.parcelId,
        lat: centerLat,
        lng: centerLng,
        widthMeters: raw.widthMeters,
        depthMeters: raw.depthMeters,
        heightMeters: raw.heightMeters,
        zScale: raw.zScale,
        rotationDeg: raw.rotationDeg
      });
      if (res.ok && res.volume) {
        return {
          ...raw,
          ...res.volume,
          id: raw.id,
          customName: raw.customName || '',
          valid: true,
          errors: []
        };
      }
      const w = Number(raw.widthMeters || LAND_VOLUME_LIMITS.defaultWidthMeters);
      const d = Number(raw.depthMeters || LAND_VOLUME_LIMITS.defaultDepthMeters);
      const h = Number(raw.heightMeters || LAND_VOLUME_LIMITS.defaultHeightMeters);
      const rot = Number(raw.rotationDeg || 0);
      const { corners, ring } = computeOrientedFootprintLngLat({
        lat: centerLat,
        lng: centerLng,
        widthMeters: w,
        depthMeters: d,
        rotationDeg: rot
      });
      return {
        ...raw,
        centerLat,
        centerLng,
        widthMeters: w,
        depthMeters: d,
        heightMeters: h,
        zScale: Number((h / LAND_VOLUME_LIMITS.defaultHeightMeters).toFixed(3)),
        rotationDeg: rot,
        footprintAreaSqM: Math.round(w * d),
        volumeCubicM: Math.round(w * d * h),
        corners,
        ring,
        valid: false,
        errors: res.errors || ['Invalid land volume dimensions.']
      };
    });

    return validated.map((item, idx) => {
      let hasOverlap = existingVols.some((ev) => footprintsOverlap(item, ev));
      if (!hasOverlap) {
        hasOverlap = validated.some((other, oIdx) => oIdx !== idx && footprintsOverlap(item, other));
      }
      return { ...item, hasOverlap };
    });
  }, [draftParcelsRaw, parcels]);

  const ownedUserParcels = useMemo(() => {
    if (!user?.id) return [];
    const byPid = new Map();
    for (const p of parcels || []) {
      if (p.ownerSub === user.id || p.claimedBy === user.id) {
        byPid.set(p.parcelId, p);
      }
    }
    for (const mp of myLands?.parcels || []) {
      if (mp?.parcelId) {
        const prev = byPid.get(mp.parcelId) || {};
        byPid.set(mp.parcelId, {
          ...prev,
          ...mp,
          volume: mp.volume || prev.volume,
          frozen: Boolean(mp.frozen ?? mp.settings?.frozen ?? prev.frozen)
        });
      }
    }
    return Array.from(byPid.values());
  }, [parcels, myLands, user?.id]);

  const ownedParcelIds = useMemo(
    () => ownedUserParcels.map((p) => p.parcelId).filter(Boolean),
    [ownedUserParcels]
  );

  // Live latest owner-set land name lookup so renaming a land updates every badge, list & toast immediately
  const landNameByParcelId = useMemo(() => {
    const map = new Map();
    for (const list of [parcels, ownedUserParcels, recentlyMintedParcels]) {
      for (const p of list || []) {
        const pid = String(p?.parcelId || '').toUpperCase();
        if (!pid) continue;
        const resolved = resolveLandDisplayName(p, { defaultName: '' });
        if (resolved) map.set(pid, resolved);
      }
    }
    return map;
  }, [parcels, ownedUserParcels, recentlyMintedParcels]);

  const getLiveLandName = useCallback(
    (parcelOrItem, fallback = 'Virtual Land') => {
      if (!parcelOrItem) return fallback;
      const pid =
        typeof parcelOrItem === 'string'
          ? parcelOrItem.toUpperCase()
          : String(parcelOrItem.parcelId || '').toUpperCase();
      if (pid && landNameByParcelId.has(pid)) {
        return landNameByParcelId.get(pid);
      }
      if (typeof parcelOrItem === 'object') {
        return resolveLandDisplayName(parcelOrItem, { defaultName: fallback });
      }
      return fallback;
    },
    [landNameByParcelId]
  );

  const activeAddItemParcel = useMemo(() => {
    if (!addItemParcelId) return null;
    const pid = String(addItemParcelId).toUpperCase();
    return (
      ownedUserParcels.find((p) => p.parcelId === pid) ||
      parcels.find((p) => p.parcelId === pid) ||
      (visitedParcel?.parcel?.parcelId?.toUpperCase() === pid ? visitedParcel.parcel : null) ||
      null
    );
  }, [addItemParcelId, ownedUserParcels, parcels, visitedParcel]);

  const activeAddItemSculptures = useMemo(() => {
    if (!activeAddItemParcel) return [];
    const fromMine = activeAddItemParcel.sculptures || [];
    if (fromMine.length > 0) return fromMine;
    return (sculptures || []).filter((s) => s.parcelId === activeAddItemParcel.parcelId);
  }, [activeAddItemParcel, sculptures]);

  const applyDraftState = useCallback((nextDrafts, nextSelectedId) => {
    draftParcelsRawRef.current = nextDrafts;
    draftCountRef.current = nextDrafts.length;
    setDraftParcelsRaw(nextDrafts);
    if (nextSelectedId !== undefined) {
      selectedDraftIdRef.current = nextSelectedId;
      setSelectedDraftId(nextSelectedId);
    }
  }, []);

  const recordDraftUndoSnapshot = useCallback((label, explicitDrafts, explicitSelectedId) => {
    const snapshotDrafts =
      explicitDrafts !== undefined ? explicitDrafts : draftParcelsRawRef.current;
    const snapshotSelected =
      explicitSelectedId !== undefined ? explicitSelectedId : selectedDraftIdRef.current;
    const nextPast = pushDraftHistoryEntry(draftUndoStackRef.current, {
      drafts: snapshotDrafts,
      selectedDraftId: snapshotSelected,
      label
    });
    draftUndoStackRef.current = nextPast;
    setDraftUndoStack(nextPast);
    draftRedoStackRef.current = [];
    setDraftRedoStack([]);
  }, []);

  const pruneMintedDraftsFromHistory = useCallback((mintedDraftIds) => {
    const nextPast = pruneDraftIdsFromHistory(draftUndoStackRef.current, mintedDraftIds);
    const nextFuture = pruneDraftIdsFromHistory(draftRedoStackRef.current, mintedDraftIds);
    draftUndoStackRef.current = nextPast;
    draftRedoStackRef.current = nextFuture;
    setDraftUndoStack(nextPast);
    setDraftRedoStack(nextFuture);
  }, []);

  const handleDraftGestureStart = useCallback((draftId, kind = 'edit') => {
    const labelMap = {
      body: 'Move land',
      corner: 'Resize land',
      edge: 'Resize land',
      vbar: 'Rotate land',
      height: 'Adjust land height',
      scale: 'Scale land',
      width: 'Resize land width',
      depth: 'Resize land depth',
      rotate: 'Rotate land'
    };
    pendingDraftGestureRef.current = {
      draftId,
      kind,
      committed: false,
      snapshot: {
        drafts: cloneDrafts(draftParcelsRawRef.current),
        selectedDraftId: selectedDraftIdRef.current,
        label: labelMap[kind] || 'Edit land'
      }
    };
    lastDraftCoalesceRef.current = { draftId: '', fieldGroup: '', ts: 0 };
  }, []);

  const handleDraftGestureEnd = useCallback(() => {
    pendingDraftGestureRef.current = null;
  }, []);

  const handleAddDraftRectangle = useCallback(
    (rect) => {
      const currentDrafts = draftParcelsRawRef.current;
      const currentCount = currentDrafts.length;
      if (currentCount >= LAND_VOLUME_LIMITS.maxSelectionBatch) {
        setLandStatus({
          text: `Selection batch limit reached (max ${LAND_VOLUME_LIMITS.maxSelectionBatch} squares).`,
          isError: true
        });
        return;
      }
      recordDraftUndoSnapshot('Add land');
      pendingDraftGestureRef.current = null;
      lastDraftCoalesceRef.current = { draftId: '', fieldGroup: '', ts: 0 };
      const nextId = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const heightMeters = Number(rect.heightMeters || LAND_VOLUME_LIMITS.defaultHeightMeters);
      const newDraft = {
        id: nextId,
        centerLat: Number(rect.lat),
        centerLng: Number(rect.lng),
        widthMeters: Number(rect.widthMeters || LAND_VOLUME_LIMITS.defaultWidthMeters),
        depthMeters: Number(rect.depthMeters || LAND_VOLUME_LIMITS.defaultDepthMeters),
        heightMeters,
        zScale: Number((heightMeters / LAND_VOLUME_LIMITS.defaultHeightMeters).toFixed(3)),
        rotationDeg: Number(rect.rotationDeg || 0),
        customName: ''
      };
      applyDraftState([...currentDrafts, newDraft], nextId);
      setSidebarTab('land');
      setDrawMode(false);
      setLandStatus('');
      if (currentCount === 0 && viewModeRef.current === '2d') {
        setViewMode('3d');
        setAutoSwitchedHint(true);
      }
    },
    [applyDraftState, recordDraftUndoSnapshot]
  );

  const handleAddDraftAtCenter = useCallback(() => {
    const existingVols = (parcels || []).map((p) => p?.volume || null).filter(Boolean);
    const activeVols = draftParcels.map((d) => d).filter(Boolean);
    const takenVols = [...existingVols, ...activeVols];

    let anchorLat =
      Number(mapViewport?.lat) ||
      Number(userLocation?.lat) ||
      Number(sculptures?.[0]?.lat) ||
      37.7749;
    let anchorLng =
      Number(mapViewport?.lng) ||
      Number(userLocation?.lng) ||
      Number(sculptures?.[0]?.lng) ||
      -122.4194;

    const defaultCamRotation = Number.isFinite(Number(mapViewport?.bearing))
      ? normalizeRotationDeg(mapViewport.bearing)
      : viewModeRef.current === 'isometric'
      ? 315
      : viewModeRef.current === '3d'
      ? 325
      : 0;

    let targetRotation = defaultCamRotation;
    if (draftParcelsRaw.length > 0) {
      const selectedDraft =
        draftParcelsRaw.find((d) => d.id === selectedDraftId) ||
        draftParcelsRaw[draftParcelsRaw.length - 1];
      targetRotation = normalizeRotationDeg(selectedDraft.rotationDeg ?? defaultCamRotation);
      const rotRad = (targetRotation * Math.PI) / 180;
      const stepMeters = Math.max(
        30,
        Number(selectedDraft.widthMeters || LAND_VOLUME_LIMITS.defaultWidthMeters) / 2 +
          LAND_VOLUME_LIMITS.defaultWidthMeters / 2 +
          14
      );
      const mPerDegLng = 111320 * Math.max(0.08, Math.cos((Number(selectedDraft.centerLat ?? anchorLat) * Math.PI) / 180));
      anchorLat =
        Number(selectedDraft.centerLat ?? selectedDraft.lat ?? anchorLat) +
        (-stepMeters * Math.sin(rotRad)) / 111320;
      anchorLng =
        Number(selectedDraft.centerLng ?? selectedDraft.lng ?? anchorLng) +
        (stepMeters * Math.cos(rotRad)) / mPerDegLng;
    }

    const candidateOffsets = [
      [0, 0],
      [0, 0.00035],
      [0.00035, 0],
      [0, -0.00035],
      [-0.00035, 0],
      [0.00035, 0.00035],
      [-0.00035, 0.00035],
      [0, 0.0007],
      [0.0007, 0]
    ];

    let chosenLat = anchorLat;
    let chosenLng = anchorLng;
    for (const [dLat, dLng] of candidateOffsets) {
      const probe = validateAndNormalizeLandVolume({
        lat: anchorLat + dLat,
        lng: anchorLng + dLng,
        widthMeters: LAND_VOLUME_LIMITS.defaultWidthMeters,
        depthMeters: LAND_VOLUME_LIMITS.defaultDepthMeters,
        heightMeters: LAND_VOLUME_LIMITS.defaultHeightMeters,
        rotationDeg: targetRotation
      }).volume;
      if (probe && !takenVols.some((tv) => footprintsOverlap(probe, tv))) {
        chosenLat = anchorLat + dLat;
        chosenLng = anchorLng + dLng;
        break;
      }
    }

    handleAddDraftRectangle({
      lat: chosenLat,
      lng: chosenLng,
      widthMeters: LAND_VOLUME_LIMITS.defaultWidthMeters,
      depthMeters: LAND_VOLUME_LIMITS.defaultDepthMeters,
      heightMeters: LAND_VOLUME_LIMITS.defaultHeightMeters,
      rotationDeg: targetRotation
    });
  }, [
    parcels,
    draftParcels,
    draftParcelsRaw,
    selectedDraftId,
    mapViewport?.lat,
    mapViewport?.lng,
    mapViewport?.bearing,
    userLocation?.lat,
    userLocation?.lng,
    sculptures,
    handleAddDraftRectangle
  ]);

  const handleUpdateDraft = useCallback(
    (id, patch, options = {}) => {
      const currentDrafts = draftParcelsRawRef.current;
      const nextDrafts = currentDrafts.map((item) =>
        item.id === id ? { ...item, ...patch } : item
      );
      if (draftSnapshotsEqual(currentDrafts, nextDrafts)) return;

      const gesture = pendingDraftGestureRef.current;
      if (gesture && gesture.draftId === id) {
        if (!gesture.committed) {
          recordDraftUndoSnapshot(
            gesture.snapshot.label,
            gesture.snapshot.drafts,
            gesture.snapshot.selectedDraftId
          );
          gesture.committed = true;
        }
      } else if (options?.discrete) {
        recordDraftUndoSnapshot(options.label || 'Edit land');
        lastDraftCoalesceRef.current = { draftId: '', fieldGroup: '', ts: 0 };
      } else {
        const fieldGroup = getDraftUpdateFieldGroup(patch);
        const now = Date.now();
        const prevCoalesce = lastDraftCoalesceRef.current;
        const canCoalesce =
          prevCoalesce.draftId === id &&
          prevCoalesce.fieldGroup === fieldGroup &&
          now - prevCoalesce.ts <= DRAFT_EDIT_COALESCE_MS;
        if (!canCoalesce) {
          const autoLabel =
            options?.label ||
            (fieldGroup === 'title'
              ? 'Rename land'
              : fieldGroup === 'description'
              ? 'Edit land description'
              : 'Edit land');
          recordDraftUndoSnapshot(autoLabel);
        }
        lastDraftCoalesceRef.current = { draftId: id, fieldGroup, ts: now };
      }

      applyDraftState(nextDrafts);
    },
    [applyDraftState, recordDraftUndoSnapshot]
  );

  const handleRemoveDraft = useCallback(
    (id) => {
      const currentDrafts = draftParcelsRawRef.current;
      if (!currentDrafts.some((item) => item.id === id)) return false;
      recordDraftUndoSnapshot('Delete land');
      pendingDraftGestureRef.current = null;
      lastDraftCoalesceRef.current = { draftId: '', fieldGroup: '', ts: 0 };
      const nextDrafts = currentDrafts.filter((item) => item.id !== id);
      const nextSelected = selectedDraftIdRef.current === id ? '' : selectedDraftIdRef.current;
      applyDraftState(nextDrafts, nextSelected);
      setLandStatus({ text: '🗑️ Deleted unminted land — press Ctrl+Z / Cmd+Z to undo.' });
      return true;
    },
    [applyDraftState, recordDraftUndoSnapshot]
  );

  const handleClearDrafts = useCallback(() => {
    const currentDrafts = draftParcelsRawRef.current;
    if (currentDrafts.length > 0) {
      recordDraftUndoSnapshot('Clear draft lands');
    }
    pendingDraftGestureRef.current = null;
    lastDraftCoalesceRef.current = { draftId: '', fieldGroup: '', ts: 0 };
    applyDraftState([], '');
    setLandStatus(
      currentDrafts.length > 0
        ? { text: 'Cleared draft lands — press Ctrl+Z / Cmd+Z to undo.' }
        : ''
    );
  }, [applyDraftState, recordDraftUndoSnapshot]);

  const handleUndoDraftAction = useCallback(() => {
    const past = draftUndoStackRef.current;
    if (!past.length) return false;
    const entry = past[past.length - 1];
    const nextPast = past.slice(0, -1);
    const nextFuture = pushDraftHistoryEntry(draftRedoStackRef.current, {
      drafts: draftParcelsRawRef.current,
      selectedDraftId: selectedDraftIdRef.current,
      label: entry.label
    });
    draftUndoStackRef.current = nextPast;
    draftRedoStackRef.current = nextFuture;
    setDraftUndoStack(nextPast);
    setDraftRedoStack(nextFuture);
    pendingDraftGestureRef.current = null;
    lastDraftCoalesceRef.current = { draftId: '', fieldGroup: '', ts: 0 };
    const restoredDrafts = cloneDrafts(entry.drafts);
    applyDraftState(restoredDrafts, entry.selectedDraftId || '');
    if (restoredDrafts.length > 0) {
      setSidebarTab('land');
    }
    setLandStatus({ text: `↩ Undid: ${entry.label}` });
    return true;
  }, [applyDraftState]);

  const handleRedoDraftAction = useCallback(() => {
    const future = draftRedoStackRef.current;
    if (!future.length) return false;
    const entry = future[future.length - 1];
    const nextFuture = future.slice(0, -1);
    const nextPast = pushDraftHistoryEntry(draftUndoStackRef.current, {
      drafts: draftParcelsRawRef.current,
      selectedDraftId: selectedDraftIdRef.current,
      label: entry.label
    });
    draftUndoStackRef.current = nextPast;
    draftRedoStackRef.current = nextFuture;
    setDraftUndoStack(nextPast);
    setDraftRedoStack(nextFuture);
    pendingDraftGestureRef.current = null;
    lastDraftCoalesceRef.current = { draftId: '', fieldGroup: '', ts: 0 };
    const restoredDrafts = cloneDrafts(entry.drafts);
    applyDraftState(restoredDrafts, entry.selectedDraftId || '');
    if (restoredDrafts.length > 0) {
      setSidebarTab('land');
    }
    setLandStatus({ text: `↪ Redid: ${entry.label}` });
    return true;
  }, [applyDraftState]);

  const resolveSelectedLandForCopy = useCallback(() => {
    const curSelected = selectedDraftIdRef.current;
    const currentDrafts = draftParcelsRawRef.current;
    if (curSelected) {
      const matchedDraft = currentDrafts.find((d) => d.id === curSelected);
      if (matchedDraft) return matchedDraft;
      if (curSelected.startsWith('owned:')) {
        const pid = curSelected.slice(6);
        const owned =
          ownedUserParcels.find((p) => p.parcelId === pid) ||
          (parcels || []).find((p) => p.parcelId === pid);
        if (owned) return owned;
      }
    }
    if (sidebarTab === 'land' && currentDrafts.length > 0) {
      return currentDrafts[0];
    }
    if (selectedLandParcelId) {
      return (parcels || []).find((p) => p.parcelId === selectedLandParcelId) || null;
    }
    return null;
  }, [ownedUserParcels, parcels, selectedLandParcelId, sidebarTab]);

  const handleCopySelectedLand = useCallback(() => {
    const target = resolveSelectedLandForCopy();
    const template = extractLandCopyTemplate(target, LAND_VOLUME_LIMITS);
    if (!template) return false;
    copiedLandTemplateRef.current = template;
    setCopiedLandTemplate(template);
    const label = template.customName ? `"${template.customName}"` : 'selected land';
    setLandStatus({
      text: `📋 Copied ${label} (${Math.round(template.widthMeters)}×${Math.round(template.depthMeters)}×${Math.round(template.heightMeters)}m) — press Ctrl+V / Cmd+V to duplicate.`
    });
    return true;
  }, [resolveSelectedLandForCopy]);

  const handlePasteCopiedLand = useCallback(() => {
    const template = copiedLandTemplateRef.current;
    if (!template) return false;
    const currentDrafts = draftParcelsRawRef.current;
    if (currentDrafts.length >= LAND_VOLUME_LIMITS.maxSelectionBatch) {
      setLandStatus({
        text: `Selection batch limit reached (max ${LAND_VOLUME_LIMITS.maxSelectionBatch} squares).`,
        isError: true
      });
      return false;
    }
    const pasted = createPastedDraftFromTemplate(template, {
      existingParcels: parcels,
      existingDrafts: draftParcelsRawRef.current,
      limits: LAND_VOLUME_LIMITS
    });
    if (!pasted) return false;
    recordDraftUndoSnapshot('Paste land');
    pendingDraftGestureRef.current = null;
    lastDraftCoalesceRef.current = { draftId: '', fieldGroup: '', ts: 0 };
    applyDraftState([...currentDrafts, pasted], pasted.id);
    setSidebarTab('land');
    setDrawMode(false);
    setLandStatus({
      text: `📌 Pasted duplicate land (${Math.round(pasted.widthMeters)}×${Math.round(pasted.depthMeters)}×${Math.round(pasted.heightMeters)}m) — press Ctrl+Z / Cmd+Z to undo.`
    });
    return true;
  }, [applyDraftState, parcels, recordDraftUndoSnapshot]);

  const hasBlockingDesktopModal = Boolean(
    selected ||
      pairOpen ||
      infoOpen ||
      landManageOpen ||
      titleModalTarget ||
      loginOpen ||
      visitedParcel ||
      activeAddItemParcel ||
      profileHandle ||
      archiveOpen ||
      adminOpen
  );

  useEffect(() => {
    const onKeyDown = (e) => {
      if (hasBlockingDesktopModal) return;
      if (isEditableKeyboardTarget(e.target)) return;

      const key = String(e.key || '').toLowerCase();
      const mod = Boolean(e.metaKey || e.ctrlKey);

      // Ctrl+Z / Cmd+Z -> Undo last land action
      if (mod && !e.altKey && !e.shiftKey && key === 'z') {
        if (draftUndoStackRef.current.length > 0) {
          e.preventDefault();
          handleUndoDraftAction();
        }
        return;
      }

      // Ctrl+Shift+Z / Cmd+Shift+Z / Ctrl+Y / Cmd+Y -> Redo land action
      if (mod && !e.altKey && ((e.shiftKey && key === 'z') || (!e.shiftKey && key === 'y'))) {
        if (draftRedoStackRef.current.length > 0) {
          e.preventDefault();
          handleRedoDraftAction();
        }
        return;
      }

      // Delete / Backspace -> Delete selected unminted land (never deletes minted land)
      if (!mod && !e.altKey && (e.key === 'Delete' || e.key === 'Backspace')) {
        const selId = selectedDraftIdRef.current;
        if (selId && draftParcelsRawRef.current.some((d) => d.id === selId)) {
          e.preventDefault();
          handleRemoveDraft(selId);
        }
        return;
      }

      // Ctrl+C / Cmd+C -> Copy selected land (when user has no text selection highlighted)
      if (mod && !e.altKey && !e.shiftKey && key === 'c') {
        if (hasActiveTextSelection()) return;
        const target = resolveSelectedLandForCopy();
        if (target) {
          e.preventDefault();
          handleCopySelectedLand();
        }
        return;
      }

      // Ctrl+V / Cmd+V -> Paste duplicated land
      if (mod && !e.altKey && !e.shiftKey && key === 'v') {
        if (copiedLandTemplateRef.current) {
          e.preventDefault();
          handlePasteCopiedLand();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    hasBlockingDesktopModal,
    handleUndoDraftAction,
    handleRedoDraftAction,
    handleRemoveDraft,
    resolveSelectedLandForCopy,
    handleCopySelectedLand,
    handlePasteCopiedLand
  ]);

  const handleMintDraft = useCallback(async (draft) => {
    if (!draft) return;
    if (!user?.id) {
      setLoginOpen(true);
      setLandStatus({ text: 'Sign in with Google to mint free starter land.', isError: true });
      return;
    }
    setMintBusy(true);
    setLandStatus('');
    setMintLimitError(null);
    try {
      const res = await api.claimLand({
        parcelId: draft.parcelId,
        lat: draft.centerLat,
        lng: draft.centerLng,
        customName: draft.customName?.trim() || '',
        description: draft.description?.trim() || undefined,
        curationNote: draft.description?.trim() || undefined,
        volume: {
          centerLat: draft.centerLat,
          centerLng: draft.centerLng,
          widthMeters: draft.widthMeters,
          depthMeters: draft.depthMeters,
          heightMeters: draft.heightMeters,
          zScale: draft.zScale,
          rotationDeg: draft.rotationDeg
        }
      });
      const mintedParcelRecord = {
        parcelId: res.parcelId,
        customName: res.customName || draft.customName?.trim() || 'Virtual Land',
        description: draft.description?.trim() || '',
        volume: res.volume || {
          centerLat: draft.centerLat,
          centerLng: draft.centerLng,
          widthMeters: draft.widthMeters,
          depthMeters: draft.depthMeters,
          heightMeters: draft.heightMeters,
          zScale: draft.zScale,
          rotationDeg: draft.rotationDeg
        }
      };
      setRecentlyMintedParcels((prev) => [
        mintedParcelRecord,
        ...prev.filter((p) => p.parcelId !== res.parcelId)
      ]);
      const remainingDrafts = draftParcelsRawRef.current.filter((item) => item.id !== draft.id);
      applyDraftState(remainingDrafts, `owned:${res.parcelId}`);
      pruneMintedDraftsFromHistory([draft.id]);
      setLandStatus({
        text: `Minted "${mintedParcelRecord.customName}" (${Math.round(draft.widthMeters)}×${Math.round(draft.depthMeters)}×${Math.round(draft.heightMeters)}m) — ${res.gasPaidBy === 'platform-relayer' ? 'Gas Sponsored' : 'Minted'}! Visit in person on Mobile AR and add art within 28 days to clear the timer and permanently own it.`
      });
      recordUserAction(user?.id, {
        type: 'mint_land',
        icon: '🏗️',
        title: `Minted land "${mintedParcelRecord.customName}"`,
        detail: `${Math.round(draft.widthMeters)}×${Math.round(draft.depthMeters)}×${Math.round(draft.heightMeters)}m`,
        parcelId: res.parcelId,
        linkLabel: 'Land'
      });
      setNotifRefreshSignal((n) => n + 1);
      await Promise.all([refreshData(), refreshMyLands()]);
    } catch (err) {
      if (err?.data?.code === 'STARTER_FREE_LAND_LIMIT_REACHED' || err?.status === 429) {
        setMintLimitError({
          message: err.message,
          usedSlots: err?.data?.usedSlots ?? LAND_VOLUME_LIMITS.starterFreeHumanClaims,
          maxSlots: err?.data?.maxSlots ?? LAND_VOLUME_LIMITS.starterFreeHumanClaims,
          unbuiltParcels: err?.data?.unbuiltParcels || []
        });
        setNotifRefreshSignal((n) => n + 1);
      } else {
        setLandStatus({ text: err?.message || 'Could not mint land parcel.', isError: true });
      }
    } finally {
      setMintBusy(false);
    }
  }, [user?.id, refreshData, refreshMyLands, applyDraftState, pruneMintedDraftsFromHistory]);

  const handleMintAll = useCallback(async () => {
    const ready = draftParcels.filter(
      (d) => d.valid !== false && !d.hasOverlap && String(d.customName || '').trim().length >= 2
    );
    if (!ready.length) return;
    if (!user?.id) {
      setLoginOpen(true);
      setLandStatus({ text: 'Sign in with Google to mint starter parcels.', isError: true });
      return;
    }
    setMintBusy(true);
    setLandStatus('');
    setMintLimitError(null);
    const mintedIds = [];
    const mintedRecords = [];
    const mintedSet = new Set();
    let lastError = '';
    let hitLimitPayload = null;
    for (const draft of ready) {
      try {
        const res = await api.claimLand({
          parcelId: draft.parcelId,
          lat: draft.centerLat,
          lng: draft.centerLng,
          customName: draft.customName?.trim() || '',
          description: draft.description?.trim() || undefined,
          curationNote: draft.description?.trim() || undefined,
          volume: {
            centerLat: draft.centerLat,
            centerLng: draft.centerLng,
            widthMeters: draft.widthMeters,
            depthMeters: draft.depthMeters,
            heightMeters: draft.heightMeters,
            zScale: draft.zScale,
            rotationDeg: draft.rotationDeg
          }
        });
        mintedIds.push(res.parcelId);
        mintedRecords.push({
          parcelId: res.parcelId,
          customName: res.customName || draft.customName?.trim() || 'Virtual Land',
          description: draft.description?.trim() || '',
          volume: res.volume || {
            centerLat: draft.centerLat,
            centerLng: draft.centerLng,
            widthMeters: draft.widthMeters,
            depthMeters: draft.depthMeters,
            heightMeters: draft.heightMeters,
            zScale: draft.zScale,
            rotationDeg: draft.rotationDeg
          }
        });
        mintedSet.add(draft.id);
      } catch (err) {
        if (err?.data?.code === 'STARTER_FREE_LAND_LIMIT_REACHED' || err?.status === 429) {
          hitLimitPayload = {
            message: err.message,
            usedSlots: err?.data?.usedSlots ?? LAND_VOLUME_LIMITS.starterFreeHumanClaims,
            maxSlots: err?.data?.maxSlots ?? LAND_VOLUME_LIMITS.starterFreeHumanClaims,
            unbuiltParcels: err?.data?.unbuiltParcels || []
          };
        } else {
          lastError = err?.message || 'Mint failed.';
        }
        break;
      }
    }
    if (mintedSet.size > 0) {
      setRecentlyMintedParcels((prev) => {
        const addedIds = new Set(mintedRecords.map((r) => r.parcelId));
        return [...mintedRecords, ...prev.filter((p) => !addedIds.has(p.parcelId))];
      });
      const remainingDrafts = draftParcelsRawRef.current.filter((item) => !mintedSet.has(item.id));
      applyDraftState(remainingDrafts, `owned:${mintedIds[mintedIds.length - 1]}`);
      pruneMintedDraftsFromHistory(mintedSet);
      for (const rec of mintedRecords) {
        recordUserAction(user?.id, {
          type: 'mint_land',
          icon: '🏗️',
          title: `Minted land "${rec.customName}"`,
          detail: rec.volume
            ? `${Math.round(rec.volume.widthMeters)}×${Math.round(rec.volume.depthMeters)}×${Math.round(rec.volume.heightMeters)}m`
            : 'Virtual Land',
          parcelId: rec.parcelId,
          linkLabel: 'Land'
        });
      }
      setNotifRefreshSignal((n) => n + 1);
      await Promise.all([refreshData(), refreshMyLands()]);
    }
    if (hitLimitPayload) {
      setMintLimitError(hitLimitPayload);
      setNotifRefreshSignal((n) => n + 1);
      if (mintedRecords.length > 0) {
        setLandStatus({
          text: `Minted ${mintedRecords.map((r) => `"${r.customName}"`).join(', ')}. Free starter limit reached for remaining plots.`
        });
      }
    } else if (lastError) {
      setLandStatus({
        text: mintedRecords.length
          ? `Minted ${mintedRecords.map((r) => `"${r.customName}"`).join(', ')}. Stopped: ${lastError}`
          : lastError,
        isError: true
      });
    } else {
      setLandStatus({
        text: `Minted ${mintedRecords.length} land(s): ${mintedRecords.map((r) => `"${r.customName}"`).join(', ')}`
      });
    }
    setMintBusy(false);
  }, [draftParcels, user?.id, refreshData, refreshMyLands, applyDraftState, pruneMintedDraftsFromHistory]);

  const handleUpdateOwnedVolume = useCallback(async (parcelId, nextVolume) => {
    if (!parcelId || !user?.id) return;
    setMintBusy(true);
    setLandStatus('');
    try {
      await api.updateLandVolume(parcelId, nextVolume);
      const updatedLandName = getLiveLandName(parcelId);
      setLandStatus({ text: `Saved updated 3D bounds for "${updatedLandName}".` });
      recordUserAction(user?.id, {
        type: 'update_land_volume',
        icon: '📐',
        title: `Updated 3D bounds for "${updatedLandName}"`,
        detail: 'Saved land dimensions',
        parcelId,
        linkLabel: 'Land'
      });
      await Promise.all([refreshData(), refreshMyLands()]);
    } catch (err) {
      setLandStatus({ text: err?.message || 'Could not update 3D volume.', isError: true });
    } finally {
      setMintBusy(false);
    }
  }, [user?.id, refreshData, refreshMyLands, getLiveLandName]);

  const handleToggleFreezeParcel = useCallback(async (parcelId, nextFrozen) => {
    if (!parcelId || !user?.id) return;
    setMintBusy(true);
    try {
      await api.updateLandSettings(parcelId, { frozen: Boolean(nextFrozen) });
      const landName = getLiveLandName(parcelId);
      const freezeMsg = nextFrozen
        ? `Frozen "${landName}" — no new sculptures can be placed here.`
        : `Unfrozen "${landName}" — new sculptures are allowed again.`;
      setLandStatus({ text: freezeMsg });
      notifySettingsSaved(freezeMsg);
      recordUserAction(user?.id, {
        type: nextFrozen ? 'freeze_land' : 'unfreeze_land',
        icon: nextFrozen ? '❄️' : '☀️',
        title: `${nextFrozen ? 'Froze' : 'Unfroze'} "${landName}"`,
        detail: nextFrozen ? 'Locked new placements' : 'Allowed new placements',
        parcelId,
        linkLabel: 'Land'
      });
      await Promise.all([refreshData(), refreshMyLands()]);
    } catch (err) {
      setLandStatus({ text: err?.message || 'Could not update freeze setting.', isError: true });
      throw err;
    } finally {
      setMintBusy(false);
    }
  }, [user?.id, refreshData, refreshMyLands, getLiveLandName]);

  const handleToggleSculptureVisibility = useCallback(async (sculptureId, nextHidden) => {
    if (!sculptureId || !user?.id) return;
    await api.setSculptureVisibility(sculptureId, {
      hidden: Boolean(nextHidden),
      reason: nextHidden ? 'Hidden by Virtual Land owner' : ''
    });
    await Promise.all([refreshData(), refreshMyLands()]);
  }, [user?.id, refreshData, refreshMyLands]);

  const handleCopyParcelShareLink = useCallback(async (parcel) => {
    if (!parcel?.parcelId) return;
    const shareUrl = buildParcelShareUrl({
      origin: window.location.origin,
      pathname: window.location.pathname,
      parcelId: parcel.parcelId,
      customName: parcel.customName || '',
      compact: true
    });
    const ok = await copyToClipboard(shareUrl);
    setLandStatus({
      text: ok
        ? `Copied share link for "${getLiveLandName(parcel)}": ${shareUrl}`
        : shareUrl
    });
  }, [getLiveLandName]);

  const handleSaveOwnedTitle = useCallback(
    async (parcelId, { customName, description }) => {
      await api.updateLandParcel(parcelId, {
        customName,
        description,
        curationNote: description
      });
      setLandStatus({
        text: customName
          ? `Renamed land to "${customName}".`
          : `Saved details for "${getLiveLandName(parcelId)}".`
      });
      recordUserAction(user?.id, {
        type: 'rename_land',
        icon: '✏️',
        title: customName
          ? `Renamed land to "${customName}"`
          : `Updated details for "${getLiveLandName(parcelId)}"`,
        detail: 'Saved land metadata',
        parcelId,
        linkLabel: 'Land'
      });
      await Promise.all([refreshData(), refreshMyLands()]);
    },
    [refreshData, refreshMyLands, getLiveLandName, user?.id]
  );

  const handleOpenAddLandItem = useCallback((parcelOrId) => {
    const pid =
      typeof parcelOrId === 'string'
        ? parcelOrId
        : parcelOrId?.parcelId || '';
    if (!pid) return;
    setAddItemParcelId(String(pid).toUpperCase());
  }, []);

  useEffect(() => {
    if (!welcomeRequest?.type) return;
    if (welcomeRequest.type === 'agent') {
      setPairOpen(false);
      setInfoInitialTab('guide');
      setInfoInitialViewport('agents');
      setInfoOpen(true);
    } else if (welcomeRequest.type === 'info') {
      setPairOpen(false);
      setInfoInitialTab('guide');
      setInfoInitialViewport('');
      setInfoOpen(true);
    }
  }, [welcomeRequest]);

  return (
    <NotificationProvider
      user={user}
      variant="desktop"
      refreshSignal={notifRefreshSignal}
      pendingApprovals={pendingApprovals}
      pendingApprovalsLoaded={pendingApprovalsLoaded}
      onRequestPendingRefresh={refreshPairingAndApprovals}
      onApprovalResolved={handleDesktopApprovalResolved}
      onAction={handleNotificationAction}
    >
    <div className="desktop-shell">
      <header className="desktop-nav">
        <div className="brand">
          <BrandLogo variant="lockup" height={34} />
          <span className="badge teal">Desktop Map Explorer</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {pendingApprovals.length > 0 && (
            <button
              type="button"
              className="btn desktop-pending-approvals-btn"
              data-testid="desktop-pending-approvals-btn"
              onClick={() => {
                const first = pendingApprovals[0];
                if (!first) return;
                const previewMatch =
                  pendingPreviewSculptures.find((p) => p.pendingRequestId === first.id) ||
                  buildPendingPreviewSculpture(first, {
                    parcels,
                    existingSculptures: sculptures,
                    allowFallbackCoords: true
                  });
                if (previewMatch) {
                  openSculpture(previewMatch);
                  return;
                }
                if (!first.parcelId) return;
                const match =
                  (parcels || []).find(
                    (p) => String(p.parcelId || '').toUpperCase() === String(first.parcelId).toUpperCase()
                  ) || { parcelId: first.parcelId };
                openLandShowcase(match);
              }}
              title="Preview & approve pending transactions"
            >
              <XeroIcon emoji="✍️" size={14} /> Approve ({pendingApprovals.length})
            </button>
          )}
          <button
            type="button"
            className={`btn btn-primary btn-pair-glow ${
              mcpState.needsRepair || mcpState.expiringSoon ? 'has-repair-alert' : ''
            }`}
            data-testid="nav-pair-phone-btn"
            data-needs-repair={mcpState.needsRepair || mcpState.expiringSoon ? 'true' : 'false'}
            onClick={() => {
              if (mcpState.needsRepair || mcpState.expiringSoon) {
                setAgentPairExpanded(true);
              }
              openPairModal();
            }}
            title={
              mcpState.needsRepair
                ? 'Re-pair needed: your agent pairing expired or disconnected'
                : mcpState.expiringSoon
                ? 'Agent pairing expires soon — click to re-pair'
                : 'Pair your mobile phone via QR for live 3D drawing & in-person AR sculpting'
            }
          >
            <XeroIcon emoji="🔗" size={16} /> Pairing
            {(mcpState.needsRepair || mcpState.expiringSoon) && (
              <span className="pair-repair-dot" aria-label="Re-pair needed" />
            )}
          </button>
          <button
            type="button"
            className="btn"
            style={{ borderColor: 'rgba(0, 245, 212, 0.5)', color: 'var(--accent)' }}
            onClick={openMintLandMode}
            title="Select, size, rotate & scale 3D lands on desktop"
          >
            <XeroIcon emoji="🏗️" size={16} /> Mint Land
          </button>
          {(mcpState.mcpActive || desktopPhonePaired) &&
            (myLands.parcelCount > 0 || (myLands.parcels && myLands.parcels.length > 0)) && (
            <button
              type="button"
              className="btn"
              data-testid="nav-land-management-btn"
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
          <NotificationCenter
            user={user}
            variant="desktop"
            refreshSignal={notifRefreshSignal}
            pendingApprovals={pendingApprovals}
            onApprovalResolved={handleDesktopApprovalResolved}
            onAction={handleNotificationAction}
          />
          {user ? (
            <button
              type="button"
              className="btn"
              data-testid="desktop-profile-btn"
              onClick={() => setProfileHandle(user.username || user.id)}
              title="Open your public profile, edit @username, bio, icon & header banner"
            >
              <UserHandleBadge user={user} fallback="Creator" size="sm" />
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => setLoginOpen(true)}>
              <XeroIcon emoji="🔐" size={16} /> Sign In
            </button>
          )}
        </div>
      </header>

      <main className="desktop-main">
        <div className="desktop-map-layout">
          <div className="desktop-map-stage">
            <MapView3D
              sculptures={mapViewSculptures}
              parcels={parcels}
              draftParcels={draftParcels}
              ownedParcelIds={ownedParcelIds}
              selectedDraftId={selectedDraftId}
              drawMode={drawMode}
              viewMode={viewMode}
              autoSwitchedHint={autoSwitchedHint}
              userLocation={userLocation}
              focusArea={
                areaFilter === 'nearby' &&
                Boolean(userLocation) &&
                (nearbyCategory === 'land'
                  ? groupedLands.nearbyLands.length > 0
                  : nearbyMatches.length > 0)
              }
              selectedSculptureId={selected?.id || lastSculpture?.id || ''}
              selectedParcelId={selectedLandParcelId}
              initialView={mapViewport}
              focusTarget={mapFocusTarget}
              onViewportChange={handleViewportChange}
              config={config}
              onSelectSculpture={openSculpture}
              onSelectParcel={openLandShowcase}
              onNavigateParcel={focusLandOnMap}
              onNavigateSculpture={(sc) => {
                if (!sc) return;
                setLastSculpture(sc);
                focusLandForSculpture(sc);
              }}
              onAddDraftRectangle={handleAddDraftRectangle}
              onSelectDraft={(id) => {
                selectedDraftIdRef.current = id;
                setSelectedDraftId(id);
                setSidebarTab('land');
              }}
              onUpdateDraft={handleUpdateDraft}
              onDraftGestureStart={handleDraftGestureStart}
              onDraftGestureEnd={handleDraftGestureEnd}
              onAdd3DItemForParcel={handleOpenAddLandItem}
              onTitleParcel={(p) => setTitleModalTarget({ mode: 'owned', parcel: p })}
              onCopyParcelShareLink={handleCopyParcelShareLink}
              onViewModeChange={(nextMode) => setViewMode(nextMode)}
              onDismissAuto3dHint={() => setAutoSwitchedHint(false)}
            />
          </div>

          <aside
            className="card desktop-nearby-panel"
            aria-label={nearbyCategory === 'land' ? 'Land' : 'Sculptures'}
            data-nearby-category={nearbyCategory}
          >
            <div className="desktop-nearby-header">
              <div
                className="desktop-nearby-category-tabs"
                role="tablist"
                aria-label="Browse Land or Sculptures"
                data-testid="desktop-nearby-category-tabs"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={nearbyCategory === 'land'}
                  className={`desktop-nearby-category-tab ${
                    nearbyCategory === 'land' ? 'is-active' : ''
                  }`}
                  data-testid="desktop-nearby-tab-land"
                  onClick={() => selectNearbyCategory('land')}
                >
                  <XeroIcon emoji="🗺️" size={19} />
                  <span>Land</span>
                  <span className="desktop-nearby-tab-count">
                    {groupedLands.displayedLands.length}
                  </span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={nearbyCategory === 'sculptures'}
                  className={`desktop-nearby-category-tab ${
                    nearbyCategory === 'sculptures' ? 'is-active' : ''
                  }`}
                  data-testid="desktop-nearby-tab-sculptures"
                  onClick={() => selectNearbyCategory('sculptures')}
                >
                  <XeroIcon emoji="🗿" size={19} />
                  <span>Sculptures</span>
                  <span className="desktop-nearby-tab-count">{displayedSculptures.length}</span>
                </button>
              </div>
              <button
                type="button"
                className="btn desktop-nearby-refresh-btn"
                onClick={refreshData}
                title="Refresh land & sculptures"
                aria-label="Refresh land and sculptures"
              >
                <XeroIcon emoji="🔄" size={13} />
              </button>
            </div>

            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`btn ${sidebarTab === 'list' ? 'btn-primary' : ''}`}
                style={{ padding: '4px 7px', fontSize: 11, flex: '1 1 auto' }}
                onClick={() => switchSidebarTab('list')}
              >
                <XeroIcon emoji="📍" size={11} /> List
              </button>
              <button
                type="button"
                className={`btn ${sidebarTab === 'land' ? 'btn-primary' : ''}`}
                style={{ padding: '4px 7px', fontSize: 11, flex: '1 1 auto' }}
                onClick={openMintLandMode}
              >
                <XeroIcon emoji="🏗️" size={11} /> Mint Land{draftParcels.length > 0 ? ` (${draftParcels.length})` : ''}
              </button>
              <button
                type="button"
                className={`btn ${sidebarTab === 'market' ? 'btn-primary' : ''}`}
                style={{ padding: '4px 7px', fontSize: 11, flex: '1 1 auto' }}
                onClick={() => switchSidebarTab('market')}
              >
                <XeroIcon emoji="🛒" size={11} /> Market ({listings.length})
              </button>
              <button
                type="button"
                className={`btn ${sidebarTab === 'gallery' ? 'btn-primary' : ''}`}
                style={{ padding: '4px 7px', fontSize: 11, flex: '1 1 auto' }}
                onClick={() => switchSidebarTab('gallery')}
              >
                <XeroIcon emoji="🎨" size={11} /> Gallery
              </button>
              <button
                type="button"
                className={`btn ${sidebarTab === 'leaders' ? 'btn-primary' : ''}`}
                style={{ padding: '4px 7px', fontSize: 11, flex: '1 1 auto' }}
                onClick={() => switchSidebarTab('leaders')}
              >
                <XeroIcon emoji="🏆" size={11} /> Leaders
              </button>
            </div>

            {sidebarTab !== 'leaders' && sidebarTab !== 'market' && sidebarTab !== 'land' && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className={`btn ${areaFilter === 'nearby' ? 'btn-primary' : ''}`}
                  style={{ padding: '5px 10px', fontSize: 12, flex: 1 }}
                  onClick={() => setAreaFilter('nearby')}
                >
                  Near Me{' '}
                  {userLocation
                    ? `(${
                        sidebarTab === 'list' && nearbyCategory === 'land'
                          ? groupedLands.nearbyLands.length
                          : nearbyMatches.length
                      })`
                    : ''}
                </button>
                <button
                  type="button"
                  className={`btn ${areaFilter === 'all' ? 'btn-primary' : ''}`}
                  style={{ padding: '5px 10px', fontSize: 12, flex: 1 }}
                  onClick={() => setAreaFilter('all')}
                >
                  Global (
                  {sidebarTab === 'list' && nearbyCategory === 'land'
                    ? groupedLands.allLands.length
                    : sculptures.length}
                  )
                </button>
              </div>
            )}

            {sidebarTab === 'list' &&
              nearbyCategory === 'sculptures' &&
              areaFilter === 'nearby' &&
              userLocation &&
              nearbyMatches.length === 0 &&
              sculptures.length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  No sculptures within {nearbyRadiusLabel} yet — showing all {sculptures.length} global sculptures sorted closest first.
                </div>
              )}

            {sidebarTab === 'list' &&
              nearbyCategory === 'land' &&
              areaFilter === 'nearby' &&
              userLocation &&
              groupedLands.autoFallbackToAll &&
              groupedLands.allLands.length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  No lands within {nearbyRadiusLabel} yet — showing all {groupedLands.allLands.length} global lands sorted closest first.
                </div>
              )}

            {sidebarTab === 'land' ? (
              <DesktopLandBuilderPanel
                draftParcels={draftParcels}
                ownedParcels={ownedUserParcels}
                recentlyMintedParcels={recentlyMintedParcels}
                selectedDraftId={selectedDraftId}
                drawMode={drawMode}
                onToggleDrawMode={() => setDrawMode((cur) => !cur)}
                onAddDraftAtCenter={handleAddDraftAtCenter}
                onSelectDraft={(id) => {
                  selectedDraftIdRef.current = id;
                  setSelectedDraftId(id);
                }}
                onUpdateDraft={handleUpdateDraft}
                onRemoveDraft={handleRemoveDraft}
                onClearDrafts={handleClearDrafts}
                onUndoDraft={handleUndoDraftAction}
                onRedoDraft={handleRedoDraftAction}
                canUndo={draftUndoStack.length > 0}
                canRedo={draftRedoStack.length > 0}
                undoLabel={
                  draftUndoStack.length > 0
                    ? draftUndoStack[draftUndoStack.length - 1].label
                    : ''
                }
                hasCopiedDraft={Boolean(copiedLandTemplate)}
                onCopySelectedLand={handleCopySelectedLand}
                onPasteCopiedLand={handlePasteCopiedLand}
                onDraftGestureStart={handleDraftGestureStart}
                onDraftGestureEnd={handleDraftGestureEnd}
                onMintDraft={handleMintDraft}
                onMintAll={handleMintAll}
                onUpdateOwnedVolume={handleUpdateOwnedVolume}
                onOpenAddLandItem={handleOpenAddLandItem}
                onOpenTitleOwned={(parcel) => setTitleModalTarget({ mode: 'owned', parcel })}
                onCopyOwnedShareLink={handleCopyParcelShareLink}
                onToggleFreezeParcel={handleToggleFreezeParcel}
                onOpenLandManagement={(pid) => {
                  setLandManageParcelId(pid || '');
                  setLandManageOpen(true);
                }}
                mintLimitError={mintLimitError}
                onDismissMintLimitError={() => setMintLimitError(null)}
                mintBusy={mintBusy}
                landStatus={landStatus}
                cameraBearingDeg={
                  Number.isFinite(Number(mapViewport?.bearing))
                    ? Number(mapViewport.bearing)
                    : viewMode === 'isometric'
                    ? 315
                    : viewMode === '3d'
                    ? 325
                    : 0
                }
                user={user}
                pairingCode={mcpState?.activePairing?.code || mcpState?.pairings?.[0]?.code || ''}
                publicUrl={config?.publicUrl || ''}
                apiOrigin={API_BASE || window.location.origin}
                config={config}
                onSignIn={() => setLoginOpen(true)}
              />
            ) : sidebarTab === 'market' ? (
              <div className="desktop-nearby-list" aria-label="SPRAY.LAND Marketplace">
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--accent)', padding: '2px 2px 6px' }}>
                  Every trade pays: 5% Platform · 3% Agent Steward · 2% Human Contributors Pool · 90% Seller
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
                      <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>{getLiveLandName(lst)} · Seller:</span>
                        <UserHandleBadge
                          user={{
                            id: lst.sellerSub,
                            username: lst.sellerUsername,
                            sellerName: lst.sellerName,
                            avatarImage: lst.sellerAvatar
                          }}
                          fallback="Seller"
                          size="xs"
                          onClick={
                            lst.sellerUsername || lst.sellerSub
                              ? () => setProfileHandle(lst.sellerUsername || lst.sellerSub)
                              : null
                          }
                        />
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
                {creatorLeaderboard.length === 0 && dualLeaders.humanArtists.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 4px' }}>
                    No builders ranked yet.
                  </div>
                ) : (
                  (dualLeaders.humanArtists.length > 0
                    ? dualLeaders.humanArtists.map((h) => ({
                        key: h.userId,
                        profileId: h.username || h.userId,
                        userId: h.userId,
                        username: h.username || '',
                        avatarImage: h.avatarImage || '',
                        sculptures: h.sculptureCount,
                        parcelCount: h.parcelsVisited,
                        metaText: `${h.totalXp} XP · ${h.landsAwakened} awakened`
                      }))
                    : creatorLeaderboard.map((c) => ({
                        key: c.key,
                        profileId: c.profileId || '',
                        userId: c.creatorSub || '',
                        username: c.username || '',
                        avatarImage: c.avatarImage || '',
                        sculptures: c.sculptures,
                        parcelCount: c.parcelCount,
                        metaText: `${c.voxels.toLocaleString()} total 3D blocks`
                      }))
                  ).map((entry, idx) => (
                    <div
                      key={entry.key}
                      className="desktop-nearby-item"
                      style={{ cursor: entry.profileId ? 'pointer' : 'default' }}
                      onClick={() => entry.profileId && setProfileHandle(entry.profileId)}
                      role={entry.profileId ? 'button' : undefined}
                      tabIndex={entry.profileId ? 0 : undefined}
                      onKeyDown={(e) => {
                        if (entry.profileId && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          setProfileHandle(entry.profileId);
                        }
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, width: '100%' }}>
                        <strong style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span>#{idx + 1}</span>
                          <UserHandleBadge
                            user={{
                              id: entry.userId,
                              username: entry.username,
                              avatarImage: entry.avatarImage
                            }}
                            fallback="Creator"
                            size="xs"
                          />
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
              </div>
            ) : sidebarTab === 'gallery' ? (
              <div
                className="desktop-nearby-list desktop-gallery-grid"
                aria-label="Sculpture Gallery"
                data-testid="desktop-gallery-grid"
              >
                {displayedSculptures.length === 0 ? (
                  <div
                    style={{
                      gridColumn: '1 / -1',
                      fontSize: 12,
                      color: 'var(--muted)',
                      padding: '12px 4px'
                    }}
                  >
                    No published sculptures in the gallery yet.
                  </div>
                ) : (
                  displayedSculptures.map((sc) => {
                    const isActive = (selected?.id || lastSculpture?.id) === sc.id;
                    return (
                      <div
                        key={sc.id}
                        className={`desktop-gallery-card ${isActive ? 'is-selected' : ''}`}
                        data-testid="desktop-gallery-card"
                        data-sculpture-id={sc.id}
                        onClick={() => openSculpture(sc)}
                        role="button"
                        tabIndex={0}
                        aria-label={`Open ${sc.title || 'Sculpture'} in 3D`}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            openSculpture(sc);
                          }
                        }}
                      >
                        <SculptureThumbnail sculpture={sc} />
                        <div className="gallery-card-body">
                          <strong className="gallery-card-title" title={sc.title}>
                            {sc.title}
                          </strong>
                          <span className="badge gold gallery-card-land" title={getLiveLandName(sc)}>
                            {getLiveLandName(sc)}
                          </span>
                          <div className="gallery-card-footer">
                            <UserHandleBadge
                              user={{
                                id: sc.creatorSub,
                                username: sc.creatorUsername,
                                creatorName: sc.creatorName,
                                avatarImage: sc.creatorAvatar
                              }}
                              fallback="Creator"
                              size="xs"
                            />
                            <div className="gallery-card-actions">
                              <button
                                type="button"
                                className="btn gallery-card-action-btn"
                                title="Copy sculpture link"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  await copyToClipboard(buildSculptureShareUrl(sc.id));
                                  setCopiedId(sc.id);
                                  setTimeout(() => setCopiedId(''), 1800);
                                }}
                              >
                                {copiedId === sc.id ? '✓' : <XeroIcon emoji="📋" size={16} />}
                              </button>
                              <a
                                className="btn gallery-card-action-btn"
                                title="Share on X"
                                href={buildShareToXUrl({
                                  title: sc.title,
                                  landName: getLiveLandName(sc),
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
                      </div>
                    );
                  })
                )}
              </div>
            ) : nearbyCategory === 'land' ? (
              <div
                className="desktop-nearby-list"
                data-testid="desktop-nearby-lands-list"
                aria-label="Lands"
              >
                {groupedLands.displayedLands.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)', padding: '12px 4px' }}>
                    No virtual lands claimed yet. Click Mint Land above to draw a 3D parcel on the map!
                  </div>
                ) : (
                  groupedLands.displayedLands.map((land) => {
                    const isSelectedLand =
                      Boolean(selectedLandParcelId) && selectedLandParcelId === land.parcelId;
                    const isOwned = isLandOwnedByUser(land, { user, ownedParcelIds });
                    const exp = land.expiration;
                    const expBadgeClass =
                      exp.state === 'expired' || exp.state === 'expiring-soon'
                        ? 'badge danger'
                        : exp.state === 'expiring' || exp.state === 'dormant'
                        ? 'badge gold'
                        : 'badge teal';
                    const liveTitle = getLiveLandName(land, land.displayName || 'Virtual Land');

                    return (
                      <div
                        key={land.parcelId}
                        role="button"
                        tabIndex={0}
                        className={`desktop-nearby-item desktop-land-item ${
                          isSelectedLand ? 'is-selected' : ''
                        } ${isOwned ? 'is-owned' : ''}`}
                        data-testid="desktop-land-item"
                        data-parcel-id={land.parcelId}
                        data-selected={isSelectedLand ? 'true' : 'false'}
                        data-owned={isOwned ? 'true' : 'false'}
                        onClick={() => focusLandOnMap(land)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            focusLandOnMap(land);
                          }
                        }}
                      >
                        <div className="desktop-land-item-top">
                          <div className="desktop-land-item-title-wrap">
                            <strong className="desktop-land-item-title">{liveTitle}</strong>
                            {isOwned && (
                              <span className="badge gold" style={{ fontSize: 9.5 }}>
                                Owned
                              </span>
                            )}
                          </div>
                          {land.distanceLabel && (
                            <span className="badge teal" style={{ fontSize: 10, flexShrink: 0 }}>
                              {land.distanceLabel} away
                            </span>
                          )}
                        </div>

                        <div className="desktop-land-item-meta">
                          <span className="badge" style={{ fontSize: 10 }}>
                            <XeroIcon emoji="🎨" size={10} /> {land.sculptures.length}{' '}
                            {land.sculptures.length === 1 ? 'sculpture' : 'sculptures'}
                          </span>
                          {land.compactDimensionsLabel && (
                            <span className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>
                              {land.compactDimensionsLabel}
                            </span>
                          )}
                          {exp.state !== 'permanent' && (
                            <span
                              className={expBadgeClass}
                              style={{ fontSize: 9.5 }}
                              title={exp.detailText}
                            >
                              <XeroIcon emoji={exp.state === 'expired' ? '⏱️' : '⏳'} size={10} />{' '}
                              {exp.badgeText}
                            </span>
                          )}
                          {land.isFrozen && (
                            <span className="badge" style={{ fontSize: 9.5 }}>
                              ❄️ Frozen
                            </span>
                          )}
                        </div>

                        {land.description && (
                          <div className="desktop-land-item-desc">{land.description}</div>
                        )}

                        <div className="desktop-land-item-actions">
                          <button
                            type="button"
                            className="btn btn-primary"
                            style={{ padding: '3px 9px', fontSize: 10.5 }}
                            data-testid="desktop-land-inspect-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              openLandShowcase(land);
                            }}
                          >
                            <XeroIcon emoji="🧊" size={11} /> Inspect Land
                          </button>
                          <button
                            type="button"
                            className="btn"
                            style={{ padding: '3px 8px', fontSize: 10.5 }}
                            onClick={async (e) => {
                              e.stopPropagation();
                              await handleCopyParcelShareLink(land);
                              setCopiedId(land.parcelId);
                              setTimeout(() => setCopiedId(''), 1800);
                            }}
                            title={`Copy share link for ${liveTitle}`}
                          >
                            {copiedId === land.parcelId ? (
                              'Copied!'
                            ) : (
                              <>
                                <XeroIcon emoji="📋" size={15} /> Copy Link
                              </>
                            )}
                          </button>
                          {isOwned && (
                            <button
                              type="button"
                              className="btn"
                              style={{ padding: '3px 8px', fontSize: 10.5 }}
                              data-testid="desktop-land-manage-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                setLandManageParcelId(land.parcelId);
                                setLandManageOpen(true);
                              }}
                              title={`Manage ${liveTitle}`}
                            >
                              <XeroIcon emoji="⚙️" size={15} /> Manage
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            ) : (
              <div className="desktop-nearby-list" data-testid="desktop-nearby-sculptures-list">
              {displayedSculptures.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--muted)', padding: '12px 4px' }}>
                  No published sculptures on the map yet. Pair or open SPRAY.LAND on your mobile phone to create the first piece nearby!
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
                            {formatDistanceLabel(sc.distanceMeters, unitSystem)}
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span className="badge" style={{ fontSize: 10 }}>
                          {getLiveLandName(sc)}
                        </span>
                        <span className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>
                          {sc.modelType === 'custom-3d'
                            ? `${String(sc.customModel?.format || '3D').toUpperCase()} Model`
                            : `${sc.voxelCount || sc.voxels?.length || 0} blocks`}{' '}
                          · PoL {sc.polScore}
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
          <div
            className="modal-card wide pair-hub-modal"
            data-testid="pair-phone-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <h2 className="modal-title">
                  <XeroIcon emoji="🔗" size={22} /> Pairing · Phone QR &amp; AI Agent (MCP)
                </h2>
                <p className="pair-modal-subtitle">
                  Scan on mobile to sculpt in AR with a live full-size 3D desktop monitor, or connect your AI Agent (MCP) below.
                </p>
              </div>
              <div className="modal-header-actions">
                <GlobalNotificationBell compact testId="pair-modal-notif-bell-btn" />
                <button
                  type="button"
                  className="btn"
                  onClick={() => setPairOpen(false)}
                  aria-label="Close pairing modal"
                >
                  <XeroIcon emoji="❌" size={15} />
                </button>
              </div>
            </div>

            <PairWorkbench3D
              inModal
              onPhonePairedChange={(paired) => setDesktopPhonePaired(Boolean(paired))}
            />

            {/* Structured Revealable AI Agent Pairing (MCP) Accordion */}
            <div className="pair-agent-accordion" data-testid="pair-agent-accordion">
              <button
                type="button"
                className="pair-agent-accordion-trigger"
                data-testid="pair-agent-reveal-toggle"
                aria-expanded={agentPairExpanded}
                onClick={() => setAgentPairExpanded((prev) => !prev)}
              >
                <div className="pair-agent-trigger-left">
                  <span className="pair-agent-icon" aria-hidden="true">🤖</span>
                  <div>
                    <strong>AI Agent Pairing (MCP)</strong>
                    <span className="pair-agent-sub">
                      Connect your AI agent to co-build, stage 3D models, or manage your lands
                    </span>
                  </div>
                </div>
                <div className="pair-agent-trigger-right">
                  <span
                    className={`badge ${
                      mcpState.needsRepair
                        ? 'danger'
                        : mcpState.expiringSoon
                        ? 'gold'
                        : mcpState.mcpActive
                        ? 'teal'
                        : 'gold'
                    }`}
                  >
                    {mcpState.needsRepair
                      ? '⚠️ Re-pair Needed'
                      : mcpState.expiringSoon
                      ? '⏳ Expiring Soon'
                      : mcpState.mcpActive
                      ? mcpState.activePairing?.keyConnected
                        ? '🟢 Connected'
                        : '🟢 Active'
                      : 'Optional Setup'}
                  </span>
                  <span className="pair-agent-caret">
                    {agentPairExpanded ? 'Hide ▴' : 'Reveal Steps ▾'}
                  </span>
                </div>
              </button>

              {agentPairExpanded && (
                <div className="pair-agent-body" data-testid="pair-agent-structured-steps">
                  {user && (mcpState.needsRepair || mcpState.expiringSoon) && (
                    <div
                      className="desktop-repair-banner"
                      data-testid="desktop-repair-banner"
                      role="alert"
                      style={{ marginBottom: 10 }}
                    >
                      <span>
                        🔗{' '}
                        {mcpState.expiringSoon
                          ? `Your active agent pairing (${mcpState.activePairing?.code || 'MCP'}) expires soon — generate a fresh code below to stay connected.`
                          : `Your previous agent pairing (${mcpState.latestPairing?.code || 'MCP'}) ${
                              mcpState.repairReason === 'disconnected' ? 'was disconnected' : 'expired'
                            } — generate a fresh code below to re-pair.`}
                      </span>
                    </div>
                  )}
                  {!user ? (
                    <div className="pair-agent-signin-row">
                      <span>Sign in first to generate a personal MCP Agent Pairing code and prompt.</span>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => {
                          setPairOpen(false);
                          setLoginOpen(true);
                        }}
                      >
                        <XeroIcon emoji="🔐" size={13} /> Sign In to Pair Agent
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="pair-agent-steps-grid">
                        <div className="pair-agent-step-card">
                          <div className="pair-agent-step-num">STEP 1</div>
                          <strong>Generate Pairing Code</strong>
                          <p>Creates a personal <code>GLP-…</code> pairing code linked to your wallet.</p>
                          {(() => {
                            const displayMcpCode =
                              mcpState.activePairing?.code || mcpState.pairings?.[0]?.code || '';
                            const handleCopyMcpCode = async () => {
                              if (!displayMcpCode) return;
                              await copyToClipboard(displayMcpCode);
                              setCopiedMcpCode(true);
                              setMcpNotice(`Copied pairing code ${displayMcpCode}.`);
                              clearTimeout(copiedMcpCodeTimerRef.current);
                              copiedMcpCodeTimerRef.current = window.setTimeout(
                                () => setCopiedMcpCode(false),
                                1800
                              );
                            };
                            return (
                              <div className="pair-agent-code-row">
                                <button
                                  type="button"
                                  className={`pair-agent-code-box mono ${
                                    displayMcpCode ? 'is-clickable' : ''
                                  }`}
                                  data-testid="pair-agent-code-value"
                                  disabled={!displayMcpCode}
                                  onClick={handleCopyMcpCode}
                                  title={
                                    displayMcpCode
                                      ? 'Click to copy pairing code'
                                      : 'Generate a pairing code in Step 2'
                                  }
                                  aria-label={
                                    displayMcpCode
                                      ? `Copy pairing code ${displayMcpCode}`
                                      : 'Pairing code not generated yet'
                                  }
                                >
                                  <span>{displayMcpCode || 'Not generated yet'}</span>
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-xs btn-outline pair-agent-code-copy-btn"
                                  data-testid="pair-agent-code-copy-btn"
                                  disabled={!displayMcpCode}
                                  onClick={handleCopyMcpCode}
                                  title="Copy pairing code"
                                  aria-label="Copy pairing code"
                                >
                                  <XeroIcon emoji={copiedMcpCode ? '✅' : '📋'} size={13} />
                                  <span>{copiedMcpCode ? 'Copied' : 'Copy'}</span>
                                </button>
                              </div>
                            );
                          })()}
                        </div>

                        <div className="pair-agent-step-card">
                          <div className="pair-agent-step-num">STEP 2</div>
                          <strong>Copy Structured MCP Prompt</strong>
                          <p>Paste the prompt into Claude, OpenClaw, Cursor, or any MCP-ready agent.</p>
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            data-testid="pair-agent-generate-copy-btn"
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
                              setAgentPairPromptPreview(prompt);
                              await copyToClipboard(prompt);
                              setMcpNotice(
                                `Generated ${created.pairing?.code} & copied structured MCP Agent Prompt.`
                              );
                            }}
                          >
                            <XeroIcon emoji="🔑" size={13} /> Generate Code &amp; Copy Prompt
                          </button>
                        </div>

                        <div className="pair-agent-step-card">
                          <div className="pair-agent-step-num">STEP 3</div>
                          <strong>Verify &amp; Control Access</strong>
                          <p>Revoke or rotate your agent pairing code anytime with one click.</p>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                            <span className={`badge ${mcpState.mcpActive ? 'teal' : 'gold'}`}>
                              {mcpState.mcpActive
                                ? mcpState.activePairing?.keyConnected
                                  ? 'Keys Verified'
                                  : 'Awaiting Agent Handshake'
                                : 'Standby'}
                            </span>
                            {mcpState.activePairing && (
                              <button
                                type="button"
                                className="btn btn-xs btn-danger"
                                onClick={async () => {
                                  await api.disconnectMcpPairing(mcpState.activePairing.code);
                                  const updated = await api.listMcpPairings();
                                  setMcpState(updated);
                                  setAgentPairPromptPreview('');
                                  setMcpNotice('Disconnected MCP pairing.');
                                }}
                              >
                                Disconnect
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      {mcpNotice && (
                        <div className="status-banner" role="status" style={{ marginTop: 10 }}>
                          {mcpNotice}
                        </div>
                      )}

                      {agentPairPromptPreview && (
                        <textarea
                          readOnly
                          className="land-agent-preview"
                          aria-label="Structured MCP agent pairing prompt"
                          value={agentPairPromptPreview}
                          rows={5}
                          style={{ marginTop: 8 }}
                        />
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
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
              <div className="modal-header-actions">
                <GlobalNotificationBell compact testId="admin-modal-notif-bell-btn" />
                <button type="button" className="btn" onClick={() => setAdminOpen(false)}>
                  <XeroIcon emoji="❌" size={15} />
                </button>
              </div>
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

      {visitedParcel && (
        <PlotVisitView
          variant="desktop"
          parcel={visitedParcel.parcel}
          sculptures={visitedParcel.sculptures || []}
          allParcels={parcels}
          user={user}
          ownedParcelIds={ownedParcelIds}
          config={config}
          userLocation={userLocation}
          loading={Boolean(visitedParcel.loading)}
          error={visitedParcel.error || ''}
          onSelectNeighborParcel={async (neighborParcel) => {
            if (!neighborParcel?.parcelId) return;
            setVisitedParcel({
              loading: true,
              parcel: neighborParcel,
              sculptures: [],
              error: ''
            });
            try {
              const res = await api.getLandDetail(neighborParcel.parcelId);
              if (res?.parcel) {
                setVisitedParcel({
                  loading: false,
                  parcel: res.parcel,
                  sculptures: res.sculptures || [],
                  error: ''
                });
              }
            } catch {
              setVisitedParcel((prev) =>
                prev ? { ...prev, loading: false, error: 'Could not load neighboring land.' } : null
              );
            }
          }}
          onSelectSculpture={(sc) => openSculpture(sc)}
          onOpenManageLand={(pid) => {
            setLandManageParcelId(pid || '');
            setLandManageOpen(true);
          }}
          onOpenPair={() => {
            setVisitedParcel(null);
            setAgentPairExpanded(true);
            openPairModal();
          }}
          onOpenAddLandItem={(pid) => handleOpenAddLandItem(pid)}
          onOpenProfile={(handle) => {
            if (handle) setProfileHandle(handle);
          }}
          onRequestLogin={() => setLoginOpen(true)}
          onPlotUpdated={({ parcel: nextParcel, sculptures: nextSculptures } = {}) => {
            setVisitedParcel((prev) =>
              prev
                ? {
                    ...prev,
                    parcel: nextParcel || prev.parcel,
                    sculptures: Array.isArray(nextSculptures) ? nextSculptures : prev.sculptures
                  }
                : prev
            );
            refreshData();
            refreshMyLands();
            refreshPairingAndApprovals();
            setNotifRefreshSignal((n) => n + 1);
          }}
          onClose={() => setVisitedParcel(null)}
        />
      )}

      {selected && (
        <SculptureModal
          sculpture={selected}
          user={user}
          config={config}
          userLocation={userLocation}
          isDesktop
          allParcels={parcels}
          onSelectParcel={openLandShowcase}
          onSelectSculpture={openSculpture}
          onRequestLogin={() => setLoginOpen(true)}
          onSculptureUpdated={(updated, extra = {}) => {
            setSelected(updated);
            setLastSculpture(updated);
            const pushedMap = new Map(
              (Array.isArray(extra?.pushedSiblings) ? extra.pushedSiblings : []).map((p) => [
                p.id,
                p
              ])
            );
            const applyRowUpdate = (s) => {
              if (s.id === updated.id) return { ...s, ...updated };
              const pushed = pushedMap.get(s.id);
              if (!pushed) return s;
              return {
                ...s,
                anchorOffset: {
                  ...(s.anchorOffset || {}),
                  dx: pushed.dx,
                  dy: pushed.dy,
                  dz: pushed.dz
                }
              };
            };
            setSculptures((prev) => prev.map(applyRowUpdate));
            setVisitedParcel((prev) =>
              prev
                ? {
                    ...prev,
                    sculptures: (prev.sculptures || []).map(applyRowUpdate)
                  }
                : prev
            );
            refreshData();
            refreshMyLands();
          }}
          onSculptureDeleted={(deletedId) => {
            setSculptures((prev) => prev.filter((s) => s.id !== deletedId));
            setVisitedParcel((prev) =>
              prev
                ? {
                    ...prev,
                    sculptures: (prev.sculptures || []).filter((s) => s.id !== deletedId)
                  }
                : prev
            );
            refreshData();
            refreshMyLands();
          }}
          onOpenLandManagement={(pid) => {
            setLandManageParcelId(pid || '');
            setLandManageOpen(true);
          }}
          onOpenAddLandItem={(pid) => handleOpenAddLandItem(pid)}
          onApprovePending={handleApprovePendingFromPreview}
          onRejectPending={handleRejectPendingFromPreview}
          pendingApprovalBusy={Boolean(
            selected?.pendingRequestId && previewApprovalBusyId === selected.pendingRequestId
          )}
          pendingApprovalError={
            selected?.pendingRequestId
              ? previewApprovalErrors?.[selected.pendingRequestId] || null
              : null
          }
          onClose={() => {
            setSelected(null);
            refreshData();
            refreshMyLands();
            refreshVisitedParcelDetail();
          }}
        />
      )}

      {activeAddItemParcel && (
        <AddLandItemModal
          parcel={activeAddItemParcel}
          existingSculptures={activeAddItemSculptures}
          user={user}
          mcpState={mcpState}
          onMcpStateChange={setMcpState}
          onToggleFreeze={handleToggleFreezeParcel}
          onToggleSculptureVisibility={handleToggleSculptureVisibility}
          onSculptureUploaded={async () => {
            await Promise.all([refreshData(), refreshMyLands(), refreshVisitedParcelDetail()]);
          }}
          onSelectSculpture={(sc) => openSculpture(sc)}
          onOpenLandManagement={(pid) => {
            setLandManageParcelId(pid || '');
            setLandManageOpen(true);
          }}
          onClose={() => setAddItemParcelId('')}
        />
      )}

      {titleModalTarget?.parcel && (
        <TitleLandModal
          mode={titleModalTarget.mode}
          parcel={titleModalTarget.parcel}
          busy={mintBusy}
          onSave={async ({ customName, description }) => {
            if (titleModalTarget.mode === 'draft') {
              handleUpdateDraft(
                titleModalTarget.parcel.id,
                { customName, description },
                { discrete: true, label: 'Edit land title' }
              );
            } else {
              await handleSaveOwnedTitle(titleModalTarget.parcel.parcelId, {
                customName,
                description
              });
            }
          }}
          onSaveAndMint={
            titleModalTarget.mode === 'draft'
              ? async ({ customName, description }) => {
                  const updatedDraft = {
                    ...titleModalTarget.parcel,
                    customName,
                    description
                  };
                  handleUpdateDraft(titleModalTarget.parcel.id, { customName, description });
                  await handleMintDraft(updatedDraft);
                }
              : null
          }
          onClose={() => setTitleModalTarget(null)}
        />
      )}

      {landManageOpen && user && (
        <LandManagementModal
          user={user}
          initialParcelId={landManageParcelId}
          userLocation={userLocation}
          onSelectSculpture={(sc) => openSculpture(sc)}
          onOpenAddLandItem={(p) => handleOpenAddLandItem(p)}
          onFocusParcel={(p, vol) => {
            const cLat = Number(vol?.centerLat ?? p?.volume?.centerLat ?? p?.centerLat ?? p?.bounds?.center?.[0]);
            const cLng = Number(vol?.centerLng ?? p?.volume?.centerLng ?? p?.centerLng ?? p?.bounds?.center?.[1]);
            if (Number.isFinite(cLat) && Number.isFinite(cLng)) {
              setMapFocusTarget({ lat: cLat, lng: cLng, zoom: 17.8, ts: Date.now() });
              setMapViewport((prev) => ({ ...(prev || {}), lat: cLat, lng: cLng, zoom: 17.8 }));
            }
            setViewMode('isometric');
            setLandManageOpen(false);
          }}
          onWorkspaceChanged={() => {
            refreshData();
            refreshMyLands();
            refreshVisitedParcelDetail();
          }}
          onClose={() => setLandManageOpen(false)}
        />
      )}

      {profileHandle && (
        <ProfileModal
          handle={profileHandle}
          user={user}
          config={config}
          onUserUpdate={(nextUser) => {
            if (
              profileHandle &&
              user?.username &&
              profileHandle.toLowerCase() === user.username.toLowerCase() &&
              nextUser?.username
            ) {
              setProfileHandle(nextUser.username);
            }
            onUserUpdate(nextUser);
          }}
          onSelectSculpture={(sc) => openSculpture(sc)}
          onOpenMintGuide={openMintLandMode}
          onOpenLand={(land) => {
            const cLat = Number(land?.centerLat ?? land?.volume?.centerLat);
            const cLng = Number(land?.centerLng ?? land?.volume?.centerLng);
            if (Number.isFinite(cLat) && Number.isFinite(cLng)) {
              setMapFocusTarget({ lat: cLat, lng: cLng, zoom: 17.8, ts: Date.now() });
              setMapViewport((prev) => ({ ...(prev || {}), lat: cLat, lng: cLng, zoom: 17.8 }));
            }
            setProfileHandle('');
            setVisitedParcel({ loading: true, parcel: null, sculptures: [], error: '' });
            api
              .getLandDetail(land.parcelId)
              .then((res) => {
                if (res?.parcel) {
                  setVisitedParcel({
                    loading: false,
                    parcel: res.parcel,
                    sculptures: res.sculptures || [],
                    error: ''
                  });
                } else {
                  setVisitedParcel({
                    loading: false,
                    parcel: null,
                    sculptures: [],
                    error: 'Virtual Land plot not found.'
                  });
                }
              })
              .catch(() => {
                setVisitedParcel({
                  loading: false,
                  parcel: null,
                  sculptures: [],
                  error: 'Could not load Virtual Land plot.'
                });
              });
          }}
          onOpenWalletSettings={() => {
            setInfoInitialTab('account');
            setInfoOpen(true);
          }}
          onLogout={() => {
            onLogout();
            setProfileHandle('');
          }}
          onClose={() => setProfileHandle('')}
        />
      )}

      {infoOpen && (
        <InfoTermsModal
          config={config}
          user={user}
          mcpState={mcpState}
          onMcpStateChange={setMcpState}
          initialTab={infoInitialTab}
          initialViewportGuide={infoInitialViewport}
          onUserUpdate={onUserUpdate}
          onOpenProfile={() => user && setProfileHandle(user.username || user.id)}
          onOpenArchive={(archId = '') => {
            setArchiveInitialId(archId || '');
            setArchiveOpen(true);
          }}
          onOpenPair={openPairModal}
          onOpenWelcome={onOpenWelcome}
          onStartMapMint={() => {
            setInfoOpen(false);
            setInfoInitialTab('guide');
            setInfoInitialViewport('');
            openMintLandMode();
          }}
          onLogout={() => {
            onLogout();
            setInfoOpen(false);
          }}
          onRequestLogin={() => {
            setInfoOpen(false);
            setLoginOpen(true);
          }}
          onClose={() => {
            setInfoOpen(false);
            setInfoInitialTab('guide');
            setInfoInitialViewport('');
          }}
        />
      )}

      {archiveOpen && (
        <LandArchiveModal
          initialArchiveId={archiveInitialId}
          onJumpToLocation={(lat, lng, label) => {
            if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
              setMapFocusTarget({
                lat: Number(lat),
                lng: Number(lng),
                zoom: 18.2,
                label: label || 'Archived Land Spot',
                nonce: Date.now()
              });
            }
          }}
          onClose={() => {
            setArchiveOpen(false);
            setArchiveInitialId('');
          }}
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
    </NotificationProvider>
  );
}
