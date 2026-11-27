import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import xeroemoji from 'xeroemoji';
import {
  buildParcelShareUrl,
  resolveLandDisplayName
} from '../../../shared/landVolume.mjs';
import { copyToClipboard } from '../utils/clipboard.js';
import {
  registerDesktopZoomableMap,
  zoomLeafletByDelta
} from '../utils/desktopMapPinchZoom.js';
import { notifySettingsSaved } from '../utils/toastNotice.js';
import { buildDefaultHudReservedRects } from '../utils/canvasLabelLayout.js';
import { getSculptureChainLinks } from '../utils/chainLinks.js';
import {
  computeClosestLandsPerimeterFit,
  extractParcelPerimeterPoints,
  formatSimpleLandLabel
} from '../utils/landMapHelpers.js';
import { resolveParcelVolume } from '../utils/landPreviewHelpers.js';
import {
  buildNeighborArrowsSignature,
  computeNeighborEdgeArrows
} from '../utils/neighborEdgeArrows.js';
import { useMeasurementUnits } from '../utils/measurementUnits.js';
import { getLeafletTileConfig, useMapTheme } from '../utils/mapTheme.js';
import NeighborEdgeArrowsOverlay from './NeighborEdgeArrowsOverlay.jsx';
import XeroIcon from './XeroIcon.jsx';

