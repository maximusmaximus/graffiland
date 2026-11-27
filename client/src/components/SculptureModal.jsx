import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { BrowserProvider, Contract, isAddress } from 'ethers';
import xeroemoji from 'xeroemoji';
import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import { HUMAN_MAX_DRAW_SPAN_METERS } from '../../../shared/constants.mjs';
import { resolveLandDisplayName } from '../../../shared/landVolume.mjs';
import {
  buildPlacementItemFromSculpture,
  computeItemLocalBox,
  computeMaxFeasibleScale,
  computeMaxScaleForParcel,
  computeRotatedBoxDimensions,
  extractSculptureBaseDimensions,
  extractSculptureRotation,
  extractSculptureScale,
  MIN_ARTWORK_SCALE,
  resolveParcelVolumeForPlacement,
  resolveSculpturePlacement,
  tiltToDegrees
} from '../../../shared/sculpturePlacement.mjs';
import {
  buildTransferAuthMessage,
  ERC721_TRANSFER_ABI
} from '../../../shared/transferMessage.mjs';
import { api, API_BASE, resolveApiUrl } from '../utils/api.js';
import { resolveMiniMapLandBoundary } from '../utils/landPreviewHelpers.js';
import { getLeafletTileConfig, useMapTheme } from '../utils/mapTheme.js';
import {
  decryptPinnedIpfsBatch,
  encryptPinnedIpfsBatch,
  getOrCreateDeviceIdentity
} from '../utils/chatCrypto.js';
import { getSculptureChainLinks } from '../utils/chainLinks.js';
import {
  buildSculptureShareUrl,
  buildShareToXUrl,
  copyToClipboard
} from '../utils/clipboard.js';
import { buildPropertyOwnerPrompt } from '../../../shared/landSignatureMessage.mjs';
import {
  resolveAuthorHandleForStorage,
  resolveSafeUserAvatar
} from '../../../shared/userDisplay.mjs';
import {
  formatDistance,
  formatShortLength,
  useMeasurementUnits
} from '../utils/measurementUnits.js';
import { notifySettingsSaved } from '../utils/toastNotice.js';
import { EmojiInput, EmojiTextarea } from './EmojiField.jsx';
import { GlobalNotificationBell } from './NotificationCenter.jsx';
import SculptureViewer3D from './SculptureViewer3D.jsx';
import SculptureRevisionsPanel from './SculptureRevisionsPanel.jsx';
import UserHandleBadge from './UserHandleBadge.jsx';
import XeroIcon from './XeroIcon.jsx';

async function switchOrAddRobinhoodNetwork(eth, chainInfo) {
  const chainIdNum = Number(chainInfo?.chainId || 46630);
  const chainHex = `0x${chainIdNum.toString(16)}`;
  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainHex }]
    });
  } catch (err) {
    if (err?.code === 4902 && chainInfo?.rpcUrl) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: chainHex,
            chainName: chainInfo.name || 'Robinhood Chain Testnet',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [chainInfo.rpcUrl],
            blockExplorerUrls: chainInfo.explorer ? [chainInfo.explorer] : []
          }
        ]
      });
    } else {
      throw err;
    }
  }
}

const EMPTY_PARCELS = [];

function formatPendingExpiry(expiresAt) {
  if (!expiresAt) return '';
  const diffMs = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(diffMs)) return '';
  if (diffMs <= 0) return 'expired';
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m left`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h left`;
  return `${Math.round(hrs / 24)}d left`;
}

