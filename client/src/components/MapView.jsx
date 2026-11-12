import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import React, { useEffect, useRef } from 'react';
import xeroemoji from 'xeroemoji';
import XeroIcon from './XeroIcon.jsx';

export default function MapView({ sculptures = [], parcels = [], onSelectSculpture }) {
  const mapHostRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  useEffect(() => {
    if (!mapHostRef.current || mapRef.current) return;

    const map = L.map(mapHostRef.current, {
      center: [37.7749, -122.4194],
      zoom: 3,
      zoomControl: true
    });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);

    const layer = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerRef.current = layer;

    return () => {
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
      coords.push([sc.lat, sc.lng]);
      const marker = L.marker([sc.lat, sc.lng], { icon: customIcon });
      marker.on('click', () => onSelectSculpture(sc));
      marker.bindTooltip(`${sc.title} · ${sc.parcelId}`);
      marker.addTo(layer);
    }

    if (coords.length > 0) {
      map.fitBounds(coords, { padding: [50, 50], maxZoom: 16 });
    }
  }, [sculptures, parcels, onSelectSculpture]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <XeroIcon emoji="🗺️" size={22} />
          <strong>Global Virtual Land &amp; 3D Graffiti Map</strong>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="badge teal">
            <XeroIcon emoji="📍" size={13} /> {parcels.length} Virtual Land Parcels
          </span>
          <span className="badge pink">
            <XeroIcon emoji="🧱" size={13} /> {sculptures.length} Sculptures
          </span>
        </div>
      </div>

      <div className="map-container">
        <div ref={mapHostRef} style={{ width: '100%', height: '100%' }} />
        {sculptures.length === 0 && (
          <div
            style={{
              position: 'absolute',
              bottom: 20,
              left: 20,
              zIndex: 500,
              background: 'rgba(10, 14, 24, 0.88)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '10px 14px',
              fontSize: 13
            }}
          >
            <XeroIcon emoji="📱" size={16} /> No published phone sculptures yet — scan the QR code in
            Pair Studio to drop the first 3D sculpture on the map!
          </div>
        )}
      </div>
    </div>
  );
}
