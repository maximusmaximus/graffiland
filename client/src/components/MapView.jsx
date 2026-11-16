import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import React, { useEffect, useRef } from 'react';
import xeroemoji from 'xeroemoji';
import XeroIcon from './XeroIcon.jsx';

export default function MapView({
  sculptures = [],
  parcels = [],
  userLocation = null,
  focusArea = false,
  areaRadiusMeters = 5000,
  compact = false,
  onSelectSculpture
}) {
  const mapHostRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  useEffect(() => {
    if (!mapHostRef.current || mapRef.current) return;

    const initialCenter =
      userLocation && Number.isFinite(userLocation.lat) && Number.isFinite(userLocation.lng)
        ? [userLocation.lat, userLocation.lng]
        : [37.7749, -122.4194];
    const initialZoom = userLocation ? 14 : 3;

    const map = L.map(mapHostRef.current, {
      center: initialCenter,
      zoom: initialZoom,
      zoomControl: true
    });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);

    const layer = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerRef.current = layer;

    const resizeTimer = setTimeout(() => {
      map.invalidateSize();
    }, 90);

    return () => {
      clearTimeout(resizeTimer);
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

    for (const p of parcels) {
      if (!p.bounds) continue;
      const rect = L.rectangle([p.bounds.sw, p.bounds.ne], {
        color: '#00f5d4',
        weight: 1.5,
        fillColor: '#00f5d4',
        fillOpacity: 0.18
      });
      rect.bindTooltip(`Virtual Land ${p.parcelId} (${p.sculptureCount} sculptures)`);
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
      const marker = L.marker([Number(sc.lat), Number(sc.lng)], { icon: customIcon });
      marker.on('click', () => onSelectSculpture(sc));
      marker.bindTooltip(`${sc.title} · ${sc.parcelId}`);
      marker.addTo(layer);
    }

    if (coords.length > 0) {
      if (hasUser && focusArea) {
        coords.push([Number(userLocation.lat), Number(userLocation.lng)]);
      }
      map.fitBounds(coords, { padding: [44, 44], maxZoom: 16 });
    } else if (hasUser) {
      map.setView([Number(userLocation.lat), Number(userLocation.lng)], 14);
    }
  }, [sculptures, parcels, userLocation, focusArea, areaRadiusMeters, onSelectSculpture]);

  function centerOnUser() {
    const map = mapRef.current;
    if (
      map &&
      userLocation &&
      Number.isFinite(Number(userLocation.lat)) &&
      Number.isFinite(Number(userLocation.lng))
    ) {
      map.setView([Number(userLocation.lat), Number(userLocation.lng)], 15);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {!compact && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <XeroIcon emoji="🗺️" size={22} />
            <strong>Global Virtual Land &amp; 3D Graffiti Map</strong>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {userLocation && (
              <button type="button" className="btn" onClick={centerOnUser}>
                <XeroIcon emoji="🎯" size={13} /> Center on Me
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
