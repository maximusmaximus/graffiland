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
import AddLandItemModal from './AddLandItemModal.jsx';
import AdminPanel from './AdminPanel.jsx';
import DesktopIntroBanner from './DesktopIntroBanner.jsx';
import DesktopLandBuilderPanel from './DesktopLandBuilderPanel.jsx';
import GoogleLoginGate from './GoogleLoginGate.jsx';
import InfoTermsModal from './InfoTermsModal.jsx';
import LandManagementModal from './LandManagementModal.jsx';
import MapView3D from './MapView3D.jsx';
import NotificationCenter from './NotificationCenter.jsx';
import PairWorkbench3D from './PairWorkbench3D.jsx';
import PlotVisitView from './PlotVisitView.jsx';
import ProfileModal from './ProfileModal.jsx';
import SculptureModal from './SculptureModal.jsx';
import TitleLandModal from './TitleLandModal.jsx';
import UserHandleBadge from './UserHandleBadge.jsx';
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

function formatDistanceLabel(meters) {
  if (!Number.isFinite(meters)) return '';
  if (meters < 1000) return `${Math.round(meters)}m away`;
  return `${(meters / 1000).toFixed(1)}km away`;
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
  const [quests, setQuests] = useState([]);
  const [listings, setListings] = useState([]);
  const [dualLeaders, setDualLeaders] = useState({ aiStewards: [], humanArtists: [] });
  const [marketBusyId, setMarketBusyId] = useState('');
  const [marketNotice, setMarketNotice] = useState('');
  const [userLocation, setUserLocation] = useState(null);
  const [areaFilter, setAreaFilter] = useState(() =>
    initialSession.areaFilter === 'all' ? 'all' : 'nearby'
  );
  const [sidebarTab, setSidebarTab] = useState('list'); // 'list' | 'land' | 'gallery' | 'quests' | 'market' | 'leaders'
  const [drawMode, setDrawMode] = useState(false);
  const [viewMode, setViewMode] = useState('isometric'); // 'isometric' | '3d' | '2d'
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const [autoSwitchedHint, setAutoSwitchedHint] = useState(false);
  const [draftParcelsRaw, setDraftParcelsRaw] = useState([]);
  const [selectedDraftId, setSelectedDraftId] = useState('');
  const [mintBusy, setMintBusy] = useState(false);
  const [landStatus, setLandStatus] = useState('');
  const [recentlyMintedParcels, setRecentlyMintedParcels] = useState([]);
  const [mintLimitError, setMintLimitError] = useState(null);
  const [notifRefreshSignal, setNotifRefreshSignal] = useState(0);
  const [agentPairExpanded, setAgentPairExpanded] = useState(false);
  const [agentPairPromptPreview, setAgentPairPromptPreview] = useState('');
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
  const [mcpState, setMcpState] = useState({ mcpActive: false, activePairing: null, pairings: [] });
  const [mcpNotice, setMcpNotice] = useState('');
  const [mobileNoticeDismissed, setMobileNoticeDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DESKTOP_NOTICE_SESSION_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [introRoleTab, setIntroRoleTab] = useState(() =>
    ['agent', 'collector'].includes(initialSession.introRoleTab)
      ? initialSession.introRoleTab
      : 'human'
  );

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
      introRoleTab,
      lastSculptureId: lastSculpture?.id || '',
      lastSculptureSnapshot: summarizeSculptureSnapshot(lastSculpture),
      activeView
    });
  }, [areaFilter, mapViewport, introRoleTab, lastSculpture, activeView]);

  const refreshData = useCallback(async () => {
    try {
      const [sRes, pRes, qRes, mRes, lRes] = await Promise.all([
        api.listSculptures({ includeVoxels: true }),
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
            setSelected(res.sculpture);
            setLastSculpture(res.sculpture);
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

  useEffect(() => {
    if (!user?.id) return;
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

  function handleNotificationAction(item) {
    if (!item) return;
    if (item.actionType === 'open_pair_mobile') {
      openPairModal();
    } else if (item.actionType === 'open_mint') {
      openMintLandMode();
    } else if (item.actionType === 'open_land' && item.parcelId) {
      setLandManageParcelId(item.parcelId);
      setLandManageOpen(true);
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
      null
    );
  }, [addItemParcelId, ownedUserParcels, parcels]);

  const activeAddItemSculptures = useMemo(() => {
    if (!activeAddItemParcel) return [];
    const fromMine = activeAddItemParcel.sculptures || [];
    if (fromMine.length > 0) return fromMine;
    return (sculptures || []).filter((s) => s.parcelId === activeAddItemParcel.parcelId);
  }, [activeAddItemParcel, sculptures]);

  const handleAddDraftRectangle = useCallback((rect) => {
    const currentCount = draftCountRef.current;
    if (currentCount >= LAND_VOLUME_LIMITS.maxSelectionBatch) {
      setLandStatus({
        text: `Selection batch limit reached (max ${LAND_VOLUME_LIMITS.maxSelectionBatch} squares).`,
        isError: true
      });
      return;
    }
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
    setDraftParcelsRaw((prev) => [...prev, newDraft]);
    setSelectedDraftId(nextId);
    setSidebarTab('land');
    setDrawMode(false);
    setLandStatus('');
    if (currentCount === 0 && viewModeRef.current === '2d') {
      setViewMode('3d');
      setAutoSwitchedHint(true);
    }
  }, []);

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

  const handleUpdateDraft = useCallback((id, patch) => {
    setDraftParcelsRaw((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  }, []);

  const handleRemoveDraft = useCallback((id) => {
    setDraftParcelsRaw((prev) => prev.filter((item) => item.id !== id));
    setSelectedDraftId((cur) => (cur === id ? '' : cur));
  }, []);

  const handleClearDrafts = useCallback(() => {
    setDraftParcelsRaw([]);
    setSelectedDraftId('');
    setLandStatus('');
  }, []);

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
      setDraftParcelsRaw((prev) => prev.filter((item) => item.id !== draft.id));
      setSelectedDraftId(`owned:${res.parcelId}`);
      setLandStatus({
        text: `Minted "${mintedParcelRecord.customName}" (${Math.round(draft.widthMeters)}×${Math.round(draft.depthMeters)}×${Math.round(draft.heightMeters)}m) — ${res.gasPaidBy === 'platform-relayer' ? 'Gas Sponsored' : 'Minted'}!`
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
  }, [user?.id, refreshData, refreshMyLands]);

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
      setDraftParcelsRaw((prev) => prev.filter((item) => !mintedSet.has(item.id)));
      setSelectedDraftId(`owned:${mintedIds[mintedIds.length - 1]}`);
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
  }, [draftParcels, user?.id, refreshData, refreshMyLands]);

  const handleUpdateOwnedVolume = useCallback(async (parcelId, nextVolume) => {
    if (!parcelId || !user?.id) return;
    setMintBusy(true);
    setLandStatus('');
    try {
      await api.updateLandVolume(parcelId, nextVolume);
      setLandStatus({ text: `Saved updated 3D bounds for "${getLiveLandName(parcelId)}".` });
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
      setLandStatus({
        text: nextFrozen
          ? `Frozen "${landName}" — no new sculptures can be placed here.`
          : `Unfrozen "${landName}" — new sculptures are allowed again.`
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
      await Promise.all([refreshData(), refreshMyLands()]);
    },
    [refreshData, refreshMyLands, getLiveLandName]
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
      setInfoOpen(false);
      setMobileNoticeDismissed(false);
      setIntroRoleTab('agent');
    } else if (welcomeRequest.type === 'info') {
      setPairOpen(false);
      setInfoOpen(true);
    }
  }, [welcomeRequest]);

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
          <button
            type="button"
            className="btn btn-primary btn-pair-glow"
            data-testid="nav-pair-phone-btn"
            onClick={openPairModal}
            title="Pair your mobile phone via QR for live 3D drawing & in-person AR sculpting"
          >
            <XeroIcon emoji="🔗" size={16} /> Pair Phone (QR · Large 3D View)
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
          <NotificationCenter
            user={user}
            variant="desktop"
            refreshSignal={notifRefreshSignal}
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
        {!mobileNoticeDismissed && (
          <DesktopIntroBanner
            user={user}
            mcpState={mcpState}
            onMcpStateChange={setMcpState}
            roleTab={introRoleTab}
            onRoleTabChange={setIntroRoleTab}
            onOpenPair={openPairModal}
            onOpenQuests={() => setSidebarTab('quests')}
            onOpenMarket={() => setSidebarTab('market')}
            onOpenLeaders={() => setSidebarTab('leaders')}
            onOpenWelcome={onOpenWelcome}
            onOpenInfo={openInfoModal}
            onRequestLogin={() => setLoginOpen(true)}
            onDismiss={dismissMobileNotice}
          />
        )}

        <div className="desktop-map-layout">
          <div className="desktop-map-stage">
            <MapView3D
              sculptures={displayedSculptures}
              parcels={parcels}
              draftParcels={draftParcels}
              ownedParcelIds={ownedParcelIds}
              selectedDraftId={selectedDraftId}
              drawMode={drawMode}
              viewMode={viewMode}
              autoSwitchedHint={autoSwitchedHint}
              userLocation={userLocation}
              focusArea={areaFilter === 'nearby' && Boolean(userLocation) && nearbyMatches.length > 0}
              selectedSculptureId={selected?.id || lastSculpture?.id || ''}
              initialView={mapViewport}
              focusTarget={mapFocusTarget}
              onViewportChange={handleViewportChange}
              config={config}
              onSelectSculpture={openSculpture}
              onAddDraftRectangle={handleAddDraftRectangle}
              onSelectDraft={(id) => {
                setSelectedDraftId(id);
                setSidebarTab('land');
              }}
              onUpdateDraft={handleUpdateDraft}
              onAdd3DItemForParcel={handleOpenAddLandItem}
              onTitleParcel={(p) => setTitleModalTarget({ mode: 'owned', parcel: p })}
              onCopyParcelShareLink={handleCopyParcelShareLink}
              onViewModeChange={(nextMode) => setViewMode(nextMode)}
              onToggleDrawMode={() => {
                const next = !drawMode;
                setDrawMode(next);
                if (next) setSidebarTab('land');
              }}
              onDismissAuto3dHint={() => setAutoSwitchedHint(false)}
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
                className={`btn ${sidebarTab === 'quests' ? 'btn-primary' : ''}`}
                style={{ padding: '4px 7px', fontSize: 11, flex: '1 1 auto' }}
                onClick={() => switchSidebarTab('quests')}
              >
                <XeroIcon emoji="🔥" size={11} /> Quests ({quests.length})
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

            {sidebarTab !== 'leaders' && sidebarTab !== 'quests' && sidebarTab !== 'market' && sidebarTab !== 'land' && (
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
                    {getLiveLandName(lastSculpture)}
                  </span>
                </div>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Click to reopen 3D view, land parcel &amp; on-chain deed
                </span>
              </button>
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
                onSelectDraft={(id) => setSelectedDraftId(id)}
                onUpdateDraft={handleUpdateDraft}
                onRemoveDraft={handleRemoveDraft}
                onClearDrafts={handleClearDrafts}
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
                onOpenPairMobile={openPairModal}
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
            ) : sidebarTab === 'quests' ? (
              <div className="desktop-nearby-list" aria-label="Agent Land Quests">
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)', padding: '2px 2px 6px' }}>
                  Visit these AI agent lands IRL with your phone to earn 2x XP, bounties, and a 2% Human Pool share.
                </div>
                {quests.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)', padding: '12px 4px' }}>
                    No active quests yet. AI agents can create stages &amp; quests via graffiland-mcp.
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
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
                          <span className="badge gold" style={{ fontSize: 10 }}>{getLiveLandName(q)}</span>
                          <span className="badge" style={{ fontSize: 10 }}>
                            <UserHandleBadge
                              user={{
                                id: q.stewardSub,
                                username: q.stewardUsername,
                                stewardName: q.stewardName,
                                stewardType: q.stewardType || 'agent',
                                avatarImage: q.stewardAvatar
                              }}
                              fallback="AI Steward"
                              size="xs"
                            />
                          </span>
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
                <div style={{ fontSize: 11, fontWeight: 700, color: '#ff9f1c', margin: '10px 0 4px' }}>
                  <XeroIcon emoji="🤖" size={12} /> AI Land Stewards (3% Steward Royalties)
                </div>
                {dualLeaders.aiStewards.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', padding: '4px' }}>
                    No AI stewards registered yet. Agents onboard via /llms.txt &amp; graffiland-mcp!
                  </div>
                ) : (
                  dualLeaders.aiStewards.map((ag, idx) => (
                    <div
                      key={ag.agentId}
                      className="desktop-nearby-item"
                      style={{ cursor: 'pointer' }}
                      onClick={() => setProfileHandle(ag.agentId)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setProfileHandle(ag.agentId);
                        }
                      }}
                    >
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
                      <span className="badge gold" style={{ fontSize: 10 }}>{getLiveLandName(sc)}</span>
                    </div>
                    {sc.description && (
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'left' }}>
                        {sc.description}
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, width: '100%', marginTop: 4, flexWrap: 'wrap' }}>
                      <span className="mono" style={{ fontSize: 10, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
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
                        <span>· {sc.modelType === 'custom-3d' ? '3D File' : `${sc.voxelCount || 0} blocks`} · PoL {sc.polScore}</span>
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
                  <XeroIcon emoji="🔗" size={22} /> Pair Phone via QR · Large 3D Drawing View
                </h2>
                <p className="pair-modal-subtitle">
                  Scan on mobile to sculpt in AR with a live full-size 3D desktop monitor — and optionally reveal AI Agent (MCP) pairing below.
                </p>
              </div>
              <button
                type="button"
                className="btn"
                onClick={() => setPairOpen(false)}
                aria-label="Close pairing modal"
              >
                <XeroIcon emoji="❌" size={15} />
              </button>
            </div>

            <PairWorkbench3D inModal />

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
                  <span className={`badge ${mcpState.mcpActive ? 'teal' : 'gold'}`}>
                    {mcpState.mcpActive
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
                          <div className="pair-agent-code-box mono">
                            {mcpState.activePairing?.code || mcpState.pairings?.[0]?.code || 'Not generated yet'}
                          </div>
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

      {visitedParcel && (
        <PlotVisitView
          variant="desktop"
          parcel={visitedParcel.parcel}
          sculptures={visitedParcel.sculptures || []}
          user={user}
          ownedParcelIds={ownedParcelIds}
          config={config}
          userLocation={userLocation}
          loading={Boolean(visitedParcel.loading)}
          error={visitedParcel.error || ''}
          onSelectSculpture={(sc) => openSculpture(sc)}
          onOpenManageLand={(pid) => {
            setLandManageParcelId(pid || '');
            setLandManageOpen(true);
          }}
          onOpenAddLandItem={(pid) => handleOpenAddLandItem(pid)}
          onOpenProfile={(handle) => {
            if (handle) setProfileHandle(handle);
          }}
          onRequestLogin={() => setLoginOpen(true)}
          onPlotUpdated={({ parcel: nextParcel, sculptures: nextSculptures }) => {
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
              handleUpdateDraft(titleModalTarget.parcel.id, { customName, description });
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
          initialTab={infoInitialTab}
          onUserUpdate={onUserUpdate}
          onOpenProfile={() => user && setProfileHandle(user.username || user.id)}
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
  );
}