export default function SculptureModal({
  sculpture: initialSculpture,
  user,
  config,
  userLocation = null,
  allParcels = EMPTY_PARCELS,
  onSculptureUpdated,
  onSculptureDeleted = null,
  onSelectParcel = null,
  onModifyInCanvas = null,
  onOpenLandManagement = null,
  onOpenAddLandItem = null,
  onRequestLogin = null,
  onApprovePending = null,
  onRejectPending = null,
  pendingApprovalBusy = false,
  pendingApprovalError = null,
  onClose
}) {
  const [sculpture, setSculpture] = useState(initialSculpture);
  const isPendingPreview = Boolean(sculpture?.isPendingPreview);
  const [localPendingBusy, setLocalPendingBusy] = useState(false);
  const [localPendingError, setLocalPendingError] = useState(null);
  const [previewViewMode, setPreviewViewMode] = useState('isometric'); // 'isometric' | 'land'
  const [previewSpin, setPreviewSpin] = useState(false);
  const [previewResetTick, setPreviewResetTick] = useState(0);
  const scFallbackCoords =
    Number.isFinite(Number(sculpture?.lat)) && Number.isFinite(Number(sculpture?.lng))
      ? { lat: Number(sculpture.lat), lng: Number(sculpture.lng) }
      : null;
  const { unitSystem } = useMeasurementUnits(userLocation, scFallbackCoords);
  const landMapHostRef = useRef(null);
  const [toAddress, setToAddress] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [nftNotice, setNftNotice] = useState('');
  const [nftError, setNftError] = useState('');
  const [listingPrice, setListingPrice] = useState('0.05');
  const [listingBusy, setListingBusy] = useState(false);
  const [listingNotice, setListingNotice] = useState('');
  const [listingError, setListingError] = useState('');
  const [editTitle, setEditTitle] = useState(initialSculpture?.title || '');
  const [editDesc, setEditDesc] = useState(initialSculpture?.description || '');
  const [editOffset, setEditOffset] = useState(() => {
    const rot = extractSculptureRotation(initialSculpture);
    return {
      dx: Number(initialSculpture?.anchorOffset?.dx || 0),
      dy: Number(initialSculpture?.anchorOffset?.dy || 0),
      dz: Number(initialSculpture?.anchorOffset?.dz || 0),
      yaw: rot.yaw,
      pitch: rot.pitch,
      roll: rot.roll
    };
  });
  const [editScale, setEditScale] = useState(() => extractSculptureScale(initialSculpture));
  const [measuredBaseDims, setMeasuredBaseDims] = useState(null);
  const [parcelDetail, setParcelDetail] = useState(null);
  const [parcelSculptures, setParcelSculptures] = useState([]);
  const [studioOpen, setStudioOpen] = useState(true);
  const [showLandBoundsPreview, setShowLandBoundsPreview] = useState(true);
  const [showGizmoHandles, setShowGizmoHandles] = useState(true);
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const [studioCameraFocus, setStudioCameraFocus] = useState('model'); // 'model' | 'land'
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [parcelFrozen, setParcelFrozen] = useState(Boolean(initialSculpture?.parcelFrozen));
  const [showAllMetadata, setShowAllMetadata] = useState(false);
  const [metadataCopied, setMetadataCopied] = useState(false);
  const [landCustomName, setLandCustomName] = useState('');
  const [landCurationNote, setLandCurationNote] = useState('');
  const [propBusy, setPropBusy] = useState('');
  const [propNotice, setPropNotice] = useState('');
  const [propError, setPropError] = useState('');
  const [promptCopied, setPromptCopied] = useState(false);
  const [modalPins, setModalPins] = useState([]);
  const [pinDraftText, setPinDraftText] = useState('');
  const [editModalPinId, setEditModalPinId] = useState('');
  const [editModalPinText, setEditModalPinText] = useState('');
  const [pinBatchInfo, setPinBatchInfo] = useState(initialSculpture?.pinSummary || null);

  useEffect(() => {
    setSculpture(initialSculpture);
    setEditTitle(initialSculpture?.title || '');
    setEditDesc(initialSculpture?.description || '');
    const initRot = extractSculptureRotation(initialSculpture);
    setEditOffset({
      dx: Number(initialSculpture?.anchorOffset?.dx || 0),
      dy: Number(initialSculpture?.anchorOffset?.dy || 0),
      dz: Number(initialSculpture?.anchorOffset?.dz || 0),
      yaw: initRot.yaw,
      pitch: initRot.pitch,
      roll: initRot.roll
    });
    setEditScale(extractSculptureScale(initialSculpture));
    setMeasuredBaseDims(null);
    setConfirmRemove(false);
    setParcelFrozen(Boolean(initialSculpture?.parcelFrozen));
    setLandCustomName(initialSculpture?.parcelName || '');
    setMetadataCopied(false);
    setNftNotice('');
    setNftError('');
    setPropNotice('');
    setPropError('');
    setPromptCopied(false);
    setModalPins([]);
    setPinDraftText('');
    setEditModalPinId('');
    setPinBatchInfo(initialSculpture?.pinSummary || null);
    setLocalPendingBusy(false);
    setLocalPendingError(null);
    if (!initialSculpture?.id || initialSculpture?.isPendingPreview) return;
    let cancelled = false;
    api
      .getSculpture(initialSculpture.id)
      .then((res) => {
        if (!cancelled && res?.sculpture) {
          setSculpture(res.sculpture);
          setEditTitle(res.sculpture.title || '');
          setEditDesc(res.sculpture.description || '');
          const fetchedRot = extractSculptureRotation(res.sculpture);
          setEditOffset({
            dx: Number(res.sculpture.anchorOffset?.dx || 0),
            dy: Number(res.sculpture.anchorOffset?.dy || 0),
            dz: Number(res.sculpture.anchorOffset?.dz || 0),
            yaw: fetchedRot.yaw,
            pitch: fetchedRot.pitch,
            roll: fetchedRot.roll
          });
          setEditScale(extractSculptureScale(res.sculpture));
          setParcelFrozen(Boolean(res.sculpture.parcelFrozen));
          if (res.sculpture.parcelName !== undefined) {
            setLandCustomName(res.sculpture.parcelName || '');
          }
          if (res.sculpture.pinSummary) {
            setPinBatchInfo(res.sculpture.pinSummary);
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initialSculpture, user?.id]);

  // Load parent Virtual Land 3D volume + sibling artworks for live bounds & non-intersecting push preview
  const scParcelId = sculpture?.parcelId || '';
  useEffect(() => {
    if (!scParcelId) {
      setParcelDetail(null);
      setParcelSculptures([]);
      return undefined;
    }
    let cancelled = false;
    api
      .getLandDetail(scParcelId)
      .then((res) => {
        if (cancelled) return;
        if (res?.parcel) {
          setParcelDetail(res.parcel);
          const resolvedName =
            res.parcel.customName ||
            resolveLandDisplayName(res.parcel, { defaultName: '' });
          if (resolvedName) {
            setLandCustomName((prev) => prev || resolvedName);
          }
          const resolvedNote = String(res.parcel.description || res.parcel.curationNote || '').trim();
          if (resolvedNote) {
            setLandCurationNote((prev) => prev || resolvedNote);
          }
          if (res.parcel.frozen !== undefined) {
            setParcelFrozen(Boolean(res.parcel.frozen));
          }
        }
        if (Array.isArray(res?.sculptures)) {
          setParcelSculptures(res.sculptures);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [scParcelId, user?.id]);

  const scMapId = sculpture?.id;
  const scMapLat = sculpture?.lat;
  const scMapLng = sculpture?.lng;
  const miniMapBoundary = useMemo(
    () =>
      resolveMiniMapLandBoundary({
        parcelDetail,
        allParcels,
        sculpture
      }),
    [parcelDetail, allParcels, sculpture]
  );
  const scLandDisplayName = resolveLandDisplayName(
    {
      customName: landCustomName || parcelDetail?.customName || sculpture?.parcelName || '',
      displayName: parcelDetail?.displayName || sculpture?.landDisplayName || '',
      firstSculptureTitle: sculpture?.title || '',
      placeName: sculpture?.placeName || ''
    },
    { defaultName: 'Virtual Land' }
  );

  // Live 3D land bounds & non-intersecting collision-push solver state
  const placementVolume = useMemo(
    () => resolveParcelVolumeForPlacement({ parcel: parcelDetail, sculpture }),
    [parcelDetail, sculpture]
  );

  const effectiveBaseDims = useMemo(
    () => extractSculptureBaseDimensions(sculpture, measuredBaseDims),
    [sculpture, measuredBaseDims]
  );

  const placementItems = useMemo(() => {
    if (!sculpture?.id) return [];
    const byId = new Map();
    for (const sc of parcelSculptures || []) {
      if (!sc?.id || sc.hidden) continue;
      byId.set(sc.id, sc);
    }
    byId.set(sculpture.id, sculpture);
    return Array.from(byId.values()).map((sc) =>
      buildPlacementItemFromSculpture(
        sc,
        placementVolume,
        sc.id === sculpture.id ? effectiveBaseDims : null
      )
    );
  }, [effectiveBaseDims, parcelSculptures, placementVolume, sculpture]);

  const targetBaseItem = useMemo(
    () => placementItems.find((it) => it.id === sculpture?.id) || null,
    [placementItems, sculpture?.id]
  );

  const livePlacement = useMemo(() => {
    if (!sculpture?.id || placementItems.length === 0) return null;
    return resolveSculpturePlacement({
      parcelVolume: placementVolume,
      targetId: sculpture.id,
      targetTransform: {
        dx: Number(editOffset.dx || 0),
        dy: Math.max(0, Number(editOffset.dy || 0)),
        dz: Number(editOffset.dz || 0),
        yaw: Number(editOffset.yaw || 0),
        pitch: tiltToDegrees(editOffset.pitch || 0),
        roll: tiltToDegrees(editOffset.roll || 0),
        scale: Number(editScale || 1)
      },
      items: placementItems
    });
  }, [editOffset, editScale, placementItems, placementVolume, sculpture?.id]);

  const maxScaleForLand = useMemo(() => {
    if (!targetBaseItem) return 10;
    const landCap = computeMaxScaleForParcel(
      {
        ...targetBaseItem,
        yaw: Number(editOffset.yaw || 0),
        pitch: tiltToDegrees(editOffset.pitch || 0),
        roll: tiltToDegrees(editOffset.roll || 0)
      },
      placementVolume
    );
    if (sculpture?.modelType === 'custom-3d') return landCap;
    const unitRot = computeRotatedBoxDimensions({
      width: Number(targetBaseItem.baseWidth || 0.05),
      height: Number(targetBaseItem.baseHeight || 0.05),
      depth: Number(targetBaseItem.baseDepth || 0.05),
      yaw: Number(editOffset.yaw || 0),
      pitch: tiltToDegrees(editOffset.pitch || 0),
      roll: tiltToDegrees(editOffset.roll || 0),
      scale: 1
    });
    const effW = Math.max(0.01, unitRot.effW);
    const effD = Math.max(0.01, unitRot.effD);
    const humanCap = Math.min(
      HUMAN_MAX_DRAW_SPAN_METERS / effW,
      HUMAN_MAX_DRAW_SPAN_METERS / effD
    );
    return Math.max(MIN_ARTWORK_SCALE, Math.min(landCap, Math.floor(humanCap * 1000) / 1000));
  }, [editOffset.pitch, editOffset.roll, editOffset.yaw, placementVolume, sculpture?.modelType, targetBaseItem]);

  const maxSafeScale = useMemo(() => {
    if (!sculpture?.id || placementItems.length === 0) return maxScaleForLand;
    const feasible = computeMaxFeasibleScale({
      parcelVolume: placementVolume,
      targetId: sculpture.id,
      targetTransform: {
        dx: Number(editOffset.dx || 0),
        dy: Math.max(0, Number(editOffset.dy || 0)),
        dz: Number(editOffset.dz || 0),
        yaw: Number(editOffset.yaw || 0),
        pitch: tiltToDegrees(editOffset.pitch || 0),
        roll: tiltToDegrees(editOffset.roll || 0)
      },
      items: placementItems
    });
    return Math.min(feasible, maxScaleForLand);
  }, [editOffset, maxScaleForLand, placementItems, placementVolume, sculpture?.id]);

  const handleMeasuredBounds = useCallback((dims) => {
    if (!dims) return;
    setMeasuredBaseDims((prev) => {
      if (
        prev &&
        Math.abs(prev.width - dims.width) < 0.005 &&
        Math.abs(prev.height - dims.height) < 0.005 &&
        Math.abs(prev.depth - dims.depth) < 0.005
      ) {
        return prev;
      }
      return dims;
    });
  }, []);

  const { mapTheme } = useMapTheme();
  const miniMapRef = useRef(null);
  const miniMapOverlayRef = useRef(null);

  useEffect(() => {
    const host = landMapHostRef.current;
    const latNum = Number(scMapLat);
    const lngNum = Number(scMapLng);
    if (!host || !scMapId || !Number.isFinite(latNum) || !Number.isFinite(lngNum)) return undefined;

    host.classList.toggle('is-map-light', mapTheme === 'light');
    const map = L.map(host, {
      center: [latNum, lngNum],
      zoom: 19,
      maxZoom: 21,
      zoomControl: false,
      attributionControl: false
    });
    miniMapRef.current = map;

    const tileCfg = getLeafletTileConfig(mapTheme);
    L.tileLayer(tileCfg.url, { ...tileCfg.options, maxNativeZoom: 19, maxZoom: 21 }).addTo(map);

    const overlay = L.layerGroup().addTo(map);
    miniMapOverlayRef.current = overlay;

    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 80);

    return () => {
      clearTimeout(timer);
      miniMapOverlayRef.current = null;
      miniMapRef.current = null;
      map.remove();
    };
  }, [scMapId, scMapLat, scMapLng, mapTheme]);

  // Draw the authoritative oriented land boundary polygon & sculpture pin, fitting cleanly to the land
  useEffect(() => {
    const map = miniMapRef.current;
    const overlay = miniMapOverlayRef.current;
    if (!map || !overlay) return undefined;

    overlay.clearLayers();
    let boundaryLayer = null;
    if (miniMapBoundary.latLngCorners.length >= 4) {
      boundaryLayer = L.polygon(miniMapBoundary.latLngCorners, {
        color: '#ffd166',
        weight: 2.5,
        fillColor: '#00f5d4',
        fillOpacity: 0.24
      })
        .bindTooltip(scLandDisplayName)
        .addTo(overlay);
    }

    if (miniMapBoundary.pinLatLng) {
      const pinUrl = xeroemoji.get('📍')?.svgUrl;
      const pinIcon = L.divIcon({
        className: 'graffiland-map-pin',
        html: pinUrl
          ? `<img src="${pinUrl}" width="26" height="26" style="filter: drop-shadow(0 2px 6px rgba(0,245,212,0.75));" />`
          : '📍',
        iconSize: [26, 26],
        iconAnchor: [13, 24]
      });
      L.marker(miniMapBoundary.pinLatLng, { icon: pinIcon }).addTo(overlay);
    }

    const fitToLand = () => {
      map.invalidateSize();
      if (boundaryLayer && typeof boundaryLayer.getBounds === 'function') {
        const fitBounds = boundaryLayer.getBounds();
        if (miniMapBoundary.pinLatLng && typeof fitBounds.extend === 'function') {
          fitBounds.extend(miniMapBoundary.pinLatLng);
        }
        map.fitBounds(fitBounds, { padding: [26, 26], maxZoom: 20, animate: false });
      } else if (miniMapBoundary.center) {
        map.setView(miniMapBoundary.center, 19, { animate: false });
      }
    };

    fitToLand();
    const timer = setTimeout(fitToLand, 90);
    return () => clearTimeout(timer);
  }, [miniMapBoundary, scLandDisplayName, mapTheme]);

  const pol = sculpture?.proofOfLocation || {};
  const geo = pol.geoInfo || {};
  const sensors = pol.sensors || {};
  const solar = pol.solar || {};
  const elevation = sculpture?.elevation || pol.elevation || {};
  const ownerAddr = sculpture?.recipientAddress || sculpture?.ownerAddress || '';
  const ownerWallets = [
    user?.walletAddress,
    user?.customPayoutAddress,
    user?.activeMintRecipient
  ]
    .filter(Boolean)
    .map((a) => a.toLowerCase());
  const isCreatorOwner = Boolean(
    user?.id && sculpture?.creatorSub && String(sculpture.creatorSub) === String(user.id)
  );
  const isPropertyOwner = Boolean(
    isCreatorOwner || (ownerAddr && ownerWallets.includes(ownerAddr.toLowerCase()))
  );
  const isLandOwner = Boolean(
    sculpture?.viewerIsLandOwner ||
      (user?.id && parcelDetail?.ownerSub && String(parcelDetail.ownerSub) === String(user.id))
  );
  const canModerateLand = Boolean(user && (isPropertyOwner || isLandOwner));
  const isContributor = Boolean(user && !canModerateLand && sculpture?.viewerCanContribute);
  const canModifySculpture = Boolean(user && (canModerateLand || isContributor));
  const isEmbeddedOwner = Boolean(
    user?.walletAddress &&
      ownerAddr &&
      user.walletAddress.toLowerCase() === ownerAddr.toLowerCase()
  );

  useEffect(() => {
    if (!isPropertyOwner || !user?.id || !sculpture?.id) return;
    let cancelled = false;
    api
      .getOwnerPinSeal(sculpture.id)
      .then(async (sealRes) => {
        if (cancelled) return;
        if (sealRes.meta) setPinBatchInfo(sealRes.meta);
        if (sealRes.encryptedBatch) {
          const dec = await decryptPinnedIpfsBatch({
            encryptedBatch: sealRes.encryptedBatch,
            parcelSealKeyB64: sealRes.parcelSealKeyB64,
            sculptureId: sculpture.id,
            parcelId: sculpture.parcelId,
            geohash: sculpture.geohash
          });
          if (!cancelled) setModalPins(dec.pins || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isPropertyOwner, sculpture?.geohash, sculpture?.id, sculpture?.parcelId, user?.id]);

  useEffect(() => {
    setPreviewViewMode('isometric');
    setPreviewSpin(false);
    setStudioCameraFocus('model');
    setPreviewResetTick((t) => t + 1);
  }, [initialSculpture?.id]);

  const previewLiveTransform = useMemo(() => {
    if (!isPendingPreview) return null;
    const ao = sculpture?.anchorOffset || {};
    const rot = extractSculptureRotation(sculpture);
    return {
      baseX: Number(targetBaseItem?.baseX || 0),
      baseZ: Number(targetBaseItem?.baseZ || 0),
      dx: Number(ao.dx || 0),
      dy: Math.max(0, Number(ao.dy || 0)),
      dz: Number(ao.dz || 0),
      yaw: Number.isFinite(Number(ao.yaw)) ? Number(ao.yaw) : rot.yaw,
      pitch: Number.isFinite(Number(ao.pitch)) ? tiltToDegrees(ao.pitch) : rot.pitch,
      roll: Number.isFinite(Number(ao.roll)) ? tiltToDegrees(ao.roll) : rot.roll,
      scale: extractSculptureScale(sculpture) || 1
    };
  }, [isPendingPreview, sculpture, targetBaseItem?.baseX, targetBaseItem?.baseZ]);

  const viewerLiveTransform = useMemo(() => {
    const resolved = livePlacement?.ok ? livePlacement.target : null;
    return {
      baseX: Number(targetBaseItem?.baseX || 0),
      baseZ: Number(targetBaseItem?.baseZ || 0),
      dx: resolved ? resolved.dx : Number(editOffset.dx || 0),
      dy: resolved ? resolved.dy : Math.max(0, Number(editOffset.dy || 0)),
      dz: resolved ? resolved.dz : Number(editOffset.dz || 0),
      yaw: resolved ? resolved.yaw : Number(editOffset.yaw || 0),
      pitch: resolved ? resolved.pitch : tiltToDegrees(editOffset.pitch || 0),
      roll: resolved ? resolved.roll : tiltToDegrees(editOffset.roll || 0),
      scale: resolved ? resolved.scale : Number(editScale || 1)
    };
  }, [editOffset, editScale, livePlacement, targetBaseItem?.baseX, targetBaseItem?.baseZ]);

  const viewerSiblingBoxes = useMemo(() => {
    if (!sculpture?.id) return [];
    if (livePlacement?.ok && Array.isArray(livePlacement.allItems)) {
      return livePlacement.allItems
        .filter((it) => it.id !== sculpture.id)
        .map((it) => ({
          id: it.id,
          title: it.title,
          box: it.box,
          wasPushed: Boolean(it.wasPushed),
          isColliding: false
        }));
    }
    const collidingSet = new Set(livePlacement?.collidingIds || []);
    return placementItems
      .filter((it) => it.id !== sculpture.id)
      .map((it) => ({
        id: it.id,
        title: it.title,
        box: computeItemLocalBox(it),
        wasPushed: false,
        isColliding: collidingSet.has(it.id)
      }));
  }, [livePlacement, placementItems, sculpture?.id]);

  const activeScaleDims = useMemo(() => {
    const s = Math.max(MIN_ARTWORK_SCALE, Number(editScale || 1));
    const rot = computeRotatedBoxDimensions({
      width: effectiveBaseDims.width,
      height: effectiveBaseDims.height,
      depth: effectiveBaseDims.depth,
      yaw: Number(editOffset.yaw || 0),
      pitch: tiltToDegrees(editOffset.pitch || 0),
      roll: tiltToDegrees(editOffset.roll || 0),
      scale: s
    });
    return {
      w: Math.round(rot.effW * 100) / 100,
      h: Math.round(rot.effH * 100) / 100,
      d: Math.round(rot.effD * 100) / 100
    };
  }, [editOffset.pitch, editOffset.roll, editOffset.yaw, editScale, effectiveBaseDims]);

  const moveRanges = useMemo(() => {
    const halfW = Math.max(0.5, Number(placementVolume.widthMeters || 14) / 2);
    const halfD = Math.max(0.5, Number(placementVolume.depthMeters || 14) / 2);
    const volH = Math.max(1, Number(placementVolume.heightMeters || 18));
    const bx = Number(targetBaseItem?.baseX || 0);
    const bz = Number(targetBaseItem?.baseZ || 0);
    const halfItemW = activeScaleDims.w / 2;
    const halfItemD = activeScaleDims.d / 2;
    const minDx = Math.round((-halfW + halfItemW - bx + 0.02) * 100) / 100;
    const maxDx = Math.round((halfW - halfItemW - bx - 0.02) * 100) / 100;
    const minDz = Math.round((-halfD + halfItemD - bz + 0.02) * 100) / 100;
    const maxDz = Math.round((halfD - halfItemD - bz - 0.02) * 100) / 100;
    const maxDy = Math.max(0, Math.round((volH - activeScaleDims.h - 0.02) * 100) / 100);
    return {
      minDx: Math.min(minDx, maxDx),
      maxDx: Math.max(minDx, maxDx),
      minDz: Math.min(minDz, maxDz),
      maxDz: Math.max(minDz, maxDz),
      maxDy
    };
  }, [activeScaleDims, placementVolume, targetBaseItem?.baseX, targetBaseItem?.baseZ]);

  if (!sculpture) return null;

  async function saveOwnerPinnedIpfsBatch(nextPins) {
    if (!user?.id || !sculpture?.id) return;
    setPropBusy('pins');
    setPropNotice('');
    setPropError('');
    try {
      const idObj = await getOrCreateDeviceIdentity(user.id);
      const sealRes = await api.getOwnerPinSeal(sculpture.id);
      const encryptedBatch = await encryptPinnedIpfsBatch({
        pins: nextPins,
        sculptureId: sculpture.id,
        parcelId: sculpture.parcelId,
        geohash: sculpture.geohash,
        batchSeq: sealRes.nextBatchSeq,
        parcelSealKeyB64: sealRes.parcelSealKeyB64,
        identity: idObj
      });
      const saved = await api.saveEncryptedPinBatch(sculpture.id, { encryptedBatch });
      if (saved.meta) setPinBatchInfo(saved.meta);
      const dec = await decryptPinnedIpfsBatch({
        encryptedBatch,
        parcelSealKeyB64: sealRes.parcelSealKeyB64,
        sculptureId: sculpture.id,
        parcelId: sculpture.parcelId,
        geohash: sculpture.geohash
      });
      setModalPins(dec.pins || []);
      onSculptureUpdated?.({ ...sculpture, pinSummary: saved.meta });
      setPropNotice(
        `Encrypted pin batch v${saved.meta?.batchSeq || sealRes.nextBatchSeq} saved to IPFS (${saved.ipfs?.cid?.slice(0, 14)}...).`
      );
    } catch (err) {
      setPropError(err.message || 'Could not pin encrypted batch to IPFS');
    } finally {
      setPropBusy('');
    }
  }

  async function handleSaveSculptureEdit(e) {
    e?.preventDefault?.();
    if (livePlacement && !livePlacement.ok) {
      setPropError(livePlacement.message || 'Artwork position or scale violates land bounds.');
      return;
    }
    setPropBusy('save');
    setPropNotice('');
    setPropError('');
    try {
      const targetDx = livePlacement?.ok ? livePlacement.target.dx : Number(editOffset.dx || 0);
      const targetDy = livePlacement?.ok ? livePlacement.target.dy : Math.max(0, Number(editOffset.dy || 0));
      const targetDz = livePlacement?.ok ? livePlacement.target.dz : Number(editOffset.dz || 0);
      const targetYaw = livePlacement?.ok ? livePlacement.target.yaw : Number(editOffset.yaw || 0);
      const targetPitch = livePlacement?.ok
        ? livePlacement.target.pitch
        : tiltToDegrees(editOffset.pitch || 0);
      const targetRoll = livePlacement?.ok
        ? livePlacement.target.roll
        : tiltToDegrees(editOffset.roll || 0);
      const targetScaleVal = livePlacement?.ok ? livePlacement.target.scale : Number(editScale || 1);

      const res = await api.updateSculpture(sculpture.id, {
        title: editTitle,
        description: editDesc,
        scale: targetScaleVal,
        baseDimensions: effectiveBaseDims,
        anchorOffset: {
          dx: targetDx,
          dy: targetDy,
          dz: targetDz,
          yaw: targetYaw,
          pitch: targetPitch,
          roll: targetRoll,
          scale: targetScaleVal
        }
      });
      if (res?.sculpture) {
        const merged = { ...sculpture, ...res.sculpture };
        setSculpture(merged);
        const savedRot = extractSculptureRotation(res.sculpture);
        setEditOffset({
          dx: Number(res.sculpture.anchorOffset?.dx || 0),
          dy: Number(res.sculpture.anchorOffset?.dy || 0),
          dz: Number(res.sculpture.anchorOffset?.dz || 0),
          yaw: savedRot.yaw,
          pitch: savedRot.pitch,
          roll: savedRot.roll
        });
        setEditScale(extractSculptureScale(res.sculpture));

        // Keep local sibling positions in sync with any gently pushed neighbors
        const pushedList = Array.isArray(res.pushedSiblings) ? res.pushedSiblings : [];
        const pushedMap = new Map(pushedList.map((p) => [p.id, p]));
        setParcelSculptures((prev) =>
          (prev || []).map((item) => {
            if (item.id === res.sculpture.id) return { ...item, ...res.sculpture };
            const pushed = pushedMap.get(item.id);
            if (!pushed) return item;
            return {
              ...item,
              anchorOffset: {
                ...(item.anchorOffset || {}),
                dx: pushed.dx,
                dy: pushed.dy,
                dz: pushed.dz
              }
            };
          })
        );

        onSculptureUpdated?.(merged, { pushedSiblings: pushedList });
        const savedMsg =
          pushedList.length > 0
            ? `Saved transform & updated IPFS bundle! Safely shifted ${pushedList.length} neighboring artwork${
                pushedList.length === 1 ? '' : 's'
              } (${pushedList.map((p) => `"${p.title}"`).join(', ')}) inside "${scLandDisplayName}".`
            : 'Artwork settings, rotation, scale & position saved.';
        setPropNotice(savedMsg);
        notifySettingsSaved(savedMsg);
      }
    } catch (err) {
      setPropError(err.message || 'Update failed');
    } finally {
      setPropBusy('');
    }
  }

  async function handleToggleSculptureVisibility() {
    setPropBusy('visibility');
    setPropNotice('');
    setPropError('');
    try {
      const nextHidden = !sculpture.hidden;
      const res = await api.setSculptureVisibility(sculpture.id, {
        hidden: nextHidden,
        reason: nextHidden ? 'Hidden by Virtual Land owner' : ''
      });
      if (res?.sculpture) {
        setSculpture((prev) => ({ ...prev, ...res.sculpture }));
        onSculptureUpdated?.({ ...sculpture, ...res.sculpture });
      }
      const visMsg = nextHidden
        ? 'Artwork hidden from public map, gallery, and AR feeds.'
        : 'Artwork restored to public map, gallery, and AR feeds.';
      setPropNotice(visMsg);
      notifySettingsSaved(visMsg);
    } catch (err) {
      setPropError(err.message || 'Could not update artwork visibility.');
    } finally {
      setPropBusy('');
    }
  }

  async function handleToggleFreezeLand() {
    setPropBusy('freeze');
    setPropNotice('');
    setPropError('');
    try {
      const nextFrozen = !parcelFrozen;
      const res = await api.updateLandSettings(sculpture.parcelId, { frozen: nextFrozen });
      const actualFrozen = Boolean(res?.settings?.frozen ?? nextFrozen);
      setParcelFrozen(actualFrozen);
      setSculpture((prev) => ({ ...prev, parcelFrozen: actualFrozen }));
      onSculptureUpdated?.({ ...sculpture, parcelFrozen: actualFrozen });
      const freezeMsg = actualFrozen
        ? `Frozen "${scLandDisplayName}" — no new sculptures can be placed on this land.`
        : `Unfrozen "${scLandDisplayName}" — new sculptures are allowed again.`;
      setPropNotice(freezeMsg);
      notifySettingsSaved(freezeMsg);
    } catch (err) {
      setPropError(err.message || 'Could not update land freeze setting.');
    } finally {
      setPropBusy('');
    }
  }

  async function handleSaveLandCuration(e) {
    e.preventDefault();
    setPropBusy('land');
    setPropNotice('');
    setPropError('');
    try {
      const res = await api.updateLandParcel(sculpture.parcelId, {
        customName: landCustomName,
        curationNote: landCurationNote
      });
      const updatedName = resolveLandDisplayName(
        {
          customName: res?.parcel?.customName || landCustomName || '',
          displayName: res?.parcel?.displayName || '',
          firstSculptureTitle: sculpture.title || ''
        },
        { defaultName: 'Virtual Land' }
      );
      setSculpture((prev) => ({
        ...prev,
        parcelName: res?.parcel?.customName ?? landCustomName,
        landDisplayName: updatedName
      }));
      onSculptureUpdated?.({
        ...sculpture,
        parcelName: res?.parcel?.customName ?? landCustomName,
        landDisplayName: updatedName
      });
      const curMsg = `Saved land curation settings for "${updatedName}".`;
      setPropNotice(curMsg);
      notifySettingsSaved(curMsg);
    } catch (err) {
      setPropError(err.message || 'Land update failed');
    } finally {
      setPropBusy('');
    }
  }

  async function handleDeleteOwnedSculpture() {
    setPropBusy('delete');
    setPropNotice('');
    setPropError('');
    try {
      await api.deleteSculpture(sculpture.id);
      onSculptureDeleted?.(sculpture.id);
      onClose?.();
    } catch (err) {
      setPropError(err.message || 'Delete failed');
    } finally {
      setPropBusy('');
    }
  }

  async function handleCopyOwnerPrompt() {
    setPropBusy('prompt');
    setPropNotice('');
    setPropError('');
    try {
      const pairingsRes = await api.listMcpPairings();
      let code = pairingsRes.activePairing?.code || pairingsRes.pairings?.find((p) => p.status === 'pending')?.code;
      const origin = API_BASE || window.location.origin;
      if (!code) {
        const created = await api.createMcpPairing({ apiOrigin: origin });
        code = created.pairing?.code;
      }
      const promptText = buildPropertyOwnerPrompt({
        apiOrigin: origin,
        pairingCode: code,
        ownerAddress: ownerAddr,
        parcelId: sculpture.parcelId
      });
      await navigator.clipboard?.writeText(promptText);
      setPromptCopied(true);
      setPropNotice(`Copied Property Owner MCP Prompt (Pairing Code: ${code}).`);
    } catch (err) {
      setPropError(err.message || 'Could not copy prompt');
    } finally {
      setPropBusy('');
    }
  }
  const glbUrl = resolveApiUrl(
    sculpture.modelGlbUrl || `/api/sculptures/${encodeURIComponent(sculpture.id)}/model.glb`
  );
  const tokenMetaUrl = resolveApiUrl(
    sculpture.metadataUrl || `/api/sculptures/${encodeURIComponent(sculpture.id)}/metadata.json`
  );
  const chainLinks = getSculptureChainLinks(sculpture, config);
  const explorerTokenUrl = chainLinks.tokenUrl;
  const explorerTxUrl = chainLinks.txUrl;
  const explorerContractUrl = chainLinks.contractUrl;
  const transfers = Array.isArray(sculpture.transfers) ? sculpture.transfers : [];
  const hasCoords =
    Number.isFinite(Number(sculpture.lat)) && Number.isFinite(Number(sculpture.lng));
  const googleMapsUrl = hasCoords
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
        `${sculpture.lat},${sculpture.lng}`
      )}`
    : '';
  const distanceMeters =
    hasCoords &&
    userLocation &&
    Number.isFinite(Number(userLocation.lat)) &&
    Number.isFinite(Number(userLocation.lng))
      ? Math.round(
          haversineMeters(
            Number(userLocation.lat),
            Number(userLocation.lng),
            Number(sculpture.lat),
            Number(sculpture.lng)
          )
        )
      : null;
  const distanceLabel =
    distanceMeters === null ? '' : `${formatDistance(distanceMeters, unitSystem)} away`;

  const handleAddToWallet = async () => {
    setNftNotice('');
    setNftError('');
    if (!window.ethereum) {
      setNftNotice(
        `No Web3 extension detected. Import Contract ${sculpture.chain?.contractAddress} · Token #${sculpture.chain?.tokenId} manually in MetaMask or Robinhood Wallet.`
      );
      return;
    }
    setBusyAction('wallet');
    try {
      await switchOrAddRobinhoodNetwork(window.ethereum, config?.chain?.network);
      await window.ethereum.request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC721',
          options: {
            address: sculpture.chain?.contractAddress,
            tokenId: String(sculpture.chain?.tokenId)
          }
        }
      });
      setNftNotice('Added ERC-721 NFT & Robinhood Chain to your connected wallet.');
    } catch (err) {
      setNftError(
        err?.message ||
          `Could not auto-import in this wallet. Contract: ${sculpture.chain?.contractAddress}, Token ID: ${sculpture.chain?.tokenId}`
      );
    } finally {
      setBusyAction('');
    }
  };

  const handleSyncOwner = async () => {
    setNftNotice('');
    setNftError('');
    setBusyAction('sync');
    try {
      const res = await api.syncSculptureOwnership(sculpture.id);
      if (res?.sculpture) {
        setSculpture(res.sculpture);
        onSculptureUpdated?.(res.sculpture);
      }
      setNftNotice(
        res?.simulated
          ? `Ownership verified (${res.ownerAddress}) — pre-deployment ledger mode.`
          : res?.changed
          ? `Synced new on-chain owner: ${res.ownerAddress}`
          : `On-chain owner matches (${res.ownerAddress}).`
      );
    } catch (err) {
      setNftError(err.message || 'Could not sync ownership.');
    } finally {
      setBusyAction('');
    }
  };

  const handleEmbeddedTransfer = async (e) => {
    e.preventDefault();
    setNftNotice('');
    setNftError('');
    if (!isAddress(toAddress.trim())) {
      setNftError('Enter a valid 0x EVM destination address.');
      return;
    }
    setBusyAction('transfer-embedded');
    try {
      const res = await api.transferSculpture(sculpture.id, { toAddress: toAddress.trim() });
      if (res?.sculpture) {
        setSculpture(res.sculpture);
        onSculptureUpdated?.(res.sculpture);
      }
      setToAddress('');
      setNftNotice(`NFT #${sculpture.chain?.tokenId} transferred to ${res.transfer?.toAddress}`);
    } catch (err) {
      setNftError(err.message || 'Transfer failed.');
    } finally {
      setBusyAction('');
    }
  };

  const handleExternalWalletTransfer = async () => {
    setNftNotice('');
    setNftError('');
    if (!isAddress(toAddress.trim())) {
      setNftError('Enter a valid 0x EVM destination address.');
      return;
    }
    if (!window.ethereum) {
      setNftError('MetaMask / Web3 wallet extension is required for external wallet transfers.');
      return;
    }
    setBusyAction('transfer-external');
    try {
      const provider = new BrowserProvider(window.ethereum);
      await provider.send('eth_requestAccounts', []);
      const signer = await provider.getSigner();
      const connectedAddr = await signer.getAddress();
      if (connectedAddr.toLowerCase() !== ownerAddr.toLowerCase()) {
        throw new Error(`Switch MetaMask to current owner ${ownerAddr} (currently ${connectedAddr}).`);
      }

      const dest = toAddress.trim();
      let payload;
      if (!sculpture.chain?.simulated && config?.chain?.liveReady) {
        await switchOrAddRobinhoodNetwork(window.ethereum, config?.chain?.network);
        const contract = new Contract(
          sculpture.chain.contractAddress,
          ERC721_TRANSFER_ABI,
          signer
        );
        const tx = await contract['safeTransferFrom(address,address,uint256)'](
          ownerAddr,
          dest,
          sculpture.chain.tokenId
        );
        const receipt = await tx.wait();
        payload = { toAddress: dest, txHash: receipt.hash };
      } else {
        const msg = buildTransferAuthMessage({
          sculptureId: sculpture.id,
          tokenId: sculpture.chain?.tokenId,
          fromAddress: ownerAddr,
          toAddress: dest,
          contractAddress: sculpture.chain?.contractAddress,
          chainId: sculpture.chain?.chainId
        });
        const signature = await signer.signMessage(msg);
        payload = { toAddress: dest, signature };
      }

      const res = await api.transferSculpture(sculpture.id, payload);
      if (res?.sculpture) {
        setSculpture(res.sculpture);
        onSculptureUpdated?.(res.sculpture);
      }
      setToAddress('');
      setNftNotice(`External wallet transfer confirmed -> ${res.transfer?.toAddress}`);
    } catch (err) {
      setNftError(err.message || 'External wallet transfer failed.');
    } finally {
      setBusyAction('');
    }
  };

  const siblingCount = Math.max(0, placementItems.length - 1);
  const currentSavedScale = extractSculptureScale(sculpture);
  const isCompactViewport = typeof window !== 'undefined' && window.innerWidth <= 640;

  const handleGizmoTransformChange = (patch) => {
    if (!patch || typeof patch !== 'object') return;
    setShowLandBoundsPreview(true);
    if (patch.scale !== undefined && Number.isFinite(Number(patch.scale))) {
      setEditScale(Number(patch.scale));
    }
    if (
      patch.dx !== undefined ||
      patch.dy !== undefined ||
      patch.dz !== undefined ||
      patch.yaw !== undefined ||
      patch.pitch !== undefined ||
      patch.roll !== undefined
    ) {
      setEditOffset((prev) => ({
        dx: patch.dx !== undefined ? Number(patch.dx) : prev.dx,
        dy: patch.dy !== undefined ? Number(patch.dy) : prev.dy,
        dz: patch.dz !== undefined ? Number(patch.dz) : prev.dz,
        yaw: patch.yaw !== undefined ? Number(patch.yaw) : prev.yaw,
        pitch: patch.pitch !== undefined ? tiltToDegrees(patch.pitch) : prev.pitch,
        roll: patch.roll !== undefined ? tiltToDegrees(patch.roll) : prev.roll
      }));
    }
  };

  const effectivePendingBusy = Boolean(pendingApprovalBusy || localPendingBusy);
  const effectivePendingError = pendingApprovalError || localPendingError;

  async function handlePreviewApprove(options = {}) {
    const reqObj = sculpture?.pendingRequest;
    if (!reqObj?.id || effectivePendingBusy) return;
    setLocalPendingError(null);
    if (typeof onApprovePending === 'function') {
      await onApprovePending(reqObj, options);
      return;
    }
    setLocalPendingBusy(true);
    try {
      const autoFitScale = Boolean(options?.autoFitScale);
      const res = await api.mobileSignRequest(reqObj.id, autoFitScale ? { autoFitScale: true } : {});
      notifySettingsSaved(`Approved & minted "${sculpture.title || 'Sculpture'}"!`);
      if (res?.result?.sculpture) {
        onSculptureUpdated?.(res.result.sculpture);
      }
      onClose?.();
    } catch (err) {
      const maxSafe = Number(err?.data?.maxSafeScale ?? err?.data?.suggestedScale ?? 0);
      setLocalPendingError({
        message: err?.message || 'Could not approve transaction.',
        code: String(err?.data?.code || ''),
        maxSafeScale: Number.isFinite(maxSafe) && maxSafe > 0 ? maxSafe : null
      });
    } finally {
      setLocalPendingBusy(false);
    }
  }

  async function handlePreviewReject() {
    const reqObj = sculpture?.pendingRequest;
    if (!reqObj?.id || effectivePendingBusy) return;
    setLocalPendingError(null);
    if (typeof onRejectPending === 'function') {
      await onRejectPending(reqObj);
      return;
    }
    setLocalPendingBusy(true);
    try {
      await api.rejectSignatureRequest(reqObj.id);
      notifySettingsSaved(`Rejected "${sculpture.title || 'Sculpture'}".`);
      onClose?.();
    } catch (err) {
      setLocalPendingError({
        message: err?.message || 'Could not reject transaction.',
        code: '',
        maxSafeScale: null
      });
    } finally {
      setLocalPendingBusy(false);
    }
  }

  const hasLandVolumeForPreview = Boolean(
    placementVolume &&
      Number(placementVolume.widthMeters) > 0 &&
      Number(placementVolume.depthMeters) > 0 &&
      Number(placementVolume.heightMeters) > 0
  );
  const showPendingLandView = isPendingPreview && previewViewMode === 'land' && hasLandVolumeForPreview;
  const pendingExpiryLabel = isPendingPreview
    ? formatPendingExpiry(sculpture.pendingExpiresAt || sculpture.pendingRequest?.expiresAt)
    : '';
  const pendingSizeLabel =
    isPendingPreview && measuredBaseDims
      ? `${formatShortLength(activeScaleDims.w, unitSystem)} × ${formatShortLength(
          activeScaleDims.h,
          unitSystem
        )} × ${formatShortLength(activeScaleDims.d, unitSystem)}`
      : '';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal-card sculpture-modal-card ${
          isPendingPreview ? 'is-pending-preview' : 'is-studio-split'
        }`.trim()}
        data-testid="sculpture-modal"
        data-pending-preview={isPendingPreview ? 'true' : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left Studio Stage (Desktop) / Pinned Top 3D Model Window (Mobile) */}
        <div className="sculpture-modal-sticky-stage" data-testid="sculpture-sticky-stage">
          <div className="modal-header sculpture-modal-header">
            <div className="sculpture-modal-title-group">
              <h2 className="modal-title">
                {isPendingPreview ? (
                  <span className="map-preview-pill" data-testid="preview-modal-badge">
                    Preview
                  </span>
                ) : (
                  <XeroIcon emoji="🧊" size={20} />
                )}
                <span className="sculpture-modal-title-text">{sculpture.title}</span>
              </h2>
              {isPendingPreview ? (
                <span className="preview-header-sub">
                  by <strong>{sculpture.pendingAgentName || 'Paired Agent'}</strong> · on{' '}
                  <strong>{scLandDisplayName}</strong>
                </span>
              ) : (
                (sculpture.creatorUsername || sculpture.creatorName) && (
                  <UserHandleBadge
                    user={{
                      id: sculpture.creatorSub,
                      username: sculpture.creatorUsername,
                      creatorName: sculpture.creatorName,
                      avatarImage: sculpture.creatorAvatar
                    }}
                    fallback="Creator"
                    size="xs"
                  />
                )
              )}
            </div>
            <div className="modal-header-actions sculpture-modal-top-actions">
              <GlobalNotificationBell compact testId="sculpture-modal-notif-bell-btn" />
              {!isPendingPreview && sculpture?.id && (
                <button
                  type="button"
                  className={`btn ${shareLinkCopied ? 'is-copy-confirmed' : ''}`}
                  data-testid="sculpture-header-copy-link-btn"
                  onClick={async () => {
                    const ok = await copyToClipboard(buildSculptureShareUrl(sculpture.id));
                    if (ok) {
                      setShareLinkCopied(true);
                      setTimeout(() => setShareLinkCopied(false), 1800);
                    }
                    setPropNotice(ok ? 'Copied shareable deep link (?sculpture=...)!' : 'Copy unavailable');
                  }}
                  aria-label="Copy direct share link to this sculpture"
                  title="Copy direct share link to this sculpture"
                >
                  {shareLinkCopied ? '✓' : <XeroIcon emoji="📋" size={16} />}
                </button>
              )}
              <button type="button" className="btn" onClick={onClose} aria-label="Close sculpture details">
                <XeroIcon emoji="❌" size={16} />
              </button>
            </div>
          </div>

          <div className="preview-stage-shell">
            <SculptureViewer3D
              sculpture={sculpture}
              voxels={sculpture.voxels || []}
              height={
                isPendingPreview
                  ? isCompactViewport
                    ? 268
                    : 360
                  : isCompactViewport
                  ? 250
                  : 520
              }
              fillHeight={!isPendingPreview}
              autoRotate={isPendingPreview ? previewSpin : !canModifySculpture && studioCameraFocus === 'model'}
              isometricFocus={isPendingPreview ? !showPendingLandView : studioCameraFocus === 'model'}
              cameraFocus={
                isPendingPreview ? (showPendingLandView ? 'land' : 'model') : studioCameraFocus
              }
              resetViewTick={previewResetTick}
              liveTransform={
                isPendingPreview
                  ? previewLiveTransform
                  : canModifySculpture
                  ? viewerLiveTransform
                  : null
              }
              parcelVolume={placementVolume}
              siblingBoxes={viewerSiblingBoxes}
              showLandBounds={
                isPendingPreview
                  ? showPendingLandView
                  : hasLandVolumeForPreview && showLandBoundsPreview
              }
              showEditGizmo={!isPendingPreview && canModifySculpture && showGizmoHandles}
              maxSafeScale={maxSafeScale}
              moveRanges={moveRanges}
              placementBlocked={Boolean(!isPendingPreview && canModifySculpture && livePlacement && !livePlacement.ok)}
              unitSystem={unitSystem}
              cornerTopLeftExtra={
                !isPendingPreview ? (
                  <div className="viewer-corner-subrow">
                    <span className="viewer-corner-pill is-teal mono" data-testid="sculpture-corner-land-pill">
                      <XeroIcon emoji="📍" size={11} /> {scLandDisplayName}
                    </span>
                    {canModifySculpture ? (
                      <span className="viewer-corner-pill mono" data-testid="sculpture-corner-transform-pill">
                        {Number(editScale || 1).toFixed(2)}× · {activeScaleDims.w}×{activeScaleDims.h}×{activeScaleDims.d}m · Yaw{' '}
                        {Math.round(Number(editOffset.yaw || 0))}°
                      </span>
                    ) : (
                      <span className="viewer-corner-pill mono">
                        {activeScaleDims.w}×{activeScaleDims.h}×{activeScaleDims.d}m
                      </span>
                    )}
                  </div>
                ) : null
              }
              cornerTopRight={
                !isPendingPreview ? (
                  <div className="viewer-corner-stats" data-testid="sculpture-corner-stats">
                    {sculpture.modelType === 'custom-3d' && sculpture.customModel ? (
                      <span className="viewer-corner-pill is-teal mono">
                        <XeroIcon emoji="🗿" size={11} /> {String(sculpture.customModel.format || 'glb').toUpperCase()}
                        {sculpture.meshStats?.triangleCount > 0 &&
                          ` · ${sculpture.meshStats.triangleCount.toLocaleString()} tris`}
                        {sculpture.meshStats?.hasDraco && ' · Draco'}
                        {sculpture.meshStats?.hasMeshopt && ' · Meshopt'}
                      </span>
                    ) : (
                      <span className="viewer-corner-pill mono">
                        <XeroIcon emoji="🧱" size={11} /> {sculpture.voxelCount} voxels
                      </span>
                    )}
                    <span className="viewer-corner-pill is-teal mono">v{sculpture.currentRev || 1}</span>
                    {sculpture.polScore != null && (
                      <span className="viewer-corner-pill is-gold mono">
                        <XeroIcon emoji="✅" size={11} /> PoL {sculpture.polScore}/100
                      </span>
                    )}
                    <span className="viewer-corner-pill is-pink mono">
                      <XeroIcon emoji="🪙" size={11} /> {sculpture.chain?.royaltyPercent || 5}% Fee
                    </span>
                    <span
                      className={`viewer-corner-pill ${
                        sculpture.layerRole === 'steward_stage' ? 'is-gold' : 'is-teal'
                      }`}
                    >
                      {sculpture.layerRole === 'steward_stage'
                        ? '🤖 Steward Stage'
                        : sculpture.qualifiesForContributorPool !== false
                        ? '🎨 2% Pool'
                        : '🌱 Micro (<3)'}
                    </span>
                    {Math.abs(currentSavedScale - 1) > 0.01 && (
                      <span className="viewer-corner-pill is-gold mono" data-testid="sculpture-scale-badge">
                        📐 {currentSavedScale.toFixed(2)}×
                      </span>
                    )}
                    {(sculpture.anchorOffset?.dx ||
                      sculpture.anchorOffset?.dy ||
                      sculpture.anchorOffset?.dz ||
                      sculpture.anchorOffset?.yaw) ? (
                      <span className="viewer-corner-pill mono">
                        📌 {sculpture.anchorOffset.dx}, {sculpture.anchorOffset.dy}, {sculpture.anchorOffset.dz}m
                      </span>
                    ) : null}
                    {sculpture.hidden && (
                      <span className="viewer-corner-pill is-danger">🙈 Hidden</span>
                    )}
                    {parcelFrozen && (
                      <span className="viewer-corner-pill is-danger">❄️ Frozen</span>
                    )}
                    {isLandOwner && !isPropertyOwner && (
                      <span className="viewer-corner-pill is-gold">🏠 Land Owner</span>
                    )}
                    {isContributor && (
                      <span className="viewer-corner-pill is-gold">🤝 Contributor</span>
                    )}
                  </div>
                ) : null
              }
              cornerBottomLeft={
                !isPendingPreview ? (
                  <div className="viewer-corner-controls" data-testid="sculpture-camera-controls">
                    <button
                      type="button"
                      className={`viewer-corner-btn ${studioCameraFocus === 'model' ? 'is-active' : ''}`}
                      data-testid="sculpture-focus-model-btn"
                      onClick={() => {
                        setStudioCameraFocus('model');
                        setPreviewResetTick((t) => t + 1);
                      }}
                      title="Zoom inside the land to fill the view with this model"
                    >
                      🎯 Focus Model
                    </button>
                    {hasLandVolumeForPreview && (
                      <button
                        type="button"
                        className={`viewer-corner-btn ${
                          studioCameraFocus === 'land' && showLandBoundsPreview ? 'is-active' : ''
                        }`}
                        data-testid="sculpture-fit-land-btn"
                        onClick={() => {
                          setShowLandBoundsPreview(true);
                          setStudioCameraFocus('land');
                          setPreviewResetTick((t) => t + 1);
                        }}
                        title="Pull back to see the full Virtual Land envelope"
                      >
                        📦 Fit Land
                      </button>
                    )}
                    {hasLandVolumeForPreview && (
                      <button
                        type="button"
                        className={`viewer-corner-btn ${showLandBoundsPreview ? 'is-active' : ''}`}
                        data-testid="sculpture-land-preview-toggle"
                        onClick={() => setShowLandBoundsPreview((v) => !v)}
                        title="Toggle 3D Land Bounds & neighboring items wireframe"
                      >
                        {showLandBoundsPreview ? '🧱 Bounds: ON' : '🧱 Bounds'}
                      </button>
                    )}
                    {canModifySculpture && (
                      <button
                        type="button"
                        className={`viewer-corner-btn ${showGizmoHandles ? 'is-active' : ''}`}
                        data-testid="sculpture-gizmo-toggle"
                        onClick={() => setShowGizmoHandles((v) => !v)}
                        title="Toggle 3D drag bars & corner points on artwork"
                      >
                        {showGizmoHandles ? '🎛️ Gizmo: ON' : '🎛️ Gizmo'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="viewer-corner-btn"
                      data-testid="sculpture-cam-reset-btn"
                      onClick={() => setPreviewResetTick((t) => t + 1)}
                      title="Re-center current camera focus (or double-click model)"
                    >
                      ↺
                    </button>
                  </div>
                ) : null
              }
              onModelBoundsMeasured={handleMeasuredBounds}
              onTransformChange={!isPendingPreview && canModifySculpture ? handleGizmoTransformChange : null}
            />

            {isPendingPreview && (
              <div className="preview-stage-toolbar" data-testid="preview-camera-toolbar">
                <div className="preview-stage-mode-group" role="group" aria-label="Preview camera view">
                  <button
                    type="button"
                    className={`preview-stage-chip ${!showPendingLandView ? 'is-active' : ''}`}
                    data-testid="preview-cam-iso-btn"
                    onClick={() => {
                      setPreviewViewMode('isometric');
                      setPreviewResetTick((t) => t + 1);
                    }}
                    title="Zoomed-in isometric view of the model"
                  >
                    🧊 Isometric
                  </button>
                  {hasLandVolumeForPreview && (
                    <button
                      type="button"
                      className={`preview-stage-chip ${showPendingLandView ? 'is-active' : ''}`}
                      data-testid="preview-cam-land-btn"
                      onClick={() => setPreviewViewMode('land')}
                      title="See where this model sits inside your land boundaries"
                    >
                      📦 On Land
                    </button>
                  )}
                </div>
                <div className="preview-stage-util-group">
                  <button
                    type="button"
                    className={`preview-stage-chip ${previewSpin ? 'is-active' : ''}`}
                    data-testid="preview-cam-spin-btn"
                    onClick={() => setPreviewSpin((s) => !s)}
                    title={previewSpin ? 'Pause turntable spin' : 'Slowly spin model'}
                  >
                    🔄 {previewSpin ? 'Spinning' : 'Spin'}
                  </button>
                  <button
                    type="button"
                    className="preview-stage-chip"
                    data-testid="preview-cam-reset-btn"
                    onClick={() => setPreviewResetTick((t) => t + 1)}
                    title="Reset isometric framing"
                  >
                    ↺ Reset
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Scrollable Modifiers & Details Body — Slides behind the pinned 3D model window */}
        <div
          className={`sculpture-modal-scroll-body ${
            isPendingPreview ? 'is-pending-preview-body' : ''
          }`.trim()}
          data-testid="sculpture-scroll-body"
        >
        {isPendingPreview ? (
          <div
            className="preview-approval-modal-card"
            data-testid="sculpture-preview-approval-bar"
          >
            <div className="preview-meta-strip">
              <span className="preview-meta-chip is-gold">⏳ Needs Approval</span>
              <span className="preview-meta-chip mono">
                {sculpture.modelType === 'custom-3d'
                  ? `${String(sculpture.customModel?.format || '3D').toUpperCase()} · ${Number(
                      sculpture.customModel?.scale || 1
                    )}×`
                  : `${sculpture.voxelCount || sculpture.voxels?.length || 0} blocks`}
              </span>
              {pendingSizeLabel && (
                <span className="preview-meta-chip mono" title="Estimated 3D dimensions">
                  📐 {pendingSizeLabel}
                </span>
              )}
              {pendingExpiryLabel && (
                <span className="preview-meta-chip mono">{pendingExpiryLabel}</span>
              )}
              <span className="preview-meta-hint">Drag to orbit · Scroll/pinch to zoom</span>
            </div>

            {sculpture.description && (
              <p className="preview-approval-desc">{sculpture.description}</p>
            )}

            {effectivePendingError?.message && (
              <div
                className="approval-inline-error"
                data-testid="preview-modal-approval-error"
                role="alert"
                style={{ marginTop: 8 }}
              >
                <div className="approval-inline-error-msg">⚠️ {effectivePendingError.message}</div>
                {effectivePendingError.code === 'exceeds_land_bounds' &&
                  Number(effectivePendingError.maxSafeScale) >= 0.001 && (
                    <button
                      type="button"
                      className="btn btn-xs btn-primary"
                      data-testid="preview-modal-autofit-btn"
                      disabled={effectivePendingBusy}
                      onClick={() => handlePreviewApprove({ autoFitScale: true })}
                    >
                      {effectivePendingBusy
                        ? 'Fitting & Minting…'
                        : `📐 Auto-Fit (${effectivePendingError.maxSafeScale}×) & Approve`}
                    </button>
                  )}
              </div>
            )}

            <div className="preview-approval-modal-actions">
              <button
                type="button"
                className="btn btn-primary preview-approve-primary-btn"
                data-testid="preview-modal-approve-btn"
                disabled={effectivePendingBusy}
                onClick={() => handlePreviewApprove()}
              >
                {effectivePendingBusy ? 'Approving & Minting…' : '✅ Approve & Mint'}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                data-testid="preview-modal-reject-btn"
                disabled={effectivePendingBusy}
                onClick={handlePreviewReject}
              >
                {effectivePendingBusy ? 'Working…' : '✕ Reject'}
              </button>
              {onSelectParcel && sculpture.parcelId && (
                <button
                  type="button"
                  className="btn btn-ghost preview-open-land-btn"
                  data-testid="preview-modal-open-land-btn"
                  onClick={() => {
                    const pid = sculpture.parcelId;
                    const found =
                      (allParcels || []).find(
                        (p) => String(p?.parcelId || '').toUpperCase() === String(pid).toUpperCase()
                      ) ||
                      parcelDetail || { parcelId: pid };
                    onClose?.();
                    onSelectParcel(found);
                  }}
                >
                  📍 Open Land →
                </button>
              )}
            </div>
          </div>
        ) : (
        <>
        {/* Immediate Logged-In Artwork Studio (Modify, Scale, Move, Rotate, Hide & Remove) */}
        {canModifySculpture ? (
          <div className="card sculpture-transform-studio" data-testid="sculpture-transform-studio">
            <div className="sculpture-studio-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 13.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <XeroIcon emoji="🎛️" size={15} /> Modify, Scale &amp; Move Artwork
                </strong>
                <span className="badge gold" style={{ fontSize: 10 }}>
                  {isPropertyOwner ? 'Owner' : isLandOwner ? 'Land Owner' : 'Contributor'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-xs"
                  data-testid="sculpture-studio-toggle"
                  aria-expanded={studioOpen}
                  onClick={() => setStudioOpen((v) => !v)}
                >
                  {studioOpen ? '▾ Hide Sliders' : '▴ Open Sliders'}
                </button>
              </div>
            </div>

            {studioOpen && (
              <form onSubmit={handleSaveSculptureEdit} noValidate className="sculpture-studio-form">
                {/* Live Scale Controls */}
                <div className="sculpture-transform-block">
                  <div className="sculpture-transform-row-head">
                    <label htmlFor="sculpture-scale-slider" style={{ fontWeight: 700, fontSize: 12 }}>
                      📐 Scale ({Number(editScale || 1).toFixed(2)}×)
                    </label>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {activeScaleDims.w}×{activeScaleDims.h}×{activeScaleDims.d}m inside{' '}
                      {Math.round(placementVolume.widthMeters * 10) / 10}×
                      {Math.round(placementVolume.depthMeters * 10) / 10}×
                      {Math.round(placementVolume.heightMeters * 10) / 10}m land (max safe{' '}
                      {maxSafeScale.toFixed(2)}×)
                    </span>
                  </div>
                  <div className="sculpture-slider-line">
                    <input
                      id="sculpture-scale-slider"
                      type="range"
                      data-testid="sculpture-scale-slider"
                      aria-label="Scale artwork"
                      min={MIN_ARTWORK_SCALE}
                      max={Math.max(MIN_ARTWORK_SCALE + 0.1, maxSafeScale)}
                      step="0.05"
                      value={Math.min(Math.max(MIN_ARTWORK_SCALE, Number(editScale || 1)), Math.max(MIN_ARTWORK_SCALE + 0.1, maxSafeScale))}
                      onChange={(e) => {
                        setShowLandBoundsPreview(true);
                        setEditScale(Number(e.target.value));
                      }}
                    />
                    <input
                      type="number"
                      className="input mono sculpture-num-input"
                      data-testid="sculpture-scale-input"
                      aria-label="Scale multiplier"
                      min={MIN_ARTWORK_SCALE}
                      max={Math.max(60, maxScaleForLand)}
                      step="any"
                      value={editScale}
                      onChange={(e) => {
                        setShowLandBoundsPreview(true);
                        setEditScale(Number(e.target.value || MIN_ARTWORK_SCALE));
                      }}
                    />
                  </div>
                  <div className="sculpture-scale-presets">
                    {[0.5, 1, 1.5, 2].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className={`btn btn-xs ${
                          Math.abs(Number(editScale) - preset) < 0.03 ? 'btn-primary' : ''
                        }`}
                        disabled={preset > maxSafeScale + 0.001}
                        onClick={() => {
                          setShowLandBoundsPreview(true);
                          setEditScale(preset);
                        }}
                      >
                        {preset}×
                      </button>
                    ))}
                    <button
                      type="button"
                      className="btn btn-xs btn-outline"
                      data-testid="sculpture-fit-max-scale-btn"
                      onClick={() => {
                        setShowLandBoundsPreview(true);
                        setEditScale(maxSafeScale);
                      }}
                    >
                      ✨ Max Safe ({maxSafeScale.toFixed(2)}×)
                    </button>
                  </div>
                </div>

                {/* Move Position (X, Z, Y) & Rotate Sliders */}
                <div className="sculpture-move-grid">
                  <label className="sculpture-axis-control">
                    <div className="sculpture-axis-label">
                      <span>↔ Move X (East/West)</span>
                      <span className="mono">{Number(editOffset.dx || 0).toFixed(2)} m</span>
                    </div>
                    <div className="sculpture-slider-line">
                      <input
                        type="range"
                        data-testid="sculpture-move-dx"
                        aria-label="Move X East West"
                        min={moveRanges.minDx}
                        max={moveRanges.maxDx}
                        step="0.1"
                        value={Math.min(moveRanges.maxDx, Math.max(moveRanges.minDx, Number(editOffset.dx || 0)))}
                        onChange={(e) => {
                          setShowLandBoundsPreview(true);
                          setEditOffset((p) => ({ ...p, dx: Number(e.target.value) }));
                        }}
                      />
                      <input
                        type="number"
                        className="input mono sculpture-num-input"
                        aria-label="dx (m)"
                        step="any"
                        value={editOffset.dx}
                        onChange={(e) => {
                          setShowLandBoundsPreview(true);
                          setEditOffset((p) => ({ ...p, dx: Number(e.target.value || 0) }));
                        }}
                      />
                    </div>
                  </label>

                  <label className="sculpture-axis-control">
                    <div className="sculpture-axis-label">
                      <span>↕ Move Z (North/South)</span>
                      <span className="mono">{Number(editOffset.dz || 0).toFixed(2)} m</span>
                    </div>
                    <div className="sculpture-slider-line">
                      <input
                        type="range"
                        data-testid="sculpture-move-dz"
                        aria-label="Move Z North South"
                        min={moveRanges.minDz}
                        max={moveRanges.maxDz}
                        step="0.1"
                        value={Math.min(moveRanges.maxDz, Math.max(moveRanges.minDz, Number(editOffset.dz || 0)))}
                        onChange={(e) => {
                          setShowLandBoundsPreview(true);
                          setEditOffset((p) => ({ ...p, dz: Number(e.target.value) }));
                        }}
                      />
                      <input
                        type="number"
                        className="input mono sculpture-num-input"
                        aria-label="dz (m)"
                        step="any"
                        value={editOffset.dz}
                        onChange={(e) => {
                          setShowLandBoundsPreview(true);
                          setEditOffset((p) => ({ ...p, dz: Number(e.target.value || 0) }));
                        }}
                      />
                    </div>
                  </label>

                  <label className="sculpture-axis-control">
                    <div className="sculpture-axis-label">
                      <span>⬆️ Height Y (Elevation)</span>
                      <span className="mono">{Number(editOffset.dy || 0).toFixed(2)} m</span>
                    </div>
                    <div className="sculpture-slider-line">
                      <input
                        type="range"
                        data-testid="sculpture-move-dy"
                        aria-label="Move Y Height"
                        min={0}
                        max={Math.max(0.5, moveRanges.maxDy)}
                        step="0.1"
                        value={Math.min(Math.max(0.5, moveRanges.maxDy), Math.max(0, Number(editOffset.dy || 0)))}
                        onChange={(e) => {
                          setShowLandBoundsPreview(true);
                          setEditOffset((p) => ({ ...p, dy: Number(e.target.value) }));
                        }}
                      />
                      <input
                        type="number"
                        className="input mono sculpture-num-input"
                        aria-label="dy (m)"
                        step="any"
                        value={editOffset.dy}
                        onChange={(e) => {
                          setShowLandBoundsPreview(true);
                          setEditOffset((p) => ({ ...p, dy: Number(e.target.value || 0) }));
                        }}
                      />
                    </div>
                  </label>

                  <label className="sculpture-axis-control">
                    <div className="sculpture-axis-label">
                      <span>↻ Rotate (Yaw)</span>
                      <span className="mono">{Math.round(Number(editOffset.yaw || 0))}°</span>
                    </div>
                    <div className="sculpture-slider-line">
                      <input
                        type="range"
                        data-testid="sculpture-rotate-yaw"
                        aria-label="Rotate Yaw Degrees"
                        min={-180}
                        max={180}
                        step="5"
                        value={Math.min(180, Math.max(-180, Number(editOffset.yaw || 0)))}
                        onChange={(e) => {
                          setShowLandBoundsPreview(true);
                          setEditOffset((p) => ({ ...p, yaw: Number(e.target.value) }));
                        }}
                      />
                      <input
                        type="number"
                        className="input mono sculpture-num-input"
                        aria-label="yaw (°)"
                        step="15"
                        value={editOffset.yaw}
                        onChange={(e) => {
                          setShowLandBoundsPreview(true);
                          setEditOffset((p) => ({ ...p, yaw: Number(e.target.value || 0) }));
                        }}
                      />
                    </div>
                  </label>

                  <label className="sculpture-axis-control">
                    <div className="sculpture-axis-label">
                      <span>↕ Tilt Vertical (Pitch X)</span>
                      <span className="mono">{Math.round(Number(editOffset.pitch || 0))}°</span>
                    </div>
                    <div className="sculpture-slider-line">
                      <input
                        type="range"
                        data-testid="sculpture-rotate-pitch"
                        aria-label="Tilt Vertical Pitch X Degrees"
                        min={-180}
                        max={180}
                        step="5"
                        value={Math.min(180, Math.max(-180, Number(editOffset.pitch || 0)))}
                        onChange={(e) => {
                          setShowLandBoundsPreview(true);
                          setEditOffset((p) => ({ ...p, pitch: Number(e.target.value) }));
                        }}
                      />
                      <input
                        type="number"
                        className="input mono sculpture-num-input"
                        data-testid="sculpture-rotate-pitch-input"
                        aria-label="pitch (°)"
                        min={-180}
                        max={180}
                        step="5"
                        value={editOffset.pitch}
                        onChange={(e) => {
                          setShowLandBoundsPreview(true);
                          setEditOffset((p) => ({ ...p, pitch: tiltToDegrees(e.target.value || 0) }));
                        }}
                      />
                    </div>
                  </label>

                  <label className="sculpture-axis-control">
                    <div className="sculpture-axis-label">
                      <span>🔄 Tilt Sideways (Roll Z)</span>
                      <span className="mono">{Math.round(Number(editOffset.roll || 0))}°</span>
                    </div>
                    <div className="sculpture-slider-line">
                      <input
                        type="range"
                        data-testid="sculpture-rotate-roll"
                        aria-label="Tilt Sideways Roll Z Degrees"
                        min={-180}
                        max={180}
                        step="5"
                        value={Math.min(180, Math.max(-180, Number(editOffset.roll || 0)))}
                        onChange={(e) => {
                          setShowLandBoundsPreview(true);
                          setEditOffset((p) => ({ ...p, roll: Number(e.target.value) }));
                        }}
                      />
                      <input
                        type="number"
                        className="input mono sculpture-num-input"
                        data-testid="sculpture-rotate-roll-input"
                        aria-label="roll (°)"
                        min={-180}
                        max={180}
                        step="5"
                        value={editOffset.roll}
                        onChange={(e) => {
                          setShowLandBoundsPreview(true);
                          setEditOffset((p) => ({ ...p, roll: tiltToDegrees(e.target.value || 0) }));
                        }}
                      />
                    </div>
                  </label>
                </div>

                {/* Vertical Tilt Presets & Live Vertical Height Measurement Bar */}
                <div
                  className="sculpture-vertical-measure-bar"
                  data-testid="sculpture-vertical-measure-readout"
                >
                  <div className="sculpture-vertical-measure-stats">
                    <strong>
                      📏 Vertical Height:{' '}
                      <span className="mono" data-testid="sculpture-vertical-height-value">
                        {formatShortLength(activeScaleDims.h, unitSystem)}
                      </span>
                    </strong>
                    <span className="mono sculpture-vertical-dims-sub">
                      ({activeScaleDims.w}m W × {activeScaleDims.h}m H × {activeScaleDims.d}m D ·
                      ceiling {formatShortLength(placementVolume.heightMeters, unitSystem)})
                    </span>
                  </div>
                  <div className="sculpture-vertical-presets">
                    <button
                      type="button"
                      className={`btn btn-xs ${
                        Math.abs(Number(editOffset.pitch || 0) - 90) < 1 &&
                        Math.abs(Number(editOffset.roll || 0)) < 1
                          ? 'btn-primary'
                          : ''
                      }`}
                      data-testid="sculpture-stand-vertical-x-btn"
                      onClick={() => {
                        setShowLandBoundsPreview(true);
                        setEditOffset((p) => ({ ...p, pitch: 90, roll: 0 }));
                      }}
                      title="Stand sculpture upright 90° around X axis to measure vertical height"
                    >
                      ↕ Stand Vertical (+90° X)
                    </button>
                    <button
                      type="button"
                      className={`btn btn-xs ${
                        Math.abs(Number(editOffset.roll || 0) - 90) < 1 &&
                        Math.abs(Number(editOffset.pitch || 0)) < 1
                          ? 'btn-primary'
                          : ''
                      }`}
                      data-testid="sculpture-stand-vertical-z-btn"
                      onClick={() => {
                        setShowLandBoundsPreview(true);
                        setEditOffset((p) => ({ ...p, pitch: 0, roll: 90 }));
                      }}
                      title="Stand sculpture upright 90° around Z axis to measure side length vertically"
                    >
                      ↕ Stand Side (+90° Z)
                    </button>
                    <button
                      type="button"
                      className={`btn btn-xs ${
                        Math.abs(Number(editOffset.pitch || 0)) < 1 &&
                        Math.abs(Number(editOffset.roll || 0)) < 1
                          ? 'btn-primary'
                          : ''
                      }`}
                      data-testid="sculpture-level-flat-btn"
                      onClick={() => {
                        setShowLandBoundsPreview(true);
                        setEditOffset((p) => ({ ...p, pitch: 0, roll: 0 }));
                      }}
                      title="Reset vertical tilt (Pitch & Roll) back to 0°"
                    >
                      📐 Level Flat (0°)
                    </button>
                  </div>
                </div>

                {/* Live Collision & Bounds Status Pill */}
                {livePlacement && (
                  <div
                    className={`sculpture-placement-status ${
                      !livePlacement.ok
                        ? 'is-blocked'
                        : livePlacement.pushedSiblings?.length > 0
                        ? 'is-pushing'
                        : 'is-clear'
                    }`}
                    data-testid={
                      !livePlacement.ok
                        ? 'sculpture-placement-blocked'
                        : 'sculpture-placement-status'
                    }
                    role={!livePlacement.ok ? 'alert' : 'status'}
                  >
                    {!livePlacement.ok ? (
                      <>
                        <span>⛔ {livePlacement.message}</span>
                        <button
                          type="button"
                          className="btn btn-xs btn-primary"
                          onClick={() => setEditScale(maxSafeScale)}
                        >
                          Fit Max Safe ({maxSafeScale.toFixed(2)}×)
                        </button>
                      </>
                    ) : livePlacement.pushedSiblings?.length > 0 ? (
                      <span>
                        ↔️ Gently shifts {livePlacement.pushedSiblings.length} neighboring artwork
                        {livePlacement.pushedSiblings.length === 1 ? '' : 's'} (
                        {livePlacement.pushedSiblings.map((p) => p.title).join(', ')}) — zero
                        overlap, all kept inside &ldquo;{scLandDisplayName}&rdquo;.
                      </span>
                    ) : (
                      <span>
                        ✅ Fits cleanly inside &ldquo;{scLandDisplayName}&rdquo;
                        {siblingCount > 0
                          ? ` — ${siblingCount} other placed item${siblingCount === 1 ? '' : 's'} untouched`
                          : ''}
                        .
                      </span>
                    )}
                  </div>
                )}

                {/* Title & Description Modification */}
                <div className="sculpture-meta-edit-row">
                  <EmojiInput
                    className="input"
                    aria-label="Artwork title"
                    maxLength={48}
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Sculpture title (type : for emojis)"
                  />
                  <EmojiTextarea
                    className="textarea"
                    aria-label="Artwork description"
                    rows={2}
                    maxLength={240}
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    placeholder="Description (type : for emojis)"
                  />
                </div>

                {/* Primary Studio Actions: Save, Reset, Modify Voxels, Hide, Remove */}
                <div className="sculpture-studio-actions">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    data-testid="sculpture-save-transform-btn"
                    disabled={propBusy !== '' || Boolean(livePlacement && !livePlacement.ok)}
                  >
                    <XeroIcon emoji="💾" size={14} />{' '}
                    {propBusy === 'save' ? 'Saving…' : 'Save Artwork Changes'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    data-testid="sculpture-reset-transform-btn"
                    disabled={propBusy !== ''}
                    onClick={() => {
                      setEditOffset({ dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, roll: 0 });
                      setEditScale(1);
                    }}
                  >
                    ↺ Center &amp; 1×
                  </button>
                  {onModifyInCanvas && sculpture.modelType !== 'custom-3d' && (
                    <button
                      type="button"
                      className="btn"
                      disabled={propBusy !== ''}
                      onClick={() => {
                        onClose?.();
                        onModifyInCanvas(sculpture);
                      }}
                    >
                      <XeroIcon emoji="🖌️" size={14} /> Modify 3D Blocks on AR Canvas
                    </button>
                  )}
                  {canModerateLand && (
                    <button
                      type="button"
                      className="btn"
                      data-testid="sculpture-visibility-btn"
                      disabled={propBusy !== ''}
                      onClick={handleToggleSculptureVisibility}
                    >
                      {sculpture.hidden ? '👁️ Unhide Artwork' : '🙈 Hide Artwork'}
                    </button>
                  )}
                  {canModerateLand &&
                    (confirmRemove ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <button
                          type="button"
                          className="btn btn-danger"
                          data-testid="sculpture-confirm-remove-btn"
                          disabled={propBusy !== ''}
                          onClick={handleDeleteOwnedSculpture}
                        >
                          {propBusy === 'delete' ? 'Removing…' : 'Confirm Remove'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={propBusy !== ''}
                          onClick={() => setConfirmRemove(false)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-danger"
                        data-testid="sculpture-remove-btn"
                        disabled={propBusy !== ''}
                        onClick={() => setConfirmRemove(true)}
                      >
                        <XeroIcon emoji="🗑️" size={14} /> Remove Artwork
                      </button>
                    ))}
                </div>

                {propNotice && (
                  <div
                    className="mono settings-inline-saved"
                    data-testid="sculpture-save-notice"
                    role="status"
                  >
                    ✅ {propNotice}
                  </div>
                )}
                {propError && (
                  <div className="mono" role="alert" style={{ fontSize: 12, color: 'var(--danger, #ff5e7e)' }}>
                    {propError}
                  </div>
                )}
              </form>
            )}
          </div>
        ) : !user && onRequestLogin ? (
          <div className="sculpture-guest-signin-bar" data-testid="sculpture-guest-signin-bar">
            <span>🔐 Sign in to modify, scale, move, or remove artworks you own.</span>
            <button
              type="button"
              className="btn btn-xs btn-primary"
              data-testid="sculpture-signin-btn"
              onClick={onRequestLogin}
            >
              Sign In
            </button>
          </div>
        ) : null}

        {/* Compact Share, Navigation & Chain Action Bar (model stats live in 3D view corners) */}
        <div className="sculpture-quick-actions-row">
          {googleMapsUrl && (
            <a
              className="btn btn-sm btn-primary"
              href={googleMapsUrl}
              target="_blank"
              rel="noreferrer"
            >
              <XeroIcon emoji="🧭" size={14} />
              <span>
                Navigate{distanceLabel ? ` · ${distanceLabel}` : ''}
              </span>
            </a>
          )}
          <a
            className="btn btn-sm"
            href={buildShareToXUrl({
              title: sculpture.title,
              landName: scLandDisplayName,
              parcelId: sculpture.parcelId,
              sculptureId: sculpture.id
            })}
            target="_blank"
            rel="noreferrer"
            title="Share this Virtual Land sculpture to X"
          >
            𝕏 Share
          </a>
          {explorerTxUrl ? (
            <a className="btn btn-sm" href={explorerTxUrl} target="_blank" rel="noreferrer">
              <XeroIcon emoji="⛓️" size={13} />
              <span>Tx {sculpture.chain?.txHash?.slice(0, 10)}...</span>
            </a>
          ) : sculpture.chain?.txHash ? (
            <span className="badge">
              <XeroIcon emoji="⛓️" size={12} />{' '}
              {chainLinks.isSimulated ? 'Pre-chain' : 'Tx'} {sculpture.chain.txHash.slice(0, 10)}...
            </span>
          ) : null}
        </div>

        {!canModifySculpture && sculpture.description && (
          <p style={{ fontSize: 13.5, lineHeight: 1.5, margin: '4px 0 8px' }}>{sculpture.description}</p>
        )}

        <div className="sculpture-detail-cards-grid">
          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <XeroIcon emoji="🗺️" size={18} /> Location &amp; Virtual Land ({scLandDisplayName})
            </div>
            {hasCoords && (
              <div
                className="mini-land-map-wrap"
                data-testid="mini-land-map-wrap"
                data-boundary-source={miniMapBoundary.hasVolumeBoundary ? 'volume' : 'bounds'}
              >
                <div className="mini-land-map-stage">
                  <div ref={landMapHostRef} className="mini-land-map" />
                </div>
                <div className="mini-land-map-caption">
                  <span>
                    <XeroIcon emoji="🗺️" size={11} /> {scLandDisplayName}
                  </span>
                  {miniMapBoundary.sw && (
                    <span className="mono" data-testid="mini-land-map-sw">
                      SW {miniMapBoundary.sw[0].toFixed(5)},{miniMapBoundary.sw[1].toFixed(5)}
                    </span>
                  )}
                </div>
              </div>
            )}
            <table className="kv-table">
              <tbody>
                <tr>
                  <th>Place</th>
                  <td>{geo.displayName || sculpture.placeName || 'N/A'}</td>
                </tr>
                <tr>
                  <th>Coordinates</th>
                  <td className="mono">{sculpture.lat}, {sculpture.lng}</td>
                </tr>
                <tr>
                  <th>Virtual Land</th>
                  <td>{scLandDisplayName}</td>
                </tr>
                <tr>
                  <th>GPS Accuracy / Alt</th>
                  <td className="mono">
                    ±
                    {sculpture.accuracy != null
                      ? formatShortLength(sculpture.accuracy, unitSystem, { decimals: 0, compact: true })
                      : '—'}{' '}
                    ·{' '}
                    {elevation.anchorAltitudeMeters != null
                      ? `${formatShortLength(elevation.anchorAltitudeMeters, unitSystem, { decimals: 1, compact: true })} alt`
                      : sculpture.altitude != null
                        ? `${formatShortLength(sculpture.altitude, unitSystem, { decimals: 0, compact: true })} alt`
                        : 'n/a'}
                    {elevation.altitudeAccuracyMeters != null
                      ? ` (±${formatShortLength(elevation.altitudeAccuracyMeters, unitSystem, { decimals: 0, compact: true })})`
                      : ''}
                  </td>
                </tr>
                {(elevation.terrainElevationMeters != null ||
                  elevation.heightAboveGroundMeters != null ||
                  elevation.sculptureVerticalMaxM > elevation.sculptureVerticalMinM) && (
                  <tr>
                    <th>Elevation / Span</th>
                    <td className="mono">
                      {elevation.terrainElevationMeters != null
                        ? `${Math.round(elevation.terrainElevationMeters)}m ground`
                        : elevation.altitudeSource || 'sensor'}
                      {elevation.heightAboveGroundMeters != null
                        ? ` · ${elevation.heightAboveGroundMeters >= 0 ? '+' : ''}${elevation.heightAboveGroundMeters}m AGL`
                        : ''}
                      {Number.isFinite(elevation.sculptureVerticalMinM) &&
                      Number.isFinite(elevation.sculptureVerticalMaxM)
                        ? ` · ${elevation.sculptureVerticalMinM}m..${elevation.sculptureVerticalMaxM}m Y`
                        : ''}
                    </td>
                  </tr>
                )}
                <tr>
                  <th>Compass / Timezone</th>
                  <td className="mono">
                    {sculpture.heading != null ? `${Math.round(sculpture.heading)}°` : 'n/a'} · {sculpture.timezone}
                  </td>
                </tr>
                <tr>
                  <th>Solar Regime</th>
                  <td className="mono">
                    {solar.regime || '—'} ({solar.solarAltitudeDeg ?? '—'}° el
                    {solar.solarAzimuthDeg != null ? ` / ${solar.solarAzimuthDeg}° az` : ''})
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <XeroIcon emoji="📷" size={18} /> Camera + GPS Proof of Location
            </div>
            <table className="kv-table">
              <tbody>
                <tr>
                  <th>Camera-Gyro Flow</th>
                  <td className="mono">{Math.round((sensors.opticalFlowCorrelation || 0) * 100)}% match</td>
                </tr>
                <tr>
                  <th>Horizon Luminance</th>
                  <td className="mono">{sensors.horizonLuminance ?? '—'} / 255</td>
                </tr>
                <tr>
                  <th>Visual dHash</th>
                  <td className="mono">{sensors.visualDHash || '—'}</td>
                </tr>
                <tr>
                  <th>Ambient Palette</th>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {(sensors.ambientPalette || []).map((c, idx) => (
                        <span
                          key={idx}
                          title={c}
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: 4,
                            background: c,
                            border: '1px solid rgba(255,255,255,0.25)'
                          }}
                        />
                      ))}
                    </div>
                  </td>
                </tr>
                <tr>
                  <th>Sensors</th>
                  <td className="mono">
                    {sensors.cameraFrames || 0} cam · {sensors.gyroSamples || 0} gyro · {sensors.gpsSampleCount || 1} gps
                  </td>
                </tr>
                <tr>
                  <th>Proof Hash</th>
                  <td className="mono" style={{ wordBreak: 'break-all', fontSize: 10 }}>
                    {sculpture.proofHash}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" style={{ padding: 12, marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <XeroIcon emoji="💎" size={18} /> IPFS, 3D GLB &amp; Robinhood Chain NFT
          </div>
          <table className="kv-table">
            <tbody>
              <tr>
                <th>Network</th>
                <td className="mono">{sculpture.chain?.chainName} (Chain ID {sculpture.chain?.chainId})</td>
              </tr>
              <tr>
                <th>Current Owner</th>
                <td className="mono" style={{ wordBreak: 'break-all' }}>{ownerAddr}</td>
              </tr>
              <tr>
                <th>Token ID / Contract</th>
                <td className="mono" style={{ wordBreak: 'break-all' }}>
                  #{sculpture.chain?.tokenId} ·{' '}
                  {explorerContractUrl ? (
                    <a
                      href={explorerContractUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: 'var(--accent)' }}
                    >
                      {sculpture.chain?.contractAddress}
                    </a>
                  ) : (
                    sculpture.chain?.contractAddress
                  )}
                </td>
              </tr>
              <tr>
                <th>Resale Royalty</th>
                <td className="mono">{sculpture.chain?.royaltyPercent}% ({sculpture.chain?.royaltyBps} bps ERC-2981)</td>
              </tr>
              <tr>
                <th>IPFS Metadata</th>
                <td className="mono" style={{ wordBreak: 'break-all' }}>
                  <a
                    href={resolveApiUrl(sculpture.ipfs?.gatewayUrl)}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--accent)' }}
                  >
                    {sculpture.ipfs?.metadataUri}
                  </a>
                </td>
              </tr>
              <tr>
                <th>Version &amp; ERC-4906</th>
                <td className="mono">
                  Rev v{sculpture.currentRev || 1}
                  {sculpture.lastErc4906TxHash ? ` · ERC-4906 ${sculpture.lastErc4906TxHash.slice(0, 14)}...` : ''}
                </td>
              </tr>
              <tr>
                <th>Tx Hash</th>
                <td className="mono" style={{ wordBreak: 'break-all' }}>
                  {explorerTxUrl ? (
                    <a
                      href={explorerTxUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: 'var(--accent)' }}
                    >
                      {sculpture.chain?.txHash}
                    </a>
                  ) : (
                    sculpture.chain?.txHash
                  )}
                </td>
              </tr>
            </tbody>
          </table>

          <SculptureRevisionsPanel
            sculptureId={sculpture.id}
            currentRev={sculpture.currentRev || 1}
            lastErc4906TxHash={sculpture.lastErc4906TxHash || ''}
            explorerUrl={config?.chain?.network?.explorerUrl || ''}
            canRollback={isPropertyOwner}
            onRolledBack={(res) => {
              if (res?.sculpture) {
                setSculpture(res.sculpture);
                onSculptureUpdated?.(res.sculpture);
                setPropNotice(
                  `Rolled back to v${res.restoredFromRev} (now v${res.revNum}) · ERC-4906 MetadataUpdate emitted.`
                );
              }
            }}
          />

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <button
              type="button"
              className="btn"
              aria-expanded={showAllMetadata}
              onClick={() => setShowAllMetadata((v) => !v)}
            >
              <XeroIcon emoji="🧾" size={15} /> {showAllMetadata ? 'Hide All Metadata' : 'View All Metadata'}
            </button>
            <a
              className="btn"
              href={glbUrl}
              download={`graffiland-${sculpture.id}.glb`}
              target="_blank"
              rel="noreferrer"
            >
              <XeroIcon emoji="📦" size={15} /> Export 3D .GLB
            </a>
            <a className="btn" href={tokenMetaUrl} target="_blank" rel="noreferrer">
              <XeroIcon emoji="🏷️" size={15} /> ERC-721 JSON
            </a>
            <button
              type="button"
              className="btn"
              disabled={busyAction !== ''}
              onClick={handleAddToWallet}
            >
              <XeroIcon emoji="🦊" size={15} /> Add to Wallet
            </button>
            <button
              type="button"
              className="btn"
              disabled={busyAction !== ''}
              onClick={handleSyncOwner}
            >
              <XeroIcon emoji="🔄" size={15} /> Sync Owner
            </button>
            {explorerTxUrl && (
              <a className="btn btn-primary" href={explorerTxUrl} target="_blank" rel="noreferrer">
                <XeroIcon emoji="⛓️" size={15} /> View Tx On Chain
              </a>
            )}
            {explorerTokenUrl && (
              <a className="btn" href={explorerTokenUrl} target="_blank" rel="noreferrer">
                <XeroIcon emoji="🌐" size={15} /> Blockscout Token
              </a>
            )}
          </div>

          {showAllMetadata && (
            <div className="sculpture-raw-meta-wrap" data-testid="sculpture-all-metadata">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <strong style={{ fontSize: 12, color: 'var(--accent)' }}>Complete Artwork Metadata (JSON)</strong>
                <button
                  type="button"
                  className="btn btn-xs"
                  onClick={async () => {
                    const metaClean = { ...sculpture };
                    delete metaClean.voxels;
                    delete metaClean.previewDataUrl;
                    const ok = await copyToClipboard(JSON.stringify(metaClean, null, 2));
                    setMetadataCopied(ok);
                  }}
                >
                  {metadataCopied ? '✅ Copied JSON' : '📋 Copy Metadata JSON'}
                </button>
              </div>
              <pre className="desktop-prompt-preview mono" style={{ maxHeight: 220 }}>
                {JSON.stringify(
                  {
                    id: sculpture.id,
                    title: sculpture.title,
                    description: sculpture.description,
                    creatorName: sculpture.creatorName,
                    ownerAddress: ownerAddr,
                    parcelId: sculpture.parcelId,
                    geohash: sculpture.geohash,
                    coordinates: { lat: sculpture.lat, lng: sculpture.lng, altitude: sculpture.altitude },
                    elevation,
                    modelType: sculpture.modelType,
                    voxelCount: sculpture.voxelCount,
                    customModel: sculpture.customModel || null,
                    meshStats: sculpture.meshStats || null,
                    anchorOffset: sculpture.anchorOffset || { dx: 0, dy: 0, dz: 0, yaw: 0 },
                    layerRole: sculpture.layerRole,
                    currentRev: sculpture.currentRev || 1,
                    hidden: Boolean(sculpture.hidden),
                    parcelFrozen: Boolean(parcelFrozen),
                    polScore: sculpture.polScore,
                    proofHash: sculpture.proofHash,
                    ipfs: sculpture.ipfs,
                    chain: sculpture.chain,
                    createdAt: sculpture.createdAt
                  },
                  null,
                  2
                )}
              </pre>
            </div>
          )}

          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: '1px solid rgba(255,255,255,0.08)'
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <XeroIcon emoji="📤" size={16} /> Transfer NFT to External Wallet / Marketplace
            </div>
            {user ? (
              <form
                onSubmit={handleEmbeddedTransfer}
                style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
              >
                <input
                  className="input mono"
                  style={{ flex: '1 1 260px', fontSize: 12 }}
                  placeholder="Destination 0x... (MetaMask, cold wallet, OpenSea, etc.)"
                  value={toAddress}
                  onChange={(e) => setToAddress(e.target.value)}
                />
                {isEmbeddedOwner ? (
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={busyAction !== ''}
                  >
                    <XeroIcon emoji="📤" size={15} /> Transfer NFT
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busyAction !== ''}
                    onClick={handleExternalWalletTransfer}
                  >
                    <XeroIcon emoji="🦊" size={15} /> Sign &amp; Transfer
                  </button>
                )}
              </form>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                Sign in with Google or connect the owning MetaMask wallet to transfer ERC-721 custody.
              </div>
            )}
            {nftNotice && (
              <div className="mono" style={{ marginTop: 8, fontSize: 12, color: 'var(--accent)' }}>
                {nftNotice}
              </div>
            )}
            {nftError && (
              <div className="mono" style={{ marginTop: 8, fontSize: 12, color: 'var(--danger, #ff5e7e)' }}>
                {nftError}
              </div>
            )}

            {isPropertyOwner && user && (
              <div
                style={{
                  marginTop: 12,
                  paddingTop: 10,
                  borderTop: '1px solid rgba(255,255,255,0.08)'
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 4 }}>
                  <XeroIcon emoji="🛒" size={14} /> List on Built-In Marketplace (5% · 3% · 2% Split)
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
                  5% Platform · 3% Land Steward · 2% Human Contributors Pool · 90% To Seller
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    className="input mono"
                    type="number"
                    min="0.0001"
                    step="0.01"
                    value={listingPrice}
                    onChange={(e) => setListingPrice(e.target.value)}
                    style={{ width: 120, fontSize: 12 }}
                    aria-label="Listing price in ETH"
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={listingBusy}
                    onClick={async () => {
                      setListingBusy(true);
                      setListingNotice('');
                      setListingError('');
                      try {
                        const res = await api.createMarketplaceListing({
                          sculptureId: sculpture.id,
                          priceEth: Number(listingPrice)
                        });
                        setListingNotice(
                          `Listed for ${res.listing.priceEth} ETH! (${res.listing.splits?.summary || '5% / 3% / 2% / 90%'})`
                        );
                      } catch (err) {
                        setListingError(err.message || 'Listing failed');
                      } finally {
                        setListingBusy(false);
                      }
                    }}
                  >
                    {listingBusy ? 'Listing...' : 'List for Sale (ETH)'}
                  </button>
                </div>
                {listingNotice && (
                  <div className="mono" style={{ marginTop: 6, fontSize: 11.5, color: 'var(--accent)' }}>
                    {listingNotice}
                  </div>
                )}
                {listingError && (
                  <div className="mono" style={{ marginTop: 6, fontSize: 11.5, color: 'var(--danger, #ff5e7e)' }}>
                    {listingError}
                  </div>
                )}
              </div>
            )}
            {transfers.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                  Provenance &amp; Transfer History ({transfers.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {transfers.slice(0, 5).map((t) => (
                    <div
                      key={t.id}
                      className="mono"
                      style={{
                        fontSize: 11,
                        padding: '5px 8px',
                        borderRadius: 6,
                        background: 'rgba(255,255,255,0.04)',
                        wordBreak: 'break-all'
                      }}
                    >
                      {t.fromAddress.slice(0, 8)}... -&gt; {t.toAddress.slice(0, 8)}... · {t.method} ·{' '}
                      {t.txHash.slice(0, 14)}...
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {canModerateLand && (
          <div className="card" style={{ padding: 12, marginTop: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <XeroIcon emoji="🏠" size={18} />{' '}
                Property &amp; Land Owner Controls ({scLandDisplayName})
              </span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {onOpenAddLandItem && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ fontSize: 12, padding: '6px 10px' }}
                    onClick={() => {
                      onClose?.();
                      onOpenAddLandItem(sculpture.parcelId);
                    }}
                  >
                    + Add 3D Item (Agent Prompt)
                  </button>
                )}
                {onOpenLandManagement && (
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: 12, padding: '6px 10px' }}
                    onClick={() => {
                      onClose?.();
                      onOpenLandManagement(sculpture.parcelId);
                    }}
                  >
                    <XeroIcon emoji="🗺️" size={14} /> Land Management
                  </button>
                )}
                <button
                  type="button"
                  className={`btn ${parcelFrozen ? 'btn-primary' : ''}`}
                  style={{ fontSize: 12, padding: '6px 10px' }}
                  disabled={propBusy !== ''}
                  onClick={handleToggleFreezeLand}
                >
                  {parcelFrozen ? '🔓 Unfreeze Land' : '❄️ Freeze Land'}
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ fontSize: 12, padding: '6px 10px' }}
                  disabled={propBusy !== ''}
                  onClick={handleCopyOwnerPrompt}
                >
                  <XeroIcon emoji="📋" size={14} />{' '}
                  {promptCopied ? 'Copied MCP Prompt!' : 'Copy Property Owner MCP Prompt'}
                </button>
              </div>
            </div>

            {canModerateLand && (
              <>
                <form
              onSubmit={handleSaveLandCuration}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                paddingTop: 10,
                borderTop: '1px solid rgba(255,255,255,0.08)'
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-gold)' }}>
                Curate Virtual Land ({scLandDisplayName})
              </div>
              <input
                className="input"
                maxLength={48}
                value={landCustomName}
                onChange={(e) => setLandCustomName(e.target.value)}
                placeholder="Custom Virtual Land title (e.g. Neon Corner Plaza)"
              />
              <input
                className="input"
                maxLength={240}
                value={landCurationNote}
                onChange={(e) => setLandCurationNote(e.target.value)}
                placeholder="Land note or curator statement"
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button type="submit" className="btn" disabled={propBusy !== ''}>
                  <XeroIcon emoji="🗺️" size={14} /> Save Land Curations
                </button>
                {propNotice && (
                  <span
                    className="mono settings-inline-saved"
                    data-testid="sculpture-land-curation-saved"
                    role="status"
                  >
                    ✅ {propNotice}
                  </span>
                )}
              </div>
            </form>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                marginTop: 12,
                paddingTop: 10,
                borderTop: '1px solid rgba(255,255,255,0.08)'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-gold)' }}>
                  <XeroIcon emoji="📌" size={14} /> Pinned IPFS Messages (Real-Life Parcel Visitors Only)
                </span>
                {pinBatchInfo?.ipfsCid && (
                  <span className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>
                    ipfs://{pinBatchInfo.ipfsCid.slice(0, 12)}... · v{pinBatchInfo.batchSeq}
                  </span>
                )}
              </div>

              {modalPins.map((pin) => (
                <div
                  key={pin.id}
                  className="card"
                  style={{ padding: '7px 9px', borderColor: 'rgba(255, 209, 102, 0.32)' }}
                >
                  {editModalPinId === pin.id ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        className="input"
                        maxLength={500}
                        value={editModalPinText}
                        onChange={(e) => setEditModalPinText(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ fontSize: 11 }}
                        disabled={propBusy !== ''}
                        onClick={async () => {
                          const txt = editModalPinText.trim();
                          if (!txt) return;
                          await saveOwnerPinnedIpfsBatch(
                            modalPins.map((m) =>
                              m.id === pin.id ? { ...m, text: txt, updatedAt: new Date().toISOString() } : m
                            )
                          );
                          setEditModalPinId('');
                          setEditModalPinText('');
                        }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn"
                        style={{ fontSize: 11 }}
                        onClick={() => setEditModalPinId('')}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <div style={{ fontSize: 12 }}>{pin.text}</div>
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        <button
                          type="button"
                          className="btn"
                          style={{ padding: '2px 6px', fontSize: 10 }}
                          disabled={propBusy !== ''}
                          onClick={() => {
                            setEditModalPinId(pin.id);
                            setEditModalPinText(pin.text);
                          }}
                        >
                          <XeroIcon emoji="✏️" size={10} /> Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger"
                          style={{ padding: '2px 6px', fontSize: 10 }}
                          disabled={propBusy !== ''}
                          onClick={() =>
                            saveOwnerPinnedIpfsBatch(modalPins.filter((m) => m.id !== pin.id))
                          }
                        >
                          <XeroIcon emoji="🗑️" size={10} /> Remove
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="input"
                  maxLength={500}
                  value={pinDraftText}
                  onChange={(e) => setPinDraftText(e.target.value)}
                  placeholder="Pin message stored encrypted on IPFS for real-life parcel visitors..."
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={propBusy !== '' || !pinDraftText.trim()}
                  onClick={async () => {
                    const txt = pinDraftText.trim();
                    if (!txt) return;
                    const nowIso = new Date().toISOString();
                    await saveOwnerPinnedIpfsBatch([
                      ...modalPins,
                      {
                        id: crypto.randomUUID(),
                        text: txt,
                        authorName: resolveAuthorHandleForStorage(user, 'Land Holder'),
                        authorUsername: user?.username || '',
                        authorAvatar: resolveSafeUserAvatar(user?.avatarImage || ''),
                        authorAddress: ownerAddr,
                        pinnedAt: nowIso,
                        updatedAt: nowIso
                      }
                    ]);
                    setPinDraftText('');
                  }}
                >
                  <XeroIcon emoji="📌" size={13} /> Pin to IPFS
                </button>
              </div>
            </div>
              </>
            )}

            {propNotice && (
              <div className="mono" style={{ marginTop: 8, fontSize: 12, color: 'var(--accent)' }}>
                {propNotice}
              </div>
            )}
            {propError && (
              <div className="mono" style={{ marginTop: 8, fontSize: 12, color: 'var(--danger, #ff5e7e)' }}>
                {propError}
              </div>
            )}
          </div>
        )}

        <div className="card" style={{ padding: 12, marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <XeroIcon emoji="🔐" size={18} /> Land Chat Board (E2EE · One Shared Chat Per Land)
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: 'var(--muted)' }}>
            <span className="badge">
              <XeroIcon emoji="🔒" size={12} /> {sculpture.chatSummary?.messageCount ?? 0} encrypted messages
            </span>
            <span className="badge gold">
              <XeroIcon emoji="📌" size={12} /> {pinBatchInfo?.pinCount ?? sculpture.pinSummary?.pinCount ?? 0} pinned IPFS note(s) (in-person parcel unlock)
            </span>
            <span>
              Locked to physical in-person mobile AR camera selection only. Neither desktop browsers nor our servers can decrypt past chat history or parcel-pinned IPFS batches.
            </span>
          </div>
        </div>
        </>
        )}
        </div>
      </div>
    </div>
  );
}
