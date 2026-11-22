import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { computePrismScreenGeometry } from '../../utils/map3dProjection.js';
import { drawFloatingLandLabel } from '../../utils/map3dLabelOverlay.js';
import { createSculptureThreeLayer } from '../../utils/map3dSculptureLayer.js';
import { buildSculptures3DGeoJson } from '../../utils/sculpture3dGeoJson.js';
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
function MobileIsoSvgFallback({ primaryEntry, bearingDeg, sculptureCount }) {
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
  const label = vol
    ? `${formatSimpleLandLabel(primaryEntry.parcel)} · ${formatCompactMeter(
        vol.widthMeters
      )}×${formatCompactMeter(vol.depthMeters)}×${formatCompactMeter(vol.heightMeters)}m`
    : '3D Isometric Land View';

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
      </svg>
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
  onToggle2D,
  onToggleFullMap = null,
  onSelectParcel = null,
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
  const threeLayerRef = useRef(null);

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
  }, [effectiveSelectedId, primaryEntry, resolvedEntries]);
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

    const activeId = effectiveSelectedIdRef.current;
    const list = entriesRef.current || [];

    // Pass 1: Draw all prism wireframes first (non-selected then focused)
    const ordered = [
      ...list.filter((e) => e.parcel.parcelId !== activeId),
      ...list.filter((e) => e.parcel.parcelId === activeId)
    ];

    const pendingLabels = [];
    for (const entry of ordered) {
      const geom = computePrismScreenGeometry(map, maplibregl, entry.volume);
      if (!geom) continue;
      const isFocused = entry.parcel.parcelId === activeId;
      const isFrozen = Boolean(entry.parcel?.frozen || entry.parcel?.settings?.frozen);
      const isDormant = String(entry.parcel?.stewardStatus || '').toLowerCase() === 'dormant';
      const simpleLabel = formatSimpleLandLabel(entry.parcel, entry.rankIndex);
      const dims = `${formatCompactMeter(entry.volume.widthMeters)}×${formatCompactMeter(
        entry.volume.depthMeters
      )}×${formatCompactMeter(entry.volume.heightMeters)}m`;
      const outerColor = isFocused
        ? isFrozen
          ? '#7dd3fc'
          : '#00f5d4'
        : isDormant
          ? 'rgba(255, 62, 127, 0.85)'
          : 'rgba(255, 183, 3, 0.85)';
      const innerColor = isFocused
        ? isFrozen
          ? '#e0f2fe'
          : '#eafffc'
        : '#fff3c4';

      drawMobilePrismWireframe(ctx, geom, {
        outerColor,
        innerColor,
        lineWidth: isFocused ? 2.2 : 1.4,
        glowBlur: isFocused ? 13 : 6,
        dashed: !isFocused,
        showGroundHalo: isFocused
      });

      pendingLabels.push({
        geom,
        outerColor,
        innerColor,
        label: isFocused ? `${simpleLabel} · ${dims}` : simpleLabel,
        liftPx: isFocused ? 20 : 16,
        minY: 48
      });
    }

    // Pass 2: Floating labels strictly ON TOP of all wireframes with thin arrow from land center
    for (const item of pendingLabels) {
      drawFloatingLandLabel(ctx, item.geom, item);
    }
  }, []);

  const syncMapSources = useCallback(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;

    const activeId = effectiveSelectedIdRef.current;
    const entries = entriesRef.current || [];
    const landFeatures = entries
      .map((entry) =>
        parcelVolumeToFeature(entry.parcel, entry.volume, {
          isSelected: entry.parcel.parcelId === activeId
        })
      )
      .filter(Boolean);

    const parcelsWithVolumes = entries.map((e) => ({ ...e.parcel, volume: e.volume }));
    const sc3d = buildSculptures3DGeoJson(
      hydratedSculpturesRef.current || [],
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
        sculptures: hydratedSculpturesRef.current || [],
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
            top: Math.max(fit.padding.top, 60),
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
            if (map.getLayer('mobile-iso-lands-extrusion')) {
              const landHits = map.queryRenderedFeatures(e.point, {
                layers: ['mobile-iso-lands-extrusion']
              });
              const pid = landHits?.[0]?.properties?.parcelId;
              if (pid && onSelectParcelRef.current) {
                const matchEntry = (entriesRef.current || []).find(
                  (entry) => entry.parcel.parcelId === pid
                );
                if (matchEntry) {
                  onSelectParcelRef.current(matchEntry.parcel);
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

  // Keep GeoJSON sources synced when parcels, sculptures, hydration, or selection change
  useEffect(() => {
    syncMapSources();
  }, [resolvedEntries, effectiveSelectedId, hydratedSculptures, selectedSculptureId, userLocation, syncMapSources]);

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
    const ro = new ResizeObserver(() => {
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

  return (
    <div
      ref={rootRef}
      className={`mobile-iso-map-root ${isFullExpanded ? 'is-fullscreen' : ''}`}
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
          {!mapReady && (
            <div className="mobile-iso-loading-pill mono">Loading 3D Isometric…</div>
          )}
        </>
      ) : (
        <MobileIsoSvgFallback
          primaryEntry={primaryEntry}
          bearingDeg={liveBearing}
          sculptureCount={primarySculptureCount}
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
    </div>
  );
}
