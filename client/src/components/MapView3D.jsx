import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import xeroemoji from 'xeroemoji';
import { LAND_VOLUME_LIMITS } from '../../../shared/constants.mjs';
import {
  buildDefaultVolumeFromBounds,
  computeCameraAlignedDraftBox,
  computeMaxHeightForFootprint,
  computeOrientedFootprintLngLat,
  normalizeRotationDeg,
  resizeDraftFromEdge,
  scaleDraftFromCorner
} from '../../../shared/landVolume.mjs';
import { api } from '../utils/api.js';
import { getSculptureChainLinks } from '../utils/chainLinks.js';
import {
  computePrismScreenGeometry,
  pointInPolygon2D
} from '../utils/map3dProjection.js';
import InfoTip from './InfoTip.jsx';
import XeroIcon from './XeroIcon.jsx';

if (typeof maplibregl.setWorkerUrl === 'function' && maplibreWorkerUrl) {
  maplibregl.setWorkerUrl(maplibreWorkerUrl);
}

const OPENFREEMAP_LIBERTY_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const TERRARIUM_DEM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];

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
      id: 'fallback-bg',
      type: 'background',
      paint: { 'background-color': '#0b1020' }
    },
    {
      id: 'fallback-carto-raster',
      type: 'raster',
      source: 'carto-dark',
      minzoom: 0,
      maxzoom: 22
    }
  ]
};

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

function formatSearchDistance(meters) {
  if (!Number.isFinite(meters)) return '';
  if (meters < 1000) return `${Math.round(meters)}m`;
  if (meters < 50000) return `${(meters / 1000).toFixed(1)}km`;
  return '';
}

function distPointToSegment(px, py, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-6) {
    return { dist: Math.hypot(px - a.x, py - a.y), t: 0 };
  }
  const t = Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / lenSq));
  const projX = a.x + t * vx;
  const projY = a.y + t * vy;
  return { dist: Math.hypot(px - projX, py - projY), t };
}

