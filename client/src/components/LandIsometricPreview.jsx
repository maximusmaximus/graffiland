import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../utils/api.js';
import { copyToClipboard } from '../utils/clipboard.js';
import {
  buildParcelGeoSummary,
  computeIsometricCameraFit,
  computeScaleBarForZoom,
  formatBearingCardinal,
  resolveParcelVolume
} from '../utils/landPreviewHelpers.js';
import { hasWebGLSupport, loadMapLibre } from '../utils/loadMapLibre.js';
import { computePrismScreenGeometry } from '../utils/map3dProjection.js';
import { buildSculptures3DGeoJson } from '../utils/sculpture3dGeoJson.js';
import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import InfoTip from './InfoTip.jsx';
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

// Cache reverse-geocoded place summaries across parcel switches in the session
const reverseGeoCache = new Map();

function volumeToFeature(parcel, vol, { isSelected = false } = {}) {
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

function drawPreviewPrism(
  ctx,
  geom,
  { outerColor, innerColor, lineWidth = 2.1, glowBlur = 12, label = '', dashed = false, showGroundHalo = false }
) {
  if (!geom) return;
  const { bottom, top, topCenter } = geom;

  if (showGroundHalo) {
    const cx = (bottom[0].x + bottom[1].x + bottom[2].x + bottom[3].x) / 4;
    const cy = (bottom[0].y + bottom[1].y + bottom[2].y + bottom[3].y) / 4;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 245, 212, 0.14)';
    ctx.beginPath();
    ctx.moveTo(bottom[0].x, bottom[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(bottom[i].x, bottom[i].y);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = outerColor;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  const drawEdges = (stroke, width, blur) => {
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
    drawEdges('rgba(4, 10, 20, 0.72)', lineWidth + 2.8, 2);
  }
  drawEdges(outerColor, lineWidth + 1.1, glowBlur);
  drawEdges(innerColor, Math.max(1, lineWidth - 0.5), 0);

  if (label && topCenter?.visible) {
    ctx.save();
    ctx.font = '600 10.5px "JetBrains Mono", ui-monospace, monospace';
    const textW = ctx.measureText(label).width;
    const padX = 7;
    const boxW = textW + padX * 2;
    const boxH = 19;
    const bx = topCenter.x - boxW / 2;
    const by = Math.max(8, topCenter.y - boxH - 9);
    ctx.fillStyle = 'rgba(6, 10, 20, 0.9)';
    ctx.strokeStyle = outerColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(bx, by, boxW, boxH, 5);
    } else {
      ctx.rect(bx, by, boxW, boxH);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = innerColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, topCenter.x, by + boxH / 2 + 0.5);
    ctx.restore();
  }
}

/**
 * Fallback proportional 3D isometric SVG blueprint rendered cleanly when WebGL is unavailable.
 */
function IsometricFallbackBlueprint({ volume, parcel, viewMode, bearingDeg }) {
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
  const isFrozen = Boolean(parcel?.frozen || parcel?.settings?.frozen);
  const stroke = isFrozen ? '#7dd3fc' : '#00f5d4';
  const fill = isFrozen ? 'rgba(125, 211, 252, 0.18)' : 'rgba(0, 245, 212, 0.16)';
  const pts = (list) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

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
        {/* Base polygon */}
        <polygon points={pts([b0, b1, b2, b3])} fill={fill} stroke={stroke} strokeWidth="1.8" />
        {hScale > 0 && (
          <>
            <polygon points={pts([b1, b2, t2, t1])} fill={fill} stroke={stroke} strokeWidth="1.4" opacity="0.85" />
            <polygon points={pts([b2, b3, t3, t2])} fill={fill} stroke={stroke} strokeWidth="1.4" opacity="0.65" />
            <polygon points={pts([t0, t1, t2, t3])} fill={fill} stroke="#eafffc" strokeWidth="1.8" />
            <line x1={b0[0]} y1={b0[1]} x2={t0[0]} y2={t0[1]} stroke={stroke} strokeWidth="1.2" strokeDasharray="3 3" opacity="0.7" />
          </>
        )}
        <text
          x={cx}
          y={Math.max(22, t0[1] - 10)}
          textAnchor="middle"
          fill="#eafffc"
          fontSize="11"
          fontFamily="monospace"
          fontWeight="600"
        >
          {`${Math.round(volume.widthMeters)}×${Math.round(volume.depthMeters)}×${Math.round(volume.heightMeters)}m · ${Math.round(bearingDeg)}°`}
        </text>
      </svg>
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
  const [stageSize, setStageSize] = useState({ width: 600, height: 260 });

  const volume = useMemo(() => resolveParcelVolume(parcel), [parcel]);

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
        placeContext
      }),
    [allParcels, parcel, placeContext, userLocation]
  );

  // Refs for synchronous MapLibre event handlers
  const parcelRef = useRef(parcel);
  const volumeRef = useRef(volume);
  const displayNameRef = useRef('');
  const isFrozenRef = useRef(false);
  const otherEntriesRef = useRef(otherParcelEntries);
  const onSelectParcelRef = useRef(onSelectParcel);
  const viewModeRef = useRef(viewMode);
  const bearingOffsetRef = useRef(bearingOffset);

  const effectiveDisplayName =
    String(displayNameOverride || parcel?.customName || '').trim() || parcel?.parcelId || '';
  const effectiveFrozen =
    frozenOverride !== null ? Boolean(frozenOverride) : Boolean(parcel?.frozen || parcel?.settings?.frozen);

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
  }, [onSelectParcel]);
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

    // 1) Other owned lands in subtle dashed amber so user sees spatial relationships
    for (const entry of otherEntriesRef.current || []) {
      const geom = computePrismScreenGeometry(map, maplibregl, entry.volume);
      if (!geom) continue;
      drawPreviewPrism(ctx, geom, {
        outerColor: 'rgba(255, 183, 3, 0.8)',
        innerColor: '#fff3c4',
        lineWidth: 1.4,
        glowBlur: 6,
        dashed: true,
        label: entry.parcel?.customName || entry.parcel?.parcelId || ''
      });
    }

    // 2) Active selected land in crisp glowing isometric wireframe
    const curVol = volumeRef.current;
    if (curVol) {
      const geom = computePrismScreenGeometry(map, maplibregl, curVol);
      if (geom) {
        const isFrozenNow = isFrozenRef.current;
        const shortName = displayNameRef.current || curVol.parcelId;
        const trimmed = shortName.length > 22 ? `${shortName.slice(0, 21).trimEnd()}…` : shortName;
        const heightTag = `${Math.round(curVol.heightMeters)}m`;
        drawPreviewPrism(ctx, geom, {
          outerColor: isFrozenNow ? '#7dd3fc' : '#00f5d4',
          innerColor: isFrozenNow ? '#e0f2fe' : '#eafffc',
          lineWidth: 2.3,
          glowBlur: 14,
          showGroundHalo: true,
          label: `${isFrozenNow ? '❄️ ' : ''}${trimmed} · ${heightTag}`
        });
      }
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
    const otherFeats = (otherEntriesRef.current || [])
      .map((entry) => volumeToFeature(entry.parcel, entry.volume, { isSelected: false }))
      .filter(Boolean);
    const sc3d = buildSculptures3DGeoJson(
      curParcel?.sculptures || [],
      '',
      curVol ? [{ ...curParcel, volume: curVol }] : []
    );

    const selSrc = map.getSource('preview-selected-land');
    if (selSrc && typeof selSrc.setData === 'function') {
      selSrc.setData({ type: 'FeatureCollection', features: selectedFeat ? [selectedFeat] : [] });
    }
    const othSrc = map.getSource('preview-other-lands');
    if (othSrc && typeof othSrc.setData === 'function') {
      othSrc.setData({ type: 'FeatureCollection', features: otherFeats });
    }
    const scSrc = map.getSource('preview-sculptures-3d');
    if (scSrc && typeof scSrc.setData === 'function') {
      scSrc.setData(sc3d.geojson);
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
        if (!map.getLayer('preview-other-lands-extrusion')) {
          map.addLayer({
            id: 'preview-other-lands-extrusion',
            type: 'fill-extrusion',
            source: 'preview-other-lands',
            paint: {
              'fill-extrusion-color': ['get', 'color'],
              'fill-extrusion-height': ['get', 'heightMeters'],
              'fill-extrusion-base': ['get', 'baseAltitudeM'],
              'fill-extrusion-opacity': 0.24
            }
          });
        }

        if (!map.getSource('preview-selected-land')) {
          map.addSource('preview-selected-land', { type: 'geojson', data: EMPTY_FC });
        }
        if (!map.getLayer('preview-selected-land-extrusion')) {
          map.addLayer({
            id: 'preview-selected-land-extrusion',
            type: 'fill-extrusion',
            source: 'preview-selected-land',
            paint: {
              'fill-extrusion-color': ['get', 'color'],
              'fill-extrusion-height': ['get', 'heightMeters'],
              'fill-extrusion-base': ['get', 'baseAltitudeM'],
              'fill-extrusion-opacity': 0.3
            }
          });
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
              'fill-extrusion-opacity': 0.94,
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
        map.on('click', 'preview-other-lands-extrusion', (e) => {
          const clickedPid = e?.features?.[0]?.properties?.parcelId;
          if (!clickedPid || !onSelectParcelRef.current) return;
          const match = (otherEntriesRef.current || []).find(
            (entry) => entry.parcel?.parcelId === clickedPid
          );
          if (match?.parcel) {
            onSelectParcelRef.current(match.parcel);
          }
        });

        map.on('mouseenter', 'preview-other-lands-extrusion', () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', 'preview-other-lands-extrusion', () => {
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

  // Whenever the selected parcel, display overrides, sculptures, or other lands update, sync GeoJSON
  useEffect(() => {
    syncMapData();
  }, [parcel, effectiveDisplayName, effectiveFrozen, otherParcelEntries, syncMapData]);

  useEffect(() => {
    if (!volume) return;
    const isSameParcel = lastCenteredParcelRef.current.parcelId === volume.parcelId;
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
  const scaleBar = computeScaleBarForZoom(volume.centerLat, liveZoom, 92);
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
                ? ' Amber outlines show your other owned lands — click one to switch to it.'
                : ''}
            </InfoTip>
          </div>
          <div className="land-preview-place" data-testid="land-preview-place">
            <XeroIcon emoji="📍" size={12} />
            <span>
              {geoSummary.placePrimary ||
                (placeLoading ? 'Locating neighborhood & street…' : geoSummary.cardinalCoords)}
            </span>
          </div>
        </div>
      </div>

      {/* 2) Interactive Isometric 3D Map Viewport */}
      <div ref={stageRef} className="land-preview-stage">
        {webglAvailable ? (
          <>
            <div ref={mapHostRef} className="land-preview-map-host" />
            <canvas ref={wireCanvasRef} className="land-preview-wire-canvas" aria-hidden="true" />
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
            viewMode={viewMode}
            bearingDeg={liveBearing}
          />
        )}

        {/* Top-Left: View Mode Switcher (Iso / Area / 2D) */}
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

        {/* Top-Right: Rotating North Compass Rose + 90° Isometric Orbit */}
        <div className="land-preview-compass-group">
          <button
            type="button"
            className="land-preview-compass"
            aria-label={`Compass heading ${compass.label}. Click to reset isometric view`}
            title={`Facing ${compass.label} (${compass.degrees}°) — click to reset isometric angle`}
            onClick={handleResetCompass}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              style={{ transform: `rotate(${-liveBearing}deg)`, transition: 'transform 220ms ease' }}
              aria-hidden="true"
            >
              <polygon points="12,2 15.2,12 12,10.2 8.8,12" fill="#ff5e7e" />
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
      </div>

      {/* 3) Structured Geographic Quick-Facts Strip */}
      <div className="land-preview-facts">
        <div className="land-preview-fact">
          <span className="land-preview-fact-label">Coordinates</span>
          <span className="land-preview-fact-value mono" data-testid="land-preview-coords">
            {geoSummary.cardinalCoords}
          </span>
        </div>
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
                : `Grid ${geoSummary.geohash || parcel.parcelId}`)}
          </span>
          <span className="land-preview-fact-sub mono">
            {geoSummary.geohash ? `Geohash ${geoSummary.geohash}` : parcel.parcelId}
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
            🧭 Google Maps
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
