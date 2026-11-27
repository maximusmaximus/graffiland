import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import xeroemoji from 'xeroemoji';
import { LAND_VOLUME_LIMITS } from '../../../shared/constants.mjs';
import {
  buildDefaultVolumeFromBounds,
  buildParcelShareUrl,
  computeCameraAlignedDraftBox,
  computeMaxHeightForFootprint,
  computeOrientedFootprintLngLat,
  normalizeRotationDeg,
  resizeDraftFromEdge,
  resolveLandDisplayName,
  scaleDraftFromCorner
} from '../../../shared/landVolume.mjs';
import {
  extractSculptureBaseDimensions,
  extractSculptureScale,
  parcelLocalOffsetToWorldLatLng
} from '../../../shared/sculpturePlacement.mjs';
import { api, resolveApiUrl } from '../utils/api.js';
import { buildLandShareToXUrl, copyToClipboard } from '../utils/clipboard.js';
import {
  registerDesktopZoomableMap,
  zoomMapLibreByDelta
} from '../utils/desktopMapPinchZoom.js';
import { getSculptureChainLinks } from '../utils/chainLinks.js';
import {
  buildGoogleMapsLandUrl,
  computeClosestLandsPerimeterFit,
  formatSimpleLandLabel,
  resolveLandCoords
} from '../utils/landMapHelpers.js';
import { computeDraft3DAutoFit } from '../utils/landPreviewHelpers.js';
import {
  computePrismScreenGeometry,
  hitTestMintedParcelPrism,
  pointInPolygon2D,
  projectLngLatAltToScreen
} from '../utils/map3dProjection.js';
export { hitTestMintedParcelPrism };
import {
  drawFloatingCenterArrow,
  drawFloatingLandLabel,
  getPrismLabelAnchor
} from '../utils/map3dLabelOverlay.js';
import { buildDefaultHudReservedRects, rectsOverlap } from '../utils/canvasLabelLayout.js';
import { createSculptureThreeLayer } from '../utils/map3dSculptureLayer.js';
import {
  applyGraffilandMapLibreTheme,
  getFallbackMapLibreStyleForTheme,
  getMapLibreStyleForTheme,
  useMapTheme
} from '../utils/mapTheme.js';
import { useMeasurementUnits } from '../utils/measurementUnits.js';
import {
  buildNeighborArrowsSignature,
  computeNeighborEdgeArrows
} from '../utils/neighborEdgeArrows.js';
import { X_LOGO_SVG_PATH } from './XLogoIcon.jsx';
import {
  colorWithAlpha,
  computeGizmoDepthProfile,
  drawDepthFadedPrismEdges
} from '../utils/prismDepthFade.js';
import { buildSculptures3DGeoJson } from '../utils/sculpture3dGeoJson.js';
import InfoTip from './InfoTip.jsx';
import NeighborEdgeArrowsOverlay from './NeighborEdgeArrowsOverlay.jsx';
import XeroIcon from './XeroIcon.jsx';

const HOLD_TO_DRAW_MS = 380;
const HEIGHT_HANDLE_LIFT_PX = 26;

if (typeof maplibregl.setWorkerUrl === 'function' && maplibreWorkerUrl) {
  maplibregl.setWorkerUrl(maplibreWorkerUrl);
}

