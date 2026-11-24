import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveLandDisplayName } from '../../../shared/landVolume.mjs';
import { api, resolveApiUrl } from '../utils/api.js';
import { buildSculptureShareUrl, copyToClipboard } from '../utils/clipboard.js';
import {
  buildParcelGeoSummary,
  computeIsometricCameraFit,
  computeScaleBarForZoom,
  formatBearingCardinal,
  resolveParcelVolume
} from '../utils/landPreviewHelpers.js';
import { hasWebGLSupport, loadMapLibre } from '../utils/loadMapLibre.js';
import {
  computePrismScreenGeometry,
  projectLngLatAltToScreen
} from '../utils/map3dProjection.js';
import {
  computeSideArtworkCallouts,
  drawArtworkCalloutLeader,
  drawFloatingLandLabel
} from '../utils/map3dLabelOverlay.js';
import { buildDefaultHudReservedRects } from '../utils/canvasLabelLayout.js';
import { createSculptureThreeLayer } from '../utils/map3dSculptureLayer.js';
import {
  buildNeighborArrowsSignature,
  computeNeighborEdgeArrows
} from '../utils/neighborEdgeArrows.js';
import { drawDepthFadedPrismEdges } from '../utils/prismDepthFade.js';
import { buildSculptures3DGeoJson } from '../utils/sculpture3dGeoJson.js';
import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import { useMeasurementUnits } from '../utils/measurementUnits.js';
import InfoTip from './InfoTip.jsx';
import NeighborEdgeArrowsOverlay from './NeighborEdgeArrowsOverlay.jsx';
import XeroIcon from './XeroIcon.jsx';

const OPENFREEMAP_LIBERTY_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const FALLBACK_DARK_STYLE = {
  version: 8,
  sources: {
    'carto-dark': {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'
      ],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }
  },
  layers: [
    {
      id: 'preview-fallback-bg',
      type: 'background',
      paint: { 'background-color': '#0b1020' }
    },
    {
      id: 'preview-fallback-carto',
      type: 'raster',
      source: 'carto-dark',
      minzoom: 0,
      maxzoom: 22
    }
  ]
};

// Cache reverse-geocoded place summaries & hydrated sculpture voxels across parcel switches
const reverseGeoCache = new Map();
const previewSculptureCache = new Map();
const previewSculptureInFlight = new Set();

function volumeToFeature(parcel, vol, { isSelected = false } = {}) {
  if (!vol || !Array.isArray(vol.ring) || vol.ring.length < 4) return null;
  const isFrozen = Boolean(parcel?.frozen || parcel?.settings?.frozen);
  const isDormant = String(parcel?.stewardStatus || '').toLowerCase() === 'dormant';
  const color = isSelected
    ? isFrozen
      ? '#7dd3fc'
      : '#ff1f8f'
    : isDormant
      ? '#ff4da6'
      : '#ff1f8f';
  const innerColor = isFrozen ? '#e0f2fe' : isSelected ? '#ffe0f2' : '#ffd6ec';
  return {
    type: 'Feature',
    properties: {
      parcelId: parcel?.parcelId || vol.parcelId,
      heightMeters: Number(vol.heightMeters || 18),
      baseAltitudeM: Number(vol.baseAltitudeM || 0),
      color,
      innerColor,
      isSelected: isSelected ? 1 : 0
    },
    geometry: {
      type: 'Polygon',
      coordinates: [vol.ring]
    }
  };
}

function drawPreviewPrism(
  ctx,
  geom,
  { outerColor, innerColor, lineWidth = 2.1, glowBlur = 12, dashed = false, includeBottomEdges = true }
) {
  if (!geom) return;

  // Never paint a translucent floor polygon on the foreground 2D canvas — the pink land base
  // renders on MapLibre's ground layers strictly BEHIND the 3D sculptures.
  // Depth-faded 3D boundary wireframe: lines closest to user stay crisp, far-side lines fade >=25%
  drawDepthFadedPrismEdges(ctx, geom, {
    outerColor,
    innerColor,
    lineWidth,
    glowBlur,
    dashed,
    darkHalo: !dashed,
    nearAlpha: 1.0,
    farAlpha: 0.32,
    includeBottomEdges
  });
}

/**
 * Fallback proportional 3D isometric SVG blueprint rendered cleanly when WebGL is unavailable.
 */
