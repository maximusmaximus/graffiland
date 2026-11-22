import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveLandDisplayName } from '../../../../shared/landVolume.mjs';
import { api, resolveApiUrl } from '../../utils/api.js';
import {
  computeClosestLandsPerimeterFit,
  formatSimpleLandLabel
} from '../../utils/landMapHelpers.js';
import {
  computeIsometricCameraFit,
  computeScaleBarForZoom,
  formatBearingCardinal,
  resolveParcelVolume
} from '../../utils/landPreviewHelpers.js';
import { hasWebGLSupport, loadMapLibre } from '../../utils/loadMapLibre.js';
import {
  computePrismScreenGeometry,
  projectLngLatAltToScreen
} from '../../utils/map3dProjection.js';
import {
  computeFloatingLandLabelBox,
  computeSideArtworkCallouts,
  drawArtworkCalloutLeader,
  drawFloatingCenterArrow,
  drawFloatingLandLabel
} from '../../utils/map3dLabelOverlay.js';
import { buildDefaultHudReservedRects } from '../../utils/canvasLabelLayout.js';
import { createSculptureThreeLayer } from '../../utils/map3dSculptureLayer.js';
import {
  buildNeighborArrowsSignature,
  computeNeighborEdgeArrows
} from '../../utils/neighborEdgeArrows.js';
import { buildSculptures3DGeoJson } from '../../utils/sculpture3dGeoJson.js';
import NeighborEdgeArrowsOverlay from '../NeighborEdgeArrowsOverlay.jsx';
import XeroIcon from '../XeroIcon.jsx';

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
      id: 'mobile-iso-fallback-bg',
      type: 'background',
      paint: { 'background-color': '#0b1020' }
    },
    {
      id: 'mobile-iso-fallback-carto',
      type: 'raster',
      source: 'carto-dark',
      minzoom: 0,
      maxzoom: 22
    }
  ]
};

// Session cache for hydrated sculpture voxel arrays so switching 2D <-> 3D is instant
const voxelHydrationCache = new Map();
const voxelHydrationInFlight = new Set();

function formatCompactMeter(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  if (n < 10) {
    const r = Number(n.toFixed(1));
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  }
  return String(Math.round(n));
}

function parcelVolumeToFeature(parcel, vol, { isSelected = false } = {}) {
  if (!vol || !Array.isArray(vol.ring) || vol.ring.length < 4) return null;
  const isFrozen = Boolean(parcel?.frozen || parcel?.settings?.frozen);
  const isDormant = String(parcel?.stewardStatus || '').toLowerCase() === 'dormant';
  const color = isSelected
    ? isFrozen
      ? '#7dd3fc'
      : '#00f5d4'
    : isDormant
      ? '#ff3e7f'
      : '#ffb703';
  return {
    type: 'Feature',
    properties: {
      parcelId: parcel?.parcelId || vol.parcelId,
      heightMeters: Number(vol.heightMeters || 18),
      baseAltitudeM: Number(vol.baseAltitudeM || 0),
      color,
      isSelected: isSelected ? 1 : 0
    },
    geometry: {
      type: 'Polygon',
      coordinates: [vol.ring]
    }
  };
}