const TERRARIUM_DEM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];

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
  const isFrozen = Boolean(p?.frozen || p?.settings?.frozen);
  return {
    type: 'Feature',
    properties: {
      parcelId: p.parcelId,
      heightMeters: Number(vol.heightMeters || fallbackHeight),
      baseAltitudeM: Number(vol.baseAltitudeM || 0),
      color: isFrozen ? '#7dd3fc' : isDormant ? '#ff4da6' : '#ff1f8f',
      innerColor: isFrozen ? '#e0f2fe' : isDormant ? '#ffc2dc' : '#ffd6ec',
      borderColor: isFrozen ? '#7dd3fc' : isDormant ? '#ff85c0' : '#ff1f8f'
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
    showGizmo = false,
    activeHandle = '',
    includeBottomEdges = true
  }
) {
  if (!geom) return;
  const { bottom, top, topCenter } = geom;

  // Depth-faded 3D boundary wireframe: lines closest to user stay crisp, far-side lines fade >=25%
  drawDepthFadedPrismEdges(ctx, geom, {
    outerColor,
    innerColor,
    lineWidth,
    glowBlur,
    darkHalo: true,
    nearAlpha: 1.0,
    farAlpha: 0.32,
    includeBottomEdges
  });

  if (showGizmo) {
    const gizmoProfile = computeGizmoDepthProfile(bottom, top, { activeHandle });
    const { isHeightGroupActive } = gizmoProfile;

    const drawEdgeBar = (pA, pB, style, barColor) => {
      const s1 = lerpPt(pA, pB, 0.3);
      const s2 = lerpPt(pA, pB, 0.7);
      ctx.save();
      ctx.lineCap = 'round';
      if (style.haloAlpha > 0.04) {
        ctx.strokeStyle = `rgba(4, 10, 20, ${style.haloAlpha.toFixed(3)})`;
        ctx.lineWidth = style.width + (style.isOccluded && !style.isActive ? 1.4 : 2.8);
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.stroke();
      }

      ctx.strokeStyle = colorWithAlpha(barColor, style.alpha);
      ctx.shadowColor = style.glowBlur > 0 ? colorWithAlpha(barColor, style.alpha) : 'transparent';
      ctx.shadowBlur = style.glowBlur;
      ctx.lineWidth = style.width;
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.stroke();

      if (style.coreAlpha > 0.04) {
        ctx.strokeStyle = colorWithAlpha('#ffffff', style.coreAlpha);
        ctx.shadowBlur = 0;
        ctx.lineWidth = style.coreWidth;
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.stroke();
      }
      ctx.restore();
    };

    const drawVerticalBar = (pBot, pTop, style) => {
      const v1 = lerpPt(pBot, pTop, 0.22);
      const v2 = lerpPt(pBot, pTop, 0.78);
      const vColor = style.isActive ? '#ffd166' : '#ffb703';
      ctx.save();
      ctx.lineCap = 'round';
      if (style.haloAlpha > 0.04) {
        ctx.strokeStyle = `rgba(4, 10, 20, ${style.haloAlpha.toFixed(3)})`;
        ctx.lineWidth = style.width + (style.isOccluded && !style.isActive ? 1.6 : 2.8);
        ctx.beginPath();
        ctx.moveTo(v1.x, v1.y);
        ctx.lineTo(v2.x, v2.y);
        ctx.stroke();
      }

      ctx.strokeStyle = colorWithAlpha(vColor, style.alpha);
      ctx.shadowColor = style.glowBlur > 0 ? colorWithAlpha(vColor, style.alpha) : 'transparent';
      ctx.shadowBlur = style.glowBlur;
      ctx.lineWidth = style.width;
      ctx.beginPath();
      ctx.moveTo(v1.x, v1.y);
      ctx.lineTo(v2.x, v2.y);
      ctx.stroke();

      if (style.coreAlpha > 0.04) {
        ctx.strokeStyle = colorWithAlpha('#fff8dc', style.coreAlpha);
        ctx.shadowBlur = 0;
        ctx.lineWidth = style.isOccluded && !style.isActive ? 1.0 : 1.4;
        ctx.beginPath();
        ctx.moveTo(v1.x, v1.y);
        ctx.lineTo(v2.x, v2.y);
        ctx.stroke();
      }
      ctx.restore();
    };

    const drawCornerBall = (pt, style) => {
      const r = style.radius;
      const rimColor = style.isActive ? '#ffd166' : outerColor;
      ctx.save();
      if (style.haloAlpha > 0.04) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r + (style.isOccluded && !style.isActive ? 0.9 : 1.6), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(4, 10, 20, ${style.haloAlpha.toFixed(3)})`;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fillStyle = colorWithAlpha(rimColor, style.alpha);
      ctx.shadowColor = style.glowBlur > 0 ? colorWithAlpha(rimColor, style.alpha) : 'transparent';
      ctx.shadowBlur = style.glowBlur;
      ctx.fill();

      if (style.glintAlpha > 0.04) {
        ctx.beginPath();
        ctx.arc(pt.x - r * 0.2, pt.y - r * 0.2, Math.max(1.4, r * 0.45), 0, Math.PI * 2);
        ctx.fillStyle = colorWithAlpha('#ffffff', style.glintAlpha);
        ctx.shadowBlur = 0;
        ctx.fill();
      }
      ctx.restore();
    };

    // Pass 1: Occluded bottom bars & bottom corners (behind/underneath the 3D volume) drawn FIRST & faded
    for (const bar of gizmoProfile.bottomBars) {
      if (bar.isActive || !bar.isOccluded) continue;
      drawEdgeBar(bottom[bar.index], bottom[bar.next], bar, '#00f5d4');
    }
    for (const corner of gizmoProfile.bottomCorners) {
      if (corner.isActive || !corner.isOccluded) continue;
      drawCornerBall(bottom[corner.index], corner);
    }

    // Pass 2: Occluded back vertical rotation bars softly behind the top face
    for (const vbar of gizmoProfile.verticalBars) {
      if (vbar.isActive || !vbar.isOccluded) continue;
      drawVerticalBar(bottom[vbar.index], top[vbar.index], vbar);
    }

    // Pass 3: Interior dashed vertical center guide inside the prism
    if (topCenter?.visible) {
      const baseCenter = {
        x: (bottom[0].x + bottom[1].x + bottom[2].x + bottom[3].x) / 4,
        y: (bottom[0].y + bottom[1].y + bottom[2].y + bottom[3].y) / 4
      };
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = isHeightGroupActive
        ? 'rgba(255, 209, 102, 0.72)'
        : 'rgba(0, 245, 212, 0.42)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(baseCenter.x, baseCenter.y);
      ctx.lineTo(topCenter.x, topCenter.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Pass 4: Visible exterior front-bottom bars & corners (softly grounded beneath the top rim)
    for (const bar of gizmoProfile.bottomBars) {
      if (bar.isActive || bar.isOccluded) continue;
      drawEdgeBar(bottom[bar.index], bottom[bar.next], bar, '#00f5d4');
    }
    for (const corner of gizmoProfile.bottomCorners) {
      if (corner.isActive || corner.isOccluded) continue;
      drawCornerBall(bottom[corner.index], corner);
    }

    // Pass 5: Visible exterior vertical rotation bars
    for (const vbar of gizmoProfile.verticalBars) {
      if (vbar.isActive || vbar.isOccluded) continue;
      drawVerticalBar(bottom[vbar.index], top[vbar.index], vbar);
    }

    // Pass 6: Top rim bars (boldest & brightest cyan bars, strictly ON TOP of floor/wall bars)
    for (const bar of gizmoProfile.topBars) {
      drawEdgeBar(
        top[bar.index],
        top[bar.next],
        bar,
        bar.isActive ? '#ffd166' : '#38f8dc'
      );
    }

    // Pass 7: Top corner balls (strictly ON TOP of top rim bars)
    for (const corner of gizmoProfile.topCorners) {
      drawCornerBall(top[corner.index], corner);
    }

    // Pass 8: Actively hovered/dragged bottom or vertical handle promoted to crisp gold highlight
    for (const bar of gizmoProfile.bottomBars) {
      if (!bar.isActive) continue;
      drawEdgeBar(bottom[bar.index], bottom[bar.next], bar, '#ffd166');
    }
    for (const vbar of gizmoProfile.verticalBars) {
      if (!vbar.isActive) continue;
      drawVerticalBar(bottom[vbar.index], top[vbar.index], vbar);
    }
    for (const corner of gizmoProfile.bottomCorners) {
      if (!corner.isActive) continue;
      drawCornerBall(bottom[corner.index], corner);
    }

    // Pass 9: Pronounced Center Z-Axis Up/Down Elevator Handle (strictly LAST on top of everything)
    if (topCenter?.visible) {
      const isHActive = isHeightGroupActive;
      const liftY = topCenter.y - HEIGHT_HANDLE_LIFT_PX;
      const hColor = isHActive ? '#ffd166' : '#00f5d4';

      ctx.save();
      // Base anchor dot on top face center
      ctx.beginPath();
      ctx.arc(topCenter.x, topCenter.y, 4.2, 0, Math.PI * 2);
      ctx.fillStyle = hColor;
      ctx.shadowColor = hColor;
      ctx.shadowBlur = 10;
      ctx.fill();

      // Solid glowing elevator stem from topCenter up to lift handle
      ctx.strokeStyle = 'rgba(4, 10, 20, 0.9)';
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(topCenter.x, topCenter.y);
      ctx.lineTo(topCenter.x, liftY);
      ctx.stroke();

      ctx.strokeStyle = hColor;
      ctx.shadowColor = hColor;
      ctx.shadowBlur = isHActive ? 18 : 11;
      ctx.lineWidth = 3.6;
      ctx.beginPath();
      ctx.moveTo(topCenter.x, topCenter.y);
      ctx.lineTo(topCenter.x, liftY);
      ctx.stroke();

      // Pronounced circular up/down pull orb with bright ▲ / ▼ arrows
      const orbR = isHActive ? 15 : 13;
      ctx.beginPath();
      ctx.arc(topCenter.x, liftY, orbR + 2.2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(4, 10, 20, 0.94)';
      ctx.shadowBlur = 0;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(topCenter.x, liftY, orbR, 0, Math.PI * 2);
      ctx.fillStyle = isHActive ? 'rgba(255, 209, 102, 0.28)' : 'rgba(0, 245, 212, 0.24)';
      ctx.strokeStyle = hColor;
      ctx.lineWidth = isHActive ? 2.8 : 2.2;
      ctx.shadowColor = hColor;
      ctx.shadowBlur = isHActive ? 20 : 12;
      ctx.fill();
      ctx.stroke();

      // Up & down vertical arrow chevrons inside the orb
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#ffffff';
      ctx.fillStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Center vertical bar
      ctx.beginPath();
      ctx.moveTo(topCenter.x, liftY - 6.5);
      ctx.lineTo(topCenter.x, liftY + 6.5);
      ctx.stroke();

      // Up triangle ▲
      ctx.beginPath();
      ctx.moveTo(topCenter.x, liftY - 9.5);
      ctx.lineTo(topCenter.x - 4.2, liftY - 4.2);
      ctx.lineTo(topCenter.x + 4.2, liftY - 4.2);
      ctx.closePath();
      ctx.fill();

      // Down triangle ▼
      ctx.beginPath();
      ctx.moveTo(topCenter.x, liftY + 9.5);
      ctx.lineTo(topCenter.x - 4.2, liftY + 4.2);
      ctx.lineTo(topCenter.x + 4.2, liftY + 4.2);
      ctx.closePath();
      ctx.fill();
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
}

export default function MapView3D({
  sculptures = [],
  parcels = [],
  draftParcels = [],
  ownedParcelIds = [],
  selectedDraftId = '',
  drawMode = false,
  viewMode = 'isometric',
  autoSwitchedHint = false,
  userLocation = null,
  focusArea: _focusArea = false,
  selectedSculptureId = '',
  selectedParcelId = '',
  initialView = null,
  config = null,
  onViewportChange = null,
  onSelectSculpture = null,
  onSelectParcel = null,
  onAddDraftRectangle = null,
  onSelectDraft = null,
  onUpdateDraft = null,
  onDraftGestureStart = null,
  onDraftGestureEnd = null,
  onAdd3DItemForParcel = null,
  onTitleParcel = null,
  onCopyParcelShareLink = null,
  onNavigateParcel = null,
  onNavigateSculpture = null,
  focusTarget = null,
  onViewModeChange = null,
  onDismissAuto3dHint = null
}) {
  const stageRef = useRef(null);
  const mapHostRef = useRef(null);
  const wireCanvasRef = useRef(null);
  const floatingPinsLayerRef = useRef(null);
  const floatingPinMapRef = useRef(new Map());
  const floatingArtworkLayerRef = useRef(null);
  const floatingArtworkMapRef = useRef(new Map());
  const searchBoxRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const ownedMarkersRef = useRef([]);
  const searchPinMarkerRef = useRef(null);
  const styleReadyRef = useRef(false);
  const fallbackAppliedRef = useRef(false);
  const initialViewModeRef = useRef(viewMode);
  const firstViewModeSyncRef = useRef(true);

  const initPitchVal = viewMode === 'isometric' ? 52 : viewMode === '3d' ? 56 : 0;
  const initBearingVal = viewMode === 'isometric' ? -45 : viewMode === '3d' ? -35 : 0;
  const [pitchDeg, setPitchDeg] = useState(initPitchVal);
  const [bearingDeg, setBearingDeg] = useState(initBearingVal);
  // 3D buildings & terrain are enabled automatically in 3D/isometric; 3D buildings turn off in 2D
  const showBuildings = viewMode !== '2d';
  const showTerrain = true;
  const { mapTheme, isDarkMap, toggleMapTheme } = useMapTheme();
  const mapThemeRef = useRef(mapTheme);
  const appliedMapThemeRef = useRef(mapTheme);
  useEffect(() => {
    mapThemeRef.current = mapTheme;
  }, [mapTheme]);

  // Interactive hover, hold-to-draw, & gizmo cursor state
  const [hoveredDraftId, setHoveredDraftId] = useState('');
  const [activeHandle, setActiveHandle] = useState('');
  const [gizmoCursor, setGizmoCursor] = useState('');
  const [gizmoHint, setGizmoHint] = useState('');
  const [holdDrawActive, setHoldDrawActive] = useState(false);
  const draftCanvasDragMode = 'orbit';
  const [rendered3dSculptureCount, setRendered3dSculptureCount] = useState(0);
  const [loadedThree3dCount, setLoadedThree3dCount] = useState(0);
  const [edgeTags, setEdgeTags] = useState([]);
  const [edgeStageDims, setEdgeStageDims] = useState({ width: 0, height: 0 });
  const edgeTagsSigRef = useRef('');
  const mapHudRectsCacheRef = useRef({ w: 0, h: 0, ts: 0, rects: [] });
  const threeLayerRef = useRef(null);
  const { unitSystem } = useMeasurementUnits(userLocation);
  const unitSystemRef = useRef(unitSystem);
  useEffect(() => {
    unitSystemRef.current = unitSystem;
  }, [unitSystem]);

  // Dynamic Location Search state (intersections, businesses, landmarks, addresses, coords, parcels)
  const [searchQuery, setSearchQuery] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeSearchIdx, setActiveSearchIdx] = useState(-1);
  const [liveCamera, setLiveCamera] = useState({ lat: null, lng: null, zoom: null });
  const [isGizmoDragging, setIsGizmoDragging] = useState(false);
  const searchSeqRef = useRef(0);
  const skipNextAutoSearchRef = useRef(false);
  const pendingFocusTargetRef = useRef(null);
  const lastDraftAutoFitRef = useRef({ id: '', width: 0, depth: 0, height: 0, baseAlt: 0 });
  const appliedDraftPaddingRef = useRef(false);

  // Latest props kept in refs for synchronous MapLibre event handlers & 60fps Canvas2D rendering
  const sculpturesRef = useRef(sculptures);
  const selectedSculptureIdRef = useRef(selectedSculptureId);
  const selectedParcelIdRef = useRef(selectedParcelId);
  const parcelsRef = useRef(parcels);
  const draftsRef = useRef(draftParcels);
  const selectedDraftIdRef = useRef(selectedDraftId);
  const hoveredDraftIdRef = useRef(hoveredDraftId);
  const activeHandleRef = useRef(activeHandle);
  const drawModeRef = useRef(drawMode);
  const showBuildingsRef = useRef(showBuildings);
  const showTerrainRef = useRef(showTerrain);
  const onSelectSculptureRef = useRef(onSelectSculpture);
  const onSelectParcelRef = useRef(onSelectParcel);
  const onNavigateParcelRef = useRef(onNavigateParcel);
  const onNavigateSculptureRef = useRef(onNavigateSculpture);
  const onSelectDraftRef = useRef(onSelectDraft);
  const onAddDraftRef = useRef(onAddDraftRectangle);
  const onUpdateDraftRef = useRef(onUpdateDraft);
  const onDraftGestureStartRef = useRef(onDraftGestureStart);
  const onDraftGestureEndRef = useRef(onDraftGestureEnd);
  const onAdd3DItemForParcelRef = useRef(onAdd3DItemForParcel);
  const onTitleParcelRef = useRef(onTitleParcel);
  const onCopyParcelShareLinkRef = useRef(onCopyParcelShareLink);
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
  const holdDrawRef = useRef(null);
  const pendingSculptureClickRef = useRef(null);
  const pendingParcelClickRef = useRef(null);
  const gizmoDragRef = useRef(null);
  const orbitDragRef = useRef(null);
  const shiftPanActiveRef = useRef(false);
  const draftCanvasDragModeRef = useRef('orbit');
  const jumpToSearchResultRef = useRef(null);

  useEffect(() => {
    sculpturesRef.current = sculptures;
  }, [sculptures]);
  useEffect(() => {
    selectedSculptureIdRef.current = selectedSculptureId;
  }, [selectedSculptureId]);
  useEffect(() => {
    selectedParcelIdRef.current = selectedParcelId;
  }, [selectedParcelId]);
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
    onSelectSculptureRef.current = onSelectSculpture;
  }, [onSelectSculpture]);
  useEffect(() => {
    onSelectParcelRef.current = onSelectParcel;
  }, [onSelectParcel]);
  useEffect(() => {
    onNavigateParcelRef.current = onNavigateParcel;
  }, [onNavigateParcel]);
  useEffect(() => {
    onNavigateSculptureRef.current = onNavigateSculpture;
  }, [onNavigateSculpture]);
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
    onDraftGestureStartRef.current = onDraftGestureStart;
  }, [onDraftGestureStart]);
  useEffect(() => {
    onDraftGestureEndRef.current = onDraftGestureEnd;
  }, [onDraftGestureEnd]);
  useEffect(() => {
    onAdd3DItemForParcelRef.current = onAdd3DItemForParcel;
  }, [onAdd3DItemForParcel]);
  useEffect(() => {
    onTitleParcelRef.current = onTitleParcel;
  }, [onTitleParcel]);
  useEffect(() => {
    onCopyParcelShareLinkRef.current = onCopyParcelShareLink;
  }, [onCopyParcelShareLink]);
  useEffect(() => {
    if (
      !focusTarget ||
      !Number.isFinite(Number(focusTarget.lat)) ||
      !Number.isFinite(Number(focusTarget.lng))
    ) {
      return;
    }
    const targetLat = Number(focusTarget.lat);
    const targetLng = Number(focusTarget.lng);
    const targetZoom = Number(focusTarget.zoom || 17.8);
    const targetPitch = Number.isFinite(Number(focusTarget.pitch))
      ? Number(focusTarget.pitch)
      : undefined;
    const targetBearing = Number.isFinite(Number(focusTarget.bearing))
      ? Number(focusTarget.bearing)
      : undefined;
    const map = mapRef.current;
    userAdjustedRef.current = true;
    const camOpts = {
      center: [targetLng, targetLat],
      zoom: targetZoom,
      ...(targetPitch !== undefined ? { pitch: targetPitch } : {}),
      ...(targetBearing !== undefined ? { bearing: targetBearing } : {})
    };
    if (!map) {
      pendingFocusTargetRef.current = camOpts;
      return;
    }
    pendingFocusTargetRef.current = null;
    if (focusTarget.instant) {
      map.jumpTo(camOpts);
    } else {
      map.flyTo({
        ...camOpts,
        duration: 550
      });
    }
  }, [focusTarget]);
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

    // PASS 1: Draw all 3D wireframes & gizmos first so floating labels ALWAYS sit strictly on top
    const parcelGeomMap = new Map();
    const pendingFloatingLabels = [];

    // 1) Existing owned parcels -> depth-sorted back-to-front so nearer lands draw cleanly ahead of farther ones
    const projectedParcels = [];
    for (const p of parcelsRef.current || []) {
      const vol =
        p?.volume ||
        (p?.bounds ? buildDefaultVolumeFromBounds(p.bounds, p.parcelId, p.geohash) : null);
      if (!vol) continue;
      const geom = computePrismScreenGeometry(map, maplibregl, vol);
      if (!geom) continue;
      const isDormant = p?.stewardStatus === 'dormant';
      const isFrozen = Boolean(p?.frozen || p?.settings?.frozen);
      const pidUpper = String(p?.parcelId || '').toUpperCase();
      const isSelectedParcel =
        Boolean(selectedParcelIdRef.current) &&
        pidUpper === String(selectedParcelIdRef.current).toUpperCase();
      const outerColor = isSelectedParcel
        ? '#ffd166'
        : isFrozen
        ? '#7dd3fc'
        : isDormant
        ? '#ff4da6'
        : '#ff1f8f';
      const innerColor = isSelectedParcel
        ? '#fff3c4'
        : isFrozen
        ? '#e0f2fe'
        : isDormant
        ? '#ffc2dc'
        : '#ffd6ec';
      projectedParcels.push({
        pid: pidUpper,
        vol,
        geom,
        outerColor,
        innerColor,
        isSelectedParcel
      });
    }
    const mapPitch = Number(map.getPitch?.() || 0);
    projectedParcels.sort((a, b) => (b.geom.avgDepth || 0) - (a.geom.avgDepth || 0));
    for (const item of projectedParcels) {
      const isElevated = Number(item.vol?.baseAltitudeM || 0) > 0.25;
      if (mapPitch >= 2 || isElevated) {
        drawGlowingPrism(ctx, item.geom, {
          outerColor: item.outerColor,
          innerColor: item.innerColor,
          lineWidth: item.isSelectedParcel ? 2.5 : 1.8,
          glowBlur: item.isSelectedParcel ? 16 : 10,
          includeBottomEdges: isElevated
        });
      }
      if (item.pid) {
        parcelGeomMap.set(item.pid, {
          vol: item.vol,
          geom: item.geom,
          outerColor: item.outerColor,
          innerColor: item.innerColor
        });
      }
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
      const dimLabel = `${d.customName ? `${d.customName} · ` : ''}${Math.round(
        d.widthMeters
      )}×${Math.round(d.depthMeters)}×${Math.round(d.heightMeters)}m · ${Math.round(
        d.rotationDeg || 0
      )}°`;

      drawGlowingPrism(ctx, geom, {
        outerColor,
        innerColor,
        lineWidth: showGizmo ? 2.5 : 1.9,
        glowBlur: showGizmo ? 18 : 11,
        showGizmo,
        activeHandle: handleForThis
      });

      pendingFloatingLabels.push({
        geom,
        label: dimLabel,
        outerColor,
        innerColor,
        liftPx: showGizmo ? HEIGHT_HANDLE_LIFT_PX + 24 : 22,
        minY: 16
      });

      if (isSelected || (!activeGizmoCoords && isHovered)) {
        const edge0Mid = lerpPt(geom.bottom[0], geom.bottom[1], 0.5);
        const edge1Mid = lerpPt(geom.bottom[1], geom.bottom[2], 0.5);
        const topBar0Mid = lerpPt(geom.top[0], geom.top[1], 0.5);
        const topBar1Mid = lerpPt(geom.top[1], geom.top[2], 0.5);
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
          topBar0: [Math.round(topBar0Mid.x), Math.round(topBar0Mid.y)],
          topBar1: [Math.round(topBar1Mid.x), Math.round(topBar1Mid.y)],
          vbar0: [Math.round(vbar0Mid.x), Math.round(vbar0Mid.y)],
          vbar1: [Math.round(vbar1Mid.x), Math.round(vbar1Mid.y)],
          topCenter: [Math.round(geom.topCenter.x), Math.round(geom.topCenter.y)],
          heightHandle: [
            Math.round(geom.topCenter.x),
            Math.round(geom.topCenter.y - HEIGHT_HANDLE_LIFT_PX)
          ],
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
        const outerColor = preview.hitLimit ? '#ffd166' : '#00f5d4';
        drawGlowingPrism(ctx, geom, {
          outerColor,
          innerColor: '#ffffff',
          lineWidth: 2.3,
          glowBlur: 18
        });
        pendingFloatingLabels.push({
          geom,
          label: previewLabel,
          outerColor,
          innerColor: '#ffffff',
          liftPx: 22,
          minY: 16
        });
      }
    } else if (drawModeRef.current && hoverDrawPreviewRef.current && !hoveredDraftIdRef.current) {
      const hoverGeom = computePrismScreenGeometry(map, maplibregl, hoverDrawPreviewRef.current);
      if (hoverGeom) {
        drawGlowingPrism(ctx, hoverGeom, {
          outerColor: 'rgba(0, 245, 212, 0.72)',
          innerColor: 'rgba(234, 255, 252, 0.85)',
          lineWidth: 1.5,
          glowBlur: 10
        });
        pendingFloatingLabels.push({
          geom: hoverGeom,
          label: 'Click or drag to place',
          outerColor: 'rgba(0, 245, 212, 0.85)',
          innerColor: '#eafffc',
          liftPx: 18,
          minY: 16
        });
      }
    }

    // PASS 2: Floating land labels & top-center leader arrows strictly ON TOP of every wireframe
    const placedOverlayRects = [];
    const landPinEntries = [];
    for (const [pid, pinInfo] of floatingPinMapRef.current.entries()) {
      const entry = parcelGeomMap.get(pid);
      const el = pinInfo?.el;
      if (!el) continue;
      if (!entry) {
        el.style.display = 'none';
        continue;
      }
      const anchor = getPrismLabelAnchor(entry.geom);
      if (
        !anchor ||
        !anchor.visible ||
        anchor.roofCenter.x < 14 ||
        anchor.roofCenter.x > w - 14 ||
        anchor.roofCenter.y < 14 ||
        anchor.roofCenter.y > h - 14
      ) {
        el.style.display = 'none';
        continue;
      }
      landPinEntries.push({ pid, el, entry, anchor });
    }
    // Place foreground / selected parcels first so closest lands claim the cleanest anchor spots
    landPinEntries.sort((a, b) => {
      const aSel = a.pid === String(selectedParcelIdRef.current || '').toUpperCase() ? 1 : 0;
      const bSel = b.pid === String(selectedParcelIdRef.current || '').toUpperCase() ? 1 : 0;
      if (aSel !== bSel) return bSel - aSel;
      return (a.entry.geom.avgDepth || 0) - (b.entry.geom.avgDepth || 0);
    });

    for (const { el, entry, anchor } of landPinEntries) {
      el.style.display = 'flex';
      if (el.dataset.landAccent !== entry.outerColor) {
        el.dataset.landAccent = entry.outerColor;
        el.style.setProperty('--land-tag-accent', entry.outerColor);
        el.style.setProperty('--land-tag-text', entry.innerColor);
      }
      const pinW = el.offsetWidth || 132;
      const pinH = el.offsetHeight || 52;
      let pinBottomY = Math.max(46, Math.min(anchor.highestTopY, anchor.roofCenter.y) - 22);
      // Stagger vertically above colliding sibling land labels while keeping leader lines strictly plumb
      for (let attempt = 0; attempt < 5; attempt++) {
        const rect = {
          x: anchor.roofCenter.x - pinW / 2,
          y: pinBottomY - pinH,
          w: pinW,
          h: pinH
        };
        if (!placedOverlayRects.some((r) => rectsOverlap(rect, r, 4))) break;
        const shifted = pinBottomY - (pinH + 6);
        if (shifted < pinH + 6) break;
        pinBottomY = shifted;
      }

      el.style.transform = `translate3d(${Math.round(anchor.roofCenter.x)}px, ${Math.round(
        pinBottomY
      )}px, 0) translate(-50%, -100%)`;

      placedOverlayRects.push({
        x: anchor.roofCenter.x - pinW / 2,
        y: pinBottomY - pinH,
        w: pinW,
        h: pinH
      });

      // Extend land leader line strictly to the exact top center of the land boundary
      drawFloatingCenterArrow(ctx, {
        fromX: anchor.roofCenter.x,
        fromY: pinBottomY,
        toX: anchor.roofCenter.x,
        toY: anchor.roofCenter.y,
        color: entry.outerColor,
        dotColor: entry.innerColor
      });
    }

    // PASS 2b: Floating artwork labels strictly ABOVE all wireframe & leader lines (z-index 10)
    const artworkEntries = [];
    for (const [scId, info] of floatingArtworkMapRef.current.entries()) {
      const el = info?.el;
      const sc = info?.sculpture;
      if (!el || !sc) continue;
      const liveTransform = threeLayerRef.current?.getTransform?.(scId) || null;
      const scPid = String(sc.parcelId || '').toUpperCase();
      const parentVol = scPid ? parcelGeomMap.get(scPid)?.vol || null : null;
      const parcelRotDeg = Number(parentVol?.rotationDeg || 0);

      let artLat;
      let artLng;
      let artTopAlt;
      if (
        liveTransform &&
        Number.isFinite(Number(liveTransform.lat)) &&
        Number.isFinite(Number(liveTransform.lng))
      ) {
        if (
          Number.isFinite(Number(liveTransform.worldLat)) &&
          Number.isFinite(Number(liveTransform.worldLng))
        ) {
          artLat = Number(liveTransform.worldLat);
          artLng = Number(liveTransform.worldLng);
        } else {
          const wPos = parcelLocalOffsetToWorldLatLng(
            Number(liveTransform.lat),
            Number(liveTransform.lng),
            Number(liveTransform.anchorDx || 0),
            Number(liveTransform.anchorDz || 0),
            Number(liveTransform.parcelRotationDeg ?? parcelRotDeg)
          );
          artLat = wPos.lat;
          artLng = wPos.lng;
        }
        const renderedH = Math.max(0.2, Number(liveTransform.renderedSize?.y || 1));
        artTopAlt = Number(liveTransform.altitudeMeters || 0) + renderedH;
      } else {
        const rawLat = Number(sc.lat);
        const rawLng = Number(sc.lng);
        if (!Number.isFinite(rawLat) || !Number.isFinite(rawLng)) {
          el.style.display = 'none';
          continue;
        }
        const dxM = Number(sc.anchorOffset?.dx || 0);
        const dyM = Math.max(0, Number(sc.anchorOffset?.dy || 0));
        const dzM = Number(sc.anchorOffset?.dz || 0);
        const wPos = parcelLocalOffsetToWorldLatLng(rawLat, rawLng, dxM, dzM, parcelRotDeg);
        artLat = wPos.lat;
        artLng = wPos.lng;
        const baseDims = extractSculptureBaseDimensions(sc);
        const userScale = extractSculptureScale(sc);
        const baseAlt = Number(parentVol?.baseAltitudeM || 0);
        artTopAlt = baseAlt + dyM + Math.max(0.2, baseDims.height * userScale);
      }

      const pt = projectLngLatAltToScreen(map, maplibregl, artLng, artLat, artTopAlt);
      if (
        !pt ||
        !pt.visible ||
        !Number.isFinite(pt.x) ||
        !Number.isFinite(pt.y) ||
        pt.x < 14 ||
        pt.x > w - 14 ||
        pt.y < 14 ||
        pt.y > h - 14
      ) {
        el.style.display = 'none';
        continue;
      }
      artworkEntries.push({
        scId,
        el,
        isSelected: scId === selectedSculptureIdRef.current,
        isPendingPreview: Boolean(sc.isPendingPreview),
        pt
      });
    }
    artworkEntries.sort((a, b) => (b.pt.depth || 0) - (a.pt.depth || 0));

    for (const item of artworkEntries) {
      const { el, pt, isSelected, isPendingPreview } = item;
      el.style.display = 'inline-flex';
      const elW = el.offsetWidth || 124;
      const elH = el.offsetHeight || 28;
      const minCenterX = Math.min(w / 2, elW / 2 + 10);
      const maxCenterX = Math.max(w / 2, w - elW / 2 - 10);
      const baseCenterX = Math.max(minCenterX, Math.min(maxCenterX, pt.x));
      const baseBottomY = Math.max(elH + 12, Math.min(h - 14, pt.y - 18));

      // Avoid blocking land labels or sibling artwork pills even in dense clusters
      const stepY = elH + 10;
      const stepX = Math.max(elW * 0.92 + 14, 128);
      const candidates = [
        { cx: baseCenterX, by: baseBottomY },
        { cx: baseCenterX, by: Math.max(elH + 12, baseBottomY - stepY) },
        { cx: Math.min(maxCenterX, baseCenterX + stepX), by: baseBottomY },
        { cx: Math.max(minCenterX, baseCenterX - stepX), by: baseBottomY },
        { cx: baseCenterX, by: Math.min(h - 14, pt.y + elH + 18) },
        { cx: Math.min(maxCenterX, baseCenterX + stepX), by: Math.max(elH + 12, baseBottomY - stepY) },
        { cx: Math.max(minCenterX, baseCenterX - stepX), by: Math.max(elH + 12, baseBottomY - stepY) },
        { cx: baseCenterX, by: Math.max(elH + 12, baseBottomY - stepY * 2) },
        { cx: baseCenterX, by: Math.min(h - 14, pt.y + elH + 18 + stepY) },
        { cx: Math.min(maxCenterX, baseCenterX + stepX * 1.45), by: baseBottomY },
        { cx: Math.max(minCenterX, baseCenterX - stepX * 1.45), by: baseBottomY },
        { cx: baseCenterX, by: Math.max(elH + 12, baseBottomY - stepY * 3) }
      ];
      let chosen = candidates[0];
      let bestOverlapScore = Infinity;
      for (const cand of candidates) {
        const rect = { x: cand.cx - elW / 2, y: cand.by - elH, w: elW, h: elH };
        if (!placedOverlayRects.some((r) => rectsOverlap(rect, r, 6))) {
          chosen = cand;
          bestOverlapScore = 0;
          break;
        }
        let overlapScore = 0;
        for (const r of placedOverlayRects) {
          const ox = Math.max(0, Math.min(rect.x + rect.w + 4, r.x + r.w) - Math.max(rect.x - 4, r.x));
          const oy = Math.max(0, Math.min(rect.y + rect.h + 4, r.y + r.h) - Math.max(rect.y - 4, r.y));
          overlapScore += ox * oy;
        }
        if (overlapScore < bestOverlapScore) {
          bestOverlapScore = overlapScore;
          chosen = cand;
        }
      }
      placedOverlayRects.push({
        x: chosen.cx - elW / 2,
        y: chosen.by - elH,
        w: elW,
        h: elH
      });

      el.style.transform = `translate3d(${Math.round(chosen.cx)}px, ${Math.round(
        chosen.by
      )}px, 0) translate(-50%, -100%)`;

      const stemFromY = chosen.by < pt.y ? chosen.by : chosen.by - elH;
      const artLineColor = isSelected || isPendingPreview ? '#ffd166' : '#00f5d4';
      const artDotColor = isSelected || isPendingPreview ? '#fff8dc' : '#eafffc';
      drawFloatingCenterArrow(ctx, {
        fromX: chosen.cx,
        fromY: stemFromY,
        toX: pt.x,
        toY: pt.y,
        color: artLineColor,
        dotColor: artDotColor
      });
    }

    // PASS 2c: Off-screen clickable edge tags so lands & sculptures outside the viewport stay reachable on the edges
    if (drawModeRef.current || (draftsRef.current || []).length > 0) {
      if (edgeTagsSigRef.current !== '') {
        edgeTagsSigRef.current = '';
        setEdgeTags([]);
      }
    } else {
      const onScreenParcelIds = new Set(
        landPinEntries
          .filter(
            (lp) =>
              lp.anchor.roofCenter.x >= 14 &&
              lp.anchor.roofCenter.x <= w - 14 &&
              lp.anchor.roofCenter.y >= 14 &&
              lp.anchor.roofCenter.y <= h - 14
          )
          .map((lp) => lp.pid)
      );
      const onScreenSculptureIds = new Set(
        artworkEntries
          .filter(
            (a) =>
              a.pt.x >= 14 &&
              a.pt.x <= w - 14 &&
              a.pt.y >= 14 &&
              a.pt.y <= h - 14
          )
          .map((a) => a.scId)
      );

      const selPidUpper = String(selectedParcelIdRef.current || '').toUpperCase();
      const selScId = String(selectedSculptureIdRef.current || '');
      let focusedOnScreenEntry = null;
      const offScreenLandEntries = [];

      for (const p of parcelsRef.current || []) {
        const pidUpper = String(p?.parcelId || '').toUpperCase();
        if (!pidUpper) continue;
        const vol =
          parcelGeomMap.get(pidUpper)?.vol ||
          p?.volume ||
          (p?.bounds ? buildDefaultVolumeFromBounds(p.bounds, p.parcelId, p.geohash) : null);
        if (!vol) continue;
        const isSel = Boolean(selPidUpper && pidUpper === selPidUpper);
        if (onScreenParcelIds.has(pidUpper)) {
          if (isSel) {
            focusedOnScreenEntry = { parcel: p, volume: vol };
          }
          continue;
        }
        offScreenLandEntries.push({
          parcel: p,
          volume: vol,
          isSelected: isSel
        });
      }

      const offScreenSculptureCandidates = [];
      for (const sc of sculpturesRef.current || []) {
        if (!sc?.id || sc.hidden) continue;
        if (onScreenSculptureIds.has(sc.id)) continue;
        const scLat = Number(sc.lat);
        const scLng = Number(sc.lng);
        if (!Number.isFinite(scLat) || !Number.isFinite(scLng)) continue;
        const scPidUpper = String(sc.parcelId || '').toUpperCase();
        const isSel = Boolean(selScId && sc.id === selScId);
        const isPending = Boolean(sc.isPendingPreview);
        const belongsToOnScreenLand = Boolean(scPidUpper && onScreenParcelIds.has(scPidUpper));
        const isStandalone = !scPidUpper;
        if (
          isSel ||
          isPending ||
          belongsToOnScreenLand ||
          isStandalone ||
          offScreenLandEntries.length < 4
        ) {
          offScreenSculptureCandidates.push({
            id: sc.id,
            sculpture: sc,
            title: sc.title || '3D Artwork',
            lat: scLat,
            lng: scLng,
            alt: 0,
            isSelected: isSel,
            isPendingPreview: isPending
          });
        }
      }

      const mapCenter = typeof map.getCenter === 'function' ? map.getCenter() : null;
      const originCoords =
        mapCenter && Number.isFinite(mapCenter.lat) && Number.isFinite(mapCenter.lng)
          ? { lat: mapCenter.lat, lng: mapCenter.lng }
          : null;

      const nowMs = performance.now();
      const hudCache = mapHudRectsCacheRef.current;
      let measuredMapHudRects = hudCache.rects;
      if (hudCache.w !== w || hudCache.h !== h || nowMs - hudCache.ts > 500) {
        measuredMapHudRects = [];
        const containerEl = mapHostRef.current?.parentElement;
        if (containerEl && typeof containerEl.getBoundingClientRect === 'function') {
          const containerRect = containerEl.getBoundingClientRect();
          containerEl
            .querySelectorAll(
              '.map3d-search-box, .map3d-floating-toolbar, .map3d-legend, .map3d-gizmo-pill, .map3d-auto3d-pill, .maplibregl-ctrl-top-right, .maplibregl-ctrl-bottom-right'
            )
            .forEach((node) => {
              const r = node.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                measuredMapHudRects.push({
                  x: r.left - containerRect.left,
                  y: r.top - containerRect.top,
                  w: r.width,
                  h: r.height
                });
              }
            });
        }
        mapHudRectsCacheRef.current = { w, h, ts: nowMs, rects: measuredMapHudRects };
      }
      const mapEdgeReservedRects = buildDefaultHudReservedRects({
        stageWidth: w,
        stageHeight: h,
        topLeftWidth: 260,
        topRightWidth: 96,
        topHeight: 54,
        bottomLeftWidth: 200,
        bottomRightWidth: 120,
        bottomHeight: 48,
        measuredRects: measuredMapHudRects
      });

      const nextEdgeTags =
        (focusedOnScreenEntry || originCoords) &&
        (offScreenLandEntries.length > 0 || offScreenSculptureCandidates.length > 0)
          ? computeNeighborEdgeArrows({
              focusedEntry: focusedOnScreenEntry,
              originCoords,
              otherEntries: offScreenLandEntries,
              otherSculptures: offScreenSculptureCandidates,
              projectLngLat: (lng, lat, alt = 0) =>
                projectLngLatAltToScreen(map, maplibregl, lng, lat, alt),
              viewportWidth: w,
              viewportHeight: h,
              bearingDeg: typeof map.getBearing === 'function' ? map.getBearing() : 0,
              reservedRects: [...mapEdgeReservedRects, ...placedOverlayRects],
              maxArrows: 6,
              edgeInsetX: 10,
              topInsetY: 12,
              bottomInsetY: 12,
              edgeOnly: true,
              defaultLandColor: '#ff1f8f',
              unitSystem: unitSystemRef.current
            })
          : [];

      const nextEdgeSig = buildNeighborArrowsSignature(nextEdgeTags);
      if (nextEdgeSig !== edgeTagsSigRef.current) {
        edgeTagsSigRef.current = nextEdgeSig;
        setEdgeTags(nextEdgeTags);
        setEdgeStageDims((prev) =>
          prev.width === Math.round(w) && prev.height === Math.round(h)
            ? prev
            : { width: Math.round(w), height: Math.round(h) }
        );
      }
    }

    const desktopReservedRects = buildDefaultHudReservedRects({
      stageWidth: w,
      stageHeight: h,
      topLeftWidth: 260,
      topRightWidth: 220,
      topHeight: 54,
      bottomLeftWidth: 160,
      bottomRightWidth: 140,
      bottomHeight: 46
    });
    const desktopPlacedLabels = [];
    for (const item of pendingFloatingLabels) {
      drawFloatingLandLabel(ctx, item.geom, {
        ...item,
        minY: Math.max(52, Number(item.minY || 52)),
        stageWidth: w,
        stageHeight: h,
        reservedRects: desktopReservedRects,
        placedRects: desktopPlacedLabels
      });
    }
    // 4) Hold-to-draw charge progress ring (when user holds down on 1 map location)
    const hold = holdDrawRef.current;
    if (hold && !hold.activated) {
      const elapsed = performance.now() - hold.startedAt;
      if (elapsed >= 80) {
        const progress = Math.max(0, Math.min(1, (elapsed - 80) / (HOLD_TO_DRAW_MS - 80)));
        ctx.save();
        ctx.beginPath();
        ctx.arc(hold.startPx, hold.startPy, 18, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0, 245, 212, 0.25)';
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(
          hold.startPx,
          hold.startPy,
          18,
          -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * progress
        );
        ctx.strokeStyle = '#00f5d4';
        ctx.shadowColor = '#00f5d4';
        ctx.shadowBlur = 14;
        ctx.lineWidth = 3.5;
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.restore();
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
    const sc3d = buildSculptures3DGeoJson(
      sculpturesRef.current || [],
      selectedSculptureIdRef.current || '',
      parcelsRef.current || []
    );
    setRendered3dSculptureCount(sc3d.renderedCount);

    const ownedSrc = map.getSource('owned-lands');
    if (ownedSrc && typeof ownedSrc.setData === 'function') {
      ownedSrc.setData({ type: 'FeatureCollection', features: ownedFeatures });
    }
    const draftSrc = map.getSource('draft-lands');
    if (draftSrc && typeof draftSrc.setData === 'function') {
      draftSrc.setData({ type: 'FeatureCollection', features: draftFeatures });
    }
    const sculpturesSrc = map.getSource('sculptures-3d');
    if (sculpturesSrc && typeof sculpturesSrc.setData === 'function') {
      sculpturesSrc.setData(sc3d.geojson);
    }
    if (threeLayerRef.current && typeof threeLayerRef.current.setData === 'function') {
      threeLayerRef.current.setData({
        sculptures: sculpturesRef.current || [],
        parcels: parcelsRef.current || [],
        selectedSculptureId: selectedSculptureIdRef.current || ''
      });
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

    applyGraffilandMapLibreTheme(map, {
      theme: mapThemeRef.current,
      showBuildings: showBuildingsRef.current,
      buildingOpacity: 0.78
    });

    try {
      if (showTerrainRef.current && map.getSource('terrarium-dem')) {
        map.setTerrain({ source: 'terrarium-dem', exaggeration: 1.25 });
      } else {
        map.setTerrain(null);
      }
    } catch {
      // ignore if DEM blocked
    }

    try {
      if (!map.getSource('owned-lands')) {
        map.addSource('owned-lands', { type: 'geojson', data: EMPTY_FC });
      }
      // Render owned land bottom floor + glowing ground perimeter strictly BEFORE 3D sculptures
      // so the pink land base ALWAYS sits on the bottom behind the models, never in the foreground.
      if (!map.getLayer('owned-lands-floor-fill')) {
        map.addLayer({
          id: 'owned-lands-floor-fill',
          type: 'fill',
          source: 'owned-lands',
          paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': 0.2
          }
        });
      }
      if (!map.getLayer('owned-lands-floor-glow')) {
        map.addLayer({
          id: 'owned-lands-floor-glow',
          type: 'line',
          source: 'owned-lands',
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 7,
            'line-blur': 5,
            'line-opacity': 0.34
          }
        });
      }
      if (!map.getLayer('owned-lands-floor-outline')) {
        map.addLayer({
          id: 'owned-lands-floor-outline',
          type: 'line',
          source: 'owned-lands',
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 2.4,
            'line-opacity': 0.92
          }
        });
      }
      if (!map.getLayer('owned-lands-floor-core')) {
        map.addLayer({
          id: 'owned-lands-floor-core',
          type: 'line',
          source: 'owned-lands',
          paint: {
            'line-color': ['get', 'innerColor'],
            'line-width': 1,
            'line-opacity': 0.68
          }
        });
      }

      if (!map.getSource('draft-lands')) {
        map.addSource('draft-lands', { type: 'geojson', data: EMPTY_FC });
      }
      if (!map.getLayer('draft-lands-floor-fill')) {
        map.addLayer({
          id: 'draft-lands-floor-fill',
          type: 'fill',
          source: 'draft-lands',
          paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': 0.2
          }
        });
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
            'fill-extrusion-opacity': 0.16
          }
        });
      }

      // Mount real un-pixelated Three.js 3D models STRICTLY AFTER all ground land floor layers
      let threeMounted = Boolean(map.getLayer('sculptures-three-3d'));
      if (!threeMounted) {
        try {
          const threeLayer = createSculptureThreeLayer({
            id: 'sculptures-three-3d',
            maplibregl,
            resolveUrlFn: resolveApiUrl,
            onStatsChange: (stats) => {
              setLoadedThree3dCount(stats?.loadedCount || 0);
              drawWireframes();
            }
          });
          threeLayerRef.current = threeLayer;
          map.addLayer(threeLayer);
          threeMounted = Boolean(map.getLayer('sculptures-three-3d'));
        } catch {
          threeLayerRef.current = null;
          threeMounted = false;
        }
      }

      if (!map.getSource('sculptures-3d')) {
        map.addSource('sculptures-3d', { type: 'geojson', data: EMPTY_FC });
      }
      if (!map.getLayer('sculptures-3d-extrusion')) {
        map.addLayer({
          id: 'sculptures-3d-extrusion',
          type: 'fill-extrusion',
          source: 'sculptures-3d',
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-height': ['get', 'heightMeters'],
            'fill-extrusion-base': ['get', 'baseMeters'],
            // Keep subtle invisible hit-proxy for click picking when real Three.js layer is active
            'fill-extrusion-opacity': threeMounted ? 0.001 : 0.94,
            'fill-extrusion-vertical-gradient': true
          }
        });
      }
    } catch {
      // never fail basemap rendering on custom overlay setup
    }

    syncGeoJsonSources();
  }, [drawWireframes, syncGeoJsonSources]);

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

    let map;
    try {
      appliedMapThemeRef.current = mapThemeRef.current;
      map = new maplibregl.Map({
        container: mapHostRef.current,
        style: getMapLibreStyleForTheme(mapThemeRef.current),
        center: centerLngLat,
        zoom: startZoom,
        minZoom: 1,
        maxZoom: 22,
        pitch: initPitch,
        bearing: initBearing,
        maxPitch: 68,
        antialias: true,
        attributionControl: true
      });
      // Keep wheel & pinch zoom responsive and unrestricted while drafting/sizing tall 3D lands
      map.scrollZoom?.enable?.();
      map.scrollZoom?.setWheelZoomRate?.(1 / 180);
      map.scrollZoom?.setZoomRate?.(1 / 65);
      map.touchZoomRotate?.enable?.();
    } catch {
      return undefined;
    }

    map.addControl(
      new maplibregl.NavigationControl({ showCompass: true, showZoom: true, visualizePitch: true }),
      'top-right'
    );

    mapRef.current = map;
    const unregisterPinchZoom = registerDesktopZoomableMap({
      id: 'map-view-3d',
      getContainer: () => stageRef.current || mapHostRef.current,
      getNativeTarget: () => mapHostRef.current,
      zoomByDelta: (delta, cx, cy) =>
        zoomMapLibreByDelta(map, delta, cx, cy, () => {
          userAdjustedRef.current = true;
        })
    });

    if (pendingFocusTargetRef.current) {
      const pending = pendingFocusTargetRef.current;
      pendingFocusTargetRef.current = null;
      userAdjustedRef.current = true;
      map.jumpTo(
        pending.center
          ? pending
          : { center: [pending.lng, pending.lat], zoom: pending.zoom }
      );
    }

    const onStyleLoad = () => {
      ensureCustomLayers(map);
      const c = map.getCenter();
      const z = Number(map.getZoom().toFixed(2));
      const lat = Number(c.lat.toFixed(6));
      const lng = Number(c.lng.toFixed(6));
      setLiveCamera({ lat, lng, zoom: z });
      onViewportChangeRef.current?.({
        lat,
        lng,
        zoom: z,
        bearing: normalizeRotationDeg(map.getBearing())
      });
    };

    let tileErrCount = 0;
    const onMapError = (ev) => {
      const msg = String(ev?.error?.message || '');
      const isTileSourceError =
        ev?.sourceId === 'openmaptiles' &&
        (/failed to fetch|network|cors|timeout|404|429|500|502|503/i.test(msg) ||
          ev?.error?.status === 0 ||
          Number(ev?.error?.status) >= 400);
      if (isTileSourceError) {
        tileErrCount += 1;
      }
      const isFatalStyleFetchError =
        !ev?.sourceId &&
        (/failed to fetch|network|cors|load style|timeout|404|429|500|502|503/i.test(msg) ||
          ev?.error?.status === 0);
      if (
        !fallbackAppliedRef.current &&
        ((isFatalStyleFetchError && !styleReadyRef.current) || tileErrCount >= 3)
      ) {
        fallbackAppliedRef.current = true;
        styleReadyRef.current = false;
        try {
          map.setStyle(getFallbackMapLibreStyleForTheme(mapThemeRef.current));
        } catch {
          // ignore
        }
      }
    };

    const glCanvas = map.getCanvas?.();
    const onContextLost = (ev) => {
      ev.preventDefault();
    };
    const onContextRestored = () => {
      try {
        map.triggerRepaint?.();
        drawWireframes();
      } catch {
        // ignore
      }
    };
    glCanvas?.addEventListener?.('webglcontextlost', onContextLost, false);
    glCanvas?.addEventListener?.('webglcontextrestored', onContextRestored, false);

    const syncCameraUi = () => {
      const nextPitch = Math.round(map.getPitch() * 10) / 10;
      const nextBearing = Math.round(map.getBearing() * 10) / 10;
      setPitchDeg(nextPitch);
      setBearingDeg(nextBearing);
    };

    const onMoveEnd = () => {
      syncCameraUi();
      const c = map.getCenter();
      const z = Number(map.getZoom().toFixed(2));
      const lat = Number(c.lat.toFixed(6));
      const lng = Number(c.lng.toFixed(6));
      setLiveCamera({ lat, lng, zoom: z });
      onViewportChangeRef.current?.({
        lat,
        lng,
        zoom: z,
        bearing: normalizeRotationDeg(map.getBearing())
      });
    };

    const onDragStart = (ev) => {
      if (ev?.originalEvent) {
        userAdjustedRef.current = true;
      }
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
          map.setStyle(getFallbackMapLibreStyleForTheme(mapThemeRef.current));
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
      glCanvas?.removeEventListener?.('webglcontextlost', onContextLost);
      glCanvas?.removeEventListener?.('webglcontextrestored', onContextRestored);
      map.off('style.load', onStyleLoad);
      map.off('error', onMapError);
      map.off('render', drawWireframes);
      map.off('move', syncCameraUi);
      map.off('moveend', onMoveEnd);
      map.off('dragstart', onDragStart);
      map.off('zoomstart', onDragStart);
      for (const mk of markersRef.current) mk.remove();
      markersRef.current = [];
      for (const mk of ownedMarkersRef.current) mk.remove();
      ownedMarkersRef.current = [];
      if (holdDrawRef.current) {
        clearTimeout(holdDrawRef.current.timerId);
        cancelAnimationFrame(holdDrawRef.current.rafId);
        holdDrawRef.current = null;
      }
      searchPinMarkerRef.current?.remove();
      searchPinMarkerRef.current = null;
      unregisterPinchZoom();
      map.remove();
      mapRef.current = null;
      styleReadyRef.current = false;
    };
  }, [drawWireframes, ensureCustomLayers]);

  // Sync GeoJSON 3D prisms, 3D sculptures & wireframes whenever data/selection/hover change
  useEffect(() => {
    syncGeoJsonSources();
  }, [
    sculptures,
    selectedSculptureId,
    parcels,
    draftParcels,
    selectedDraftId,
    hoveredDraftId,
    activeHandle,
    syncGeoJsonSources
  ]);

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

  // Live Dark / Light basemap theme switching
  useEffect(() => {
    const map = mapRef.current;
    if (!map || appliedMapThemeRef.current === mapTheme) return;
    appliedMapThemeRef.current = mapTheme;
    styleReadyRef.current = false;
    fallbackAppliedRef.current = false;
    try {
      map.setStyle(getMapLibreStyleForTheme(mapTheme));
    } catch {
      // ignore if map is unmounting
    }
  }, [mapTheme]);

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

  // Disable left-click pan while Draw Land tool is active or while orbiting around a drawn land
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const shouldOrbitDrafts = draftParcels.length > 0 && draftCanvasDragMode === 'orbit';
    if (drawMode || shouldOrbitDrafts) {
      map.dragPan.disable();
      if (!drawMode) {
        dragStartRef.current = null;
        dragPreviewRef.current = null;
        hoverDrawPreviewRef.current = null;
        drawWireframes();
      }
    } else if (!gizmoDragRef.current && !orbitDragRef.current) {
      map.dragPan.enable();
      dragStartRef.current = null;
      dragPreviewRef.current = null;
      hoverDrawPreviewRef.current = null;
      drawWireframes();
    }
  }, [drawMode, draftParcels.length, draftCanvasDragMode, drawWireframes]);

  useEffect(() => {
    drawWireframes();
  }, [selectedParcelId, drawWireframes]);

  // Respond cleanly to parent viewMode switches ('2d' | '3d' | 'isometric')
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (firstViewModeSyncRef.current) {
      firstViewModeSyncRef.current = false;
      return;
    }
    const hostCanvas = map.getCanvas?.();
    const vw = hostCanvas?.clientWidth || mapHostRef.current?.clientWidth || 840;
    const vh = hostCanvas?.clientHeight || mapHostRef.current?.clientHeight || 540;
    const activeDraft =
      (draftsRef.current || []).find((d) => d.id === selectedDraftIdRef.current) ||
      (draftsRef.current || [])[0] ||
      null;

    if (viewMode === '2d') {
      map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 550 });
    } else if (viewMode === '3d') {
      const targetPitch = map.getPitch() >= 25 ? map.getPitch() : 56;
      const targetBearing = Math.abs(map.getBearing()) >= 10 ? map.getBearing() : -35;
      const curZoom = map.getZoom();
      const draftFit = activeDraft
        ? computeDraft3DAutoFit(activeDraft, {
            viewportWidth: vw,
            viewportHeight: vh,
            pitchDeg: targetPitch,
            bearingDeg: targetBearing
          })
        : null;
      const nextZoom = draftFit
        ? Math.min(Math.max(curZoom, Math.min(16.5, draftFit.zoom)), draftFit.zoom)
        : Math.max(curZoom, 16.5);
      map.easeTo({
        pitch: targetPitch,
        bearing: targetBearing,
        zoom: nextZoom,
        ...(draftFit ? { padding: draftFit.padding } : {}),
        duration: 600
      });
    } else if (viewMode === 'isometric') {
      const curZoom = map.getZoom();
      const draftFit = activeDraft
        ? computeDraft3DAutoFit(activeDraft, {
            viewportWidth: vw,
            viewportHeight: vh,
            pitchDeg: 52,
            bearingDeg: -45
          })
        : null;
      const nextZoom = draftFit
        ? Math.min(Math.max(curZoom, Math.min(17, draftFit.zoom)), draftFit.zoom)
        : Math.max(curZoom, 17);
      map.easeTo({
        pitch: 52,
        bearing: -45,
        zoom: nextZoom,
        ...(draftFit ? { padding: draftFit.padding } : {}),
        duration: 600
      });
    }
  }, [viewMode]);

  // Auto-zoom out when drafting/growing a tall or wide land (sliders, Max Height, Max Limit Size, or new plot)
  // so the top rectangle & ↕ height handle never clip off the top of the map viewport.
  useEffect(() => {
    const map = mapRef.current;
    const activeDraft =
      (draftParcels || []).find((d) => d.id === selectedDraftId) ||
      (draftParcels || [])[0] ||
      null;
    if (!map || !activeDraft) {
      if (!activeDraft) {
        lastDraftAutoFitRef.current = { id: '', width: 0, depth: 0, height: 0, baseAlt: 0 };
        if (appliedDraftPaddingRef.current && map) {
          appliedDraftPaddingRef.current = false;
          map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 240 });
        }
      }
      return;
    }

    const wM = Number(activeDraft.widthMeters || 0);
    const dM = Number(activeDraft.depthMeters || 0);
    const hM = Number(activeDraft.heightMeters || 0);
    const bM = Number(activeDraft.baseAltitudeM || 0);
    const prev = lastDraftAutoFitRef.current;
    const switchedDraft = prev.id !== activeDraft.id;
    const grew =
      !switchedDraft &&
      (hM > prev.height + 0.5 ||
        wM > prev.width + 1 ||
        dM > prev.depth + 1 ||
        bM > prev.baseAlt + 0.5);

    lastDraftAutoFitRef.current = { id: activeDraft.id, width: wM, depth: dM, height: hM, baseAlt: bM };

    if ((!switchedDraft && !grew) || gizmoDragRef.current || orbitDragRef.current) {
      return;
    }

    const hostCanvas = map.getCanvas?.();
    const vw = hostCanvas?.clientWidth || mapHostRef.current?.clientWidth || 0;
    const vh = hostCanvas?.clientHeight || mapHostRef.current?.clientHeight || 0;
    if (vw <= 0 || vh <= 0) return;

    const geom = computePrismScreenGeometry(map, maplibregl, activeDraft);
    const topMinY = geom
      ? Math.min(...geom.top.map((p) => p.y), geom.topCenter.y - HEIGHT_HANDLE_LIFT_PX)
      : -999;
    const isClipped =
      !geom ||
      topMinY < 42 ||
      geom.screenBounds.minX < 8 ||
      geom.screenBounds.maxX > vw - 8;
    if (!isClipped) return;

    const fit = computeDraft3DAutoFit(activeDraft, {
      viewportWidth: vw,
      viewportHeight: vh,
      pitchDeg: map.getPitch(),
      bearingDeg: map.getBearing()
    });
    if (!fit) return;

    const curZoom = map.getZoom();
    const targetZoom = Math.min(curZoom, fit.zoom);
    userAdjustedRef.current = true;
    if (hM >= 36) {
      appliedDraftPaddingRef.current = true;
    }
    map.easeTo({
      center: fit.center,
      zoom: targetZoom,
      ...(hM >= 36 ? { padding: fit.padding } : {}),
      duration: !geom ? 280 : 380,
      essential: true
    });
  }, [draftParcels, selectedDraftId]);

  // Fit initial view tightly to the perimeter of the closest available lands across the full width
  useEffect(() => {
    const map = mapRef.current;
    if (!map || userAdjustedRef.current) return;
    const closestFit = computeClosestLandsPerimeterFit({
      parcels,
      sculptures,
      location: userLocation
    });
    if (closestFit.boundsLngLat) {
      map.fitBounds(closestFit.boundsLngLat, {
        padding: { left: 18, right: 18, top: 68, bottom: 48 },
        maxZoom: 19.2,
        duration: 0,
        bearing: map.getBearing(),
        pitch: map.getPitch()
      });
      drawWireframes();
      return;
    }
    const valid = (sculptures || []).filter(
      (sc) => Number.isFinite(Number(sc.lat)) && Number.isFinite(Number(sc.lng))
    );
    if (valid.length === 1) {
      map.jumpTo({ center: [Number(valid[0].lng), Number(valid[0].lat)], zoom: 17.5 });
    } else if (valid.length > 1) {
      const bounds = new maplibregl.LngLatBounds();
      for (const sc of valid) bounds.extend([Number(sc.lng), Number(sc.lat)]);
      map.fitBounds(bounds, {
        padding: { left: 18, right: 18, top: 68, bottom: 48 },
        maxZoom: 19,
        duration: 0,
        bearing: map.getBearing(),
        pitch: map.getPitch()
      });
    }
  }, [parcels, sculptures, userLocation, drawWireframes]);

  // Render floating sculpture label pills strictly ABOVE wireframe & leader lines (z-index 10)
  // and keep the GPS user-location dot on the ground layer.
  useEffect(() => {
    const map = mapRef.current;
    const artLayer = floatingArtworkLayerRef.current;
    const artMap = floatingArtworkMapRef.current;

    for (const mk of markersRef.current) mk.remove();
    markersRef.current = [];
    for (const { el } of artMap.values()) {
      el.remove();
    }
    artMap.clear();

    if (artLayer) {
      for (const sc of sculptures || []) {
        if (!sc?.id || sc.hidden) continue;
        const lat = Number(sc.lat);
        const lng = Number(sc.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

        const isSelected = sc.id === selectedSculptureId;
        const isPendingPreview = Boolean(sc.isPendingPreview);
        const iconEmoji = isPendingPreview ? '⏳' : isSelected ? '📍' : '🧊';
        const iconSize = isSelected ? 20 : 17;
        const emojiEntry = xeroemoji.get(iconEmoji);
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `map3d-sculpture-marker map3d-ui-stop ${isSelected ? 'is-selected' : ''} ${
          isPendingPreview ? 'is-pending-preview' : ''
        }`.trim();
        el.dataset.sculptureId = sc.id;
        el.dataset.testid = isPendingPreview ? 'map3d-preview-label' : 'map3d-artwork-label';
        if (isPendingPreview) {
          el.dataset.pendingPreview = 'true';
          if (sc.pendingRequestId) el.dataset.requestId = sc.pendingRequestId;
        }
        el.setAttribute(
          'aria-label',
          isPendingPreview
            ? `Preview pending sculpture: ${sc.title || sc.id} (needs approval)`
            : `View 3D artwork: ${sc.title || sc.id}`
        );

        const chainLinks = isPendingPreview ? null : getSculptureChainLinks(sc, config);
        if (chainLinks?.txUrl) {
          el.dataset.txUrl = chainLinks.txUrl;
        }
        const liveParcel = (parcelsRef.current || []).find(
          (p) => String(p?.parcelId || '').toUpperCase() === String(sc.parcelId || '').toUpperCase()
        );
        const landLabel = resolveLandDisplayName(
          {
            customName: liveParcel?.customName || sc.parcelName || '',
            displayName: liveParcel?.displayName || sc.landDisplayName || '',
            firstSculptureTitle: sc.title || '',
            placeName: sc.placeName || ''
          },
          { defaultName: 'Virtual Land' }
        );
        const assetMeta =
          sc.modelType === 'custom-3d'
            ? `${String(sc.customModel?.format || '3D').toUpperCase()} 3D Model`
            : `${sc.voxelCount || sc.voxels?.length || 0} blocks`;
        el.title = isPendingPreview
          ? `Preview (Pending Approval) — "${sc.title || '3D Artwork'}" on ${landLabel} (${assetMeta}). Click to inspect & approve.`
          : `View "${sc.title || '3D Artwork'}" in 3D (${landLabel} · ${assetMeta})`;

        const iconWrap = document.createElement('span');
        iconWrap.className = 'map3d-sculpture-icon';
        if (emojiEntry?.svgUrl) {
          const img = document.createElement('img');
          img.src = emojiEntry.svgUrl;
          img.alt = '';
          img.width = iconSize;
          img.height = iconSize;
          img.style.display = 'block';
          img.onerror = () => {
            iconWrap.textContent = iconEmoji;
          };
          iconWrap.appendChild(img);
        } else {
          iconWrap.textContent = iconEmoji;
        }
        el.appendChild(iconWrap);
        if (isPendingPreview) {
          const previewPill = document.createElement('span');
          previewPill.className = 'map-preview-pill';
          previewPill.dataset.testid = 'map-preview-badge';
          previewPill.textContent = 'Preview';
          el.appendChild(previewPill);
        }
        if (sc.title) {
          const labelSpan = document.createElement('span');
          labelSpan.className = 'map3d-sculpture-label';
          const rawTitle = String(sc.title).trim();
          labelSpan.textContent =
            rawTitle.length > 20 ? `${rawTitle.slice(0, 19).trimEnd()}…` : rawTitle;
          el.appendChild(labelSpan);
        }

        el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onSelectSculptureRef.current?.(sc);
        });

        el.style.display = 'none';
        artLayer.appendChild(el);
        artMap.set(sc.id, { el, sculpture: sc });
      }
    }

    if (
      map &&
      userLocation &&
      Number.isFinite(Number(userLocation.lat)) &&
      Number.isFinite(Number(userLocation.lng))
    ) {
      const dot = document.createElement('div');
      dot.className = 'map3d-user-dot';
      dot.title = 'Your Location';
      const userMarker = new maplibregl.Marker({ element: dot, anchor: 'center' })
        .setLngLat([Number(userLocation.lng), Number(userLocation.lat)])
        .addTo(map);
      markersRef.current.push(userMarker);
    }

    drawWireframes();

    return () => {
      for (const mk of markersRef.current) mk.remove();
      markersRef.current = [];
      for (const { el } of artMap.values()) {
        el.remove();
      }
      artMap.clear();
    };
  }, [sculptures, parcels, userLocation, selectedSculptureId, config, drawWireframes]);

  // Render floating action & label pins strictly above wireframes (+, Title, Copy Share Link for owned; Copy Link for public)
  useEffect(() => {
    const pinLayer = floatingPinsLayerRef.current;
    const pinMap = floatingPinMapRef.current;
    if (!pinLayer) return undefined;

    for (const mk of ownedMarkersRef.current) mk.remove();
    ownedMarkersRef.current = [];
    for (const { el } of pinMap.values()) {
      el.remove();
    }
    pinMap.clear();

    const ownedSet = new Set((ownedParcelIds || []).map((id) => String(id).toUpperCase()));
    const sculptureCountByParcel = new Map();
    for (const sc of sculptures || []) {
      if (!sc || sc.hidden || sc.isPendingPreview) continue;
      const scPid = String(sc.parcelId || '').toUpperCase();
      if (!scPid) continue;
      sculptureCountByParcel.set(scPid, (sculptureCountByParcel.get(scPid) || 0) + 1);
    }

    for (const p of parcels || []) {
      const pid = String(p?.parcelId || '').toUpperCase();
      if (!pid) continue;
      const isOwned = ownedSet.has(pid);
      const lat = Number(p?.volume?.centerLat ?? p?.centerLat ?? p?.bounds?.center?.[0]);
      const lng = Number(p?.volume?.centerLng ?? p?.centerLng ?? p?.bounds?.center?.[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const itemCount = Math.max(
        Number(p?.sculptureCount ?? 0) || 0,
        sculptureCountByParcel.get(pid) || 0
      );
      const isEmptyLand = itemCount === 0;
      const landName = resolveLandDisplayName(p, { defaultName: 'Virtual Land' });
      const wrap = document.createElement('div');
      wrap.className = 'map3d-owned-action-pin map3d-ui-stop';

      if (isOwned) {
        const btnRow = document.createElement('div');
        btnRow.className = 'map3d-owned-action-row';

        const plusBtn = document.createElement('button');
        plusBtn.type = 'button';
        plusBtn.className = `map3d-owned-plus-btn map3d-ui-stop ${p?.frozen ? 'is-frozen' : ''}`;
        plusBtn.dataset.parcelId = pid;
        plusBtn.setAttribute('aria-label', `Add 3D item to ${landName}`);
        plusBtn.title = p?.frozen
          ? `${landName} is Frozen — click + to unfreeze or view agent prompt`
          : `Add a 3D item to ${landName} (Model Link or Agent Prompt)`;
        plusBtn.textContent = p?.frozen ? '+ ❄️' : '+';
        plusBtn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        plusBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onAdd3DItemForParcelRef.current?.(p);
        });
        btnRow.appendChild(plusBtn);

        const titleBtn = document.createElement('button');
        titleBtn.type = 'button';
        titleBtn.className = 'map3d-owned-mini-btn map3d-ui-stop';
        titleBtn.dataset.parcelId = pid;
        titleBtn.setAttribute('aria-label', `Title land ${landName}`);
        titleBtn.title = `Title or describe ${landName}`;
        titleBtn.textContent = '✎';
        titleBtn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        titleBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onTitleParcelRef.current?.(p);
        });
        btnRow.appendChild(titleBtn);

        wrap.appendChild(btnRow);
      }

      const labelPill = document.createElement('div');
      labelPill.className = `map3d-land-label-pill map3d-ui-stop ${
        isEmptyLand ? 'is-empty-land' : ''
      }`;
      labelPill.dataset.emptyLand = isEmptyLand ? 'true' : 'false';

      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'map3d-owned-plus-tag map3d-ui-stop';
      badge.dataset.testid = 'map3d-land-label';
      badge.dataset.parcelId = pid;
      badge.textContent = formatSimpleLandLabel(p);
      badge.setAttribute('aria-label', `Open detailed view for ${landName}`);
      badge.title = `${landName} — click to open detailed view`;
      badge.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      badge.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onSelectParcelRef.current?.(p);
      });

      const shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.className = `map3d-parcel-share-btn map3d-land-label-copy-btn map3d-ui-stop ${
        isOwned ? '' : 'is-public'
      } ${isEmptyLand ? 'is-empty-land' : ''}`.trim();
      shareBtn.dataset.testid = 'map3d-land-copy-btn';
      shareBtn.dataset.parcelId = pid;
      shareBtn.setAttribute('aria-label', `Copy share link for ${landName}`);
      shareBtn.title = `Copy shareable visit link for ${landName}`;
      const copyIconUrl = xeroemoji.get('📋')?.svgUrl || '';
      const renderIdleCopyContent = () => {
        shareBtn.replaceChildren();
        if (copyIconUrl) {
          const img = document.createElement('img');
          img.src = copyIconUrl;
          img.alt = '';
          img.setAttribute('aria-hidden', 'true');
          img.width = 15;
          img.height = 15;
          img.className = 'xero-icon';
          img.style.width = '15px';
          img.style.height = '15px';
          img.style.objectFit = 'contain';
          shareBtn.appendChild(img);
        } else {
          shareBtn.appendChild(document.createTextNode('📋'));
        }
        if (isEmptyLand) {
          shareBtn.appendChild(document.createTextNode(' Copy'));
        }
      };
      const copiedText = isEmptyLand ? '✓ Copied' : '✓';
      renderIdleCopyContent();
      shareBtn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      shareBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (onCopyParcelShareLinkRef.current) {
          await onCopyParcelShareLinkRef.current(p);
        } else {
          const shareUrl = buildParcelShareUrl({
            origin: window.location.origin,
            pathname: window.location.pathname,
            parcelId: pid,
            customName: p.customName || '',
            compact: true
          });
          await copyToClipboard(shareUrl);
        }
        shareBtn.textContent = copiedText;
        shareBtn.classList.add('is-copied');
        setTimeout(() => {
          renderIdleCopyContent();
          shareBtn.classList.remove('is-copied');
        }, 1800);
      });

      const xShareLink = document.createElement('a');
      xShareLink.href = buildLandShareToXUrl({
        parcelId: pid,
        customName: p.customName || '',
        landName
      });
      xShareLink.target = '_blank';
      xShareLink.rel = 'noopener noreferrer';
      xShareLink.className = 'map3d-land-label-x-btn map3d-ui-stop';
      xShareLink.dataset.testid = 'map3d-land-x-share-btn';
      xShareLink.dataset.parcelId = pid;
      xShareLink.setAttribute('aria-label', `Share ${landName} on X`);
      xShareLink.title = `Share ${landName} on X (Twitter)`;
      const svgNs = 'http://www.w3.org/2000/svg';
      const xSvg = document.createElementNS(svgNs, 'svg');
      xSvg.setAttribute('viewBox', '0 0 24 24');
      xSvg.setAttribute('width', '12');
      xSvg.setAttribute('height', '12');
      xSvg.setAttribute('fill', 'currentColor');
      xSvg.setAttribute('aria-hidden', 'true');
      const xPath = document.createElementNS(svgNs, 'path');
      xPath.setAttribute('d', X_LOGO_SVG_PATH);
      xSvg.appendChild(xPath);
      xShareLink.appendChild(xSvg);
      xShareLink.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      xShareLink.addEventListener('click', (ev) => ev.stopPropagation());

      const navCoords = resolveLandCoords(p);
      const navUrl = navCoords ? buildGoogleMapsLandUrl(navCoords.lat, navCoords.lng) : '';
      let navLink = null;
      if (navUrl) {
        navLink = document.createElement('a');
        navLink.href = navUrl;
        navLink.target = '_blank';
        navLink.rel = 'noopener noreferrer';
        navLink.className = 'map3d-land-label-nav-btn map3d-ui-stop';
        navLink.dataset.testid = 'map3d-land-nav-btn';
        navLink.dataset.parcelId = pid;
        navLink.setAttribute('aria-label', `Navigate to ${landName}`);
        navLink.title = `Navigate to ${landName}`;
        const navIconUrl = xeroemoji.get('🧭')?.svgUrl || '';
        if (navIconUrl) {
          const img = document.createElement('img');
          img.src = navIconUrl;
          img.alt = '';
          img.setAttribute('aria-hidden', 'true');
          img.width = 14;
          img.height = 14;
          img.className = 'xero-icon';
          img.style.width = '14px';
          img.style.height = '14px';
          img.style.objectFit = 'contain';
          navLink.appendChild(img);
        } else {
          navLink.appendChild(document.createTextNode('🧭'));
        }
        navLink.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        navLink.addEventListener('click', (ev) => ev.stopPropagation());
      }

      if (navLink) {
        labelPill.append(badge, navLink, shareBtn, xShareLink);
      } else {
        labelPill.append(badge, shareBtn, xShareLink);
      }
      wrap.appendChild(labelPill);
      wrap.style.display = 'none';
      pinLayer.appendChild(wrap);
      pinMap.set(pid, { el: wrap, parcel: p });
    }

    drawWireframes();

    return () => {
      for (const mk of ownedMarkersRef.current) mk.remove();
      ownedMarkersRef.current = [];
      for (const { el } of pinMap.values()) {
        el.remove();
      }
      pinMap.clear();
    };
  }, [parcels, sculptures, ownedParcelIds, drawWireframes]);

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
    tag.textContent = item.label || 'Found';
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

      // 1) Top Corner Balls -> scale width & depth (always checked ahead of floor handles)
      for (let i = 0; i < 4; i++) {
        const dTop = Math.hypot(px - geom.top[i].x, py - geom.top[i].y);
        if (dTop <= 12) {
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

      // 2) Pronounced Center Z-Axis Up/Down Elevator Handle (orb + vertical stem above topCenter)
      if (geom.topCenter?.visible) {
        const liftPt = { x: geom.topCenter.x, y: geom.topCenter.y - HEIGHT_HANDLE_LIFT_PX };
        const dOrb = Math.hypot(px - liftPt.x, py - liftPt.y);
        const stemSeg = distPointToSegment(px, py, geom.topCenter, liftPt);
        if (dOrb <= 20 || stemSeg.dist <= 11) {
          return {
            type: 'height',
            index: 0,
            draft: d,
            handleKey: 'height',
            cursor: 'ns-resize',
            hint: `Pull up / down to adjust height (${Math.round(d.heightMeters)}m)`
          };
        }
      }

      // 2b) Top Rim Bars -> pull up / down to raise or lower the cube's height (in 3D/Isometric views)
      for (let i = 0; i < 4; i++) {
        const next = (i + 1) % 4;
        const topMid = lerpPt(geom.top[i], geom.top[next], 0.5);
        const botMid = lerpPt(geom.bottom[i], geom.bottom[next], 0.5);
        const topBottomSep = Math.hypot(topMid.x - botMid.x, topMid.y - botMid.y);
        if (topBottomSep < 6) continue;
        const segTop = distPointToSegment(px, py, geom.top[i], geom.top[next]);
        if (segTop.dist <= 11 && segTop.t >= 0.14 && segTop.t <= 0.86) {
          return {
            type: 'height',
            index: i,
            draft: d,
            handleKey: `top-bar-${i}`,
            cursor: 'ns-resize',
            hint: `Pull top bar up / down to raise or lower height (${Math.round(d.heightMeters)}m)`
          };
        }
      }

      // 2c) Bottom Corner Balls -> scale width & depth (after top rim & elevator handle)
      for (let i = 0; i < 4; i++) {
        const dBot = Math.hypot(px - geom.bottom[i].x, py - geom.bottom[i].y);
        if (dBot <= 13) {
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

      // 3) Vertical Corner Bars -> hold & move to rotate the box
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

      // 4) Bottom Side Segment Bars -> stretch single footprint edge in/out
      for (let i = 0; i < 4; i++) {
        const next = (i + 1) % 4;
        const segBot = distPointToSegment(px, py, geom.bottom[i], geom.bottom[next]);
        if (segBot.dist <= 10 && segBot.t >= 0.14 && segBot.t <= 0.86) {
          return {
            type: 'edge',
            index: i,
            draft: d,
            handleKey: `edge-${i}`,
            cursor: i % 2 === 0 ? 'ns-resize' : 'ew-resize',
            hint: 'Drag bottom side bar to stretch edge'
          };
        }
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

  function querySculpture3DAtScreenPt(px, py) {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current || !map.getLayer('sculptures-3d-extrusion')) return null;
    try {
      const hits = map.queryRenderedFeatures([px, py], { layers: ['sculptures-3d-extrusion'] });
      const scId = hits?.[0]?.properties?.sculptureId;
      if (!scId) return null;
      return (sculpturesRef.current || []).find((s) => s.id === scId) || null;
    } catch {
      return null;
    }
  }

  function hitTestMintedParcelAtScreenPt(px, py) {
    const map = mapRef.current;
    if (!map) return null;
    let bestParcel = null;
    let bestScore = Infinity;

    for (const p of parcelsRef.current || []) {
      const vol =
        p?.volume ||
        (p?.bounds ? buildDefaultVolumeFromBounds(p.bounds, p.parcelId, p.geohash) : null);
      if (!vol) continue;
      const geom = computePrismScreenGeometry(map, maplibregl, vol);
      const res = hitTestMintedParcelPrism(px, py, geom, 10);
      if (res?.hit) {
        const score = (res.onBoundary ? 0 : 100) + res.centerDist;
        if (score < bestScore) {
          bestScore = score;
          bestParcel = p;
        }
      }
    }
    if (bestParcel) return bestParcel;

    // Fallback to MapLibre 2D/extruded parcel layers when zoomed far out
    if (styleReadyRef.current) {
      const queryLayers = ['parcels-fill', 'parcels-outline'].filter((lid) => {
        try {
          return Boolean(map.getLayer(lid));
        } catch {
          return false;
        }
      });
      if (queryLayers.length > 0) {
        try {
          const hits = map.queryRenderedFeatures([px, py], { layers: queryLayers });
          const pid = String(hits?.[0]?.properties?.parcelId || '').toUpperCase();
          if (pid) {
            return (
              (parcelsRef.current || []).find(
                (p) => String(p?.parcelId || '').toUpperCase() === pid
              ) || null
            );
          }
        } catch {
          // ignore query errors while style loads
        }
      }
    }
    return null;
  }

  function cancelPendingHoldDraw() {
    const h = holdDrawRef.current;
    if (!h) return;
    if (h.timerId) clearTimeout(h.timerId);
    if (h.rafId) cancelAnimationFrame(h.rafId);
    holdDrawRef.current = null;
    setHoldDrawActive(false);
  }

  function resolveOrbitPivotDraft() {
    const list = draftsRef.current || [];
    if (list.length === 0) return null;
    const selectedId = selectedDraftIdRef.current;
    return list.find((d) => d.id === selectedId) || list[0] || null;
  }

  function finishOrbitDrag(targetEl = null) {
    const orb = orbitDragRef.current;
    if (!orb) return;
    orbitDragRef.current = null;
    if (orb.active && targetEl && typeof targetEl.releasePointerCapture === 'function') {
      try {
        targetEl.releasePointerCapture(orb.pointerId);
      } catch {
        // ignore release errors
      }
    }
    const map = mapRef.current;
    if (map && orb.active) {
      const c = map.getCenter();
      onViewportChangeRef.current?.({
        lat: Number(c.lat.toFixed(6)),
        lng: Number(c.lng.toFixed(6)),
        zoom: Number(map.getZoom().toFixed(2)),
        bearing: normalizeRotationDeg(map.getBearing())
      });
    }
    setGizmoCursor('');
    setGizmoHint('');
    drawWireframes();
  }

  function handleOverlayPointerDown(e) {
    if (e.button !== 0 || !mapRef.current || !mapHostRef.current) return;
    if (e.target.closest('.map3d-ui-stop, .maplibregl-ctrl')) return;
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    if (
      activeEl &&
      typeof activeEl.blur === 'function' &&
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(String(activeEl.tagName || '').toUpperCase())
    ) {
      activeEl.blur();
    }

    const rect = mapHostRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // Priority 1: Grab any existing unminted land or its gizmo handles (prevents drawing duplicate boxes on top!)
    const hit = hitTestGizmoAtScreenPt(px, py);
    if (hit) {
      cancelPendingHoldDraw();
      pendingSculptureClickRef.current = null;
      pendingParcelClickRef.current = null;
      const ll = mapRef.current.unproject([px, py]);
      if (!ll) return;
      if (selectedDraftIdRef.current !== hit.draft.id) {
        onSelectDraftRef.current?.(hit.draft.id);
      }
      setHoveredDraftId(hit.draft.id);
      setActiveHandle(hit.handleKey);
      setIsGizmoDragging(true);
      setGizmoCursor(hit.type === 'vbar' ? 'grabbing' : hit.cursor);
      setGizmoHint(hit.hint);
      mapRef.current.dragPan.disable();

      const centerScreen = mapRef.current.project([hit.draft.centerLng, hit.draft.centerLat]);
      const startAngleRad = Math.atan2(py - centerScreen.y, px - centerScreen.x);
      const origHeightMeters = Number(hit.draft.heightMeters || LAND_VOLUME_LIMITS.defaultHeightMeters);
      const hitGeom = computePrismScreenGeometry(mapRef.current, maplibregl, hit.draft);
      let heightMetersPerPx = 0.35;
      if (hitGeom && origHeightMeters > 0) {
        const verticalScreenPx =
          hitGeom.bottom.reduce(
            (sum, pt, idx) =>
              sum + Math.hypot(pt.x - hitGeom.top[idx].x, pt.y - hitGeom.top[idx].y),
            0
          ) / 4;
        if (verticalScreenPx >= 6) {
          heightMetersPerPx = Math.max(0.08, Math.min(2.5, origHeightMeters / verticalScreenPx));
        }
      }

      gizmoDragRef.current = {
        ...hit,
        startPx: px,
        startPy: py,
        lastPy: py,
        startLat: ll.lat,
        startLng: ll.lng,
        origLat: hit.draft.centerLat,
        origLng: hit.draft.centerLng,
        origRotationDeg: normalizeRotationDeg(hit.draft.rotationDeg || 0),
        origHeightMeters,
        currentHeightMeters: origHeightMeters,
        heightMetersPerPx,
        centerScreenX: centerScreen.x,
        centerScreenY: centerScreen.y,
        startAngleRad,
        startDraft: { ...hit.draft }
      };
      onDraftGestureStartRef.current?.(hit.draft.id, hit.type);
      drawWireframes();
      return;
    }

    // Priority 2: Draw new land rectangle immediately when explicit Draw Land mode is active
    const ll = mapRef.current.unproject([px, py]);
    if (!ll) return;
    if (drawModeRef.current) {
      cancelPendingHoldDraw();
      pendingSculptureClickRef.current = null;
      pendingParcelClickRef.current = null;
      dragStartRef.current = { x: px, y: py, lng: ll.lng, lat: ll.lat, fromHold: false };
      dragPreviewRef.current = null;
      return;
    }

    // Priority 3: Check if user clicked a rendered 3D sculpture on the map
    const scHit = querySculpture3DAtScreenPt(px, py);
    if (scHit) {
      cancelPendingHoldDraw();
      pendingSculptureClickRef.current = { sculpture: scHit, x: px, y: py };
      pendingParcelClickRef.current = null;
      return;
    }

    // Check if user clicked a minted land's 3D boundary or interior (opens detailed view on clean click)
    const parcelHit = hitTestMintedParcelAtScreenPt(px, py);
    pendingParcelClickRef.current = parcelHit ? { parcel: parcelHit, x: px, y: py } : null;

    // Priority 3.5: When user has drawn a land, click-and-drag on canvas rotates & tilts map around that drawn land
    if (draftsRef.current.length > 0 && !drawModeRef.current && draftCanvasDragModeRef.current === 'orbit') {
      if (e.shiftKey) {
        // Shift+drag temporarily pans while staying in Orbit Land mode
        shiftPanActiveRef.current = true;
        mapRef.current.dragPan.enable();
        return;
      }
      const pivotDraft = resolveOrbitPivotDraft();
      if (
        pivotDraft &&
        Number.isFinite(Number(pivotDraft.centerLat)) &&
        Number.isFinite(Number(pivotDraft.centerLng))
      ) {
        cancelPendingHoldDraw();
        pendingSculptureClickRef.current = null;
        const c = mapRef.current.getCenter();
        orbitDragRef.current = {
          active: false,
          pointerId: e.pointerId,
          startPx: px,
          startPy: py,
          startBearing: mapRef.current.getBearing(),
          startPitch: mapRef.current.getPitch(),
          startCenterLng: Number(c.lng),
          startCenterLat: Number(c.lat),
          pivotLng: Number(pivotDraft.centerLng),
          pivotLat: Number(pivotDraft.centerLat),
          pivotName: pivotDraft.customName?.trim() || 'drawn land'
        };
        return;
      }
    }

    // Clicking a minted land boundary/prism should open its detailed view cleanly without triggering hold-to-draw
    if (parcelHit) {
      cancelPendingHoldDraw();
      pendingSculptureClickRef.current = null;
      return;
    }

    // Priority 4: Hold down in 1 spot on the map (~380ms without dragging) -> start drawing a 3D cube!
    cancelPendingHoldDraw();
    pendingSculptureClickRef.current = null;
    const holdState = {
      startPx: px,
      startPy: py,
      lat: ll.lat,
      lng: ll.lng,
      startedAt: performance.now(),
      activated: false,
      timerId: null,
      rafId: 0
    };
    const tickCharge = () => {
      if (holdDrawRef.current !== holdState || holdState.activated) return;
      drawWireframes();
      holdState.rafId = requestAnimationFrame(tickCharge);
    };
    holdState.rafId = requestAnimationFrame(tickCharge);
    holdState.timerId = setTimeout(() => {
      if (holdDrawRef.current !== holdState || holdState.activated) return;
      holdState.activated = true;
      cancelAnimationFrame(holdState.rafId);
      const map = mapRef.current;
      if (!map) return;
      map.dragPan.disable();
      const camBearing = normalizeRotationDeg(map.getBearing());
      dragStartRef.current = {
        x: holdState.startPx,
        y: holdState.startPy,
        lng: holdState.lng,
        lat: holdState.lat,
        fromHold: true
      };
      dragPreviewRef.current = {
        centerLat: Number(holdState.lat.toFixed(7)),
        centerLng: Number(holdState.lng.toFixed(7)),
        widthMeters: LAND_VOLUME_LIMITS.defaultWidthMeters,
        depthMeters: LAND_VOLUME_LIMITS.defaultDepthMeters,
        heightMeters: LAND_VOLUME_LIMITS.defaultHeightMeters,
        rotationDeg: camBearing,
        hitLimit: false
      };
      setHoldDrawActive(true);
      setGizmoCursor('crosshair');
      setGizmoHint('Drawing 3D cube — drag to size, release to place');
      drawWireframes();
    }, HOLD_TO_DRAW_MS);
    holdDrawRef.current = holdState;
  }

  function handleOverlayPointerMove(e) {
    if (!mapRef.current || !mapHostRef.current) return;
    if (
      !gizmoDragRef.current &&
      !orbitDragRef.current &&
      !dragStartRef.current &&
      !holdDrawRef.current &&
      e.target.closest('.map3d-ui-stop, .maplibregl-ctrl')
    ) {
      return;
    }

    const rect = mapHostRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // Active click-and-drag canvas orbit around the drawn land
    if (orbitDragRef.current) {
      if (e.buttons === 0) {
        finishOrbitDrag(e.currentTarget);
        return;
      }
      const orb = orbitDragRef.current;
      const dx = px - orb.startPx;
      const dy = py - orb.startPy;
      if (!orb.active && Math.hypot(dx, dy) < 4) return;
      if (!orb.active) {
        orb.active = true;
        pendingParcelClickRef.current = null;
        userAdjustedRef.current = true;
        try {
          e.currentTarget.setPointerCapture?.(orb.pointerId);
        } catch {
          // ignore synthetic pointer capture errors
        }
        setGizmoCursor('grabbing');
      }
      const deltaBearing = dx * 0.45;
      const nextBearing = orb.startBearing + deltaBearing;
      const nextPitch = Math.max(0, Math.min(65, orb.startPitch - dy * 0.25));
      const cosLat = Math.max(0.1, Math.cos((orb.pivotLat * Math.PI) / 180));
      const dx0 = (orb.startCenterLng - orb.pivotLng) * cosLat;
      const dy0 = orb.startCenterLat - orb.pivotLat;
      const theta = -(deltaBearing * Math.PI) / 180;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const dx1 = dx0 * cosT - dy0 * sinT;
      const dy1 = dx0 * sinT + dy0 * cosT;
      const nextCenterLng = orb.pivotLng + dx1 / cosLat;
      const nextCenterLat = orb.pivotLat + dy1;

      mapRef.current.jumpTo({
        center: [nextCenterLng, nextCenterLat],
        bearing: nextBearing,
        pitch: nextPitch
      });
      setBearingDeg(Math.round(nextBearing * 10) / 10);
      setPitchDeg(Math.round(nextPitch * 10) / 10);
      setGizmoHint(
        `🔄 Orbiting around ${orb.pivotName} · ${Math.round(normalizeRotationDeg(nextBearing))}° · Tilt ${Math.round(nextPitch)}°`
      );
      drawWireframes();
      return;
    }

    // Cancel pending 3D sculpture or minted land click if pointer dragged away
    if (pendingSculptureClickRef.current) {
      if (
        Math.hypot(
          px - pendingSculptureClickRef.current.x,
          py - pendingSculptureClickRef.current.y
        ) >= 6
      ) {
        pendingSculptureClickRef.current = null;
      }
    }
    if (pendingParcelClickRef.current) {
      if (
        Math.hypot(
          px - pendingParcelClickRef.current.x,
          py - pendingParcelClickRef.current.y
        ) >= 7
      ) {
        pendingParcelClickRef.current = null;
      }
    }

    // Cancel unactivated hold-to-draw if user starts dragging/panning map normally
    if (holdDrawRef.current && !holdDrawRef.current.activated) {
      if (
        Math.hypot(px - holdDrawRef.current.startPx, py - holdDrawRef.current.startPy) >= 6
      ) {
        cancelPendingHoldDraw();
        drawWireframes();
      } else {
        return;
      }
    }

    // Active gizmo handle manipulation
    if (gizmoDragRef.current) {
      const g = gizmoDragRef.current;

      if (g.type === 'vbar') {
        const curAngle = Math.atan2(py - g.centerScreenY, px - g.centerScreenX);
        const deltaDeg = ((curAngle - g.startAngleRad) * 180) / Math.PI;
        const nextRot = Math.round(normalizeRotationDeg(g.origRotationDeg + deltaDeg));
        onUpdateDraftRef.current?.(g.draft.id, { rotationDeg: nextRot });
        setGizmoHint(`Rotating ${nextRot}°`);
        drawWireframes();
        return;
      }
      if (g.type === 'height') {
        const maxHInfo = computeMaxHeightForFootprint({
          widthMeters: g.startDraft.widthMeters,
          depthMeters: g.startDraft.depthMeters,
          limits: LAND_VOLUME_LIMITS
        });
        const stepPy = (g.lastPy ?? g.startPy) - py;
        g.lastPy = py;
        const curMap = mapRef.current;
        let liveMPerPx = g.heightMetersPerPx || 0.35;
        if (curMap) {
          const probeCur = { ...g.startDraft, heightMeters: g.currentHeightMeters };
          const liveGeom = computePrismScreenGeometry(curMap, maplibregl, probeCur);
          if (liveGeom && g.currentHeightMeters > 0) {
            const vPx =
              liveGeom.bottom.reduce(
                (sum, pt, idx) =>
                  sum + Math.hypot(pt.x - liveGeom.top[idx].x, pt.y - liveGeom.top[idx].y),
                0
              ) / 4;
            if (vPx >= 6) {
              liveMPerPx = Math.max(0.08, Math.min(4.5, g.currentHeightMeters / vPx));
            }
          } else {
            const z = Number(curMap.getZoom?.() || 17);
            const pRad = (Math.max(12, Number(curMap.getPitch?.() || 52)) * Math.PI) / 180;
            const cosLat = Math.max(
              0.1,
              Math.cos((Number(g.startDraft.centerLat || 0) * Math.PI) / 180)
            );
            const mPerPxGround = (40075016.686 * cosLat) / (512 * Math.pow(2, z));
            liveMPerPx = Math.max(
              0.08,
              Math.min(4.5, mPerPxGround / Math.max(0.2, Math.sin(pRad)))
            );
          }
        }
        const nextHeight = Number(
          Math.max(
            LAND_VOLUME_LIMITS.minHeightMeters,
            Math.min(maxHInfo.heightMeters, (g.currentHeightMeters ?? g.origHeightMeters) + stepPy * liveMPerPx)
          ).toFixed(1)
        );
        g.currentHeightMeters = nextHeight;
        const nextZScale = Number((nextHeight / LAND_VOLUME_LIMITS.defaultHeightMeters).toFixed(3));
        onUpdateDraftRef.current?.(g.draft.id, { heightMeters: nextHeight, zScale: nextZScale });
        setGizmoHint(`Z Height: ${nextHeight}m (max ${Math.round(maxHInfo.heightMeters)}m)`);

        // Smoothly zoom out as the user drags the top rectangle upward so the roof & ↕ handle stay in view
        if (stepPy > 0 && curMap) {
          const hostCanvas = curMap.getCanvas?.();
          const vw = hostCanvas?.clientWidth || mapHostRef.current?.clientWidth || 0;
          const vh = hostCanvas?.clientHeight || mapHostRef.current?.clientHeight || 0;
          if (vw > 0 && vh > 0) {
            const probeNext = { ...g.startDraft, heightMeters: nextHeight };
            const nextGeom = computePrismScreenGeometry(curMap, maplibregl, probeNext);
            const topMinY = nextGeom
              ? Math.min(
                  ...nextGeom.top.map((p) => p.y),
                  nextGeom.topCenter.y - HEIGHT_HANDLE_LIFT_PX
                )
              : -999;
            if (topMinY < 82) {
              const fit = computeDraft3DAutoFit(probeNext, {
                viewportWidth: vw,
                viewportHeight: vh,
                pitchDeg: curMap.getPitch(),
                bearingDeg: curMap.getBearing()
              });
              if (fit) {
                const curZoom = curMap.getZoom();
                const targetZoom = Math.min(curZoom, fit.zoom);
                if (targetZoom < curZoom - 0.01 || !nextGeom) {
                  const blendZoom = !nextGeom
                    ? targetZoom
                    : Math.max(targetZoom, curZoom - Math.max(0.14, (curZoom - targetZoom) * 0.45));
                  userAdjustedRef.current = true;
                  appliedDraftPaddingRef.current = true;
                  curMap.jumpTo({
                    center: curMap.getCenter(),
                    zoom: blendZoom,
                    bearing: curMap.getBearing(),
                    pitch: curMap.getPitch(),
                    padding: fit.padding
                  });
                }
              }
            }
          }
        }
        drawWireframes();
        return;
      }

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
      }
      drawWireframes();
      return;
    }

    // Active drag-to-draw new land cube (either from toolbar Draw Mode OR hold-to-draw!)
    if ((drawModeRef.current || dragStartRef.current?.fromHold) && dragStartRef.current) {
      const dx = px - dragStartRef.current.x;
      const dy = py - dragStartRef.current.y;
      if (Math.hypot(dx, dy) < 6) {
        if (!dragStartRef.current.fromHold) {
          dragPreviewRef.current = null;
        }
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
      } else {
        if (hoverDrawPreviewRef.current) {
          hoverDrawPreviewRef.current = null;
          drawWireframes();
        }
        const hoveredSc = querySculpture3DAtScreenPt(px, py);
        if (hoveredSc) {
          setGizmoCursor('pointer');
          setGizmoHint(`🧊 ${hoveredSc.title} · Click for 3D & metadata`);
        } else {
          const hoveredParcel = hitTestMintedParcelAtScreenPt(px, py);
          if (hoveredParcel) {
            const pName = resolveLandDisplayName(hoveredParcel, { defaultName: 'Virtual Land' });
            setGizmoCursor('pointer');
            setGizmoHint(`🗺️ ${pName} · Click for detailed view`);
          } else if (
            draftsRef.current.length > 0 &&
            draftCanvasDragModeRef.current === 'orbit'
          ) {
            if (gizmoCursor !== 'grab') setGizmoCursor('grab');
            if (gizmoHint && !gizmoHint.startsWith('🔄')) setGizmoHint('');
          } else if (gizmoCursor === 'pointer' || gizmoCursor === 'grab') {
            setGizmoCursor('');
            setGizmoHint('');
          }
        }
      }
    }
  }

  function handleOverlayPointerUp(e) {
    if (shiftPanActiveRef.current) {
      shiftPanActiveRef.current = false;
      if (
        mapRef.current &&
        (drawModeRef.current ||
          (draftsRef.current.length > 0 && draftCanvasDragModeRef.current === 'orbit'))
      ) {
        mapRef.current.dragPan.disable();
      }
      return;
    }

    if (orbitDragRef.current) {
      const wasActiveOrbit = Boolean(orbitDragRef.current.active);
      finishOrbitDrag(e.currentTarget);
      if (!wasActiveOrbit && pendingParcelClickRef.current) {
        const targetParcel = pendingParcelClickRef.current.parcel;
        pendingParcelClickRef.current = null;
        if (targetParcel) {
          onSelectParcelRef.current?.(targetParcel);
        }
      } else {
        pendingParcelClickRef.current = null;
      }
      return;
    }

    if (gizmoDragRef.current) {
      const finishedDraftId = gizmoDragRef.current.draft?.id || '';
      gizmoDragRef.current = null;
      setIsGizmoDragging(false);
      onDraftGestureEndRef.current?.();
      const finishedDraft = (draftsRef.current || []).find((d) => d.id === finishedDraftId);
      if (finishedDraft) {
        lastDraftAutoFitRef.current = {
          id: finishedDraft.id,
          width: Number(finishedDraft.widthMeters || 0),
          depth: Number(finishedDraft.depthMeters || 0),
          height: Number(finishedDraft.heightMeters || 0),
          baseAlt: Number(finishedDraft.baseAltitudeM || 0)
        };
      }
      if (
        mapRef.current &&
        !drawModeRef.current &&
        !(draftsRef.current.length > 0 && draftCanvasDragModeRef.current === 'orbit')
      ) {
        mapRef.current.dragPan.enable();
      }
      setGizmoCursor('');
      setGizmoHint('');
      drawWireframes();
      return;
    }

    // Complete direct click on a 3D sculpture mesh -> open full metadata modal
    if (pendingSculptureClickRef.current) {
      const targetSc = pendingSculptureClickRef.current.sculpture;
      pendingSculptureClickRef.current = null;
      pendingParcelClickRef.current = null;
      if (targetSc) {
        onSelectSculptureRef.current?.(targetSc);
      }
      return;
    }

    // Complete direct click on a minted land's 3D boundary or prism -> always open its detailed view
    if (pendingParcelClickRef.current) {
      const targetParcel = pendingParcelClickRef.current.parcel;
      pendingParcelClickRef.current = null;
      cancelPendingHoldDraw();
      if (targetParcel) {
        onSelectParcelRef.current?.(targetParcel);
      }
      return;
    }

    const wasHoldActivated = Boolean(holdDrawRef.current?.activated);
    cancelPendingHoldDraw();

    if (
      (!drawModeRef.current && !wasHoldActivated && !dragStartRef.current?.fromHold) ||
      !dragStartRef.current ||
      !mapRef.current ||
      !mapHostRef.current
    ) {
      drawWireframes();
      return;
    }

    const start = dragStartRef.current;
    dragStartRef.current = null;
    dragPreviewRef.current = null;
    if (start.fromHold && !drawModeRef.current) {
      mapRef.current.dragPan.enable();
    }
    setGizmoCursor('');
    setGizmoHint('');

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

  function handleFitActiveDraft() {
    const map = mapRef.current;
    const activeDraft =
      (draftsRef.current || []).find((d) => d.id === selectedDraftIdRef.current) ||
      (draftsRef.current || [])[0] ||
      null;
    if (!map || !activeDraft) return;
    const hostCanvas = map.getCanvas?.();
    const vw = hostCanvas?.clientWidth || mapHostRef.current?.clientWidth || 840;
    const vh = hostCanvas?.clientHeight || mapHostRef.current?.clientHeight || 540;
    const fit = computeDraft3DAutoFit(activeDraft, {
      viewportWidth: vw,
      viewportHeight: vh,
      pitchDeg: map.getPitch(),
      bearingDeg: map.getBearing()
    });
    if (!fit) return;
    userAdjustedRef.current = true;
    appliedDraftPaddingRef.current = true;
    map.easeTo({
      center: fit.center,
      zoom: fit.zoom,
      padding: fit.padding,
      duration: 460,
      essential: true
    });
  }

  function handleFitClosestLands() {
    const map = mapRef.current;
    if (!map) return;
    const closestFit = computeClosestLandsPerimeterFit({
      parcels,
      sculptures,
      location: userLocation
    });
    if (!closestFit.boundsLngLat) return;
    userAdjustedRef.current = false;
    map.fitBounds(closestFit.boundsLngLat, {
      padding: { left: 18, right: 18, top: 68, bottom: 48 },
      maxZoom: 19.2,
      duration: 500,
      bearing: map.getBearing(),
      pitch: map.getPitch()
    });
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
      data-show-buildings={showBuildings ? 'on' : 'off'}
      data-show-terrain={showTerrain ? 'on' : 'off'}
      data-pitch={Math.round(pitchDeg)}
      data-bearing={Math.round(bearingDeg)}
      data-draw-mode={drawMode ? 'on' : 'off'}
      data-canvas-drag={drawMode ? 'draw' : draftParcels.length > 0 ? draftCanvasDragMode : 'pan'}
      data-hold-draw={holdDrawActive ? 'active' : 'idle'}
      data-draft-count={draftParcels.length}
      data-owned-count={parcels.length}
      data-rendered-3d-sculptures={rendered3dSculptureCount}
      data-three-3d-models={loadedThree3dCount}
      data-selected-draft-id={selectedDraftId || ''}
      data-selected-parcel-id={selectedParcelId || ''}
      data-focus-parcel-id={focusTarget?.parcelId || ''}
      data-focus-lat={Number.isFinite(Number(focusTarget?.lat)) ? String(focusTarget.lat) : ''}
      data-focus-lng={Number.isFinite(Number(focusTarget?.lng)) ? String(focusTarget.lng) : ''}
      data-focus-zoom={Number.isFinite(Number(focusTarget?.zoom)) ? String(focusTarget.zoom) : ''}
      data-map-zoom={liveCamera.zoom !== null ? String(liveCamera.zoom) : ''}
      data-map-center={
        liveCamera.lat !== null && liveCamera.lng !== null
          ? `${liveCamera.lat},${liveCamera.lng}`
          : ''
      }
      data-hovered-draft-id={hoveredDraftId || ''}
      data-active-handle={activeHandle || ''}
      style={{ display: 'flex', flexDirection: 'column', gap: 0, height: '100%', flex: 1, minHeight: 0 }}
    >
      {/* Main 3D WebGL Map + Synchronized Wireframe & Gizmo Overlay */}
      <div
        className={`map-container ${drawMode && !hoveredDraftId ? 'is-draw-mode' : ''} ${isGizmoDragging || drawMode ? 'is-draft-interacting' : ''}`}
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
        <div ref={floatingPinsLayerRef} className="map3d-floating-pins-layer" />
        <div ref={floatingArtworkLayerRef} className="map3d-floating-artwork-layer" />
        <NeighborEdgeArrowsOverlay
          arrows={edgeTags}
          viewportWidth={edgeStageDims.width}
          viewportHeight={edgeStageDims.height}
          className="is-map3d-layer"
          onSelectParcel={(parcel) => {
            if (onNavigateParcelRef.current) onNavigateParcelRef.current(parcel);
            else onSelectParcelRef.current?.(parcel);
          }}
          onSelectSculpture={(sc) => {
            if (onNavigateSculptureRef.current) onNavigateSculptureRef.current(sc);
            else onSelectSculptureRef.current?.(sc);
          }}
        />

        {/* Compact Floating Search & Map Controls Directly On Map */}
        <div className="map3d-top-overlay map3d-ui-stop">
          <div ref={searchBoxRef} className="map3d-search-box">
            <form className="map3d-search-form" onSubmit={handleSearchSubmit}>
              <input
                type="text"
                className="input map3d-search-input"
                placeholder="Search intersections, businesses, or land names…"
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
                style={{ padding: '4px 9px', fontSize: 11.5 }}
                disabled={searchBusy}
              >
                {searchBusy ? '…' : 'Find'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                data-testid="map3d-theme-toggle-btn"
                style={{ padding: '4px 7px', fontSize: 11.5, flexShrink: 0 }}
                title={isDarkMap ? 'Dark Map (click for Light)' : 'Light Map (click for Dark)'}
                aria-label={isDarkMap ? 'Switch map to Light Mode' : 'Switch map to Dark Mode'}
                onClick={toggleMapTheme}
              >
                <XeroIcon emoji={isDarkMap ? '🌙' : '☀️'} size={13} />
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
                        {item.subtitle}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div
            className="map3d-floating-toolbar"
            data-testid="map3d-overlay-toolbar"
            role="toolbar"
            aria-label="Map controls"
          >
            <button
              type="button"
              className={`btn ${viewMode === '2d' ? 'btn-primary' : ''}`}
              onClick={() => onViewModeChange?.('2d')}
            >
              2D
            </button>
            <button
              type="button"
              className={`btn ${viewMode !== '2d' ? 'btn-primary' : ''}`}
              onClick={() => onViewModeChange?.('3d')}
            >
              3D
            </button>
            {draftParcels.length > 0 && (
              <button
                type="button"
                className="btn btn-primary"
                data-testid="map3d-fit-draft-btn"
                onClick={handleFitActiveDraft}
                title="Zoom out to frame the entire drafted land boundary including its top rectangle"
              >
                📐 Fit Draft
              </button>
            )}
            {parcels.length > 0 && (
              <button
                type="button"
                className="btn"
                onClick={handleFitClosestLands}
                title="Zoom in full-width on the perimeter of the closest lands"
              >
                <XeroIcon emoji="🗺️" size={12} /> Fit Lands
              </button>
            )}
            {userLocation && (
              <button
                type="button"
                className="btn"
                onClick={handleCenterOnUser}
              >
                <XeroIcon emoji="🎯" size={12} /> Me
              </button>
            )}
            <InfoTip title="3D Map & Land Handles" mode="popover">
              <strong>Hold down</strong> in one spot on the map (or open <strong>Mint Land</strong>)
              and drag to draw a 3D cube. Once drawn, <strong>click &amp; drag anywhere around the land</strong>{' '}
              to rotate &amp; tilt the 3D map around it (hold <strong>Shift+drag</strong> to pan). Drag{' '}
              <strong>corner balls</strong> to scale, <strong>side bars</strong> to stretch an edge,{' '}
              <strong>vertical gold bars</strong> to rotate, the <strong>center ↕ orb</strong> to pull
              height up/down, or click any <strong>3D sculpture</strong> to view all metadata.
            </InfoTip>
          </div>
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