function IsometricFallbackBlueprint({
  volume,
  parcel,
  displayName = '',
  sculptures = [],
  onSelectSculpture = null,
  viewMode,
  bearingDeg
}) {
  const maxDim = Math.max(10, volume.widthMeters, volume.depthMeters, volume.heightMeters);
  const wScale = (volume.widthMeters / maxDim) * 74;
  const dScale = (volume.depthMeters / maxDim) * 74;
  const hScale = viewMode === 'topdown' ? 0 : Math.max(18, (volume.heightMeters / maxDim) * 70);
  const cx = 180;
  const cy = viewMode === 'topdown' ? 112 : 142;

  const iso = (x, y, z) => {
    if (viewMode === 'topdown') {
      return [cx + x, cy - y];
    }
    const cos30 = 0.866;
    const sin30 = 0.5;
    return [cx + (x - y) * cos30, cy + (x + y) * sin30 - z];
  };

  const hw = wScale * 0.5;
  const hd = dScale * 0.5;
  const b0 = iso(-hw, -hd, 0);
  const b1 = iso(hw, -hd, 0);
  const b2 = iso(hw, hd, 0);
  const b3 = iso(-hw, hd, 0);
  const t0 = iso(-hw, -hd, hScale);
  const t1 = iso(hw, -hd, hScale);
  const t2 = iso(hw, hd, hScale);
  const t3 = iso(-hw, hd, hScale);
  const topCenterX = (t0[0] + t1[0] + t2[0] + t3[0]) / 4;
  const topCenterY = (t0[1] + t1[1] + t2[1] + t3[1]) / 4;
  const labelY = Math.max(20, Math.min(t0[1], t1[1], t2[1], t3[1]) - 14);
  const isFrozen = Boolean(parcel?.frozen || parcel?.settings?.frozen);
  const stroke = isFrozen ? '#7dd3fc' : '#ff1f8f';
  const fill = isFrozen ? 'rgba(125, 211, 252, 0.18)' : 'rgba(255, 31, 143, 0.16)';
  const pts = (list) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  const fallbackCallouts = computeSideArtworkCallouts({
    sculptures,
    volume,
    viewportWidth: 360,
    viewportHeight: 220,
    topInsetPx: 46,
    bottomInsetPx: 38,
    marginPx: 8,
    labelHeight: 32,
    gapPx: 6,
    projectScreenPt: (_lng, _lat, _alt, _sc, idx, total) => {
      const frac = total <= 1 ? 0 : idx / (total - 1) - 0.5;
      return {
        x: cx + frac * hw * 0.7,
        y: cy - hScale * 0.45 + (idx % 2 === 0 ? -5 : 5)
      };
    }
  });

  return (
    <div className="land-preview-fallback" data-testid="land-preview-svg-fallback">
      <svg viewBox="0 0 360 220" width="100%" height="100%" aria-hidden="true">
        <defs>
          <pattern id="landIsoGrid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(148,163,184,0.12)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="360" height="220" fill="url(#landIsoGrid)" />
        {/* Surrounding context block lines */}
        <circle cx={cx} cy={cy} r={viewMode === 'context' ? 42 : 76} fill="none" stroke="rgba(255,255,255,0.08)" strokeDasharray="4 4" />
        {/* Base polygon fill */}
        <polygon points={pts([b0, b1, b2, b3])} fill={fill} stroke="none" />
        {/* Far-side boundary edges away from viewer (faded >= 25%) */}
        <line x1={b0[0]} y1={b0[1]} x2={b1[0]} y2={b1[1]} stroke={stroke} strokeWidth="1.2" opacity="0.42" />
        <line x1={b0[0]} y1={b0[1]} x2={b3[0]} y2={b3[1]} stroke={stroke} strokeWidth="1.2" opacity="0.42" />
        {hScale > 0 && (
          <>
            <line x1={b0[0]} y1={b0[1]} x2={t0[0]} y2={t0[1]} stroke={stroke} strokeWidth="1.15" opacity="0.4" />
            <line x1={t0[0]} y1={t0[1]} x2={t1[0]} y2={t1[1]} stroke={stroke} strokeWidth="1.2" opacity="0.46" />
            <line x1={t0[0]} y1={t0[1]} x2={t3[0]} y2={t3[1]} stroke={stroke} strokeWidth="1.2" opacity="0.46" />
            {/* Bottom floor stays on the ground behind the interior — never veil the foreground */}
            {/* Front-side boundary edges closest to viewer (crisp 100%) */}
            <line x1={b1[0]} y1={b1[1]} x2={t1[0]} y2={t1[1]} stroke={stroke} strokeWidth="1.6" opacity="0.82" />
            <line x1={b3[0]} y1={b3[1]} x2={t3[0]} y2={t3[1]} stroke={stroke} strokeWidth="1.6" opacity="0.82" />
            <line x1={b2[0]} y1={b2[1]} x2={t2[0]} y2={t2[1]} stroke="#eafffc" strokeWidth="2.0" opacity="1" />
            <line x1={t1[0]} y1={t1[1]} x2={t2[0]} y2={t2[1]} stroke="#eafffc" strokeWidth="1.9" opacity="1" />
            <line x1={t2[0]} y1={t2[1]} x2={t3[0]} y2={t3[1]} stroke="#eafffc" strokeWidth="1.9" opacity="1" />
          </>
        )}
        <line x1={b1[0]} y1={b1[1]} x2={b2[0]} y2={b2[1]} stroke={stroke} strokeWidth="2.0" opacity="1" />
        <line x1={b2[0]} y1={b2[1]} x2={b3[0]} y2={b3[1]} stroke={stroke} strokeWidth="2.0" opacity="1" />
        {/* Land tag leader line strictly to top center of land boundary */}
        <line
          data-testid="plot-land-leader-line"
          data-target="top-center"
          x1={topCenterX}
          y1={labelY + 4}
          x2={topCenterX}
          y2={topCenterY}
          stroke={stroke}
          strokeWidth="1.3"
        />
        <circle cx={topCenterX} cy={topCenterY} r="2.4" fill="#ffffff" />
        <text
          x={topCenterX}
          y={labelY}
          textAnchor="middle"
          fill="#eafffc"
          fontSize="11"
          fontFamily="monospace"
          fontWeight="600"
        >
          {displayName || `${Math.round(volume.widthMeters)}×${Math.round(volume.depthMeters)}×${Math.round(volume.heightMeters)}m · ${Math.round(bearingDeg)}°`}
        </text>
        {fallbackCallouts.map((c) => (
          <g key={c.sculptureId} data-testid="plot-artwork-leader-line" data-sculpture-id={c.sculptureId}>
            <polyline
              points={`${c.fromX},${c.fromY} ${c.elbowX},${c.elbowY} ${c.targetX},${c.targetY}`}
              fill="none"
              stroke="#00f5d4"
              strokeWidth="1.25"
            />
            <circle cx={c.targetX} cy={c.targetY} r="2.4" fill="#eafffc" />
          </g>
        ))}
      </svg>

      {fallbackCallouts.length > 0 && (
        <div
          className="plot-iso-callout-layer"
          data-testid="plot-iso-callout-layer"
          onPointerDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {fallbackCallouts.map((c) => (
            <div
              key={c.sculptureId}
              className={`plot-iso-artwork-callout is-${c.side}`}
              data-callout-side={c.side}
              style={{
                left: c.side === 'left' ? 8 : undefined,
                right: c.side === 'right' ? 8 : undefined,
                top: `${Math.round((c.y / 220) * 100)}%`
              }}
            >
              <button
                type="button"
                className="plot-iso-callout-main"
                data-testid="preview-artwork-label"
                data-sculpture-id={c.sculptureId}
                data-callout-side={c.side}
                title={`Open 3D view of "${c.title}"`}
                onClick={() => onSelectSculpture?.(c.sculpture)}
              >
                <span className="plot-iso-callout-title">{c.title}</span>
                <span className="plot-iso-callout-meta mono">{c.subtitle}</span>
              </button>
              <a
                href={c.sculptureUrl}
                className="plot-iso-callout-open-btn"
                data-testid="plot-artwork-view-btn"
                data-sculpture-id={c.sculptureId}
                aria-label={`Open 3D art link for ${c.title}`}
                title={`Open link for "${c.title}" (${c.sculptureUrl})`}
                onClick={(e) => {
                  if (
                    onSelectSculpture &&
                    !e.metaKey &&
                    !e.ctrlKey &&
                    !e.shiftKey &&
                    !e.altKey &&
                    e.button === 0
                  ) {
                    e.preventDefault();
                    e.stopPropagation();
                    onSelectSculpture(c.sculpture);
                  }
                }}
              >
                ↗
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function LandIsometricPreview({
  parcel,
  displayNameOverride = '',
  frozenOverride = null,
  allParcels = [],
  userLocation = null,
  onSelectParcel = null,
  onSelectSculpture = null,
  onFocusParcel = null
}) {
  const stageRef = useRef(null);
  const mapHostRef = useRef(null);
  const wireCanvasRef = useRef(null);
  const mapRef = useRef(null);
  const maplibreRef = useRef(null);
  const styleReadyRef = useRef(false);
  const fallbackAppliedRef = useRef(false);
  const lastCenteredParcelRef = useRef({ parcelId: '', lat: null, lng: null });

  const [cameraUi, setCameraUi] = useState({
    parcelId: parcel?.parcelId || '',
    mode: 'isometric',
    bearingOffset: 0,
    userMoved: false
  });
  const isSameUiParcel = cameraUi.parcelId === (parcel?.parcelId || '');
  const viewMode = isSameUiParcel ? cameraUi.mode : 'isometric';
  const bearingOffset = isSameUiParcel ? cameraUi.bearingOffset : 0;
  const userMovedCamera = isSameUiParcel ? cameraUi.userMoved : false;

  const setViewMode = useCallback(
    (nextMode) => {
      setCameraUi((prev) => {
        const curPid = parcelRef.current?.parcelId || '';
        const base =
          prev.parcelId === curPid
            ? prev
            : { parcelId: curPid, mode: 'isometric', bearingOffset: 0, userMoved: false };
        const resolved = typeof nextMode === 'function' ? nextMode(base.mode) : nextMode;
        return { ...base, parcelId: curPid, mode: resolved };
      });
    },
    []
  );
  const setBearingOffset = useCallback(
    (nextOffset) => {
      setCameraUi((prev) => {
        const curPid = parcelRef.current?.parcelId || '';
        const base =
          prev.parcelId === curPid
            ? prev
            : { parcelId: curPid, mode: 'isometric', bearingOffset: 0, userMoved: false };
        const resolved =
          typeof nextOffset === 'function' ? nextOffset(base.bearingOffset) : nextOffset;
        return { ...base, parcelId: curPid, bearingOffset: resolved };
      });
    },
    []
  );
  const setUserMovedCamera = useCallback((moved) => {
    setCameraUi((prev) => {
      const curPid = parcelRef.current?.parcelId || '';
      const base =
        prev.parcelId === curPid
          ? prev
          : { parcelId: curPid, mode: 'isometric', bearingOffset: 0, userMoved: false };
      return { ...base, parcelId: curPid, userMoved: Boolean(moved) };
    });
  }, []);

  const [liveBearing, setLiveBearing] = useState(-45);
  const [liveZoom, setLiveZoom] = useState(17.5);
  const [mapReady, setMapReady] = useState(false);
  const [webglAvailable, setWebglAvailable] = useState(() => hasWebGLSupport());
  const [placeContext, setPlaceContext] = useState(null);
  const [placeLoading, setPlaceLoading] = useState(false);
  const [coordsCopied, setCoordsCopied] = useState(false);
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const [loadedThree3dCount, setLoadedThree3dCount] = useState(0);
  const threeLayerRef = useRef(null);
  const calloutBtnMapRef = useRef(new Map());
  const userMovedCameraRef = useRef(false);
  const lastCameraKeyRef = useRef('');
  const [stageSize, setStageSize] = useState({ width: 600, height: 260 });
  const [neighborArrows, setNeighborArrows] = useState([]);
  const neighborArrowsSigRef = useRef('');

  useEffect(() => {
    userMovedCameraRef.current = userMovedCamera;
  }, [userMovedCamera]);

  const volume = useMemo(() => resolveParcelVolume(parcel), [parcel]);

  const parcelCoords = volume
    ? { lat: volume.centerLat, lng: volume.centerLng }
    : null;
  const { unitSystem } = useMeasurementUnits(userLocation, parcelCoords);
  const unitSystemRef = useRef(unitSystem);
  useEffect(() => {
    unitSystemRef.current = unitSystem;
  }, [unitSystem]);

  const otherParcelEntries = useMemo(() => {
    const out = [];
    for (const p of allParcels || []) {
      if (!p || p.parcelId === parcel?.parcelId) continue;
      const vol = resolveParcelVolume(p);
      if (vol) out.push({ parcel: p, volume: vol });
    }
    return out;
  }, [allParcels, parcel?.parcelId]);

  const geoSummary = useMemo(
    () =>
      buildParcelGeoSummary(parcel, {
        allParcels,
        userLocation,
        placeContext,
        unitSystem
      }),
    [allParcels, parcel, placeContext, userLocation, unitSystem]
  );

  // Refs for synchronous MapLibre event handlers
  const parcelRef = useRef(parcel);
  const volumeRef = useRef(volume);
  const displayNameRef = useRef('');
  const isFrozenRef = useRef(false);
  const otherEntriesRef = useRef(otherParcelEntries);
  const onSelectParcelRef = useRef(onSelectParcel);
  const onSelectSculptureRef = useRef(onSelectSculpture);
  const viewModeRef = useRef(viewMode);
  const bearingOffsetRef = useRef(bearingOffset);

  const effectiveDisplayName = resolveLandDisplayName({
    customName: displayNameOverride || parcel?.customName || '',
    displayName: parcel?.displayName || '',
    firstSculptureTitle: parcel?.sculptures?.[0]?.title || '',
    placeName: parcel?.sculptures?.[0]?.placeName || ''
  });
  const effectiveFrozen =
    frozenOverride !== null ? Boolean(frozenOverride) : Boolean(parcel?.frozen || parcel?.settings?.frozen);

  const hydratedPreviewSculptures = useMemo(() => {
    const raw = [];
    const seen = new Set();
    for (const sc of parcel?.sculptures || []) {
      if (sc?.id && !seen.has(sc.id)) {
        seen.add(sc.id);
        raw.push(sc);
      }
    }
    return raw.map((sc) => {
      if (sc.modelType === 'custom-3d' || (Array.isArray(sc.voxels) && sc.voxels.length > 0)) {
        return sc;
      }
      const cached = previewSculptureCache.get(sc.id);
      return cached ? { ...sc, ...cached } : sc;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parcel?.sculptures, hydrationVersion]);

  const hydratedPreviewSculpturesRef = useRef(hydratedPreviewSculptures);
  useEffect(() => {
    hydratedPreviewSculpturesRef.current = hydratedPreviewSculptures;
  }, [hydratedPreviewSculptures]);

  // Hydrate full voxel / custom-3D payloads for any sculptures lacking full geometry
  useEffect(() => {
    const targets = hydratedPreviewSculptures
      .filter(
        (sc) =>
          sc &&
          sc.id &&
          !sc.hidden &&
          sc.modelType !== 'custom-3d' &&
          (!Array.isArray(sc.voxels) || sc.voxels.length === 0) &&
          !previewSculptureCache.has(sc.id) &&
          !previewSculptureInFlight.has(sc.id)
      )
      .slice(0, 8);
    if (targets.length === 0) return undefined;
    let cancelled = false;
    for (const sc of targets) {
      previewSculptureInFlight.add(sc.id);
      api
        .getSculpture(sc.id)
        .then((res) => {
          if (res?.sculpture) {
            previewSculptureCache.set(sc.id, res.sculpture);
            if (!cancelled) setHydrationVersion((v) => v + 1);
          }
        })
        .catch(() => {})
        .finally(() => {
          previewSculptureInFlight.delete(sc.id);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [hydratedPreviewSculptures]);

  useEffect(() => {
    parcelRef.current = parcel;
    volumeRef.current = volume;
    displayNameRef.current = effectiveDisplayName;
    isFrozenRef.current = effectiveFrozen;
  }, [effectiveDisplayName, effectiveFrozen, parcel, volume]);
  useEffect(() => {
    otherEntriesRef.current = otherParcelEntries;
  }, [otherParcelEntries]);
  useEffect(() => {
    onSelectParcelRef.current = onSelectParcel;
    onSelectSculptureRef.current = onSelectSculpture;
  }, [onSelectParcel, onSelectSculpture]);
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);
  useEffect(() => {
    bearingOffsetRef.current = bearingOffset;
  }, [bearingOffset]);

  // Clear copied feedback when switching lands
  useEffect(() => {
    setCoordsCopied(false);
  }, [parcel?.parcelId]);

  // Fetch human-readable geographic location (street / neighborhood / city / region) with cache
  useEffect(() => {
    if (!volume) {
      setPlaceContext(null);
      setPlaceLoading(false);
      return undefined;
    }
    const key = `${volume.centerLat.toFixed(4)},${volume.centerLng.toFixed(4)}`;
    if (reverseGeoCache.has(key)) {
      setPlaceContext(reverseGeoCache.get(key));
      setPlaceLoading(false);
      return undefined;
    }
    let cancelled = false;
    setPlaceLoading(true);
    setPlaceContext(null);
    api
      .reverseGeocode(volume.centerLat, volume.centerLng)
      .then((res) => {
        if (cancelled) return;
        const normalized = res && res.shortLabel ? res : null;
        if (normalized) reverseGeoCache.set(key, normalized);
        setPlaceContext(normalized);
      })
      .catch(() => {
        if (!cancelled) setPlaceContext(null);
      })
      .finally(() => {
        if (!cancelled) setPlaceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [volume]);

  const drawWireframes = useCallback(() => {
    const map = mapRef.current;
    const maplibregl = maplibreRef.current;
    const canvas = wireCanvasRef.current;
    if (!map || !maplibregl || !canvas) return;

    const hostCanvas = map.getCanvas?.();
    const w = hostCanvas?.clientWidth || canvas.clientWidth || 0;
    const h = hostCanvas?.clientHeight || canvas.clientHeight || 0;
    if (w <= 0 || h <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Pass 1: Draw ONLY the focused land wireframe (never show other lands' lines when focused)
    let primaryLabel = null;
    const curVol = volumeRef.current;
    if (curVol) {
      const geom = computePrismScreenGeometry(map, maplibregl, curVol);
      if (geom) {
        const isFrozenNow = isFrozenRef.current;
        const shortName = displayNameRef.current || 'Virtual Land';
        const trimmed = shortName.length > 22 ? `${shortName.slice(0, 21).trimEnd()}…` : shortName;
        const outerColor = isFrozenNow ? '#7dd3fc' : '#ff1f8f';
        const innerColor = isFrozenNow ? '#e0f2fe' : '#ffd6ec';
        const mapPitch = Number(map.getPitch?.() || 0);
        const isElevated = Number(curVol.baseAltitudeM || 0) > 0.25;
        if (mapPitch >= 2 || isElevated) {
          drawPreviewPrism(ctx, geom, {
            outerColor,
            innerColor,
            lineWidth: 2.3,
            glowBlur: 14,
            includeBottomEdges: isElevated
          });
        }
        primaryLabel = {
          geom,
          outerColor,
          innerColor,
          label: `${isFrozenNow ? '❄️ ' : ''}${trimmed}`,
          liftPx: 22,
          minY: 48,
          isPrimary: true
        };
      }
    }

    // Measure actual HUD control boxes inside the map stage so floating labels & neighbor arrows NEVER overlap
    const measuredHudRects = [];
    const stageEl = stageRef.current;
    if (stageEl && typeof stageEl.getBoundingClientRect === 'function') {
      const stageRect = stageEl.getBoundingClientRect();
      const hudNodes = stageEl.querySelectorAll(
        '.land-preview-mode-group, .land-preview-compass-group, .land-preview-scale, .land-preview-refit, .land-preview-artwork-dock'
      );
      hudNodes.forEach((node) => {
        const r = node.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          measuredHudRects.push({
            x: r.left - stageRect.left,
            y: r.top - stageRect.top,
            w: r.width,
            h: r.height
          });
        }
      });
    }
    const reservedRects = buildDefaultHudReservedRects({
      stageWidth: w,
      stageHeight: h,
      measuredRects: measuredHudRects
    });
    const placedRects = [];

    // Pass 2: Focused land floating label on top of its wireframe (leader strictly to top center)
    if (primaryLabel) {
      drawFloatingLandLabel(ctx, primaryLabel.geom, {
        ...primaryLabel,
        stageWidth: w,
        stageHeight: h,
        reservedRects,
        placedRects
      });
    }

    // Pass 2b: Left/Right side sculpture callouts with glowing elbow leader lines & direct links
    const previewSculptures = (hydratedPreviewSculpturesRef.current || []).filter(
      (sc) => sc && !sc.hidden && sc.id
    );
    const sideCallouts = computeSideArtworkCallouts({
      sculptures: previewSculptures,
      volume: curVol,
      viewportWidth: w,
      viewportHeight: h,
      topInsetPx: 48,
      bottomInsetPx: 42,
      marginPx: w < 520 ? 8 : 12,
      labelHeight: w < 520 ? 32 : 36,
      gapPx: 6,
      getSculptureTransform: (id) => threeLayerRef.current?.getTransform?.(id) || null,
      projectScreenPt: (lng, lat, alt) =>
        projectLngLatAltToScreen(map, maplibregl, lng, lat, alt)
    });
    const positionedCalloutIds = new Set();
    for (const c of sideCallouts) {
      drawArtworkCalloutLeader(ctx, c);
      positionedCalloutIds.add(c.sculptureId);
      placedRects.push({ x: c.x, y: c.y, w: c.width, h: c.height || 36 });
      const el = calloutBtnMapRef.current.get(c.sculptureId);
      if (el) {
        el.style.left = `${c.x}px`;
        el.style.top = `${c.y}px`;
        el.style.width = `${c.width}px`;
        el.style.display = 'flex';
        el.dataset.calloutSide = c.side;
        el.classList.toggle('is-left', c.side === 'left');
        el.classList.toggle('is-right', c.side === 'right');
      }
    }
    for (const [id, el] of calloutBtnMapRef.current.entries()) {
      if (!positionedCalloutIds.has(id) && el) {
        el.style.display = 'none';
      }
    }

    // Pass 3: Edge-of-label directional arrows pointing toward selectable neighboring lands
    const prismAvoidRects = [];
    if (primaryLabel?.geom) {
      const pts = [...primaryLabel.geom.bottom, ...primaryLabel.geom.top];
      const minX = Math.min(...pts.map((p) => p.x));
      const maxX = Math.max(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y));
      const maxY = Math.max(...pts.map((p) => p.y));
      if (Number.isFinite(minX) && Number.isFinite(maxX) && maxX > minX && maxY > minY) {
        prismAvoidRects.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
      }
    }
    const nextArrows = curVol
      ? computeNeighborEdgeArrows({
          focusedEntry: { parcel: parcelRef.current, volume: curVol },
          otherEntries: otherEntriesRef.current || [],
          projectLngLat: (lng, lat) => map.project([lng, lat]),
          viewportWidth: w,
          viewportHeight: h,
          bearingDeg: typeof map.getBearing === 'function' ? map.getBearing() : 0,
          reservedRects: [...reservedRects, ...placedRects],
          avoidRects: prismAvoidRects,
          unitSystem: unitSystemRef.current
        })
      : [];
    const nextSig = buildNeighborArrowsSignature(nextArrows);
    if (nextSig !== neighborArrowsSigRef.current) {
      neighborArrowsSigRef.current = nextSig;
      setNeighborArrows(nextArrows);
    }
  }, []);

  const syncMapData = useCallback(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;

    const curParcel = parcelRef.current;
    const curVol = volumeRef.current;

    const selectedFeat = curVol
      ? volumeToFeature(
          { ...curParcel, frozen: isFrozenRef.current },
          curVol,
          { isSelected: true }
        )
      : null;
    const previewParcelsWithVolumes = curVol ? [{ ...curParcel, volume: curVol }] : [];
    const previewSculptures = hydratedPreviewSculpturesRef.current || curParcel?.sculptures || [];
    const sc3d = buildSculptures3DGeoJson(
      previewSculptures,
      '',
      previewParcelsWithVolumes
    );

    const selSrc = map.getSource('preview-selected-land');
    if (selSrc && typeof selSrc.setData === 'function') {
      selSrc.setData({ type: 'FeatureCollection', features: selectedFeat ? [selectedFeat] : [] });
    }
    // Never render extrusion boxes/lines of other lands when focused on a land
    const othSrc = map.getSource('preview-other-lands');
    if (othSrc && typeof othSrc.setData === 'function') {
      othSrc.setData(EMPTY_FC);
    }
    const scSrc = map.getSource('preview-sculptures-3d');
    if (scSrc && typeof scSrc.setData === 'function') {
      scSrc.setData(sc3d.geojson);
    }
    if (threeLayerRef.current && typeof threeLayerRef.current.setData === 'function') {
      threeLayerRef.current.setData({
        sculptures: previewSculptures,
        parcels: previewParcelsWithVolumes,
        selectedSculptureId: ''
      });
    }

    drawWireframes();
  }, [drawWireframes]);

  const applyCameraFit = useCallback(
    (vol, { mode = 'isometric', offsetDeg = 0, animate = true } = {}) => {
      const map = mapRef.current;
      if (!vol) return;

      const canvas = map?.getCanvas?.();
      const vw = canvas?.clientWidth || stageRef.current?.clientWidth || stageSize.width || 600;
      const vh = canvas?.clientHeight || stageRef.current?.clientHeight || stageSize.height || 260;
      const fit = computeIsometricCameraFit(vol, {
        viewportWidth: vw,
        viewportHeight: vh,
        viewMode: mode,
        bearingOffsetDeg: offsetDeg
      });
      if (!fit) return;

      setLiveBearing(fit.bearing);
      setLiveZoom(fit.zoom);

      if (!map) return;

      const cameraOpts = {
        center: fit.center,
        zoom: fit.zoom,
        pitch: fit.pitch,
        bearing: fit.bearing,
        padding: fit.padding
      };

      if (!animate) {
        map.jumpTo(cameraOpts);
        return;
      }

      const prev = lastCenteredParcelRef.current;
      const switchedParcel = prev.parcelId && prev.parcelId !== vol.parcelId;
      const distM =
        switchedParcel && Number.isFinite(prev.lat) && Number.isFinite(prev.lng)
          ? haversineMeters(prev.lat, prev.lng, vol.centerLat, vol.centerLng)
          : 0;

      if (switchedParcel && distM > 4000) {
        // Long cross-city/world jump: jump straight to the new land cleanly instead of slow blur
        map.jumpTo(cameraOpts);
      } else {
        map.easeTo({
          ...cameraOpts,
          duration: switchedParcel ? 720 : 480,
          essential: true
        });
      }
    },
    [stageSize.height, stageSize.width]
  );

  // Track container resizes so the isometric camera fits cleanly across desktop & mobile
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      setStageSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
      if (mapRef.current) {
        mapRef.current.resize();
        drawWireframes();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [drawWireframes]);

  // Mount persistent MapLibre GL 3D isometric preview once while Land Management is open
  useEffect(() => {
    if (!webglAvailable || !mapHostRef.current || !volumeRef.current) return undefined;
    let cancelled = false;

    const ensureLayers = (map) => {
      if (!map) return;
      styleReadyRef.current = true;
      try {
        if (map.getLayer('building-3d')) {
          map.setPaintProperty('building-3d', 'fill-extrusion-color', '#24324f');
          map.setPaintProperty('building-3d', 'fill-extrusion-opacity', 0.78);
        }
      } catch {
        // fallback style has no 3D buildings layer
      }

      try {
        if (!map.getSource('preview-other-lands')) {
          map.addSource('preview-other-lands', { type: 'geojson', data: EMPTY_FC });
        }
        if (!map.getLayer('preview-other-lands-floor-fill')) {
          map.addLayer({
            id: 'preview-other-lands-floor-fill',
            type: 'fill',
            source: 'preview-other-lands',
            paint: {
              'fill-color': ['get', 'color'],
              'fill-opacity': 0.13
            }
          });
        }
        if (!map.getLayer('preview-other-lands-floor-outline')) {
          map.addLayer({
            id: 'preview-other-lands-floor-outline',
            type: 'line',
            source: 'preview-other-lands',
            paint: {
              'line-color': ['get', 'color'],
              'line-width': 1.8,
              'line-opacity': 0.72
            }
          });
        }

        if (!map.getSource('preview-selected-land')) {
          map.addSource('preview-selected-land', { type: 'geojson', data: EMPTY_FC });
        }
        // Render the land bottom floor + glowing ground perimeter strictly BEFORE 3D sculptures
        // so the pink land base ALWAYS sits underneath/behind the models, never in the foreground.
        if (!map.getLayer('preview-selected-land-floor-fill')) {
          map.addLayer({
            id: 'preview-selected-land-floor-fill',
            type: 'fill',
            source: 'preview-selected-land',
            paint: {
              'fill-color': ['get', 'color'],
              'fill-opacity': 0.22
            }
          });
        }
        if (!map.getLayer('preview-selected-land-floor-glow')) {
          map.addLayer({
            id: 'preview-selected-land-floor-glow',
            type: 'line',
            source: 'preview-selected-land',
            paint: {
              'line-color': ['get', 'color'],
              'line-width': 8,
              'line-blur': 5,
              'line-opacity': 0.36
            }
          });
        }
        if (!map.getLayer('preview-selected-land-floor-outline')) {
          map.addLayer({
            id: 'preview-selected-land-floor-outline',
            type: 'line',
            source: 'preview-selected-land',
            paint: {
              'line-color': ['get', 'color'],
              'line-width': 2.6,
              'line-opacity': 0.94
            }
          });
        }
        if (!map.getLayer('preview-selected-land-floor-core')) {
          map.addLayer({
            id: 'preview-selected-land-floor-core',
            type: 'line',
            source: 'preview-selected-land',
            paint: {
              'line-color': ['get', 'innerColor'],
              'line-width': 1,
              'line-opacity': 0.72
            }
          });
        }

        // Mount real un-pixelated Three.js 3D models STRICTLY AFTER the ground land floor layers
        let threeMounted = Boolean(map.getLayer('preview-sculptures-three-3d'));
        if (!threeMounted && maplibreRef.current) {
          try {
            const threeLayer = createSculptureThreeLayer({
              id: 'preview-sculptures-three-3d',
              maplibregl: maplibreRef.current,
              resolveUrlFn: resolveApiUrl,
              onStatsChange: (stats) => {
                setLoadedThree3dCount(stats?.loadedCount || 0);
                drawWireframes();
              }
            });
            threeLayerRef.current = threeLayer;
            map.addLayer(threeLayer);
            threeMounted = Boolean(map.getLayer('preview-sculptures-three-3d'));
          } catch {
            threeLayerRef.current = null;
            threeMounted = false;
          }
        }

        if (!map.getSource('preview-sculptures-3d')) {
          map.addSource('preview-sculptures-3d', { type: 'geojson', data: EMPTY_FC });
        }
        if (!map.getLayer('preview-sculptures-3d-extrusion')) {
          map.addLayer({
            id: 'preview-sculptures-3d-extrusion',
            type: 'fill-extrusion',
            source: 'preview-sculptures-3d',
            paint: {
              'fill-extrusion-color': ['get', 'color'],
              'fill-extrusion-height': ['get', 'heightMeters'],
              'fill-extrusion-base': ['get', 'baseMeters'],
              'fill-extrusion-opacity': threeMounted ? 0.001 : 0.94,
              'fill-extrusion-vertical-gradient': true
            }
          });
        }
      } catch {
        // never crash preview on style reload
      }

      syncMapData();
    };

    loadMapLibre()
      .then((maplibregl) => {
        if (cancelled || !mapHostRef.current) return;
        maplibreRef.current = maplibregl;
        const initVol = volumeRef.current;
        if (!initVol) return;

        const vw = stageRef.current?.clientWidth || 600;
        const vh = stageRef.current?.clientHeight || 260;
        const initFit = computeIsometricCameraFit(initVol, {
          viewportWidth: vw,
          viewportHeight: vh,
          viewMode: viewModeRef.current,
          bearingOffsetDeg: bearingOffsetRef.current
        });

        const map = new maplibregl.Map({
          container: mapHostRef.current,
          style: OPENFREEMAP_LIBERTY_STYLE,
          center: initFit ? initFit.center : [initVol.centerLng, initVol.centerLat],
          zoom: initFit ? initFit.zoom : 17.5,
          pitch: initFit ? initFit.pitch : 55,
          bearing: initFit ? initFit.bearing : -45,
          maxPitch: 70,
          attributionControl: false,
          cooperativeGestures: false
        });

        mapRef.current = map;
        lastCenteredParcelRef.current = {
          parcelId: initVol.parcelId,
          lat: initVol.centerLat,
          lng: initVol.centerLng
        };

        if (initFit) {
          map.jumpTo({
            center: initFit.center,
            zoom: initFit.zoom,
            pitch: initFit.pitch,
            bearing: initFit.bearing,
            padding: initFit.padding
          });
          setLiveBearing(initFit.bearing);
          setLiveZoom(initFit.zoom);
        }

        map.on('style.load', () => {
          ensureLayers(map);
          setMapReady(true);
        });

        map.on('error', () => {
          if (!fallbackAppliedRef.current && !styleReadyRef.current) {
            fallbackAppliedRef.current = true;
            try {
              map.setStyle(FALLBACK_DARK_STYLE);
            } catch {
              // ignore
            }
          }
        });

        map.on('move', () => {
          drawWireframes();
          setLiveBearing(Number(map.getBearing().toFixed(1)));
          setLiveZoom(Number(map.getZoom().toFixed(2)));
        });

        map.on('render', drawWireframes);

        map.on('dragstart', () => setUserMovedCamera(true));
        map.on('wheel', () => setUserMovedCamera(true));
        map.on('rotatestart', () => setUserMovedCamera(true));

        // Clicking another owned land right inside the preview switches Land Management to it
        map.on('click', 'preview-other-lands-floor-fill', (e) => {
          const clickedPid = e?.features?.[0]?.properties?.parcelId;
          if (!clickedPid || !onSelectParcelRef.current) return;
          const match = (otherEntriesRef.current || []).find(
            (entry) => entry.parcel?.parcelId === clickedPid
          );
          if (match?.parcel) {
            onSelectParcelRef.current(match.parcel);
          }
        });

        map.on('mouseenter', 'preview-other-lands-floor-fill', () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', 'preview-other-lands-floor-fill', () => {
          map.getCanvas().style.cursor = '';
        });

        // Clicking a 3D sculpture inside the isometric land preview opens that artwork's 3D view
        map.on('click', 'preview-sculptures-3d-extrusion', (e) => {
          const clickedScId = e?.features?.[0]?.properties?.sculptureId;
          if (!clickedScId || !onSelectSculptureRef.current) return;
          const match = (hydratedPreviewSculpturesRef.current || []).find(
            (sc) => sc?.id === clickedScId
          );
          if (match) {
            onSelectSculptureRef.current(match);
          }
        });
        map.on('mouseenter', 'preview-sculptures-3d-extrusion', () => {
          if (onSelectSculptureRef.current) map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', 'preview-sculptures-3d-extrusion', () => {
          map.getCanvas().style.cursor = '';
        });
      })
      .catch(() => {
        if (!cancelled) setWebglAvailable(false);
      });

    return () => {
      cancelled = true;
      styleReadyRef.current = false;
      setMapReady(false);
      if (mapRef.current) {
        try {
          mapRef.current.remove();
        } catch {
          // ignore cleanup errors
        }
        mapRef.current = null;
      }
    };
  }, [drawWireframes, setUserMovedCamera, syncMapData, webglAvailable]);

  // Whenever the selected parcel, display overrides, hydrated sculptures, or other lands update, sync layers
  useEffect(() => {
    syncMapData();
  }, [parcel, effectiveDisplayName, effectiveFrozen, otherParcelEntries, hydratedPreviewSculptures, syncMapData]);

  // Compute neighbor edge arrows immediately for SVG fallback mode (or before WebGL finishes initial paint)
  useEffect(() => {
    if (webglAvailable && mapReady) return;
    if (!volume || !parcel) {
      if (neighborArrowsSigRef.current !== '') {
        neighborArrowsSigRef.current = '';
        setNeighborArrows([]);
      }
      return;
    }
    const vw = stageSize.width || 360;
    const vh = stageSize.height || 240;
    const reservedRects = buildDefaultHudReservedRects({ stageWidth: vw, stageHeight: vh });
    const nextArrows = computeNeighborEdgeArrows({
      focusedEntry: { parcel, volume },
      otherEntries: otherParcelEntries,
      viewportWidth: vw,
      viewportHeight: vh,
      bearingDeg: liveBearing,
      reservedRects
    });
    const nextSig = buildNeighborArrowsSignature(nextArrows);
    if (nextSig !== neighborArrowsSigRef.current) {
      neighborArrowsSigRef.current = nextSig;
      setNeighborArrows(nextArrows);
    }
  }, [webglAvailable, mapReady, parcel, volume, otherParcelEntries, stageSize.width, stageSize.height, liveBearing]);

  useEffect(() => {
    if (!volume) return;
    const camKey = `${volume.parcelId}|${viewMode}|${bearingOffset}`;
    const isSameParcel = lastCenteredParcelRef.current.parcelId === volume.parcelId;
    if (camKey === lastCameraKeyRef.current && userMovedCameraRef.current) {
      return;
    }
    lastCameraKeyRef.current = camKey;
    applyCameraFit(volume, {
      mode: viewMode,
      offsetDeg: bearingOffset,
      animate: Boolean(lastCenteredParcelRef.current.parcelId)
    });
    if (!isSameParcel) {
      lastCenteredParcelRef.current = {
        parcelId: volume.parcelId,
        lat: volume.centerLat,
        lng: volume.centerLng
      };
    }
  }, [volume, viewMode, bearingOffset, applyCameraFit]);

  if (!parcel || !volume || !geoSummary) {
    return null;
  }

  const compass = formatBearingCardinal(liveBearing);
  const scaleBar = computeScaleBarForZoom(volume.centerLat, liveZoom, 92, unitSystem);
  const displayName = effectiveDisplayName;
  const isFrozen = effectiveFrozen;
  const sculptureCount = Number(parcel.sculptures?.length ?? parcel.sculptureCount ?? 0);

  const handleModeChange = (nextMode) => {
    setViewMode(nextMode);
    setUserMovedCamera(false);
  };

  const handleOrbit90 = () => {
    if (viewMode === 'topdown') {
      setViewMode('isometric');
      setBearingOffset(90);
    } else {
      setBearingOffset((prev) => (prev + 90) % 360);
    }
    setUserMovedCamera(false);
  };

  const handleRefit = () => {
    setUserMovedCamera(false);
    applyCameraFit(volume, {
      mode: viewMode,
      offsetDeg: bearingOffset,
      animate: true
    });
  };

  const handleResetCompass = () => {
    setViewMode('isometric');
    setBearingOffset(0);
    setUserMovedCamera(false);
    applyCameraFit(volume, {
      mode: 'isometric',
      offsetDeg: 0,
      animate: true
    });
  };

  const handleCopyCoords = async () => {
    await copyToClipboard(geoSummary.rawCoords);
    setCoordsCopied(true);
    setTimeout(() => setCoordsCopied(false), 1800);
  };

  return (
    <section
      className="card land-preview-card"
      data-testid="land-mgmt-iso-preview"
      data-parcel-id={parcel.parcelId}
      data-three-3d-models={loadedThree3dCount}
      data-view-mode={viewMode}
      aria-label={`Isometric map preview for ${displayName}`}
    >
      {/* 1) Geographic Place Header */}
      <div className="land-preview-header">
        <div className="land-preview-title-group">
          <div className="land-preview-title-row">
            <strong className="land-preview-title">{displayName}</strong>
            <span className="badge teal" style={{ fontSize: 10 }}>
              🗿 {sculptureCount}
            </span>
            {isFrozen && (
              <span className="badge" style={{ fontSize: 10 }}>
                ❄️ Frozen
              </span>
            )}
            {geoSummary.expiration.state !== 'permanent' && (
              <span
                className={`badge ${geoSummary.expiration.urgent ? 'badge-error' : ''}`}
                style={{ fontSize: 10 }}
              >
                ⏱️ {geoSummary.expiration.badgeText}
              </span>
            )}
            <InfoTip title="Isometric Geographic Preview">
              Shows your selected land fitted in 3D isometric view with surrounding streets, 3D
              buildings, and placed sculptures. Switch between <strong>Iso</strong> (fitted 3D plot),{' '}
              <strong>Area</strong> (neighborhood context), and <strong>2D</strong> (North-up site
              plan), or click <strong>↻ 90°</strong> to inspect all sides.
              {otherParcelEntries.length > 0
                ? ' Edge arrows point toward your neighboring lands — click any arrow label to jump to it.'
                : ''}
            </InfoTip>
          </div>
          <div className="land-preview-place" data-testid="land-preview-place">
            <XeroIcon emoji="📍" size={12} />
            <span>
              {geoSummary.placePrimary ||
                (placeLoading ? 'Locating neighborhood & street…' : '')}
            </span>
            {geoSummary.cardinalCoords && (
              <span
                className="land-preview-header-coords mono"
                data-testid="land-preview-coords"
              >
                {geoSummary.placePrimary ? '· ' : ''}
                {geoSummary.cardinalCoords}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 2) Interactive Isometric 3D Map Viewport */}
      <div ref={stageRef} className="land-preview-stage">
        {webglAvailable ? (
          <>
            <div ref={mapHostRef} className="land-preview-map-host" />
            <canvas ref={wireCanvasRef} className="land-preview-wire-canvas" aria-hidden="true" />
            {hydratedPreviewSculptures.filter((sc) => sc && !sc.hidden && sc.id).length > 0 && (
              <div
                className="plot-iso-callout-layer"
                data-testid="plot-iso-callout-layer"
                onPointerDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {hydratedPreviewSculptures
                  .filter((sc) => sc && !sc.hidden && sc.id)
                  .map((sc) => {
                    const sub =
                      sc.modelType === 'custom-3d'
                        ? `${String(sc.customModel?.format || '3D').toUpperCase()} 3D`
                        : `${Number(sc.voxelCount || sc.voxels?.length || 0)} blocks`;
                    const sculptureUrl =
                      buildSculptureShareUrl(sc.id) || `?sculpture=${encodeURIComponent(String(sc.id))}`;
                    return (
                      <div
                        key={sc.id}
                        ref={(el) => {
                          if (el) calloutBtnMapRef.current.set(sc.id, el);
                          else calloutBtnMapRef.current.delete(sc.id);
                        }}
                        className="plot-iso-artwork-callout"
                        style={{ display: 'none' }}
                      >
                        <button
                          type="button"
                          className="plot-iso-callout-main"
                          data-testid="preview-artwork-label"
                          data-sculpture-id={sc.id}
                          title={`Open 3D view of "${sc.title || 'Artwork'}"`}
                          onClick={() => onSelectSculpture?.(sc)}
                        >
                          <span className="plot-iso-callout-title">{sc.title || '3D Artwork'}</span>
                          <span className="plot-iso-callout-meta mono">{sub}</span>
                        </button>
                        <a
                          href={sculptureUrl}
                          className="plot-iso-callout-open-btn"
                          data-testid="plot-artwork-view-btn"
                          data-sculpture-id={sc.id}
                          aria-label={`Open 3D art link for ${sc.title || '3D Artwork'}`}
                          title={`Open link for "${sc.title || '3D Artwork'}" (${sculptureUrl})`}
                          onClick={(e) => {
                            if (
                              onSelectSculpture &&
                              !e.metaKey &&
                              !e.ctrlKey &&
                              !e.shiftKey &&
                              !e.altKey &&
                              e.button === 0
                            ) {
                              e.preventDefault();
                              e.stopPropagation();
                              onSelectSculpture(sc);
                            }
                          }}
                        >
                          ↗
                        </a>
                      </div>
                    );
                  })}
              </div>
            )}
            {!mapReady && (
              <div className="land-preview-loading-pill" role="status">
                <XeroIcon emoji="🗺️" size={12} /> Loading isometric map…
              </div>
            )}
          </>
        ) : (
          <IsometricFallbackBlueprint
            volume={volume}
            parcel={parcel}
            displayName={displayName}
            sculptures={hydratedPreviewSculptures.filter((sc) => sc && !sc.hidden && sc.id)}
            onSelectSculpture={onSelectSculpture}
            viewMode={viewMode}
            bearingDeg={liveBearing}
          />
        )}

        {/* Non-overlapping Top HUD Bar: View Mode Switcher + Rotating Compass & 90° Orbit */}
        <div className="land-preview-top-hud" data-testid="land-preview-top-hud">
          <div className="land-preview-mode-group" role="group" aria-label="Preview map angle">
            <button
              type="button"
              className={`land-preview-chip ${viewMode === 'isometric' ? 'is-active' : ''}`}
              aria-pressed={viewMode === 'isometric'}
              onClick={() => handleModeChange('isometric')}
            >
              🧊 Iso
            </button>
            <button
              type="button"
              className={`land-preview-chip ${viewMode === 'context' ? 'is-active' : ''}`}
              aria-pressed={viewMode === 'context'}
              title="Zoom out to see surrounding neighborhood, streets & nearby lands"
              onClick={() => handleModeChange('context')}
            >
              🏙️ Area
            </button>
            <button
              type="button"
              className={`land-preview-chip ${viewMode === 'topdown' ? 'is-active' : ''}`}
              aria-pressed={viewMode === 'topdown'}
              title="North-up top-down footprint plan"
              onClick={() => handleModeChange('topdown')}
            >
              🗺️ 2D
            </button>
          </div>

          <div className="land-preview-compass-group">
            <button
              type="button"
              className="land-preview-chip land-preview-compass"
              data-testid="land-preview-compass-btn"
              aria-label={`Compass heading ${compass.label}. Click to reset isometric view`}
              title={`Facing ${compass.label} (${compass.degrees}°) — click to reset isometric angle`}
              onClick={handleResetCompass}
            >
              <svg
                className="land-preview-compass-icon"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                style={{ transform: `rotate(${-liveBearing}deg)`, transition: 'transform 220ms ease' }}
                aria-hidden="true"
              >
                <polygon points="12,2 15.2,12 12,10.2 8.8,12" fill="#ff1f8f" />
                <polygon points="12,22 15.2,12 12,13.8 8.8,12" fill="rgba(255,255,255,0.45)" />
              </svg>
              <span className="land-preview-compass-label">{compass.label}</span>
            </button>
            <button
              type="button"
              className="land-preview-chip"
              aria-label="Rotate isometric view 90 degrees"
              title="Orbit 90° around your land"
              onClick={handleOrbit90}
            >
              ↻ 90°
            </button>
          </div>
        </div>

        {/* Bottom-Left: Dynamic Geographic Metric Scale Bar */}
        <div
          className="land-preview-scale"
          data-testid="land-preview-scale"
          aria-label={`Map scale: ${scaleBar.label}`}
        >
          <span className="land-preview-scale-text">{scaleBar.label}</span>
          <span className="land-preview-scale-bar" style={{ width: scaleBar.widthPx }} />
        </div>

        {/* Bottom-Right: Refit Button */}
        <button
          type="button"
          className={`land-preview-chip land-preview-refit ${userMovedCamera ? 'is-highlight' : ''}`}
          aria-label="Refit isometric land view"
          title="Snap back to perfectly fitted isometric view"
          onClick={handleRefit}
        >
          🎯 Fit
        </button>

        {/* Directional Edge-Arrow Labels Pointing to Selectable Neighboring Lands */}
        <NeighborEdgeArrowsOverlay
          arrows={neighborArrows}
          onSelectParcel={onSelectParcel}
        />
      </div>

      {/* 3) Structured Geographic Quick-Facts Strip (Coordinates moved to header) */}
      <div className="land-preview-facts is-two-col">
        <div className="land-preview-fact">
          <span className="land-preview-fact-label">3D Footprint</span>
          <span className="land-preview-fact-value mono">{geoSummary.dimensionsLabel}</span>
          <span className="land-preview-fact-sub mono">{geoSummary.volumeLabel}</span>
        </div>
        <div className="land-preview-fact">
          <span className="land-preview-fact-label">Spatial Context</span>
          <span className="land-preview-fact-value mono">
            {geoSummary.distanceFromUserLabel ||
              (geoSummary.nearestOwnedLand
                ? `${geoSummary.nearestOwnedLand.distanceLabel} ${geoSummary.nearestOwnedLand.cardinal} of ${geoSummary.nearestOwnedLand.name}`
                : geoSummary.geohash
                ? `Grid ${geoSummary.geohash}`
                : 'Global Coordinate Lock')}
          </span>
          <span className="land-preview-fact-sub mono">
            {geoSummary.geohash ? `Geohash ${geoSummary.geohash}` : 'Anchored 3D Plot'}
          </span>
        </div>
      </div>

      {/* 4) Geographic Quick Actions */}
      <div className="land-preview-actions">
        {geoSummary.googleMapsUrl && (
          <a
            href={geoSummary.googleMapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-xs"
          >
            <XeroIcon emoji="🧭" size={12} /> Navigate
          </a>
        )}
        {onFocusParcel && (
          <button
            type="button"
            className="btn btn-xs btn-primary"
            onClick={() => onFocusParcel(parcel, volume)}
          >
            🗺️ Open on Map
          </button>
        )}
        <button type="button" className="btn btn-xs btn-outline" onClick={handleCopyCoords}>
          {coordsCopied ? '✓ Coords Copied' : '📋 Copy Coords'}
        </button>
      </div>
    </section>
  );
}
