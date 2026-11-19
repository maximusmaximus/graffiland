import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import React, { useEffect, useRef } from 'react';
import xeroemoji from 'xeroemoji';
import { getSculptureChainLinks } from '../utils/chainLinks.js';
import XeroIcon from './XeroIcon.jsx';

export default function MapView({
  sculptures = [],
  parcels = [],
  userLocation = null,
  focusArea = false,
  areaRadiusMeters = 5000,
  compact = false,
  selectedSculptureId = '',
  initialView = null,
  onViewportChange = null,
  config = null,
  onSelectSculpture,
  onSelectParcel = null
}) {
  const mapHostRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const initialViewRef = useRef(initialView);
  const initialUserLocationRef = useRef(userLocation);
  const onViewportChangeRef = useRef(onViewportChange);
  const onSelectParcelRef = useRef(onSelectParcel);
  const userAdjustedViewRef = useRef(
    Boolean(
      initialView &&
        Number.isFinite(Number(initialView.lat)) &&
        Number.isFinite(Number(initialView.lng)) &&
        Number.isFinite(Number(initialView.zoom))
    )
  );
  const suppressViewSaveRef = useRef(false);

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
      zoomControl: true
    });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);

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

    const resizeTimer = setTimeout(() => {
      map.invalidateSize();
    }, 90);

    let observer = null;
    if (typeof ResizeObserver === 'function' && mapHostRef.current) {
      observer = new ResizeObserver(() => {
        map.invalidateSize({ animate: false });
      });
      observer.observe(mapHostRef.current);
    }

    return () => {
      clearTimeout(resizeTimer);
      observer?.disconnect();
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
    map.invalidateSize();

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
      if (p?.bounds) parcelMap.set(p.parcelId, p);
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

    const selectedParcelId =
      sculptures.find((s) => s.id === selectedSculptureId)?.parcelId || '';

    for (const p of parcelMap.values()) {
      const parcelSculptures = sculptures.filter((s) => s.parcelId === p.parcelId);
      const isSelectedParcel = selectedParcelId && p.parcelId === selectedParcelId;
      const isDormant = p.stewardStatus === 'dormant';
      const hasQuests = Number(p.openQuestCount || 0) > 0;
      const strokeColor = isSelectedParcel
        ? '#ffd166'
        : isDormant
        ? '#ff6b35'
        : hasQuests
        ? '#7b2cbf'
        : '#00f5d4';
      const rect = L.rectangle([p.bounds.sw, p.bounds.ne], {
        color: strokeColor,
        weight: isSelectedParcel || isDormant ? 2.5 : 1.75,
        dashArray: isDormant ? '6 4' : undefined,
        fillColor: strokeColor,
        fillOpacity: isSelectedParcel ? 0.28 : isDormant ? 0.26 : 0.2
      });
      const questTag = isDormant
        ? ' · 🔥 Needs First Spark (2x XP)'
        : hasQuests
        ? ` · 🎨 ${p.openQuestCount} Quest(s)`
        : '';
      const stewardTag = p.stewardType === 'agent' ? ' · 🤖 AI Steward' : '';
      rect.bindTooltip(
        `Virtual Land ${p.parcelId} (${parcelSculptures.length || p.sculptureCount} sculpture${(parcelSculptures.length || p.sculptureCount) === 1 ? '' : 's'}${questTag}${stewardTag})`
      );
      if (parcelSculptures.length > 0 && onSelectSculpture) {
        rect.on('click', () => onSelectSculpture(parcelSculptures[0]));
      } else {
        rect.on('click', () => onSelectParcelRef.current?.(p));
      }
      rect.addTo(layer);
    }

    const pinUrl = xeroemoji.get('📍')?.svgUrl;
    const customIcon = L.divIcon({
      className: 'graffiland-map-pin',
      html: pinUrl
        ? `<img src="${pinUrl}" width="28" height="28" style="filter: drop-shadow(0 2px 6px rgba(0,245,212,0.65));" />`
        : '📍',
      iconSize: [28, 28],
      iconAnchor: [14, 26]
    });

    const coords = [];
    for (const sc of sculptures) {
      if (!Number.isFinite(Number(sc.lat)) || !Number.isFinite(Number(sc.lng))) continue;
      coords.push([Number(sc.lat), Number(sc.lng)]);
      const chainLinks = getSculptureChainLinks(sc, config);
      const txShort = sc.chain?.txHash ? `${sc.chain.txHash.slice(0, 10)}...` : 'n/a';
      const marker = L.marker([Number(sc.lat), Number(sc.lng)], { icon: customIcon });
      marker.on('click', () => onSelectSculpture?.(sc));
      marker.bindTooltip(
        `${sc.title} · Land ${sc.parcelId} · ${chainLinks.isSimulated ? 'Pre-chain' : `Tx ${txShort}`}`
      );
      marker.addTo(layer);
    }

    if (!userAdjustedViewRef.current) {
      suppressViewSaveRef.current = true;
      try {
        if (coords.length > 0) {
          if (hasUser && focusArea) {
            coords.push([Number(userLocation.lat), Number(userLocation.lng)]);
          }
          map.fitBounds(coords, { padding: [44, 44], maxZoom: 16 });
        } else if (hasUser) {
          map.setView([Number(userLocation.lat), Number(userLocation.lng)], 14);
        }
      } finally {
        setTimeout(() => {
          suppressViewSaveRef.current = false;
        }, 60);
      }
    }
  }, [sculptures, parcels, userLocation, focusArea, areaRadiusMeters, selectedSculptureId, config, onSelectSculpture]);

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
        height: compact ? 'auto' : '100%',
        flex: compact ? undefined : 1,
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

      <div className={`map-container ${compact ? 'compact' : ''}`}>
        <div ref={mapHostRef} style={{ width: '100%', height: '100%' }} />
        {compact && userLocation && (
          <button
            type="button"
            className="btn map-recenter-fab"
            onClick={centerOnUser}
            title="Center map on my GPS location"
          >
            <XeroIcon emoji="🎯" size={14} /> My Area
          </button>
        )}
        {sculptures.length === 0 && (
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
            <XeroIcon emoji="📍" size={16} /> No published sculptures in this view yet — explore Global view or create one nearby!
          </div>
        )}
      </div>
    </div>
  );
}