function lerpPt(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function parcelToFeature(p, fallbackHeight = LAND_VOLUME_LIMITS.defaultHeightMeters) {
  const vol =
    p?.volume ||
    (p?.bounds ? buildDefaultVolumeFromBounds(p.bounds, p.parcelId, p.geohash) : null);
  if (!vol || !Array.isArray(vol.ring) || vol.ring.length < 4) return null;
  const isDormant = p?.stewardStatus === 'dormant';
  return {
    type: 'Feature',
    properties: {
      parcelId: p.parcelId,
      heightMeters: Number(vol.heightMeters || fallbackHeight),
      baseAltitudeM: Number(vol.baseAltitudeM || 0),
      color: isDormant ? '#ff3e7f' : '#ffb703',
      borderColor: isDormant ? '#ff7eb3' : '#ffd166'
    },
    geometry: {
      type: 'Polygon',
      coordinates: [vol.ring]
    }
  };
}

function draftToFeature(d, isSelected) {
  const ring =
    Array.isArray(d?.ring) && d.ring.length >= 4
      ? d.ring
      : computeOrientedFootprintLngLat({
          lat: d.centerLat,
          lng: d.centerLng,
          widthMeters: d.widthMeters,
          depthMeters: d.depthMeters,
          rotationDeg: d.rotationDeg || 0
        }).ring;
  const hasError = Boolean(d?.hasOverlap || !d?.valid);
  const color = hasError ? '#ff4d6d' : isSelected ? '#00f5d4' : '#00bbf9';
  return {
    type: 'Feature',
    properties: {
      id: d.id,
      parcelId: d.parcelId,
      heightMeters: Number(d.heightMeters || LAND_VOLUME_LIMITS.defaultHeightMeters),
      baseAltitudeM: Number(d.baseAltitudeM || 0),
      color
    },
    geometry: {
      type: 'Polygon',
      coordinates: [ring]
    }
  };
}

function drawGlowingPrism(
  ctx,
  geom,
  {
    outerColor,
    innerColor,
    lineWidth = 2,
    glowBlur = 14,
    label = '',
    showGizmo = false,
    activeHandle = ''
  }
) {
  if (!geom) return;
  const { bottom, top, topCenter } = geom;

  const drawEdgeList = (stroke, width, blur) => {
    ctx.save();
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

  drawEdgeList('rgba(4, 10, 20, 0.72)', lineWidth + 3.4, 2);
  drawEdgeList(outerColor, lineWidth + 1.8, glowBlur);
  drawEdgeList(innerColor, Math.max(1, lineWidth - 0.3), 0);

  if (showGizmo) {
    // 1) Side Segment Move/Scale Bars along the middle of all 4 bottom & top edges
    for (let i = 0; i < 4; i++) {
      const next = (i + 1) % 4;
      const isEdgeActive = activeHandle === `edge-${i}`;
      const barColor = isEdgeActive ? '#ffd166' : '#00f5d4';
      const drawEdgeBar = (pA, pB, thick) => {
        const s1 = lerpPt(pA, pB, 0.3);
        const s2 = lerpPt(pA, pB, 0.7);
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(4, 10, 20, 0.9)';
        ctx.lineWidth = thick + 3;
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.stroke();

        ctx.strokeStyle = barColor;
        ctx.shadowColor = barColor;
        ctx.shadowBlur = isEdgeActive ? 16 : 9;
        ctx.lineWidth = thick;
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.stroke();

        ctx.strokeStyle = '#ffffff';
        ctx.shadowBlur = 0;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.stroke();
        ctx.restore();
      };
      drawEdgeBar(bottom[i], bottom[next], isEdgeActive ? 6.5 : 5);
      drawEdgeBar(top[i], top[next], isEdgeActive ? 5.5 : 3.8);
    }

    // 2) Vertical Rotation Bars (hold & move any vertical corner bar to rotate the box)
    for (let i = 0; i < 4; i++) {
      const isVertActive = activeHandle === `vbar-${i}`;
      const v1 = lerpPt(bottom[i], top[i], 0.22);
      const v2 = lerpPt(bottom[i], top[i], 0.78);
      const vColor = isVertActive ? '#ffd166' : '#ffb703';
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(4, 10, 20, 0.88)';
      ctx.lineWidth = isVertActive ? 9.5 : 7;
      ctx.beginPath();
      ctx.moveTo(v1.x, v1.y);
      ctx.lineTo(v2.x, v2.y);
      ctx.stroke();

      ctx.strokeStyle = vColor;
      ctx.shadowColor = vColor;
      ctx.shadowBlur = isVertActive ? 18 : 9;
      ctx.lineWidth = isVertActive ? 5.8 : 4.2;
      ctx.beginPath();
      ctx.moveTo(v1.x, v1.y);
      ctx.lineTo(v2.x, v2.y);
      ctx.stroke();

      ctx.strokeStyle = '#fff8dc';
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(v1.x, v1.y);
      ctx.lineTo(v2.x, v2.y);
      ctx.stroke();
      ctx.restore();
    }

    // 3) Glowing Corner Balls on all 4 base & 4 top corners for easy scaling
    const drawCornerBall = (pt, isActive, baseR) => {
      const r = isActive ? baseR + 2.4 : baseR;
      const rimColor = isActive ? '#ffd166' : outerColor;
      ctx.save();
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r + 1.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(4, 10, 20, 0.92)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fillStyle = rimColor;
      ctx.shadowColor = rimColor;
      ctx.shadowBlur = isActive ? 18 : 12;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(pt.x - r * 0.2, pt.y - r * 0.2, Math.max(2, r * 0.48), 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.shadowBlur = 0;
      ctx.fill();
      ctx.restore();
    };

    for (let i = 0; i < 4; i++) {
      const isCornerActive = activeHandle === `corner-${i}`;
      drawCornerBall(bottom[i], isCornerActive, 6.5);
      drawCornerBall(top[i], isCornerActive, 5.5);
    }

    // 4) Top Center Z-Height Pill Handle
    if (topCenter?.visible) {
      const isHActive = activeHandle === 'height';
      ctx.save();
      ctx.strokeStyle = 'rgba(4, 10, 20, 0.9)';
      ctx.lineWidth = 8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(topCenter.x - 10, topCenter.y);
      ctx.lineTo(topCenter.x + 10, topCenter.y);
      ctx.stroke();

      ctx.strokeStyle = isHActive ? '#ffd166' : '#00f5d4';
      ctx.shadowColor = isHActive ? '#ffd166' : '#00f5d4';
      ctx.shadowBlur = isHActive ? 16 : 8;
      ctx.lineWidth = 4.2;
      ctx.beginPath();
      ctx.moveTo(topCenter.x - 10, topCenter.y);
      ctx.lineTo(topCenter.x + 10, topCenter.y);
      ctx.stroke();
      ctx.restore();
    }
  } else {
    // Non-selected prism subtle vertex dots
    ctx.save();
    ctx.fillStyle = innerColor;
    ctx.shadowColor = outerColor;
    ctx.shadowBlur = 8;
    for (const pt of top) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  if (label && topCenter?.visible) {
    ctx.save();
    ctx.font = '600 10.5px "JetBrains Mono", ui-monospace, monospace';
    const textW = ctx.measureText(label).width;
    const padX = 7;
    const boxW = textW + padX * 2;
    const boxH = 19;
    const bx = topCenter.x - boxW / 2;
    const by = topCenter.y - boxH - 11;
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

export default function MapView3D({
  sculptures = [],
  parcels = [],
  draftParcels = [],
  selectedDraftId = '',
  drawMode = false,
  viewMode = 'isometric',
  autoSwitchedHint = false,
  userLocation = null,
  focusArea = false,
  selectedSculptureId = '',
  initialView = null,
  config = null,
  onViewportChange = null,
  onSelectSculpture = null,
  onAddDraftRectangle = null,
  onSelectDraft = null,
  onUpdateDraft = null,
  onViewModeChange = null,
  onToggleDrawMode = null,
  onDismissAuto3dHint = null
}) {
  const stageRef = useRef(null);
  const mapHostRef = useRef(null);
  const wireCanvasRef = useRef(null);
  const searchBoxRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const searchPinMarkerRef = useRef(null);
  const styleReadyRef = useRef(false);
  const fallbackAppliedRef = useRef(false);
  const initialViewModeRef = useRef(viewMode);
  const firstViewModeSyncRef = useRef(true);

  const initPitchVal = viewMode === 'isometric' ? 52 : viewMode === '3d' ? 56 : 0;
  const initBearingVal = viewMode === 'isometric' ? -45 : viewMode === '3d' ? -35 : 0;
  const [pitchDeg, setPitchDeg] = useState(initPitchVal);
  const [bearingDeg, setBearingDeg] = useState(initBearingVal);
  const [showBuildings, setShowBuildings] = useState(true);
  const [showTerrain, setShowTerrain] = useState(false);

  // Interactive hover & gizmo cursor state
  const [hoveredDraftId, setHoveredDraftId] = useState('');
  const [activeHandle, setActiveHandle] = useState('');
  const [gizmoCursor, setGizmoCursor] = useState('');
  const [gizmoHint, setGizmoHint] = useState('');

  // Dynamic Location Search state (intersections, businesses, landmarks, addresses, coords, parcels)
  const [searchQuery, setSearchQuery] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeSearchIdx, setActiveSearchIdx] = useState(-1);
  const searchSeqRef = useRef(0);
  const skipNextAutoSearchRef = useRef(false);

  // Latest props kept in refs for synchronous MapLibre event handlers & 60fps Canvas2D rendering
  const parcelsRef = useRef(parcels);
  const draftsRef = useRef(draftParcels);
  const selectedDraftIdRef = useRef(selectedDraftId);
  const hoveredDraftIdRef = useRef(hoveredDraftId);
  const activeHandleRef = useRef(activeHandle);
  const drawModeRef = useRef(drawMode);
  const showBuildingsRef = useRef(showBuildings);
  const showTerrainRef = useRef(showTerrain);
  const onSelectDraftRef = useRef(onSelectDraft);
  const onAddDraftRef = useRef(onAddDraftRectangle);
  const onUpdateDraftRef = useRef(onUpdateDraft);
  const onViewportChangeRef = useRef(onViewportChange);
  const onViewModeChangeRef = useRef(onViewModeChange);
  const initialViewRef = useRef(initialView);
  const userLocationRef = useRef(userLocation);
  const userAdjustedRef = useRef(
    Boolean(
      initialView &&
        Number.isFinite(Number(initialView.lat)) &&
        Number.isFinite(Number(initialView.lng)) &&
        Number.isFinite(Number(initialView.zoom))
    )
  );
  const dragStartRef = useRef(null);
  const dragPreviewRef = useRef(null);
  const hoverDrawPreviewRef = useRef(null);
  const gizmoDragRef = useRef(null);
  const jumpToSearchResultRef = useRef(null);

  useEffect(() => {
    parcelsRef.current = parcels;
  }, [parcels]);
  useEffect(() => {
    draftsRef.current = draftParcels;
  }, [draftParcels]);
  useEffect(() => {
    selectedDraftIdRef.current = selectedDraftId;
  }, [selectedDraftId]);
  useEffect(() => {
    hoveredDraftIdRef.current = hoveredDraftId;
  }, [hoveredDraftId]);
  useEffect(() => {
    activeHandleRef.current = activeHandle;
  }, [activeHandle]);
  useEffect(() => {
    drawModeRef.current = drawMode;
  }, [drawMode]);
  useEffect(() => {
    showBuildingsRef.current = showBuildings;
  }, [showBuildings]);
  useEffect(() => {
    showTerrainRef.current = showTerrain;
  }, [showTerrain]);
  useEffect(() => {
    onSelectDraftRef.current = onSelectDraft;
  }, [onSelectDraft]);
  useEffect(() => {
    onAddDraftRef.current = onAddDraftRectangle;
  }, [onAddDraftRectangle]);
  useEffect(() => {
    onUpdateDraftRef.current = onUpdateDraft;
  }, [onUpdateDraft]);
  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);
  useEffect(() => {
    onViewModeChangeRef.current = onViewModeChange;
  }, [onViewModeChange]);

  const drawWireframes = useCallback(() => {
    const map = mapRef.current;
    const canvas = wireCanvasRef.current;
    if (!map || !canvas) return;
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

    // 1) Existing owned parcels -> glowing Amber/Gold (or Magenta for dormant quests)
    for (const p of parcelsRef.current || []) {
      const vol =
        p?.volume ||
        (p?.bounds ? buildDefaultVolumeFromBounds(p.bounds, p.parcelId, p.geohash) : null);
      if (!vol) continue;
      const geom = computePrismScreenGeometry(map, maplibregl, vol);
      if (!geom) continue;
      const isDormant = p?.stewardStatus === 'dormant';
      drawGlowingPrism(ctx, geom, {
        outerColor: isDormant ? '#ff3e7f' : '#ffb703',
        innerColor: isDormant ? '#ffc2dc' : '#fff3c4',
        lineWidth: 1.8,
        glowBlur: 10,
        label: ''
      });
    }

    // 2) Considered draft parcels -> electric Cyber Cyan with interactive corner balls, edge bars & vertical rotate bars
    let activeGizmoCoords = null;
    for (const d of draftsRef.current || []) {
      const geom = computePrismScreenGeometry(map, maplibregl, d);
      if (!geom) continue;
      const isSelected = d.id === selectedDraftIdRef.current;
      const isHovered = d.id === hoveredDraftIdRef.current;
      const showGizmo = isSelected || isHovered;
      const hasError = Boolean(d?.hasOverlap || !d?.valid);
      const outerColor = hasError ? '#ff4d6d' : showGizmo ? '#00f5d4' : '#00bbf9';
      const innerColor = hasError ? '#ffd6de' : showGizmo ? '#eafffc' : '#cbeeff';
      const handleForThis = showGizmo ? activeHandleRef.current : '';
      const dimLabel = `${Math.round(d.widthMeters)}×${Math.round(d.depthMeters)}×${Math.round(
        d.heightMeters
      )}m · ${Math.round(d.rotationDeg || 0)}°`;

      drawGlowingPrism(ctx, geom, {
        outerColor,
        innerColor,
        lineWidth: showGizmo ? 2.5 : 1.9,
        glowBlur: showGizmo ? 18 : 11,
        label: dimLabel,
        showGizmo,
        activeHandle: handleForThis
      });

      if (isSelected || (!activeGizmoCoords && isHovered)) {
        const edge0Mid = lerpPt(geom.bottom[0], geom.bottom[1], 0.5);
        const edge1Mid = lerpPt(geom.bottom[1], geom.bottom[2], 0.5);
        const vbar0Mid = lerpPt(geom.bottom[0], geom.top[0], 0.5);
        const vbar1Mid = lerpPt(geom.bottom[1], geom.top[1], 0.5);
        const baseCenter = {
          x: (geom.bottom[0].x + geom.bottom[1].x + geom.bottom[2].x + geom.bottom[3].x) / 4,
          y: (geom.bottom[0].y + geom.bottom[1].y + geom.bottom[2].y + geom.bottom[3].y) / 4
        };
        activeGizmoCoords = {
          id: d.id,
          corner0: [Math.round(geom.bottom[0].x), Math.round(geom.bottom[0].y)],
          corner1: [Math.round(geom.bottom[1].x), Math.round(geom.bottom[1].y)],
          edge0: [Math.round(edge0Mid.x), Math.round(edge0Mid.y)],
          edge1: [Math.round(edge1Mid.x), Math.round(edge1Mid.y)],
          vbar0: [Math.round(vbar0Mid.x), Math.round(vbar0Mid.y)],
          vbar1: [Math.round(vbar1Mid.x), Math.round(vbar1Mid.y)],
          topCenter: [Math.round(geom.topCenter.x), Math.round(geom.topCenter.y)],
          center: [Math.round(baseCenter.x), Math.round(baseCenter.y)]
        };
      }
    }

    if (stageRef.current) {
      if (activeGizmoCoords) {
        stageRef.current.setAttribute('data-active-gizmo', JSON.stringify(activeGizmoCoords));
      } else {
        stageRef.current.removeAttribute('data-active-gizmo');
      }
    }

    // 3) Live rectangle drag preview or draw-mode hover cursor footprint preview
    const preview = dragPreviewRef.current;
    if (preview) {
      const geom = computePrismScreenGeometry(map, maplibregl, preview);
      if (geom) {
        const previewLabel = preview.hitLimit
          ? `${preview.widthMeters}×${preview.depthMeters}m · MAX ${LAND_VOLUME_LIMITS.maxFootprintAreaSqM.toLocaleString()} m²`
          : `${preview.widthMeters}×${preview.depthMeters}m · ${Math.round(preview.rotationDeg || 0)}°`;
        drawGlowingPrism(ctx, geom, {
          outerColor: preview.hitLimit ? '#ffd166' : '#00f5d4',
          innerColor: '#ffffff',
          lineWidth: 2.3,
          glowBlur: 18,
          label: previewLabel
        });
      }
    } else if (drawModeRef.current && hoverDrawPreviewRef.current && !hoveredDraftIdRef.current) {
      const hoverGeom = computePrismScreenGeometry(map, maplibregl, hoverDrawPreviewRef.current);
      if (hoverGeom) {
        drawGlowingPrism(ctx, hoverGeom, {
          outerColor: 'rgba(0, 245, 212, 0.72)',
          innerColor: 'rgba(234, 255, 252, 0.85)',
          lineWidth: 1.5,
          glowBlur: 10,
          label: 'Click or drag to place'
        });
      }
    }
  }, []);

  const syncGeoJsonSources = useCallback(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;

    const ownedFeatures = (parcelsRef.current || [])
      .map((p) => parcelToFeature(p))
      .filter(Boolean);
    const draftFeatures = (draftsRef.current || []).map((d) =>
      draftToFeature(d, d.id === selectedDraftIdRef.current)
    );

    const ownedSrc = map.getSource('owned-lands');
    if (ownedSrc && typeof ownedSrc.setData === 'function') {
      ownedSrc.setData({ type: 'FeatureCollection', features: ownedFeatures });
    }
    const draftSrc = map.getSource('draft-lands');
    if (draftSrc && typeof draftSrc.setData === 'function') {
      draftSrc.setData({ type: 'FeatureCollection', features: draftFeatures });
    }
    drawWireframes();
  }, [drawWireframes]);

  const ensureCustomLayers = useCallback((map) => {
    if (!map) return;
    styleReadyRef.current = true;

    try {
      if (!map.getSource('terrarium-dem')) {
        map.addSource('terrarium-dem', {
          type: 'raster-dem',
          tiles: TERRARIUM_DEM_TILES,
          tileSize: 256,
          encoding: 'terrarium',
          maxzoom: 14
        });
      }
    } catch {
      // ignore if style doesn't allow DEM source
    }

    try {
      if (map.getLayer('building-3d')) {
        map.setPaintProperty('building-3d', 'fill-extrusion-color', '#24324f');
        map.setPaintProperty('building-3d', 'fill-extrusion-opacity', showBuildingsRef.current ? 0.78 : 0);
      }
    } catch {
      // ignore on fallback style
    }

    try {
      if (!map.getSource('owned-lands')) {
        map.addSource('owned-lands', { type: 'geojson', data: EMPTY_FC });
      }
      if (!map.getLayer('owned-lands-extrusion')) {
        map.addLayer({
          id: 'owned-lands-extrusion',
          type: 'fill-extrusion',
          source: 'owned-lands',
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-height': ['get', 'heightMeters'],
            'fill-extrusion-base': ['get', 'baseAltitudeM'],
            'fill-extrusion-opacity': 0.28
          }
        });
      }

      if (!map.getSource('draft-lands')) {
        map.addSource('draft-lands', { type: 'geojson', data: EMPTY_FC });
      }
      if (!map.getLayer('draft-lands-extrusion')) {
        map.addLayer({
          id: 'draft-lands-extrusion',
          type: 'fill-extrusion',
          source: 'draft-lands',
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-height': ['get', 'heightMeters'],
            'fill-extrusion-base': ['get', 'baseAltitudeM'],
            'fill-extrusion-opacity': 0.28
          }
        });
      }
    } catch {
      // never fail basemap rendering on custom overlay setup
    }

    syncGeoJsonSources();
  }, [syncGeoJsonSources]);

  useEffect(() => {
    if (!mapHostRef.current || mapRef.current) return undefined;

    const saved = initialViewRef.current;
    const initLoc = userLocationRef.current;
    const hasSaved =
      saved &&
      Number.isFinite(Number(saved.lat)) &&
      Number.isFinite(Number(saved.lng)) &&
      Number.isFinite(Number(saved.zoom));

    const centerLngLat = hasSaved
      ? [Number(saved.lng), Number(saved.lat)]
      : initLoc && Number.isFinite(initLoc.lat) && Number.isFinite(initLoc.lng)
      ? [initLoc.lng, initLoc.lat]
      : [-122.4194, 37.7749];

    const initMode = initialViewModeRef.current;
    const initPitch = initMode === 'isometric' ? 52 : initMode === '3d' ? 56 : 0;
    const initBearing = initMode === 'isometric' ? -45 : initMode === '3d' ? -35 : 0;
    const startZoom = hasSaved
      ? Number(saved.zoom)
      : initMode === 'isometric'
      ? 17
      : initLoc
      ? 16.5
      : 16;

    const map = new maplibregl.Map({
      container: mapHostRef.current,
      style: OPENFREEMAP_LIBERTY_STYLE,
      center: centerLngLat,
      zoom: startZoom,
      pitch: initPitch,
      bearing: initBearing,
      maxPitch: 68,
      antialias: true,
      attributionControl: true
    });

    map.addControl(
      new maplibregl.NavigationControl({ showCompass: true, showZoom: true, visualizePitch: true }),
      'top-right'
    );

    mapRef.current = map;

    const onStyleLoad = () => {
      ensureCustomLayers(map);
      const c = map.getCenter();
      onViewportChangeRef.current?.({
        lat: Number(c.lat.toFixed(6)),
        lng: Number(c.lng.toFixed(6)),
        zoom: Number(map.getZoom().toFixed(2)),
        bearing: normalizeRotationDeg(map.getBearing())
      });
    };

    const onMapError = (ev) => {
      const msg = String(ev?.error?.message || '');
      const isFatalStyleFetchError =
        !ev?.sourceId &&
        (/failed to fetch|network|cors|load style|timeout|404|500|502|503/i.test(msg) ||
          ev?.error?.status === 0);
      if (isFatalStyleFetchError && !fallbackAppliedRef.current && !styleReadyRef.current) {
        fallbackAppliedRef.current = true;
        try {
          map.setStyle(FALLBACK_DARK_STYLE);
        } catch {
          // ignore
        }
      }
    };

    const syncCameraUi = () => {
      const nextPitch = Math.round(map.getPitch() * 10) / 10;
      const nextBearing = Math.round(map.getBearing() * 10) / 10;
      setPitchDeg(nextPitch);
      setBearingDeg(nextBearing);
    };

    const onMoveEnd = () => {
      syncCameraUi();
      const c = map.getCenter();
      onViewportChangeRef.current?.({
        lat: Number(c.lat.toFixed(6)),
        lng: Number(c.lng.toFixed(6)),
        zoom: Number(map.getZoom().toFixed(2)),
        bearing: normalizeRotationDeg(map.getBearing())
      });
    };

    const onDragStart = () => {
      userAdjustedRef.current = true;
    };

    map.on('style.load', onStyleLoad);
    map.on('error', onMapError);
    map.on('render', drawWireframes);
    map.on('move', syncCameraUi);
    map.on('moveend', onMoveEnd);
    map.on('dragstart', onDragStart);
    map.on('zoomstart', onDragStart);

    const styleTimeout = setTimeout(() => {
      if (!styleReadyRef.current && !fallbackAppliedRef.current) {
        fallbackAppliedRef.current = true;
        try {
          map.setStyle(FALLBACK_DARK_STYLE);
        } catch {
          // ignore
        }
      }
    }, 12000);

    let observer = null;
    if (typeof ResizeObserver === 'function' && mapHostRef.current) {
      observer = new ResizeObserver(() => {
        map.resize();
        drawWireframes();
      });
      observer.observe(mapHostRef.current);
    }

    return () => {
      clearTimeout(styleTimeout);
      observer?.disconnect();
      map.off('style.load', onStyleLoad);
      map.off('error', onMapError);
      map.off('render', drawWireframes);
      map.off('move', syncCameraUi);
      map.off('moveend', onMoveEnd);
      map.off('dragstart', onDragStart);
      map.off('zoomstart', onDragStart);
      for (const mk of markersRef.current) mk.remove();
      markersRef.current = [];
      searchPinMarkerRef.current?.remove();
      searchPinMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
      styleReadyRef.current = false;
    };
  }, [drawWireframes, ensureCustomLayers]);

  // Sync GeoJSON 3D prisms & wireframes whenever drafts/parcels/selection/hover change
  useEffect(() => {
    syncGeoJsonSources();
  }, [parcels, draftParcels, selectedDraftId, hoveredDraftId, activeHandle, syncGeoJsonSources]);

  // Apply building extrusion toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    try {
      if (map.getLayer('building-3d')) {
        map.setPaintProperty('building-3d', 'fill-extrusion-opacity', showBuildings ? 0.78 : 0);
      }
    } catch {
      // ignore on fallback style
    }
  }, [showBuildings]);

  // Apply Terrarium 3D terrain toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    try {
      if (showTerrain && map.getSource('terrarium-dem')) {
        map.setTerrain({ source: 'terrarium-dem', exaggeration: 1.25 });
      } else {
        map.setTerrain(null);
      }
    } catch {
      // ignore if DEM blocked
    }
  }, [showTerrain]);

  // Disable left-click pan while Draw Land tool is active so dragging draws a rectangle
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (drawMode) {
      map.dragPan.disable();
    } else if (!gizmoDragRef.current) {
      map.dragPan.enable();
      dragStartRef.current = null;
      dragPreviewRef.current = null;
      hoverDrawPreviewRef.current = null;
      drawWireframes();
    }
  }, [drawMode, drawWireframes]);

  // Respond cleanly to parent viewMode switches ('2d' | '3d' | 'isometric')
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (firstViewModeSyncRef.current) {
      firstViewModeSyncRef.current = false;
      return;
    }
    if (viewMode === '2d') {
      map.easeTo({ pitch: 0, bearing: 0, duration: 550 });
    } else if (viewMode === '3d') {
      const targetPitch = map.getPitch() >= 25 ? map.getPitch() : 56;
      const targetBearing = Math.abs(map.getBearing()) >= 10 ? map.getBearing() : -35;
      map.easeTo({
        pitch: targetPitch,
        bearing: targetBearing,
        zoom: Math.max(map.getZoom(), 16.5),
        duration: 600
      });
    } else if (viewMode === 'isometric') {
      map.easeTo({
        pitch: 52,
        bearing: -45,
        zoom: Math.max(map.getZoom(), 17),
        duration: 600
      });
    }
  }, [viewMode]);

  // Fit initial view cleanly to sculptures when no saved session view exists
  useEffect(() => {
    const map = mapRef.current;
    if (!map || userAdjustedRef.current || focusArea) return;
    const valid = (sculptures || []).filter(
      (sc) => Number.isFinite(Number(sc.lat)) && Number.isFinite(Number(sc.lng))
    );
    if (valid.length === 1) {
      map.jumpTo({ center: [Number(valid[0].lng), Number(valid[0].lat)], zoom: 17 });
    } else if (valid.length > 1) {
      const bounds = new maplibregl.LngLatBounds();
      for (const sc of valid) bounds.extend([Number(sc.lng), Number(sc.lat)]);
      map.fitBounds(bounds, {
        padding: 60,
        maxZoom: 17,
        duration: 0,
        bearing: map.getBearing(),
        pitch: map.getPitch()
      });
    }
  }, [sculptures, focusArea]);

  // Render sculpture pin markers with XeroEmoji icons & Popup previews
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;

    for (const mk of markersRef.current) mk.remove();
    markersRef.current = [];

    for (const sc of sculptures || []) {
      const lat = Number(sc.lat);
      const lng = Number(sc.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const isSelected = sc.id === selectedSculptureId;
      const iconEmoji = isSelected ? '📍' : '🧊';
      const iconSize = isSelected ? 22 : 18;
      const emojiEntry = xeroemoji.get(iconEmoji);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `map3d-sculpture-marker ${isSelected ? 'is-selected' : ''}`;
      el.title = sc.title;
      if (emojiEntry?.svgUrl) {
        const img = document.createElement('img');
        img.src = emojiEntry.svgUrl;
        img.alt = sc.title || '';
        img.width = iconSize;
        img.height = iconSize;
        img.style.display = 'block';
        img.onerror = () => {
          el.textContent = iconEmoji;
        };
        el.appendChild(img);
      } else {
        el.textContent = iconEmoji;
      }

      const chainLinks = getSculptureChainLinks(sc, config);
      const popupEl = document.createElement('div');
      popupEl.style.cssText = 'font-size:12px;line-height:1.4;color:#0f172a;min-width:170px;';
      const titleEl = document.createElement('strong');
      titleEl.textContent = sc.title;
      const metaEl = document.createElement('div');
      metaEl.style.color = '#475569';
      metaEl.textContent = `${sc.parcelId} · ${sc.voxelCount || sc.voxels?.length || 0} blocks`;
      popupEl.append(titleEl, metaEl);
      if (chainLinks.txUrl) {
        const txLink = document.createElement('a');
        txLink.href = chainLinks.txUrl;
        txLink.target = '_blank';
        txLink.rel = 'noreferrer';
        txLink.style.cssText = 'display:inline-block;margin-top:4px;font-size:11px;color:#0284c7;';
        txLink.textContent = 'View Tx on Explorer';
        popupEl.append(txLink);
      }

      const popup = new maplibregl.Popup({ offset: 18, closeButton: false }).setDOMContent(popupEl);
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onSelectSculpture?.(sc);
      });

      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([lng, lat])
        .setPopup(popup)
        .addTo(map);
      markersRef.current.push(marker);
    }

    if (userLocation && Number.isFinite(Number(userLocation.lat)) && Number.isFinite(Number(userLocation.lng))) {
      const dot = document.createElement('div');
      dot.className = 'map3d-user-dot';
      dot.title = 'Your Location';
      const userMarker = new maplibregl.Marker({ element: dot, anchor: 'center' })
        .setLngLat([Number(userLocation.lng), Number(userLocation.lat)])
        .addTo(map);
      markersRef.current.push(userMarker);
    }

    return () => {
      for (const mk of markersRef.current) mk.remove();
      markersRef.current = [];
    };
  }, [sculptures, userLocation, selectedSculptureId, config, onSelectSculpture]);

  // Close search dropdown on outside click
  useEffect(() => {
    const onDocPointerDown = (e) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, []);

  // Live debounced dynamic autocomplete search as the user types
  const executeSearch = useCallback(
    async (rawQuery, { autoJumpIfSubmit = false } = {}) => {
      const q = String(rawQuery || '').trim();
      if (q.length < 2) {
        setSearchResults([]);
        setSearchError('');
        setSearchOpen(false);
        setActiveSearchIdx(-1);
        return;
      }
      const seq = ++searchSeqRef.current;
      setSearchBusy(true);
      setSearchError('');
      try {
        const c = mapRef.current?.getCenter?.();
        const res = await api.searchLocations(
          q,
          c ? { lat: c.lat, lng: c.lng } : userLocationRef.current
        );
        if (seq !== searchSeqRef.current) return;
        const list = res?.results || [];
        setSearchResults(list);
        setActiveSearchIdx(list.length > 0 ? 0 : -1);
        setSearchOpen(true);
        if (list.length === 0) {
          setSearchError('No matching intersection, business, or address found.');
        } else if (autoJumpIfSubmit && list.length === 1) {
          jumpToSearchResultRef.current?.(list[0]);
        }
      } catch (err) {
        if (seq !== searchSeqRef.current) return;
        setSearchError(err?.message || 'Location search unavailable.');
      } finally {
        if (seq === searchSeqRef.current) setSearchBusy(false);
      }
    },
    []
  );

  useEffect(() => {
    if (skipNextAutoSearchRef.current) {
      skipNextAutoSearchRef.current = false;
      return undefined;
    }
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearchError('');
      setSearchOpen(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      executeSearch(q, { autoJumpIfSubmit: false });
    }, 260);
    return () => clearTimeout(timer);
  }, [searchQuery, executeSearch]);

  const jumpToSearchResult = useCallback((item) => {
    if (!item || !Number.isFinite(Number(item.lat)) || !Number.isFinite(Number(item.lng))) return;
    skipNextAutoSearchRef.current = true;
    setSearchQuery(item.label || '');
    setSearchResults([]);
    setSearchOpen(false);
    setSearchError('');
    setActiveSearchIdx(-1);
    userAdjustedRef.current = true;

    const map = mapRef.current;
    if (!map) return;

    map.flyTo({
      center: [Number(item.lng), Number(item.lat)],
      zoom: 17.8,
      duration: 850
    });

    // Drop a crisp pulsing target pin at the searched spot
    searchPinMarkerRef.current?.remove();
    const pinEl = document.createElement('div');
    pinEl.className = 'map3d-search-pin';
    pinEl.title = item.label || 'Searched location';
    const dot = document.createElement('span');
    dot.className = 'map3d-search-pin-dot';
    const tag = document.createElement('span');
    tag.className = 'map3d-search-pin-label';
    tag.textContent = item.label || item.parcelId || 'Found';
    pinEl.append(dot, tag);
    searchPinMarkerRef.current = new maplibregl.Marker({ element: pinEl, anchor: 'bottom' })
      .setLngLat([Number(item.lng), Number(item.lat)])
      .addTo(map);
  }, []);

  useEffect(() => {
    jumpToSearchResultRef.current = jumpToSearchResult;
  }, [jumpToSearchResult]);

  // Interactive 3D Gizmo Hit Testing (corner balls -> vertical rotation bars -> edge segment bars -> top Z bar -> body)
  function hitTestGizmoAtScreenPt(px, py) {
    const map = mapRef.current;
    if (!map) return null;

    const ordered = [...(draftsRef.current || [])].sort((a, b) =>
      a.id === selectedDraftIdRef.current ? -1 : b.id === selectedDraftIdRef.current ? 1 : 0
    );

    for (const d of ordered) {
      const geom = computePrismScreenGeometry(map, maplibregl, d);
      if (!geom) continue;

      // 1) Corner Balls (bottom & top corners) -> scale width & depth
      for (let i = 0; i < 4; i++) {
        const dBot = Math.hypot(px - geom.bottom[i].x, py - geom.bottom[i].y);
        const dTop = Math.hypot(px - geom.top[i].x, py - geom.top[i].y);
        if (dBot <= 13 || dTop <= 12) {
          return {
            type: 'corner',
            index: i,
            draft: d,
            handleKey: `corner-${i}`,
            cursor: i % 2 === 0 ? 'nwse-resize' : 'nesw-resize',
            hint: 'Drag corner ball to scale'
          };
        }
      }

      // 2) Vertical Corner Bars -> hold & move to rotate the box
      for (let i = 0; i < 4; i++) {
        const seg = distPointToSegment(px, py, geom.bottom[i], geom.top[i]);
        if (seg.dist <= 11 && seg.t >= 0.14 && seg.t <= 0.86) {
          return {
            type: 'vbar',
            index: i,
            draft: d,
            handleKey: `vbar-${i}`,
            cursor: 'grab',
            hint: `Hold & drag vertical bar to rotate (${Math.round(d.rotationDeg || 0)}°)`
          };
        }
      }

      // 3) Side Segment Bars (bottom & top edges) -> move single segment
      for (let i = 0; i < 4; i++) {
        const next = (i + 1) % 4;
        const segBot = distPointToSegment(px, py, geom.bottom[i], geom.bottom[next]);
        const segTop = distPointToSegment(px, py, geom.top[i], geom.top[next]);
        if (
          (segBot.dist <= 10 && segBot.t >= 0.14 && segBot.t <= 0.86) ||
          (segTop.dist <= 9 && segTop.t >= 0.16 && segTop.t <= 0.84)
        ) {
          return {
            type: 'edge',
            index: i,
            draft: d,
            handleKey: `edge-${i}`,
            cursor: i % 2 === 0 ? 'ns-resize' : 'ew-resize',
            hint: 'Drag side bar to stretch edge'
          };
        }
      }

      // 4) Top Center Z-Height Pill -> scale Z axis height
      if (geom.topCenter?.visible && Math.hypot(px - geom.topCenter.x, py - geom.topCenter.y) <= 13) {
        return {
          type: 'height',
          index: 0,
          draft: d,
          handleKey: 'height',
          cursor: 'ns-resize',
          hint: `Drag top bar to change height (${Math.round(d.heightMeters)}m)`
        };
      }

      // 5) Interior Body -> select & move entire property
      let inside =
        pointInPolygon2D(px, py, geom.top) || pointInPolygon2D(px, py, geom.bottom);
      if (!inside) {
        for (let i = 0; i < 4; i++) {
          const next = (i + 1) % 4;
          const sideQuad = [geom.bottom[i], geom.bottom[next], geom.top[next], geom.top[i]];
          if (pointInPolygon2D(px, py, sideQuad)) {
            inside = true;
            break;
          }
        }
      }
      if (inside) {
        return {
          type: 'body',
          index: 0,
          draft: d,
          handleKey: 'body',
          cursor: 'move',
          hint: 'Drag to move property'
        };
      }
    }
    return null;
  }

  function handleOverlayPointerDown(e) {
    if (e.button !== 0 || !mapRef.current || !mapHostRef.current) return;
    if (e.target.closest('.map3d-ui-stop')) return;

    const rect = mapHostRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // Priority 1: Grab any existing unminted land or its gizmo handles (prevents drawing duplicate boxes on top!)
    const hit = hitTestGizmoAtScreenPt(px, py);
    if (hit) {
      const ll = mapRef.current.unproject([px, py]);
      if (!ll) return;
      if (selectedDraftIdRef.current !== hit.draft.id) {
        onSelectDraftRef.current?.(hit.draft.id);
      }
      setHoveredDraftId(hit.draft.id);
      setActiveHandle(hit.handleKey);
      setGizmoCursor(hit.type === 'vbar' ? 'grabbing' : hit.cursor);
      setGizmoHint(hit.hint);
      mapRef.current.dragPan.disable();

      const centerScreen = mapRef.current.project([hit.draft.centerLng, hit.draft.centerLat]);
      const startAngleRad = Math.atan2(py - centerScreen.y, px - centerScreen.x);

      gizmoDragRef.current = {
        ...hit,
        startPx: px,
        startPy: py,
        startLat: ll.lat,
        startLng: ll.lng,
        origLat: hit.draft.centerLat,
        origLng: hit.draft.centerLng,
        origRotationDeg: normalizeRotationDeg(hit.draft.rotationDeg || 0),
        origHeightMeters: Number(hit.draft.heightMeters || LAND_VOLUME_LIMITS.defaultHeightMeters),
        centerScreenX: centerScreen.x,
        centerScreenY: centerScreen.y,
        startAngleRad,
        startDraft: { ...hit.draft }
      };
      drawWireframes();
      return;
    }

    // Priority 2: Draw new land rectangle only when explicitly in drawMode on empty map space
    if (!drawModeRef.current) return;
    const ll = mapRef.current.unproject([px, py]);
    if (!ll) return;
    dragStartRef.current = { x: px, y: py, lng: ll.lng, lat: ll.lat };
    dragPreviewRef.current = null;
  }

  function handleOverlayPointerMove(e) {
    if (!mapRef.current || !mapHostRef.current) return;
    if (!gizmoDragRef.current && !dragStartRef.current && e.target.closest('.map3d-ui-stop')) {
      return;
    }

    const rect = mapHostRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // Active gizmo handle manipulation
    if (gizmoDragRef.current) {
      const g = gizmoDragRef.current;
      const ll = mapRef.current.unproject([px, py]);
      if (!ll) return;

      if (g.type === 'body') {
        const nextLat = Number((g.origLat + (ll.lat - g.startLat)).toFixed(7));
        const nextLng = Number((g.origLng + (ll.lng - g.startLng)).toFixed(7));
        onUpdateDraftRef.current?.(g.draft.id, { centerLat: nextLat, centerLng: nextLng });
        setGizmoHint('Moving property');
      } else if (g.type === 'corner') {
        const patch = scaleDraftFromCorner({
          draft: g.startDraft,
          cornerIndex: g.index,
          pointerLat: ll.lat,
          pointerLng: ll.lng,
          limits: LAND_VOLUME_LIMITS
        });
        if (patch) {
          onUpdateDraftRef.current?.(g.draft.id, patch);
          setGizmoHint(`Scaling ${patch.widthMeters}×${patch.depthMeters}m`);
        }
      } else if (g.type === 'edge') {
        const patch = resizeDraftFromEdge({
          draft: g.startDraft,
          edgeIndex: g.index,
          pointerLat: ll.lat,
          pointerLng: ll.lng,
          limits: LAND_VOLUME_LIMITS
        });
        if (patch) {
          onUpdateDraftRef.current?.(g.draft.id, patch);
          setGizmoHint(`Resizing side ${patch.widthMeters}×${patch.depthMeters}m`);
        }
      } else if (g.type === 'vbar') {
        const curAngle = Math.atan2(py - g.centerScreenY, px - g.centerScreenX);
        const deltaDeg = ((curAngle - g.startAngleRad) * 180) / Math.PI;
        const nextRot = Math.round(normalizeRotationDeg(g.origRotationDeg + deltaDeg));
        onUpdateDraftRef.current?.(g.draft.id, { rotationDeg: nextRot });
        setGizmoHint(`Rotating ${nextRot}°`);
      } else if (g.type === 'height') {
        const maxHInfo = computeMaxHeightForFootprint({
          widthMeters: g.startDraft.widthMeters,
          depthMeters: g.startDraft.depthMeters,
          limits: LAND_VOLUME_LIMITS
        });
        const deltaMeters = (g.startPy - py) * 0.55;
        const nextHeight = Number(
          Math.max(
            LAND_VOLUME_LIMITS.minHeightMeters,
            Math.min(maxHInfo.heightMeters, g.origHeightMeters + deltaMeters)
          ).toFixed(1)
        );
        const nextZScale = Number((nextHeight / LAND_VOLUME_LIMITS.defaultHeightMeters).toFixed(3));
        onUpdateDraftRef.current?.(g.draft.id, { heightMeters: nextHeight, zScale: nextZScale });
        setGizmoHint(`Height ${nextHeight}m`);
      }
      drawWireframes();
      return;
    }

    // Active drag-to-draw new land box
    if (drawModeRef.current && dragStartRef.current) {
      const dx = px - dragStartRef.current.x;
      const dy = py - dragStartRef.current.y;
      if (Math.hypot(dx, dy) < 6) {
        dragPreviewRef.current = null;
        drawWireframes();
        return;
      }
      const llEnd = mapRef.current.unproject([px, py]);
      if (!llEnd) return;
      dragPreviewRef.current = computeCameraAlignedDraftBox({
        startLat: dragStartRef.current.lat,
        startLng: dragStartRef.current.lng,
        endLat: llEnd.lat,
        endLng: llEnd.lng,
        bearingDeg: mapRef.current.getBearing(),
        limits: LAND_VOLUME_LIMITS
      });
      drawWireframes();
      return;
    }

    // Hover detection: hovering over any unminted land selects it & lights up its 3D controls
    const hit = hitTestGizmoAtScreenPt(px, py);
    if (hit) {
      hoverDrawPreviewRef.current = null;
      if (hoveredDraftIdRef.current !== hit.draft.id) {
        setHoveredDraftId(hit.draft.id);
      }
      if (selectedDraftIdRef.current !== hit.draft.id) {
        onSelectDraftRef.current?.(hit.draft.id);
      }
      if (activeHandleRef.current !== hit.handleKey) {
        setActiveHandle(hit.handleKey);
      }
      setGizmoCursor(hit.cursor);
      setGizmoHint(hit.hint);
    } else {
      if (hoveredDraftIdRef.current || activeHandleRef.current) {
        setHoveredDraftId('');
        setActiveHandle('');
        setGizmoCursor('');
        setGizmoHint('');
      }
      if (drawModeRef.current) {
        const llHover = mapRef.current.unproject([px, py]);
        if (llHover) {
          hoverDrawPreviewRef.current = {
            centerLat: Number(llHover.lat.toFixed(7)),
            centerLng: Number(llHover.lng.toFixed(7)),
            widthMeters: LAND_VOLUME_LIMITS.defaultWidthMeters,
            depthMeters: LAND_VOLUME_LIMITS.defaultDepthMeters,
            heightMeters: LAND_VOLUME_LIMITS.defaultHeightMeters,
            rotationDeg: normalizeRotationDeg(mapRef.current.getBearing())
          };
          drawWireframes();
        }
      } else if (hoverDrawPreviewRef.current) {
        hoverDrawPreviewRef.current = null;
        drawWireframes();
      }
    }
  }

  function handleOverlayPointerUp(e) {
    if (gizmoDragRef.current) {
      gizmoDragRef.current = null;
      if (mapRef.current && !drawModeRef.current) {
        mapRef.current.dragPan.enable();
      }
      setGizmoCursor('');
      setGizmoHint('');
      drawWireframes();
      return;
    }

    if (!drawModeRef.current || !dragStartRef.current || !mapRef.current || !mapHostRef.current) return;
    const start = dragStartRef.current;
    dragStartRef.current = null;
    dragPreviewRef.current = null;

    const rect = mapHostRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const dist = Math.hypot(px - start.x, py - start.y);
    const camBearing = normalizeRotationDeg(mapRef.current.getBearing());

    if (dist < 6) {
      const hit = hitTestGizmoAtScreenPt(px, py);
      if (hit) {
        onSelectDraftRef.current?.(hit.draft.id);
        drawWireframes();
        return;
      }
      onAddDraftRef.current?.({
        lat: start.lat,
        lng: start.lng,
        widthMeters: LAND_VOLUME_LIMITS.defaultWidthMeters,
        depthMeters: LAND_VOLUME_LIMITS.defaultDepthMeters,
        heightMeters: LAND_VOLUME_LIMITS.defaultHeightMeters,
        rotationDeg: camBearing
      });
    } else {
      const llEnd = mapRef.current.unproject([px, py]);
      if (llEnd) {
        const box = computeCameraAlignedDraftBox({
          startLat: start.lat,
          startLng: start.lng,
          endLat: llEnd.lat,
          endLng: llEnd.lng,
          bearingDeg: camBearing,
          limits: LAND_VOLUME_LIMITS
        });
        onAddDraftRef.current?.({
          lat: box.centerLat,
          lng: box.centerLng,
          widthMeters: box.widthMeters,
          depthMeters: box.depthMeters,
          heightMeters: box.heightMeters,
          rotationDeg: box.rotationDeg
        });
      }
    }
    drawWireframes();
  }

  async function handleSearchSubmit(ev) {
    ev?.preventDefault?.();
    if (searchOpen && searchResults.length > 0) {
      const target = searchResults[activeSearchIdx >= 0 ? activeSearchIdx : 0];
      if (target) {
        jumpToSearchResult(target);
        return;
      }
    }
    await executeSearch(searchQuery, { autoJumpIfSubmit: true });
  }

  function handleSearchKeyDown(e) {
    if (e.key === 'Escape') {
      setSearchOpen(false);
      return;
    }
    if (!searchOpen || searchResults.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveSearchIdx((prev) => (prev + 1) % searchResults.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveSearchIdx((prev) => (prev <= 0 ? searchResults.length - 1 : prev - 1));
    } else if (e.key === 'Enter' && activeSearchIdx >= 0 && searchResults[activeSearchIdx]) {
      e.preventDefault();
      jumpToSearchResult(searchResults[activeSearchIdx]);
    }
  }

  function rotateCamera(deltaDeg) {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ bearing: map.getBearing() + deltaDeg, duration: 300 });
  }

  function setTiltPitch(nextPitch) {
    const map = mapRef.current;
    if (!map) return;
    const p = Math.max(0, Math.min(65, Number(nextPitch)));
    map.setPitch(p);
    setPitchDeg(p);
    if (p <= 3 && viewMode !== '2d') {
      onViewModeChange?.('2d');
    } else if (p >= 20 && viewMode === '2d') {
      onViewModeChange?.('3d');
    }
  }

  function handleResetNorth() {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ bearing: 0, duration: 300 });
  }

  function handleCenterOnUser() {
    const map = mapRef.current;
    if (!map || !userLocation) return;
    userAdjustedRef.current = true;
    map.flyTo({ center: [Number(userLocation.lng), Number(userLocation.lat)], zoom: 17, duration: 750 });
  }

  return (
    <div
      ref={stageRef}
      className="map3d-stage"
      data-view-mode={viewMode}
      data-pitch={Math.round(pitchDeg)}
      data-bearing={Math.round(bearingDeg)}
      data-draw-mode={drawMode ? 'on' : 'off'}
      data-draft-count={draftParcels.length}
      data-owned-count={parcels.length}
      data-selected-draft-id={selectedDraftId || ''}
      data-hovered-draft-id={hoveredDraftId || ''}
      data-active-handle={activeHandle || ''}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', flex: 1, minHeight: 0 }}
    >
      {/* Top Camera & Draw Toolbar */}
      <div className="map3d-toolbar">
        <div className="map3d-toolbar-group" role="group" aria-label="Map Dimension Mode">
          <button
            type="button"
            className={`btn ${viewMode === '2d' ? 'btn-primary' : ''}`}
            style={{ padding: '4px 9px', fontSize: 11.5 }}
            onClick={() => onViewModeChange?.('2d')}
          >
            2D
          </button>
          <button
            type="button"
            className={`btn ${viewMode === '3d' ? 'btn-primary' : ''}`}
            style={{ padding: '4px 9px', fontSize: 11.5 }}
            onClick={() => onViewModeChange?.('3d')}
          >
            3D
          </button>
          <button
            type="button"
            className={`btn ${viewMode === 'isometric' ? 'btn-primary' : ''}`}
            style={{ padding: '4px 9px', fontSize: 11.5 }}
            onClick={() => onViewModeChange?.('isometric')}
          >
            Isometric
          </button>
          {onToggleDrawMode && (
            <button
              type="button"
              className={`btn ${drawMode ? 'btn-primary' : ''}`}
              style={{
                padding: '4px 9px',
                fontSize: 11.5,
                borderColor: drawMode ? undefined : 'rgba(0, 245, 212, 0.45)',
                color: drawMode ? undefined : 'var(--accent)'
              }}
              aria-pressed={drawMode}
              onClick={onToggleDrawMode}
            >
              {drawMode ? '✏️ Drawing Land' : '✏️ Draw Land'}
            </button>
          )}
          <InfoTip title="3D Map & Land Handles">
            Click <strong>Draw Land</strong> and drag to place a 3D parcel aligned with your map
            angle. Hover any plot to select it: drag <strong>corner balls</strong> to scale, drag{' '}
            <strong>side bars</strong> to stretch an edge, hold &amp; drag{' '}
            <strong>vertical gold bars</strong> to rotate, or drag the <strong>center</strong> to
            move.
          </InfoTip>
        </div>

        <div className="map3d-toolbar-group" role="group" aria-label="Canvas Tilt and Rotation">
          <button
            type="button"
            className="btn"
            style={{ padding: '4px 8px', fontSize: 11.5 }}
            onClick={() => rotateCamera(-15)}
            title="Rotate map counter-clockwise 15°"
          >
            ↺ -15°
          </button>
          <button
            type="button"
            className="btn"
            style={{ padding: '4px 8px', fontSize: 11.5 }}
            onClick={() => rotateCamera(15)}
            title="Rotate map clockwise 15°"
          >
            ↻ +15°
          </button>
          <button
            type="button"
            className="btn"
            style={{ padding: '4px 8px', fontSize: 11.5 }}
            onClick={handleResetNorth}
            title="Reset compass north"
          >
            🧭 North
          </button>
          <label className="map3d-tilt-control" title="Tilt from flat 2D to 3D">
            <span>Tilt {Math.round(pitchDeg)}°</span>
            <input
              type="range"
              min={0}
              max={65}
              step={1}
              value={Math.round(pitchDeg)}
              aria-label="Canvas 2D to 3D tilt"
              onChange={(e) => setTiltPitch(Number(e.target.value))}
            />
          </label>
        </div>

        <div className="map3d-toolbar-group">
          <button
            type="button"
            className={`btn ${showBuildings ? 'btn-primary' : ''}`}
            style={{ padding: '4px 9px', fontSize: 11.5 }}
            onClick={() => setShowBuildings((v) => !v)}
          >
            <XeroIcon emoji="🏢" size={12} /> Buildings
          </button>
          <button
            type="button"
            className={`btn ${showTerrain ? 'btn-primary' : ''}`}
            style={{ padding: '4px 9px', fontSize: 11.5 }}
            onClick={() => setShowTerrain((v) => !v)}
          >
            <XeroIcon emoji="🏔️" size={12} /> Terrain
          </button>
          {userLocation && (
            <button
              type="button"
              className="btn"
              style={{ padding: '4px 9px', fontSize: 11.5 }}
              onClick={handleCenterOnUser}
            >
              <XeroIcon emoji="🎯" size={12} /> Me
            </button>
          )}
        </div>
      </div>

      {/* Main 3D WebGL Map + Synchronized Wireframe & Gizmo Overlay */}
      <div
        className={`map-container ${drawMode && !hoveredDraftId ? 'is-draw-mode' : ''}`}
        style={gizmoCursor ? { cursor: gizmoCursor } : undefined}
        onPointerDown={handleOverlayPointerDown}
        onPointerMove={handleOverlayPointerMove}
        onPointerUp={handleOverlayPointerUp}
        onPointerCancel={handleOverlayPointerUp}
        onPointerLeave={() => {
          if (hoverDrawPreviewRef.current) {
            hoverDrawPreviewRef.current = null;
            drawWireframes();
          }
        }}
      >
        <div ref={mapHostRef} style={{ width: '100%', height: '100%' }} />
        <canvas ref={wireCanvasRef} className="map3d-wireframe-canvas" aria-hidden="true" />

        {/* Dynamic Live Intersection / Business / Address / Parcel Search */}
        <div ref={searchBoxRef} className="map3d-search-box map3d-ui-stop">
          <form className="map3d-search-form" onSubmit={handleSearchSubmit}>
            <input
              type="text"
              className="input map3d-search-input"
              placeholder="Search intersections, businesses, or GLAND-..."
              aria-label="Search locations, intersections, or businesses"
              autoComplete="off"
              value={searchQuery}
              onFocus={() => {
                if (searchResults.length > 0) setSearchOpen(true);
              }}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            {searchQuery && (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                aria-label="Clear search"
                onClick={() => {
                  setSearchQuery('');
                  setSearchResults([]);
                  setSearchOpen(false);
                  setSearchError('');
                  searchPinMarkerRef.current?.remove();
                  searchPinMarkerRef.current = null;
                }}
              >
                ✕
              </button>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              style={{ padding: '5px 10px', fontSize: 12 }}
              disabled={searchBusy}
            >
              {searchBusy ? '…' : 'Find'}
            </button>
          </form>
          {searchError && <div className="map3d-search-error">{searchError}</div>}
          {searchOpen && searchResults.length > 0 && (
            <div className="map3d-search-results" role="listbox" aria-label="Location search results">
              {searchResults.map((item, idx) => {
                const distLabel = formatSearchDistance(item.distanceMeters);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={idx === activeSearchIdx}
                    className={`map3d-search-item ${idx === activeSearchIdx ? 'is-active' : ''}`}
                    onMouseEnter={() => setActiveSearchIdx(idx)}
                    onClick={() => jumpToSearchResult(item)}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, width: '100%' }}>
                      <strong>{item.label}</strong>
                      <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
                        {distLabel && <span className="mono" style={{ fontSize: 10, color: 'var(--accent)' }}>{distLabel}</span>}
                        <span className="badge teal" style={{ fontSize: 10 }}>{item.category}</span>
                      </div>
                    </div>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                      {item.subtitle} · {item.parcelId}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Live Gizmo Handle Feedback Pill */}
        {gizmoHint && (
          <div className="map3d-gizmo-pill map3d-ui-stop" role="status">
            {gizmoHint}
          </div>
        )}

        {/* Auto-Switched 3D Prompt Pill */}
        {autoSwitchedHint && (
          <div className="map3d-auto3d-pill map3d-ui-stop" role="status">
            <span>Switched to 3D mode</span>
            <button
              type="button"
              className="btn"
              style={{ padding: '2px 8px', fontSize: 11 }}
              onClick={() => {
                onViewModeChange?.('2d');
                onDismissAuto3dHint?.();
              }}
            >
              Back to 2D
            </button>
            <button
              type="button"
              className="btn"
              style={{ padding: '2px 8px', fontSize: 11 }}
              onClick={() => {
                onViewModeChange?.('isometric');
                onDismissAuto3dHint?.();
              }}
            >
              Isometric
            </button>
            <button
              type="button"
              className="btn"
              style={{ padding: '2px 6px', fontSize: 11 }}
              aria-label="Dismiss 3D switch notice"
              onClick={() => onDismissAuto3dHint?.()}
            >
              ✕
            </button>
          </div>
        )}

        {/* Glowing Wireframe Color Legend */}
        <div className="map3d-legend map3d-ui-stop">
          <span className="map3d-legend-item">
            <span className="map3d-swatch is-considering" /> Draft ({draftParcels.length})
          </span>
          <span className="map3d-legend-item">
            <span className="map3d-swatch is-owned" /> Owned ({parcels.length})
          </span>
          <span className="map3d-legend-item">
            <span className="map3d-swatch is-sculptures" /> Art ({sculptures.length})
          </span>
        </div>
      </div>
    </div>
  );
}