function escapeHtml(raw) {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default function MapView({
  sculptures = [],
  parcels = [],
  userLocation = null,
  focusArea = false,
  areaRadiusMeters = 5000,
  compact = false,
  selectedSculptureId = '',
  selectedParcelId = '',
  focusParcelTick = 0,
  initialView = null,
  onViewportChange = null,
  config = null,
  onSelectSculpture,
  onSelectParcel = null,
  onToggle3D = null,
  isFullExpanded = false,
  onToggleFullMap = null
}) {
  const stageRef = useRef(null);
  const mapHostRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const initialViewRef = useRef(initialView);
  const initialUserLocationRef = useRef(userLocation);
  const onViewportChangeRef = useRef(onViewportChange);
  const onSelectParcelRef = useRef(onSelectParcel);
  const isFullExpandedRef = useRef(Boolean(isFullExpanded));
  const lastHandledFocusTickRef = useRef(focusParcelTick);
  const userAdjustedViewRef = useRef(
    Boolean(
      isFullExpanded ||
        (initialView &&
          Number.isFinite(Number(initialView.lat)) &&
          Number.isFinite(Number(initialView.lng)) &&
          Number.isFinite(Number(initialView.zoom)))
    )
  );
  const suppressViewSaveRef = useRef(false);
  const lastAutoBoundsRef = useRef(null);
  const lastFilterSignatureRef = useRef('');
  const [neighborArrows, setNeighborArrows] = useState([]);
  const neighborArrowsSigRef = useRef('');
  const focusedArrowsContextRef = useRef({ focusedEntry: null, otherEntries: [] });
  const { unitSystem } = useMeasurementUnits(userLocation);
  const unitSystemRef = useRef(unitSystem);
  const tileLayerRef = useRef(null);
  const { mapTheme, isDarkMap, toggleMapTheme } = useMapTheme();
  const mapThemeRef = useRef(mapTheme);
  useEffect(() => {
    unitSystemRef.current = unitSystem;
  }, [unitSystem]);
  useEffect(() => {
    mapThemeRef.current = mapTheme;
    const map = mapRef.current;
    if (!map) return;
    const hostEl = mapHostRef.current;
    if (hostEl) {
      hostEl.classList.toggle('is-map-light', mapTheme === 'light');
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
  }, [mapTheme]);

  const recomputeFocusedNeighborArrows = useCallback(() => {
    const map = mapRef.current;
    const host = mapHostRef.current;
    const { focusedEntry, otherEntries } = focusedArrowsContextRef.current;
    if (!focusedEntry || !otherEntries || otherEntries.length === 0 || !host) {
      if (neighborArrowsSigRef.current !== '') {
        neighborArrowsSigRef.current = '';
        setNeighborArrows([]);
      }
      return;
    }
    const vw = host.clientWidth || 360;
    const vh = host.clientHeight || 220;
    const reservedRects = buildDefaultHudReservedRects({ stageWidth: vw, stageHeight: vh });
    const nextArrows = computeNeighborEdgeArrows({
      focusedEntry,
      otherEntries,
      projectLngLat:
        map && typeof map.latLngToContainerPoint === 'function'
          ? (lng, lat) => {
              const pt = map.latLngToContainerPoint([lat, lng]);
              return { x: pt.x, y: pt.y };
            }
          : null,
      viewportWidth: vw,
      viewportHeight: vh,
      bearingDeg: 0,
      reservedRects,
      unitSystem: unitSystemRef.current
    });
    const nextSig = buildNeighborArrowsSignature(nextArrows);
    if (nextSig !== neighborArrowsSigRef.current) {
      neighborArrowsSigRef.current = nextSig;
      setNeighborArrows(nextArrows);
    }
  }, []);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  useEffect(() => {
    onSelectParcelRef.current = onSelectParcel;
  }, [onSelectParcel]);

  useEffect(() => {
    if (!mapHostRef.current || mapRef.current) return;

    const saved = initialViewRef.current;
    const initLoc = initialUserLocationRef.current;
    const hasSaved =
      saved &&
      Number.isFinite(Number(saved.lat)) &&
      Number.isFinite(Number(saved.lng)) &&
      Number.isFinite(Number(saved.zoom));

    const initialCenter = hasSaved
      ? [Number(saved.lat), Number(saved.lng)]
      : initLoc && Number.isFinite(initLoc.lat) && Number.isFinite(initLoc.lng)
      ? [initLoc.lat, initLoc.lng]
      : [37.7749, -122.4194];
    const initialZoom = hasSaved ? Number(saved.zoom) : initLoc ? 14 : 3;

    const map = L.map(mapHostRef.current, {
      center: initialCenter,
      zoom: initialZoom,
      maxZoom: 21.5,
      zoomControl: true,
      zoomSnap: 0.25,
      zoomDelta: 0.5
    });

    const tileCfg = getLeafletTileConfig(mapThemeRef.current);
    tileLayerRef.current = L.tileLayer(tileCfg.url, tileCfg.options).addTo(map);

    const markUserAdjusted = () => {
      if (!suppressViewSaveRef.current) {
        userAdjustedViewRef.current = true;
      }
    };

    const emitViewport = () => {
      if (suppressViewSaveRef.current) return;
      const c = map.getCenter();
      onViewportChangeRef.current?.({
        lat: Number(c.lat.toFixed(6)),
        lng: Number(c.lng.toFixed(6)),
        zoom: map.getZoom()
      });
    };

    map.on('dragstart', markUserAdjusted);
    map.on('zoomstart', markUserAdjusted);
    map.on('moveend', emitViewport);

    const layer = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerRef.current = layer;
    const unregisterPinchZoom = registerDesktopZoomableMap({
      id: 'map-view-2d',
      getContainer: () => stageRef.current || mapHostRef.current,
      getNativeTarget: () => mapHostRef.current,
      zoomByDelta: (delta, cx, cy) =>
        zoomLeafletByDelta(map, delta, cx, cy, () => {
          markUserAdjusted();
        })
    });

    const refitAutoBounds = () => {
      if (userAdjustedViewRef.current || isFullExpandedRef.current || !lastAutoBoundsRef.current) return;
      suppressViewSaveRef.current = true;
      try {
        map.stop();
        map.fitBounds(lastAutoBoundsRef.current, {
          paddingTopLeft: [14, 42],
          paddingBottomRight: [14, 28],
          maxZoom: 21,
          animate: false
        });
      } finally {
        setTimeout(() => {
          suppressViewSaveRef.current = false;
        }, 60);
      }
    };

    const resizeTimer = setTimeout(() => {
      map.invalidateSize({ animate: false, pan: false });
      refitAutoBounds();
    }, 90);

    let observer = null;
    if (typeof ResizeObserver === 'function' && mapHostRef.current) {
      observer = new ResizeObserver(() => {
        map.invalidateSize({ animate: false, pan: false });
        refitAutoBounds();
      });
      observer.observe(mapHostRef.current);
    }

    return () => {
      clearTimeout(resizeTimer);
      observer?.disconnect();
      unregisterPinchZoom();
      map.off('dragstart', markUserAdjusted);
      map.off('zoomstart', markUserAdjusted);
      map.off('moveend', emitViewport);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;

    layer.clearLayers();
    map.invalidateSize({ animate: false, pan: false });

    const hasUser =
      userLocation &&
      Number.isFinite(Number(userLocation.lat)) &&
      Number.isFinite(Number(userLocation.lng));

    if (hasUser) {
      const uLat = Number(userLocation.lat);
      const uLng = Number(userLocation.lng);
      if (focusArea && areaRadiusMeters > 0) {
        L.circle([uLat, uLng], {
          radius: areaRadiusMeters,
          color: '#00f5d4',
          weight: 1,
          dashArray: '4 6',
          fillColor: '#00f5d4',
          fillOpacity: 0.05
        }).addTo(layer);
      }
      L.circleMarker([uLat, uLng], {
        radius: 7,
        color: '#ffffff',
        weight: 2,
        fillColor: '#00f5d4',
        fillOpacity: 1
      })
        .bindTooltip('You are here')
        .addTo(layer);
    }

    const parcelMap = new Map();
    for (const p of parcels) {
      if (p?.parcelId && (p?.bounds || p?.volume?.corners?.length >= 4)) {
        parcelMap.set(p.parcelId, p);
      }
    }
    for (const sc of sculptures) {
      if (sc?.parcelId && sc?.parcelBounds && !parcelMap.has(sc.parcelId)) {
        parcelMap.set(sc.parcelId, {
          parcelId: sc.parcelId,
          bounds: sc.parcelBounds,
          sculptureCount: 1
        });
      }
    }

    const effectiveSelectedParcelId =
      selectedParcelId ||
      sculptures.find((s) => s.id === selectedSculptureId)?.parcelId ||
      '';

    const parcelList = Array.from(parcelMap.values());
    const closestFit = computeClosestLandsPerimeterFit({
      parcels: parcelList,
      sculptures,
      location: hasUser ? userLocation : null
    });
    const filterSig = `${focusArea ? '1' : '0'}:${parcelList.map((p) => p.parcelId).join(',')}`;
    if (
      !isFullExpandedRef.current &&
      lastFilterSignatureRef.current &&
      lastFilterSignatureRef.current !== filterSig
    ) {
      userAdjustedViewRef.current = false;
    }
    lastFilterSignatureRef.current = filterSig;

    const isFocusedSingleLand = Boolean(
      compact && !isFullExpanded && selectedParcelId && parcelMap.has(selectedParcelId)
    );

    // When focused on a specific land in compact 2D view, hide other lands' polygons/lines
    // and show clickable directional edge-arrow labels pointing to selectable neighboring lands.
    if (isFocusedSingleLand) {
      const focusedParcel = parcelMap.get(selectedParcelId);
      const focusedVol = resolveParcelVolume(focusedParcel);
      const otherEntries = parcelList
        .filter((p) => p.parcelId !== selectedParcelId)
        .map((p) => ({ parcel: p, volume: resolveParcelVolume(p) }))
        .filter((e) => e.volume);
      focusedArrowsContextRef.current = focusedVol
        ? { focusedEntry: { parcel: focusedParcel, volume: focusedVol }, otherEntries }
        : { focusedEntry: null, otherEntries: [] };
    } else {
      focusedArrowsContextRef.current = { focusedEntry: null, otherEntries: [] };
    }

    const renderedParcels = isFocusedSingleLand
      ? parcelList.filter((p) => p.parcelId === selectedParcelId)
      : parcelList;

    for (let idx = 0; idx < renderedParcels.length; idx++) {
      const p = renderedParcels[idx];
      const parcelSculptures = sculptures.filter((s) => s.parcelId === p.parcelId);
      const isSelectedParcel =
        Boolean(effectiveSelectedParcelId) && p.parcelId === effectiveSelectedParcelId;
      const isDormant = p.stewardStatus === 'dormant';
      const isFrozen = Boolean(p.frozen || p.settings?.frozen);
      const hasQuests = Number(p.openQuestCount || 0) > 0;
      const strokeColor = isSelectedParcel
        ? '#ff0099'
        : isFrozen
        ? '#7dd3fc'
        : isDormant
        ? '#ff4da6'
        : hasQuests
        ? '#c026d3'
        : '#ff1f8f';

      const styleOpts = {
        color: strokeColor,
        weight: isSelectedParcel ? 3 : isDormant ? 2.5 : 2,
        dashArray: isDormant ? '6 4' : undefined,
        fillColor: strokeColor,
        fillOpacity: isSelectedParcel ? 0.34 : isDormant ? 0.26 : 0.22
      };

      const corners = Array.isArray(p?.volume?.corners) ? p.volume.corners : [];
      const shape =
        corners.length >= 4
          ? L.polygon(
              corners.slice(0, 4).map(([lng, lat]) => [Number(lat), Number(lng)]),
              styleOpts
            )
          : p?.bounds?.sw && p?.bounds?.ne
          ? L.rectangle([p.bounds.sw, p.bounds.ne], styleOpts)
          : null;

      if (!shape) continue;

      const pLat = Number(p?.volume?.centerLat ?? p?.centerLat ?? p?.bounds?.center?.[0]);
      const pLng = Number(p?.volume?.centerLng ?? p?.centerLng ?? p?.bounds?.center?.[1]);

      const questTag = isDormant
        ? ' · 🔥 Needs First Spark (2x XP)'
        : hasQuests
        ? ` · 🎨 ${p.openQuestCount} Quest(s)`
        : '';
      const stewardTag = p.stewardType === 'agent' ? ' · 🤖 AI Steward' : '';
      const landTitle = resolveLandDisplayName(p, { defaultName: 'Virtual Land' });
      const scCount = parcelSculptures.length || p.sculptureCount || 0;
      shape.bindTooltip(
        `${landTitle} (${scCount} sculpture${scCount === 1 ? '' : 's'}${questTag}${stewardTag})`
      );
      const handleParcelClick = () => {
        if (onSelectParcelRef.current) {
          onSelectParcelRef.current(p);
        } else if (parcelSculptures.length > 0 && onSelectSculpture) {
          onSelectSculpture(parcelSculptures[0]);
        }
      };
      shape.on('click', handleParcelClick);
      shape.addTo(layer);

      // Permanent simple label directly on each land parcel (with quick inline Copy Link button)
      if (Number.isFinite(pLat) && Number.isFinite(pLng)) {
        const simpleLabel = formatSimpleLandLabel(p, idx);
        const isEmptyLand = scCount === 0;
        const stateCls = isSelectedParcel
          ? 'is-selected'
          : isFrozen
          ? 'is-frozen'
          : isDormant
          ? 'is-dormant'
          : '';
        const copyIconUrl = xeroemoji.get('📋')?.svgUrl || '';
        const copyIconHtml = copyIconUrl
          ? `<img src="${copyIconUrl}" width="15" height="15" class="xero-icon" alt="" aria-hidden="true" style="width:15px;height:15px;object-fit:contain;" />`
          : '📋';
        const idleCopyHtml = `${copyIconHtml}${isEmptyLand ? ' Copy' : ''}`;
        const labelIcon = L.divIcon({
          className: 'map-land-simple-label-marker',
          html: `<span class="map-land-simple-label ${stateCls} ${
            isEmptyLand ? 'is-empty-land' : ''
          }" data-testid="map-land-label" data-parcel-id="${escapeHtml(
            p.parcelId
          )}"><span class="map-land-simple-label-text">${escapeHtml(
            simpleLabel
          )}</span><button type="button" class="map-land-label-copy-btn" data-testid="map-land-copy-btn" data-parcel-id="${escapeHtml(
            p.parcelId
          )}" aria-label="Copy share link for ${escapeHtml(
            landTitle
          )}" title="Copy share link">${idleCopyHtml}</button></span>`,
          iconSize: null
        });
        const labelMarker = L.marker([pLat, pLng], {
          icon: labelIcon,
          zIndexOffset: isSelectedParcel ? 500 : 200
        });
        labelMarker.on('click', async (ev) => {
          const copyBtn = ev?.originalEvent?.target?.closest?.('.map-land-label-copy-btn');
          if (copyBtn) {
            ev.originalEvent?.stopPropagation?.();
            const shareUrl = buildParcelShareUrl({
              origin: typeof window !== 'undefined' ? window.location.origin : 'https://spray.land',
              pathname: typeof window !== 'undefined' ? window.location.pathname : '/',
              parcelId: p.parcelId,
              customName: p.customName || '',
              compact: true
            });
            const ok = await copyToClipboard(shareUrl);
            if (ok) {
              copyBtn.textContent = isEmptyLand ? '✓ Copied' : '✓';
              copyBtn.classList.add('is-copied');
              notifySettingsSaved(`Copied share link for "${landTitle}"!`, {
                tone: 'success',
                durationMs: 2600
              });
              setTimeout(() => {
                copyBtn.innerHTML = idleCopyHtml;
                copyBtn.classList.remove('is-copied');
              }, 1800);
            }
            return;
          }
          handleParcelClick();
        });
        labelMarker.addTo(layer);
      }
    }

    const pinUrl = xeroemoji.get('📍')?.svgUrl;
    const customIcon = L.divIcon({
      className: 'graffiland-map-pin',
      html: pinUrl
        ? `<img src="${pinUrl}" width="26" height="26" style="filter: drop-shadow(0 2px 6px rgba(0,245,212,0.65));" />`
        : '📍',
      iconSize: [26, 26],
      iconAnchor: [13, 24]
    });

    const renderedSculptures = isFocusedSingleLand
      ? sculptures.filter((sc) => !sc?.parcelId || sc.parcelId === selectedParcelId)
      : sculptures;

    for (const sc of renderedSculptures) {
      if (!Number.isFinite(Number(sc.lat)) || !Number.isFinite(Number(sc.lng))) continue;
      const isPendingPreview = Boolean(sc.isPendingPreview);
      const chainLinks = isPendingPreview ? null : getSculptureChainLinks(sc, config);
      const txShort = sc.chain?.txHash ? `${sc.chain.txHash.slice(0, 10)}...` : 'n/a';
      const iconForMarker = isPendingPreview
        ? L.divIcon({
            className: 'graffiland-map-preview-pin',
            html: `<span class="map2d-preview-marker-pill" data-testid="map2d-preview-label" data-pending-preview="true"><span class="map-preview-pill">Preview</span><span>${escapeHtml(
              String(sc.title || 'Pending Artwork').slice(0, 18)
            )}</span></span>`,
            iconSize: null
          })
        : customIcon;
      const marker = L.marker([Number(sc.lat), Number(sc.lng)], {
        icon: iconForMarker,
        zIndexOffset: isPendingPreview ? 650 : 300
      });
      marker.on('click', () => onSelectSculpture?.(sc));
      const parentParcel = sc.parcelId ? parcelMap.get(sc.parcelId) : null;
      const scLandName = resolveLandDisplayName(
        {
          customName: parentParcel?.customName || sc.parcelName || '',
          displayName: parentParcel?.displayName || sc.landDisplayName || '',
          firstSculptureTitle: sc.title || '',
          placeName: sc.placeName || ''
        },
        { defaultName: 'Virtual Land' }
      );
      marker.bindTooltip(
        isPendingPreview
          ? `Preview (Needs Approval) · ${sc.title} · ${scLandName}`
          : `${sc.title} · ${scLandName} · ${chainLinks.isSimulated ? 'Pre-chain' : `Tx ${txShort}`}`
      );
      marker.addTo(layer);
    }

    lastAutoBoundsRef.current = closestFit.boundsLatLng;
    recomputeFocusedNeighborArrows();

    if (!userAdjustedViewRef.current && !isFullExpandedRef.current) {
      suppressViewSaveRef.current = true;
      try {
        map.stop();
        if (closestFit.boundsLatLng) {
          map.fitBounds(closestFit.boundsLatLng, {
            paddingTopLeft: [14, 42],
            paddingBottomRight: [14, 28],
            maxZoom: 21,
            animate: false
          });
        } else if (hasUser) {
          map.setView([Number(userLocation.lat), Number(userLocation.lng)], 15, {
            animate: false
          });
        }
      } finally {
        setTimeout(() => {
          suppressViewSaveRef.current = false;
        }, 60);
      }
    }
  }, [
    sculptures,
    parcels,
    userLocation,
    focusArea,
    areaRadiusMeters,
    compact,
    isFullExpanded,
    selectedSculptureId,
    selectedParcelId,
    config,
    onSelectSculpture,
    recomputeFocusedNeighborArrows
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    map.on('move', recomputeFocusedNeighborArrows);
    map.on('zoomend', recomputeFocusedNeighborArrows);
    return () => {
      map.off('move', recomputeFocusedNeighborArrows);
      map.off('zoomend', recomputeFocusedNeighborArrows);
    };
  }, [recomputeFocusedNeighborArrows]);

  useEffect(() => {
    const tickAdvanced = focusParcelTick > lastHandledFocusTickRef.current;
    lastHandledFocusTickRef.current = focusParcelTick;
    if (!tickAdvanced || !selectedParcelId) return;
    const map = mapRef.current;
    if (!map) return;
    const match = parcels.find((p) => p?.parcelId === selectedParcelId);
    if (!match) return;
    const perimeter = extractParcelPerimeterPoints(match);
    if (perimeter.length >= 2) {
      userAdjustedViewRef.current = true;
      map.fitBounds(
        perimeter.map((pt) => [pt.lat, pt.lng]),
        { paddingTopLeft: [20, 44], paddingBottomRight: [20, 24], maxZoom: 21, animate: true }
      );
    }
  }, [focusParcelTick, selectedParcelId, parcels]);

  useEffect(() => {
    isFullExpandedRef.current = Boolean(isFullExpanded);
    if (isFullExpanded) {
      userAdjustedViewRef.current = true;
    }
    const map = mapRef.current;
    if (!map) return undefined;
    const t = setTimeout(() => {
      map.invalidateSize({ animate: false, pan: false });
      if (!isFullExpanded && !userAdjustedViewRef.current && lastAutoBoundsRef.current) {
        map.fitBounds(lastAutoBoundsRef.current, {
          paddingTopLeft: [14, 42],
          paddingBottomRight: [14, 28],
          maxZoom: 21,
          animate: false
        });
      }
    }, 80);
    return () => clearTimeout(t);
  }, [isFullExpanded]);

  function fitClosestLands() {
    const map = mapRef.current;
    if (!map) return;
    const hasUser =
      userLocation &&
      Number.isFinite(Number(userLocation.lat)) &&
      Number.isFinite(Number(userLocation.lng));
    const closestFit = computeClosestLandsPerimeterFit({
      parcels,
      sculptures,
      location: hasUser ? userLocation : null
    });
    if (closestFit.boundsLatLng) {
      userAdjustedViewRef.current = Boolean(isFullExpandedRef.current);
      lastAutoBoundsRef.current = closestFit.boundsLatLng;
      recomputeFocusedNeighborArrows();
      suppressViewSaveRef.current = true;
      try {
        map.fitBounds(closestFit.boundsLatLng, {
          paddingTopLeft: [14, 42],
          paddingBottomRight: [14, 28],
          maxZoom: 21,
          animate: true
        });
      } finally {
        setTimeout(() => {
          suppressViewSaveRef.current = false;
        }, 120);
      }
    }
  }

  function centerOnUser() {
    const map = mapRef.current;
    if (
      map &&
      userLocation &&
      Number.isFinite(Number(userLocation.lat)) &&
      Number.isFinite(Number(userLocation.lng))
    ) {
      userAdjustedViewRef.current = true;
      map.setView([Number(userLocation.lat), Number(userLocation.lng)], 15);
    }
  }

  function fitAllSculptures() {
    const map = mapRef.current;
    if (!map) return;
    const pts = sculptures
      .filter((sc) => Number.isFinite(Number(sc.lat)) && Number.isFinite(Number(sc.lng)))
      .map((sc) => [Number(sc.lat), Number(sc.lng)]);
    if (pts.length > 0) {
      userAdjustedViewRef.current = true;
      map.fitBounds(pts, { padding: [44, 44], maxZoom: 16 });
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        height: '100%',
        width: '100%',
        flex: 1,
        minHeight: 0
      }}
    >
      {!compact && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <XeroIcon emoji="🗺️" size={22} />
            <strong>Virtual Land &amp; 3D Graffiti Map</strong>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {userLocation && (
              <button type="button" className="btn" onClick={centerOnUser}>
                <XeroIcon emoji="🎯" size={13} /> Center on Me
              </button>
            )}
            {sculptures.length > 0 && (
              <button type="button" className="btn" onClick={fitAllSculptures}>
                <XeroIcon emoji="🌐" size={13} /> Fit Sculptures
              </button>
            )}
            <span className="badge teal">
              <XeroIcon emoji="📍" size={13} /> {parcels.length} Virtual Land Parcels
            </span>
            <span className="badge pink">
              <XeroIcon emoji="🧱" size={13} /> {sculptures.length} Sculptures
            </span>
          </div>
        </div>
      )}

      <div ref={stageRef} className={`map-container ${compact ? 'compact' : ''}`} data-map-mode="2d" data-map-theme={mapTheme}>
        <div ref={mapHostRef} className={isDarkMap ? '' : 'is-map-light'} style={{ width: '100%', height: '100%' }} />
        <NeighborEdgeArrowsOverlay
          arrows={neighborArrows}
          onSelectParcel={(p) => onSelectParcelRef.current?.(p)}
        />
        {compact && (onToggle3D || onToggleFullMap || parcels.length > 0 || userLocation) && (
          <div
            className="map-compact-fab-row"
            onPointerDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {onToggle3D && (
              <button
                type="button"
                className="btn map-recenter-fab map-mode-toggle-fab"
                data-testid="mobile-map-3d-toggle-btn"
                onClick={onToggle3D}
                aria-label="Switch to 3D isometric map"
                title="View lands in 3D isometric view"
              >
                <XeroIcon emoji="🧊" size={13} /> 3D
              </button>
            )}
            {parcels.length > 0 && (
              <button
                type="button"
                className="btn map-recenter-fab"
                data-testid="mobile-map-fit-btn"
                onClick={fitClosestLands}
                title="Zoom to fit closest lands perimeter"
              >
                <XeroIcon emoji="🗺️" size={13} /> Fit Lands
              </button>
            )}
            {userLocation && (
              <button
                type="button"
                className="btn map-recenter-fab"
                data-testid="mobile-map-me-btn"
                onClick={centerOnUser}
                title="Center map on my GPS location"
              >
                <XeroIcon emoji="🎯" size={13} /> Me
              </button>
            )}
            <button
              type="button"
              className="btn map-recenter-fab"
              data-testid="mobile-map-theme-toggle-btn"
              onClick={toggleMapTheme}
              aria-label={isDarkMap ? 'Switch map to Light Mode' : 'Switch map to Dark Mode'}
              title={isDarkMap ? 'Switch map to Light Mode' : 'Switch map to Dark Mode'}
            >
              <XeroIcon emoji={isDarkMap ? '🌙' : '☀️'} size={13} />
            </button>
            {onToggleFullMap && (
              <button
                type="button"
                className="btn map-recenter-fab"
                data-testid="mobile-map-fullscreen-btn"
                onClick={onToggleFullMap}
                aria-label={isFullExpanded ? 'Exit full map' : 'Expand full map'}
                title={isFullExpanded ? 'Exit full-screen map' : 'Expand map full-screen'}
              >
                {isFullExpanded ? '⤡' : '⤢'}
              </button>
            )}
          </div>
        )}
        {sculptures.length === 0 && parcels.length === 0 && (
          <div
            style={{
              position: 'absolute',
              bottom: 16,
              left: 16,
              right: 16,
              zIndex: 500,
              background: 'rgba(10, 14, 24, 0.88)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '10px 14px',
              fontSize: 13
            }}
          >
            <XeroIcon emoji="📍" size={16} /> No virtual lands or sculptures in this view yet — explore All Lands or create one nearby!
          </div>
        )}
      </div>
    </div>
  );
}