function drawMobilePrismWireframe(
  ctx,
  geom,
  { outerColor, innerColor, lineWidth = 2, glowBlur = 10, dashed = false, showGroundHalo = false }
) {
  if (!geom) return;
  const { bottom, top } = geom;

  if (showGroundHalo) {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 245, 212, 0.12)';
    ctx.beginPath();
    ctx.moveTo(bottom[0].x, bottom[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(bottom[i].x, bottom[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  const strokeEdges = (stroke, width, blur) => {
    ctx.save();
    if (dashed) ctx.setLineDash([5, 4]);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = outerColor;
    ctx.shadowBlur = blur;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = bottom[i];
      const b = bottom[(i + 1) % 4];
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    for (let i = 0; i < 4; i++) {
      const a = top[i];
      const b = top[(i + 1) % 4];
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    for (let i = 0; i < 4; i++) {
      ctx.moveTo(bottom[i].x, bottom[i].y);
      ctx.lineTo(top[i].x, top[i].y);
    }
    ctx.stroke();
    ctx.restore();
  };

  if (!dashed) {
    strokeEdges('rgba(4, 10, 20, 0.72)', lineWidth + 2.6, 2);
  }
  strokeEdges(outerColor, lineWidth + 1.0, glowBlur);
  strokeEdges(innerColor, Math.max(1, lineWidth - 0.5), 0);
}

/**
 * Crisp proportional SVG isometric fallback when WebGL is unavailable (e.g. jsdom / restricted GPUs).
 */
function MobileIsoSvgFallback({
  primaryEntry,
  bearingDeg,
  sculptureCount,
  showcaseMode = false,
  sculptures = [],
  selectedSculptureId = '',
  landSelected = false,
  onSelectLand = null,
  onSelectSculpture = null
}) {
  const vol = primaryEntry?.volume;
  const maxDim = vol
    ? Math.max(1.5, vol.widthMeters, vol.depthMeters, vol.heightMeters)
    : 10;
  const wScale = vol ? Math.max(26, (vol.widthMeters / maxDim) * 78) : 64;
  const dScale = vol ? Math.max(26, (vol.depthMeters / maxDim) * 78) : 64;
  const hScale = vol ? Math.max(22, (vol.heightMeters / maxDim) * 72) : 52;
  const cx = 180;
  const cy = 140;

  const iso = (x, y, z) => [cx + (x - y) * 0.866, cy + (x + y) * 0.5 - z];
  const hw = wScale / 2;
  const hd = dScale / 2;
  const b = [
    iso(-hw, -hd, 0),
    iso(hw, -hd, 0),
    iso(hw, hd, 0),
    iso(-hw, hd, 0)
  ];
  const t = [
    iso(-hw, -hd, hScale),
    iso(hw, -hd, hScale),
    iso(hw, hd, hScale),
    iso(-hw, hd, hScale)
  ];

  // Inner 10%-padded object silhouette centered inside the prism
  const objHw = hw / 1.2;
  const objHd = hd / 1.2;
  const objBase = (hScale - hScale / 1.2) / 2;
  const objTop = objBase + hScale / 1.2;
  const ob = [
    iso(-objHw, -objHd, objBase),
    iso(objHw, -objHd, objBase),
    iso(objHw, objHd, objBase),
    iso(-objHw, objHd, objBase)
  ];
  const ot = [
    iso(-objHw, -objHd, objTop),
    iso(objHw, -objHd, objTop),
    iso(objHw, objHd, objTop),
    iso(-objHw, objHd, objTop)
  ];

  const pts = (arr) => arr.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const isFrozen = Boolean(primaryEntry?.parcel?.frozen || primaryEntry?.parcel?.settings?.frozen);
  const stroke = isFrozen ? '#7dd3fc' : '#00f5d4';
  const fill = isFrozen ? 'rgba(125, 211, 252, 0.16)' : 'rgba(0, 245, 212, 0.14)';
  const landName = primaryEntry
    ? showcaseMode
      ? resolveLandDisplayName(primaryEntry.parcel, { defaultName: 'Virtual Land' })
      : formatSimpleLandLabel(primaryEntry.parcel)
    : '3D Isometric Land';
  const label = vol
    ? `${landName} · ${formatCompactMeter(
        vol.widthMeters
      )}×${formatCompactMeter(vol.depthMeters)}×${formatCompactMeter(vol.heightMeters)}m`
    : '3D Isometric Land View';

  const fallbackCallouts = showcaseMode
    ? computeSideArtworkCallouts({
        sculptures,
        volume: vol,
        viewportWidth: 360,
        viewportHeight: 220,
        selectedSculptureId,
        topInsetPx: 54,
        bottomInsetPx: 38,
        marginPx: 8,
        labelHeight: 32,
        gapPx: 6,
        projectScreenPt: (_lng, _lat, _alt, _sc, idx, total) => {
          const frac = total <= 1 ? 0 : idx / (total - 1) - 0.5;
          return {
            x: cx + frac * objHw * 0.9,
            y: cy - hScale * 0.45 + (idx % 2 === 0 ? -6 : 6)
          };
        }
      })
    : [];

  return (
    <div className="mobile-iso-fallback" data-testid="mobile-iso-svg-fallback">
      <svg viewBox="0 0 360 220" width="100%" height="100%" aria-hidden="true">
        <defs>
          <pattern id="mobileIsoGrid" width="22" height="22" patternUnits="userSpaceOnUse">
            <path
              d="M 22 0 L 0 0 0 22"
              fill="none"
              stroke="rgba(148,163,184,0.12)"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect width="360" height="220" fill="url(#mobileIsoGrid)" />
        <polygon points={pts(b)} fill={fill} stroke={stroke} strokeWidth="1.8" />
        {sculptureCount > 0 && (
          <>
            <polygon
              points={pts(ob)}
              fill="rgba(255, 62, 127, 0.35)"
              stroke="#ff3e7f"
              strokeWidth="1.1"
            />
            <polygon
              points={pts([ob[1], ob[2], ot[2], ot[1]])}
              fill="rgba(255, 209, 102, 0.48)"
              stroke="#ffd166"
              strokeWidth="1"
            />
            <polygon
              points={pts([ob[2], ob[3], ot[3], ot[2]])}
              fill="rgba(255, 62, 127, 0.45)"
              stroke="#ff7eb3"
              strokeWidth="1"
            />
            <polygon
              points={pts(ot)}
              fill="rgba(255, 209, 102, 0.65)"
              stroke="#fff3c4"
              strokeWidth="1.1"
            />
          </>
        )}
        <polygon
          points={pts([b[1], b[2], t[2], t[1]])}
          fill={fill}
          stroke={stroke}
          strokeWidth="1.3"
          opacity="0.82"
        />
        <polygon
          points={pts([b[2], b[3], t[3], t[2]])}
          fill={fill}
          stroke={stroke}
          strokeWidth="1.3"
          opacity="0.62"
        />
        <polygon points={pts(t)} fill={fill} stroke="#eafffc" strokeWidth="1.8" />
        <line
          x1={b[0][0]}
          y1={b[0][1]}
          x2={t[0][0]}
          y2={t[0][1]}
          stroke={stroke}
          strokeWidth="1.1"
          strokeDasharray="3 3"
          opacity="0.7"
        />
        {showcaseMode ? (
          <>
            <line
              x1={cx}
              y1={40}
              x2={cx}
              y2={cy}
              stroke={landSelected ? '#ffd166' : stroke}
              strokeWidth="1.4"
            />
            <circle cx={cx} cy={cy} r="2.6" fill="#ffffff" />
            {fallbackCallouts.map((c) => (
              <g key={c.sculptureId}>
                <polyline
                  points={`${c.fromX},${c.fromY} ${c.elbowX},${c.elbowY} ${c.targetX},${c.targetY}`}
                  fill="none"
                  stroke={c.isSelected ? '#ffd166' : '#00f5d4'}
                  strokeWidth={c.isSelected ? '1.8' : '1.25'}
                />
                <circle
                  cx={c.targetX}
                  cy={c.targetY}
                  r={c.isSelected ? '3.4' : '2.4'}
                  fill={c.isSelected ? '#ffd166' : '#eafffc'}
                />
              </g>
            ))}
          </>
        ) : (
          <text
            x={cx}
            y={Math.max(24, t[0][1] - 10)}
            textAnchor="middle"
            fill="#eafffc"
            fontSize="11"
            fontFamily="monospace"
            fontWeight="700"
          >
            {`${label} · ${Math.round(bearingDeg)}°`}
          </text>
        )}
      </svg>

      {showcaseMode && (
        <div className="plot-iso-callout-layer" data-testid="plot-iso-callout-layer">
          {primaryEntry && (
            <button
              type="button"
              className={`plot-iso-land-label-btn ${landSelected ? 'is-selected' : ''}`}
              data-testid="plot-land-label"
              style={{ left: '50%', top: 12, transform: 'translateX(-50%)' }}
              onClick={() => onSelectLand?.(primaryEntry.parcel)}
            >
              <span className="plot-iso-land-dot" aria-hidden="true" />
              <span>{landName}</span>
            </button>
          )}
          {fallbackCallouts.map((c) => (
            <button
              key={c.sculptureId}
              type="button"
              className={`plot-iso-artwork-callout is-${c.side} ${c.isSelected ? 'is-selected' : ''}`}
              data-testid="plot-artwork-label"
              data-sculpture-id={c.sculptureId}
              data-callout-side={c.side}
              style={{
                left: c.side === 'left' ? 8 : undefined,
                right: c.side === 'right' ? 8 : undefined,
                top: `${Math.round((c.y / 220) * 100)}%`
              }}
              onClick={() => onSelectSculpture?.(c.sculpture)}
            >
              <span className="plot-iso-callout-title">{c.title}</span>
              <span className="plot-iso-callout-meta mono">{c.subtitle}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MobileIsometricMap({
  parcels = [],
  sculptures = [],
  userLocation = null,
  selectedParcelId = '',
  selectedSculptureId = '',
  focusParcelTick = 0,
  isFullExpanded = false,
  showcaseMode = false,
  landSelected = false,
  onToggle2D,
  onToggleFullMap = null,
  onSelectParcel = null,
  onSelectLand = null,
  onSelectSculpture = null
}) {
  const rootRef = useRef(null);
  const mapHostRef = useRef(null);
  const wireCanvasRef = useRef(null);
  const mapRef = useRef(null);
  const maplibreRef = useRef(null);
  const styleReadyRef = useRef(false);
  const fallbackAppliedRef = useRef(false);
  const userMovedRef = useRef(false);
  const suppressMoveFlagRef = useRef(false);

  const [webglAvailable, setWebglAvailable] = useState(() => hasWebGLSupport());
  const [mapReady, setMapReady] = useState(false);
  const [bearingOffset, setBearingOffset] = useState(0);
  const [liveBearing, setLiveBearing] = useState(-45);
  const [liveZoom, setLiveZoom] = useState(19);
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const [loadedThree3dCount, setLoadedThree3dCount] = useState(0);
  const [neighborArrows, setNeighborArrows] = useState([]);
  const [stageDims, setStageDims] = useState({ width: 360, height: 240 });
  const neighborArrowsSigRef = useRef('');
  const threeLayerRef = useRef(null);
  const landLabelBtnRef = useRef(null);
  const calloutBtnMapRef = useRef(new Map());
  const latestCalloutsRef = useRef([]);
  const showcaseModeRef = useRef(showcaseMode);
  const landSelectedRef = useRef(landSelected);
  const onSelectLandRef = useRef(onSelectLand);

  useEffect(() => {
    showcaseModeRef.current = showcaseMode;
    landSelectedRef.current = landSelected;
    onSelectLandRef.current = onSelectLand;
  }, [landSelected, onSelectLand, showcaseMode]);

  // Resolve 3D volumes for all parcels
  const resolvedEntries = useMemo(() => {
    const out = [];
    for (let i = 0; i < (parcels || []).length; i++) {
      const p = parcels[i];
      if (!p?.parcelId) continue;
      const vol = resolveParcelVolume(p);
      if (vol) out.push({ parcel: p, volume: vol, rankIndex: i });
    }
    return out;
  }, [parcels]);

  const effectiveSelectedId = useMemo(() => {
    if (selectedParcelId && resolvedEntries.some((e) => e.parcel.parcelId === selectedParcelId)) {
      return selectedParcelId;
    }
    const scParcelId = sculptures.find((s) => s.id === selectedSculptureId)?.parcelId || '';
    if (scParcelId && resolvedEntries.some((e) => e.parcel.parcelId === scParcelId)) {
      return scParcelId;
    }
    return resolvedEntries[0]?.parcel?.parcelId || '';
  }, [resolvedEntries, sculptures, selectedParcelId, selectedSculptureId]);

  const primaryEntry = useMemo(
    () =>
      resolvedEntries.find((e) => e.parcel.parcelId === effectiveSelectedId) ||
      resolvedEntries[0] ||
      null,
    [effectiveSelectedId, resolvedEntries]
  );

  const otherEntries = useMemo(
    () =>
      resolvedEntries.filter(
        (e) => e.parcel.parcelId && e.parcel.parcelId !== primaryEntry?.parcel?.parcelId
      ),
    [primaryEntry?.parcel?.parcelId, resolvedEntries]
  );

  // Merge cached full voxel arrays into sculptures so drawn objects render in full 3D inside their land
  const hydratedSculptures = useMemo(() => {
    void hydrationVersion;
    return (sculptures || []).map((sc) => {
      if (!sc || !sc.id) return sc;
      if (Array.isArray(sc.voxels) && sc.voxels.length > 0) return sc;
      const cached = voxelHydrationCache.get(sc.id);
      if (Array.isArray(cached) && cached.length > 0) {
        return { ...sc, voxels: cached };
      }
      return sc;
    });
  }, [sculptures, hydrationVersion]);

  // Lazily hydrate voxels for the focused land and top nearby sculptures when entering 3D map
  useEffect(() => {
    const primaryPid = primaryEntry?.parcel?.parcelId || '';
    const prioritized = [...(sculptures || [])].sort((a, b) => {
      const aMatch = a?.parcelId === primaryPid ? 1 : 0;
      const bMatch = b?.parcelId === primaryPid ? 1 : 0;
      return bMatch - aMatch;
    });

    const targets = prioritized
      .filter(
        (sc) =>
          sc &&
          sc.id &&
          !sc.hidden &&
          sc.modelType !== 'custom-3d' &&
          (!Array.isArray(sc.voxels) || sc.voxels.length === 0) &&
          !voxelHydrationCache.has(sc.id) &&
          !voxelHydrationInFlight.has(sc.id)
      )
      .slice(0, 6);

    if (targets.length === 0) return undefined;
    let cancelled = false;

    for (const sc of targets) {
      voxelHydrationInFlight.add(sc.id);
      api
        .getSculpture(sc.id)
        .then((res) => {
          const voxels = res?.sculpture?.voxels;
          if (Array.isArray(voxels) && voxels.length > 0) {
            voxelHydrationCache.set(sc.id, voxels);
            if (!cancelled) setHydrationVersion((v) => v + 1);
          }
        })
        .catch(() => {})
        .finally(() => {
          voxelHydrationInFlight.delete(sc.id);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [primaryEntry?.parcel?.parcelId, sculptures]);

  // Synchronous refs for MapLibre render callbacks
  const entriesRef = useRef(resolvedEntries);
  const effectiveSelectedIdRef = useRef(effectiveSelectedId);
  const primaryEntryRef = useRef(primaryEntry);
  const otherEntriesRef = useRef(otherEntries);
  const hydratedSculpturesRef = useRef(hydratedSculptures);
  const selectedSculptureIdRef = useRef(selectedSculptureId);
  const userLocationRef = useRef(userLocation);
  const bearingOffsetRef = useRef(bearingOffset);
  const onSelectParcelRef = useRef(onSelectParcel);
  const onSelectSculptureRef = useRef(onSelectSculpture);

  useEffect(() => {
    entriesRef.current = resolvedEntries;
    effectiveSelectedIdRef.current = effectiveSelectedId;
    primaryEntryRef.current = primaryEntry;
    otherEntriesRef.current = otherEntries;
  }, [effectiveSelectedId, otherEntries, primaryEntry, resolvedEntries]);
  useEffect(() => {
    hydratedSculpturesRef.current = hydratedSculptures;
    selectedSculptureIdRef.current = selectedSculptureId;
  }, [hydratedSculptures, selectedSculptureId]);
  useEffect(() => {
    userLocationRef.current = userLocation;
  }, [userLocation]);
  useEffect(() => {
    bearingOffsetRef.current = bearingOffset;
  }, [bearingOffset]);
  useEffect(() => {
    onSelectParcelRef.current = onSelectParcel;
    onSelectSculptureRef.current = onSelectSculpture;
  }, [onSelectParcel, onSelectSculpture]);

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

    const primary = primaryEntryRef.current;

    // Pass 1: Draw ONLY the focused land wireframe (never draw neighboring lands' wireframe lines)
    const pendingLabels = [];
    let primaryGeom = null;
    let primaryOuterColor = '#00f5d4';
    let primaryInnerColor = '#eafffc';

    if (primary?.volume) {
      const geom = computePrismScreenGeometry(map, maplibregl, primary.volume);
      if (geom) {
        const isFrozen = Boolean(primary.parcel?.frozen || primary.parcel?.settings?.frozen);
        const simpleLabel = formatSimpleLandLabel(
          primary.parcel,
          showcaseModeRef.current ? null : primary.rankIndex
        );
        const dims = `${formatCompactMeter(primary.volume.widthMeters)}×${formatCompactMeter(
          primary.volume.depthMeters
        )}×${formatCompactMeter(primary.volume.heightMeters)}m`;
        const outerColor =
          landSelectedRef.current && showcaseModeRef.current
            ? '#ffd166'
            : isFrozen
              ? '#7dd3fc'
              : '#00f5d4';
        const innerColor =
          landSelectedRef.current && showcaseModeRef.current
            ? '#fff3c4'
            : isFrozen
              ? '#e0f2fe'
              : '#eafffc';

        drawMobilePrismWireframe(ctx, geom, {
          outerColor,
          innerColor,
          lineWidth: 2.2,
          glowBlur: 13,
          dashed: false,
          showGroundHalo: true
        });

        primaryGeom = geom;
        primaryOuterColor = outerColor;
        primaryInnerColor = innerColor;

        if (!showcaseModeRef.current) {
          pendingLabels.push({
            geom,
            outerColor,
            innerColor,
            label: `${simpleLabel} · ${dims}`,
            liftPx: 20,
            minY: 52,
            isPrimary: true
          });
        }
      }
    }

    // Measure HUD controls inside the mobile map viewport so floating labels & neighbor arrows never collide
    const measuredHudRects = [];
    const stageEl = rootRef.current;
    if (stageEl && typeof stageEl.getBoundingClientRect === 'function') {
      const stageRect = stageEl.getBoundingClientRect();
      stageEl
        .querySelectorAll(
          '.mobile-iso-fab-row, .mobile-iso-hud-left, .mobile-iso-hud-right, .mobile-iso-hud-bottom, .mobile-map-top-controls'
        )
        .forEach((node) => {
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

    // Pass 2: Draw primary land label strictly ON TOP of its wireframe
    for (const item of pendingLabels) {
      drawFloatingLandLabel(ctx, item.geom, {
        ...item,
        stageWidth: w,
        stageHeight: h,
        reservedRects,
        placedRects
      });
    }

    // Pass 3 (Showcase Mode): Position clickable floating Land Label & Left/Right Side Artwork Labels + elbow pointers
    if (showcaseModeRef.current) {
      const landBtn = landLabelBtnRef.current;
      if (primaryGeom) {
        const approxW = landBtn?.offsetWidth || 168;
        const landBox = computeFloatingLandLabelBox(primaryGeom, {
          viewportWidth: w,
          liftPx: 20,
          minY: w < 520 ? 56 : 46,
          pillHeight: 28,
          approxWidth: approxW
        });
        if (landBox) {
          drawFloatingCenterArrow(ctx, {
            fromX: landBox.fromX,
            fromY: landBox.fromY,
            toX: landBox.toX,
            toY: landBox.toY,
            color: primaryOuterColor,
            dotColor: primaryInnerColor
          });
          if (landBtn) {
            landBtn.style.left = `${Math.round(landBox.centerX)}px`;
            landBtn.style.top = `${Math.round(landBox.y)}px`;
            landBtn.style.display = 'inline-flex';
          }
          placedRects.push({
            x: landBox.centerX - approxW / 2,
            y: landBox.y,
            w: approxW,
            h: 30
          });
        } else if (landBtn) {
          landBtn.style.display = 'none';
        }
      } else if (landBtn) {
        landBtn.style.display = 'none';
      }

      const activeVol = primaryEntryRef.current?.volume || null;
      const callouts = computeSideArtworkCallouts({
        sculptures: hydratedSculpturesRef.current || [],
        volume: activeVol,
        viewportWidth: w,
        viewportHeight: h,
        selectedSculptureId: selectedSculptureIdRef.current || '',
        topInsetPx: w < 520 ? 76 : 66,
        bottomInsetPx: 46,
        marginPx: w < 520 ? 8 : 14,
        labelHeight: w < 520 ? 34 : 40,
        gapPx: 8,
        projectScreenPt: (lng, lat, alt) =>
          projectLngLatAltToScreen(map, maplibregl, lng, lat, alt)
      });
      latestCalloutsRef.current = callouts;

      const positionedIds = new Set();
      for (const c of callouts) {
        drawArtworkCalloutLeader(ctx, c);
        positionedIds.add(c.sculptureId);
        placedRects.push({
          x: c.x,
          y: c.y,
          w: c.width,
          h: c.height || (w < 520 ? 36 : 42)
        });
        const btn = calloutBtnMapRef.current.get(c.sculptureId);
        if (btn) {
          btn.style.left = `${c.x}px`;
          btn.style.top = `${c.y}px`;
          btn.style.width = `${c.width}px`;
          btn.style.display = 'flex';
          btn.dataset.calloutSide = c.side;
          btn.classList.toggle('is-left', c.side === 'left');
          btn.classList.toggle('is-right', c.side === 'right');
        }
      }
      for (const [id, btn] of calloutBtnMapRef.current.entries()) {
        if (!positionedIds.has(id) && btn) {
          btn.style.display = 'none';
        }
      }
    }

    // Pass 4: Compute directional edge-arrow labels pointing to selectable neighboring lands
    const prismAvoidRects = [];
    if (primaryGeom) {
      const pts = [...primaryGeom.bottom, ...primaryGeom.top];
      const minX = Math.min(...pts.map((p) => p.x));
      const maxX = Math.max(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y));
      const maxY = Math.max(...pts.map((p) => p.y));
      if (Number.isFinite(minX) && Number.isFinite(maxX) && maxX > minX && maxY > minY) {
        prismAvoidRects.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
      }
    }
    const nextArrows = primary?.volume
      ? computeNeighborEdgeArrows({
          focusedEntry: primary,
          otherEntries: otherEntriesRef.current || [],
          projectLngLat: (lng, lat) => map.project([lng, lat]),
          viewportWidth: w,
          viewportHeight: h,
          bearingDeg: typeof map.getBearing === 'function' ? map.getBearing() : 0,
          reservedRects: [...reservedRects, ...placedRects],
          avoidRects: prismAvoidRects,
          maxArrows: showcaseModeRef.current ? 2 : null
        })
      : [];
    const nextSig = buildNeighborArrowsSignature(nextArrows);
    if (nextSig !== neighborArrowsSigRef.current) {
      neighborArrowsSigRef.current = nextSig;
      setNeighborArrows(nextArrows);
    }
  }, []);

  const syncMapSources = useCallback(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;

    const primary = primaryEntryRef.current;
    // When focused on a land, NEVER render extrusion prisms or lines for other lands
    const focusedEntries = primary ? [primary] : [];
    const landFeatures = focusedEntries
      .map((entry) =>
        parcelVolumeToFeature(entry.parcel, entry.volume, {
          isSelected: true
        })
      )
      .filter(Boolean);

    const parcelsWithVolumes = focusedEntries.map((e) => ({ ...e.parcel, volume: e.volume }));
    const focusedPid = primary?.parcel?.parcelId || '';
    const focusedSculptures = focusedPid
      ? (hydratedSculpturesRef.current || []).filter(
          (s) => !s?.parcelId || s.parcelId === focusedPid
        )
      : hydratedSculpturesRef.current || [];
    const sc3d = buildSculptures3DGeoJson(
      focusedSculptures,
      selectedSculptureIdRef.current || '',
      parcelsWithVolumes
    );

    const landSrc = map.getSource('mobile-iso-lands');
    if (landSrc && typeof landSrc.setData === 'function') {
      landSrc.setData({ type: 'FeatureCollection', features: landFeatures });
    }

    const scSrc = map.getSource('mobile-iso-sculptures');
    if (scSrc && typeof scSrc.setData === 'function') {
      scSrc.setData(sc3d.geojson);
    }
    if (threeLayerRef.current && typeof threeLayerRef.current.setData === 'function') {
      threeLayerRef.current.setData({
        sculptures: focusedSculptures,
        parcels: parcelsWithVolumes,
        selectedSculptureId: selectedSculptureIdRef.current || ''
      });
    }

    const uLoc = userLocationRef.current;
    const userFeatures =
      uLoc && Number.isFinite(Number(uLoc.lat)) && Number.isFinite(Number(uLoc.lng))
        ? [
            {
              type: 'Feature',
              properties: { label: 'You' },
              geometry: {
                type: 'Point',
                coordinates: [Number(uLoc.lng), Number(uLoc.lat)]
              }
            }
          ]
        : [];
    const userSrc = map.getSource('mobile-iso-user');
    if (userSrc && typeof userSrc.setData === 'function') {
      userSrc.setData({ type: 'FeatureCollection', features: userFeatures });
    }

    drawWireframes();
  }, [drawWireframes]);

  const fitCameraToTarget = useCallback(
    ({ targetEntry = null, offsetDeg = null, animate = true, fitCluster = false } = {}) => {
      const map = mapRef.current;
      const entry = targetEntry || primaryEntryRef.current;
      const effOffset = offsetDeg !== null ? offsetDeg : bearingOffsetRef.current;

      if (!entry?.volume) return;

      const hostCanvas = map?.getCanvas?.();
      const vw = hostCanvas?.clientWidth || rootRef.current?.clientWidth || 360;
      const vh = hostCanvas?.clientHeight || rootRef.current?.clientHeight || 240;

      // Single land or explicit parcel focus -> exact isometric camera fit accounting for 3D Z-height
      if (!fitCluster || (entriesRef.current || []).length <= 1) {
        const fit = computeIsometricCameraFit(entry.volume, {
          viewportWidth: vw,
          viewportHeight: vh,
          viewMode: 'isometric',
          bearingOffsetDeg: effOffset
        });
        if (!fit) return;
        setLiveBearing(fit.bearing);
        setLiveZoom(fit.zoom);
        if (!map) return;

        suppressMoveFlagRef.current = true;
        const opts = {
          center: fit.center,
          zoom: fit.zoom,
          pitch: fit.pitch,
          bearing: fit.bearing,
          padding: {
            top: Math.max(fit.padding.top, showcaseModeRef.current && vw < 520 ? 86 : 60),
            bottom: Math.max(fit.padding.bottom, 28),
            left: 16,
            right: 16
          }
        };
        if (animate) {
          map.easeTo({ ...opts, duration: 520, essential: true });
        } else {
          map.jumpTo(opts);
        }
        setTimeout(() => {
          suppressMoveFlagRef.current = false;
        }, animate ? 560 : 80);
        return;
      }

      // Multi-land cluster fit at isometric tilt
      const closest = computeClosestLandsPerimeterFit({
        parcels: (entriesRef.current || []).map((e) => ({ ...e.parcel, volume: e.volume })),
        sculptures: hydratedSculpturesRef.current || [],
        location: userLocationRef.current
      });
      if (closest?.boundsLngLat && map) {
        const fitBearing = -45 + effOffset;
        suppressMoveFlagRef.current = true;
        map.fitBounds(closest.boundsLngLat, {
          padding: { top: 52, bottom: 32, left: 24, right: 24 },
          pitch: 55,
          bearing: fitBearing,
          maxZoom: 21.2,
          duration: animate ? 520 : 0
        });
        setTimeout(() => {
          suppressMoveFlagRef.current = false;
        }, animate ? 560 : 80);
      }
    },
    []
  );

  // Mount MapLibre GL 3D isometric map
  useEffect(() => {
    if (!webglAvailable || !mapHostRef.current) return undefined;
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
        // fallback raster style has no building-3d layer
      }

      try {
        if (!map.getSource('mobile-iso-lands')) {
          map.addSource('mobile-iso-lands', { type: 'geojson', data: EMPTY_FC });
        }
        if (!map.getLayer('mobile-iso-lands-extrusion')) {
          map.addLayer({
            id: 'mobile-iso-lands-extrusion',
            type: 'fill-extrusion',
            source: 'mobile-iso-lands',
            paint: {
              'fill-extrusion-color': ['get', 'color'],
              'fill-extrusion-height': ['get', 'heightMeters'],
              'fill-extrusion-base': ['get', 'baseAltitudeM'],
              'fill-extrusion-opacity': [
                'case',
                ['==', ['get', 'isSelected'], 1],
                0.08,
                0.06
              ]
            }
          });
        }

        // Mount real un-pixelated Three.js 3D models BEFORE translucent land prisms
        let threeMounted = Boolean(map.getLayer('mobile-iso-sculptures-three-3d'));
        if (!threeMounted && maplibreRef.current) {
          try {
            const threeLayer = createSculptureThreeLayer({
              id: 'mobile-iso-sculptures-three-3d',
              maplibregl: maplibreRef.current,
              resolveUrlFn: resolveApiUrl,
              onStatsChange: (stats) => setLoadedThree3dCount(stats?.loadedCount || 0)
            });
            threeLayerRef.current = threeLayer;
            map.addLayer(
              threeLayer,
              map.getLayer('mobile-iso-lands-extrusion') ? 'mobile-iso-lands-extrusion' : undefined
            );
            threeMounted = Boolean(map.getLayer('mobile-iso-sculptures-three-3d'));
          } catch {
            threeLayerRef.current = null;
            threeMounted = false;
          }
        }

        if (!map.getSource('mobile-iso-sculptures')) {
          map.addSource('mobile-iso-sculptures', { type: 'geojson', data: EMPTY_FC });
        }
        if (!map.getLayer('mobile-iso-sculptures-extrusion')) {
          map.addLayer({
            id: 'mobile-iso-sculptures-extrusion',
            type: 'fill-extrusion',
            source: 'mobile-iso-sculptures',
            paint: {
              'fill-extrusion-color': ['get', 'color'],
              'fill-extrusion-height': ['get', 'heightMeters'],
              'fill-extrusion-base': ['get', 'baseMeters'],
              'fill-extrusion-opacity': threeMounted ? 0.001 : 0.96,
              'fill-extrusion-vertical-gradient': true
            }
          });
        }

        if (!map.getSource('mobile-iso-user')) {
          map.addSource('mobile-iso-user', { type: 'geojson', data: EMPTY_FC });
        }
        if (!map.getLayer('mobile-iso-user-halo')) {
          map.addLayer({
            id: 'mobile-iso-user-halo',
            type: 'circle',
            source: 'mobile-iso-user',
            paint: {
              'circle-radius': 11,
              'circle-color': 'rgba(0, 245, 212, 0.28)',
              'circle-stroke-width': 0
            }
          });
        }
        if (!map.getLayer('mobile-iso-user-dot')) {
          map.addLayer({
            id: 'mobile-iso-user-dot',
            type: 'circle',
            source: 'mobile-iso-user',
            paint: {
              'circle-radius': 5.5,
              'circle-color': '#00f5d4',
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2
            }
          });
        }
      } catch {
        // style mid-transition; style.load will re-run
      }

      syncMapSources();
    };

    loadMapLibre()
      .then((maplibregl) => {
        if (cancelled || !mapHostRef.current) return;
        maplibreRef.current = maplibregl;

        const initVol = primaryEntryRef.current?.volume;
        const initLoc = userLocationRef.current;
        const vw = rootRef.current?.clientWidth || 360;
        const vh = rootRef.current?.clientHeight || 220;
        const initFit = initVol
          ? computeIsometricCameraFit(initVol, {
              viewportWidth: vw,
              viewportHeight: vh,
              viewMode: 'isometric',
              bearingOffsetDeg: bearingOffsetRef.current
            })
          : null;

        const fallbackCenter =
          initLoc && Number.isFinite(Number(initLoc.lat)) && Number.isFinite(Number(initLoc.lng))
            ? [Number(initLoc.lng), Number(initLoc.lat)]
            : [-122.4194, 37.7749];

        let map;
        try {
          map = new maplibregl.Map({
            container: mapHostRef.current,
            style: OPENFREEMAP_LIBERTY_STYLE,
            center: initFit?.center || fallbackCenter,
            zoom: initFit?.zoom ?? 16.5,
            pitch: initFit?.pitch ?? 55,
            bearing: initFit?.bearing ?? -45,
            minZoom: 3,
            maxZoom: 22.5,
            maxPitch: 72,
            antialias: true,
            attributionControl: false,
            dragRotate: true,
            pitchWithRotate: true,
            touchPitch: true,
            touchZoomRotate: true
          });
        } catch {
          setWebglAvailable(false);
          return;
        }

        mapRef.current = map;
        if (initFit) {
          setLiveBearing(initFit.bearing);
          setLiveZoom(initFit.zoom);
        }

        map.on('style.load', () => {
          ensureLayers(map);
          setMapReady(true);
        });

        map.on('load', () => {
          ensureLayers(map);
          setMapReady(true);
          if (!userMovedRef.current && primaryEntryRef.current) {
            fitCameraToTarget({ targetEntry: primaryEntryRef.current, animate: false });
          }
        });

        map.on('error', () => {
          if (!styleReadyRef.current && !fallbackAppliedRef.current) {
            fallbackAppliedRef.current = true;
            try {
              map.setStyle(FALLBACK_DARK_STYLE);
            } catch {
              setWebglAvailable(false);
            }
          }
        });

        map.on('move', () => {
          drawWireframes();
          if (!suppressMoveFlagRef.current) {
            userMovedRef.current = true;
          }
        });

        map.on('moveend', () => {
          setLiveBearing(Number(map.getBearing().toFixed(1)));
          setLiveZoom(Number(map.getZoom().toFixed(2)));
          drawWireframes();
        });

        map.on('render', drawWireframes);

        // Tap a 3D sculpture or land prism to select it
        map.on('click', (e) => {
          try {
            if (map.getLayer('mobile-iso-sculptures-extrusion')) {
              const scHits = map.queryRenderedFeatures(e.point, {
                layers: ['mobile-iso-sculptures-extrusion']
              });
              const scId = scHits?.[0]?.properties?.sculptureId;
              if (scId && onSelectSculptureRef.current) {
                const matchSc = (hydratedSculpturesRef.current || []).find((s) => s.id === scId);
                if (matchSc) {
                  onSelectSculptureRef.current(matchSc);
                  return;
                }
              }
            }
            // In showcase mode, also pick any 3D artwork whose projected anchor is right under the click
            if (showcaseModeRef.current && onSelectSculptureRef.current && latestCalloutsRef.current.length > 0) {
              let best = null;
              let bestDist = 30;
              for (const c of latestCalloutsRef.current) {
                const d = Math.hypot(e.point.x - c.targetX, e.point.y - c.targetY);
                if (d < bestDist) {
                  bestDist = d;
                  best = c;
                }
              }
              if (best?.sculpture) {
                onSelectSculptureRef.current(best.sculpture);
                return;
              }
            }
            if (map.getLayer('mobile-iso-lands-extrusion')) {
              const landHits = map.queryRenderedFeatures(e.point, {
                layers: ['mobile-iso-lands-extrusion']
              });
              const pid = landHits?.[0]?.properties?.parcelId;
              if (pid) {
                const matchEntry = (entriesRef.current || []).find(
                  (entry) => entry.parcel.parcelId === pid
                );
                if (matchEntry) {
                  if (showcaseModeRef.current && onSelectLandRef.current) {
                    onSelectLandRef.current(matchEntry.parcel);
                  } else if (onSelectParcelRef.current) {
                    onSelectParcelRef.current(matchEntry.parcel);
                  }
                }
              }
            }
          } catch {
            // ignore query errors while layers initialize
          }
        });
      })
      .catch(() => {
        if (!cancelled) setWebglAvailable(false);
      });

    return () => {
      cancelled = true;
      styleReadyRef.current = false;
      fallbackAppliedRef.current = false;
      if (mapRef.current) {
        try {
          mapRef.current.remove();
        } catch {
          // ignore cleanup errors
        }
        mapRef.current = null;
      }
      setMapReady(false);
    };
  }, [drawWireframes, fitCameraToTarget, syncMapSources, webglAvailable]);

  // Keep GeoJSON sources & showcase callouts synced when parcels, sculptures, hydration, or selection change
  useEffect(() => {
    syncMapSources();
  }, [resolvedEntries, effectiveSelectedId, hydratedSculptures, selectedSculptureId, landSelected, showcaseMode, userLocation, syncMapSources]);

  // Smoothly re-frame whenever user picks a land or taps Focus Map / 3D on a land card
  useEffect(() => {
    if (!primaryEntry?.volume) return;
    if (focusParcelTick > 0 || !userMovedRef.current) {
      userMovedRef.current = false;
      fitCameraToTarget({ targetEntry: primaryEntry, animate: focusParcelTick > 0 });
    }
  }, [focusParcelTick, primaryEntry, fitCameraToTarget]);

  // Resize MapLibre cleanly whenever container height switches between compact & full-screen
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        setStageDims({ width: Math.round(rect.width), height: Math.round(rect.height) });
      }
      const map = mapRef.current;
      if (!map) return;
      map.resize();
      drawWireframes();
      if (!userMovedRef.current && primaryEntryRef.current) {
        fitCameraToTarget({ targetEntry: primaryEntryRef.current, animate: false });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [drawWireframes, fitCameraToTarget]);

  // Compute neighbor edge arrows for SVG fallback mode (and before initial WebGL paint)
  useEffect(() => {
    if (webglAvailable && mapReady) return;
    if (!primaryEntry?.volume) {
      if (neighborArrowsSigRef.current !== '') {
        neighborArrowsSigRef.current = '';
        setNeighborArrows([]);
      }
      return;
    }
    const vw = stageDims.width || 360;
    const vh = stageDims.height || 240;
    const reservedRects = buildDefaultHudReservedRects({ stageWidth: vw, stageHeight: vh });
    const nextArrows = computeNeighborEdgeArrows({
      focusedEntry: primaryEntry,
      otherEntries,
      viewportWidth: vw,
      viewportHeight: vh,
      bearingDeg: liveBearing,
      reservedRects,
      maxArrows: showcaseMode ? 2 : null
    });
    const nextSig = buildNeighborArrowsSignature(nextArrows);
    if (nextSig !== neighborArrowsSigRef.current) {
      neighborArrowsSigRef.current = nextSig;
      setNeighborArrows(nextArrows);
    }
  }, [webglAvailable, mapReady, primaryEntry, otherEntries, stageDims.width, stageDims.height, liveBearing, showcaseMode]);

  // Extra resize pulse when isFullExpanded toggles on mobile
  useEffect(() => {
    const t = setTimeout(() => {
      if (mapRef.current) {
        mapRef.current.resize();
        drawWireframes();
        if (!userMovedRef.current && primaryEntryRef.current) {
          fitCameraToTarget({ targetEntry: primaryEntryRef.current, animate: true });
        }
      }
    }, 80);
    return () => clearTimeout(t);
  }, [isFullExpanded, drawWireframes, fitCameraToTarget]);

  function handleOrbit90() {
    const nextOffset = (bearingOffset + 90) % 360;
    setBearingOffset(nextOffset);
    userMovedRef.current = false;
    fitCameraToTarget({ targetEntry: primaryEntry, offsetDeg: nextOffset, animate: true });
  }

  function handleFitLand() {
    userMovedRef.current = false;
    fitCameraToTarget({ targetEntry: primaryEntry, animate: true });
  }

  function handleCenterMe() {
    const map = mapRef.current;
    if (
      !userLocation ||
      !Number.isFinite(Number(userLocation.lat)) ||
      !Number.isFinite(Number(userLocation.lng))
    ) {
      return;
    }
    userMovedRef.current = true;
    if (map) {
      map.easeTo({
        center: [Number(userLocation.lng), Number(userLocation.lat)],
        zoom: 18,
        pitch: 55,
        duration: 520,
        essential: true
      });
    }
  }

  const stopMapGestureLeak = (e) => {
    e.stopPropagation();
  };

  const compass = formatBearingCardinal(liveBearing);
  const scaleBar = computeScaleBarForZoom(
    primaryEntry?.volume?.centerLat ?? userLocation?.lat ?? 37.7749,
    liveZoom,
    80
  );

  const primarySculptureCount = useMemo(() => {
    if (!primaryEntry?.parcel?.parcelId) return sculptures.length;
    return sculptures.filter((s) => s?.parcelId === primaryEntry.parcel.parcelId).length;
  }, [primaryEntry?.parcel?.parcelId, sculptures]);

  const visibleShowcaseSculptures = useMemo(
    () => (hydratedSculptures || []).filter((s) => s && !s.hidden && s.id),
    [hydratedSculptures]
  );

  const primaryLandLabel = primaryEntry
    ? showcaseMode
      ? resolveLandDisplayName(primaryEntry.parcel, { defaultName: 'Virtual Land' })
      : formatSimpleLandLabel(primaryEntry.parcel)
    : 'Virtual Land';
  const primaryLandDims = primaryEntry?.volume
    ? `${formatCompactMeter(primaryEntry.volume.widthMeters)}×${formatCompactMeter(
        primaryEntry.volume.depthMeters
      )}×${formatCompactMeter(primaryEntry.volume.heightMeters)}m`
    : '';

  return (
    <div
      ref={rootRef}
      className={`mobile-iso-map-root ${isFullExpanded ? 'is-fullscreen' : ''} ${
        showcaseMode ? 'is-showcase' : ''
      }`}
      data-testid="mobile-iso-3d-map"
      data-map-mode="3d"
      data-three-3d-models={loadedThree3dCount}
    >
      {webglAvailable ? (
        <>
          <div ref={mapHostRef} className="mobile-iso-map-canvas" />
          <canvas
            ref={wireCanvasRef}
            className="mobile-iso-wire-canvas"
            aria-hidden="true"
          />
          {showcaseMode && (
            <div
              className="plot-iso-callout-layer"
              data-testid="plot-iso-callout-layer"
              onPointerDown={stopMapGestureLeak}
              onTouchStart={stopMapGestureLeak}
              onMouseDown={stopMapGestureLeak}
            >
              {primaryEntry && (
                <button
                  ref={landLabelBtnRef}
                  type="button"
                  className={`plot-iso-land-label-btn ${landSelected ? 'is-selected' : ''}`}
                  data-testid="plot-land-label"
                  style={{ display: 'none', transform: 'translateX(-50%)' }}
                  onClick={() => onSelectLand?.(primaryEntry.parcel)}
                  title={`Inspect ${primaryLandLabel}`}
                >
                  <span className="plot-iso-land-dot" aria-hidden="true" />
                  <span>{primaryLandLabel}</span>
                  {primaryLandDims && (
                    <span className="plot-iso-land-dims mono">{primaryLandDims}</span>
                  )}
                </button>
              )}
              {visibleShowcaseSculptures.map((sc) => {
                const isSel = Boolean(selectedSculptureId && selectedSculptureId === sc.id);
                const sub =
                  sc.modelType === 'custom-3d'
                    ? `${String(sc.customModel?.format || '3D').toUpperCase()} 3D`
                    : `${Number(sc.voxelCount || sc.voxels?.length || 0)} blocks`;
                return (
                  <button
                    key={sc.id}
                    ref={(el) => {
                      if (el) calloutBtnMapRef.current.set(sc.id, el);
                      else calloutBtnMapRef.current.delete(sc.id);
                    }}
                    type="button"
                    className={`plot-iso-artwork-callout ${isSel ? 'is-selected' : ''}`}
                    data-testid="plot-artwork-label"
                    data-sculpture-id={sc.id}
                    style={{ display: 'none' }}
                    onClick={() => onSelectSculpture?.(sc)}
                    title={`Inspect "${sc.title || '3D Artwork'}"`}
                  >
                    <span className="plot-iso-callout-title">{sc.title || '3D Artwork'}</span>
                    <span className="plot-iso-callout-meta mono">{sub}</span>
                  </button>
                );
              })}
            </div>
          )}
          {!mapReady && (
            <div className="mobile-iso-loading-pill mono">Loading 3D Isometric…</div>
          )}
        </>
      ) : (
        <MobileIsoSvgFallback
          primaryEntry={primaryEntry}
          bearingDeg={liveBearing}
          sculptureCount={primarySculptureCount}
          showcaseMode={showcaseMode}
          sculptures={visibleShowcaseSculptures}
          selectedSculptureId={selectedSculptureId}
          landSelected={landSelected}
          onSelectLand={onSelectLand}
          onSelectSculpture={onSelectSculpture}
        />
      )}

      {/* Top-Right Touch-Safe Floating Map Action Bar (works in compact & full-screen!) */}
      <div
        className="map-compact-fab-row mobile-iso-fab-row"
        onPointerDown={stopMapGestureLeak}
        onTouchStart={stopMapGestureLeak}
        onMouseDown={stopMapGestureLeak}
      >
        {onToggle2D && (
          <button
            type="button"
            className="btn map-recenter-fab map-mode-toggle-fab is-3d-active"
            data-testid="mobile-map-2d-toggle-btn"
            aria-label="Switch to 2D map"
            title="Switch back to 2D map"
            onClick={onToggle2D}
          >
            <XeroIcon emoji="🗺️" size={13} /> 2D
          </button>
        )}
        <button
          type="button"
          className="btn map-recenter-fab"
          data-testid="mobile-map-orbit-btn"
          aria-label="Rotate isometric view 90 degrees"
          title="Rotate 3D view 90°"
          onClick={handleOrbit90}
        >
          ↻ 90°
        </button>
        {resolvedEntries.length > 0 && (
          <button
            type="button"
            className="btn map-recenter-fab"
            data-testid="mobile-map-fit-btn"
            aria-label="Fit land in 3D isometric view"
            title="Re-center and fit 3D land"
            onClick={handleFitLand}
          >
            <XeroIcon emoji="🎯" size={13} /> Fit
          </button>
        )}
        {userLocation && (
          <button
            type="button"
            className="btn map-recenter-fab"
            data-testid="mobile-map-me-btn"
            aria-label="Center 3D map on my location"
            title="Center on my GPS location"
            onClick={handleCenterMe}
          >
            <XeroIcon emoji="📍" size={13} /> Me
          </button>
        )}
        {onToggleFullMap && (
          <button
            type="button"
            className="btn map-recenter-fab"
            data-testid="mobile-map-fullscreen-btn"
            aria-label={isFullExpanded ? 'Exit full map' : 'Expand full map'}
            title={isFullExpanded ? 'Exit full-screen map' : 'Expand map full-screen'}
            onClick={onToggleFullMap}
          >
            {isFullExpanded ? '⤡' : '⤢'}
          </button>
        )}
      </div>

      {/* Bottom-Left Compact 3D Isometric HUD (Compass + Metric Scale Bar) */}
      <div className="mobile-iso-hud-bottom" aria-hidden="true">
        <span className="mobile-iso-hud-chip is-accent">3D ISO</span>
        <span className="mobile-iso-hud-chip mono">
          🧭 {compass.label} {compass.degrees}°
        </span>
        <span className="mobile-iso-scale-chip mono">
          <span
            className="mobile-iso-scale-bar"
            style={{ width: `${Math.max(24, scaleBar.widthPx)}px` }}
          />
          <span>{scaleBar.label}</span>
        </span>
      </div>

      {/* Directional Edge-Arrow Labels Pointing to Selectable Neighboring Lands */}
      <NeighborEdgeArrowsOverlay
        arrows={neighborArrows}
        onSelectParcel={onSelectParcel}
      />
    </div>
  );
}
