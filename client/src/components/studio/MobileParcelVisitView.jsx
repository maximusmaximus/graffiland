import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { haversineMeters } from '../../../../shared/chatPolicy.mjs';
import { buildParcelShareUrl } from '../../../../shared/landVolume.mjs';
import { copyToClipboard } from '../../utils/clipboard.js';
import { formatLandDimensions } from '../../utils/landMapHelpers.js';
import XeroIcon from '../XeroIcon.jsx';
import MobileIsometricMap from './MobileIsometricMap.jsx';

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export default function MobileParcelVisitView({
  parcel,
  sculptures = [],
  userLocation = null,
  loading = false,
  error = '',
  onRefreshLocation = null,
  onViewInAR = null,
  onMakeArt = null,
  onSelectSculpture = null,
  onClose
}) {
  const mapHostRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const [copiedMsg, setCopiedMsg] = useState('');
  const [mapDimensionMode, setMapDimensionMode] = useState('2d'); // '2d' | '3d'
  const [isMapFull, setIsMapFull] = useState(false);

  const centerLat = Number(
    parcel?.volume?.centerLat ?? parcel?.centerLat ?? parcel?.bounds?.center?.[0]
  );
  const centerLng = Number(
    parcel?.volume?.centerLng ?? parcel?.centerLng ?? parcel?.bounds?.center?.[1]
  );
  const hasCenter = Number.isFinite(centerLat) && Number.isFinite(centerLng);

  const isFrozen = Boolean(parcel?.frozen || parcel?.settings?.frozen);

  const distanceMeters = useMemo(() => {
    if (
      !hasCenter ||
      !userLocation ||
      !Number.isFinite(Number(userLocation.lat)) ||
      !Number.isFinite(Number(userLocation.lng))
    ) {
      return null;
    }
    return haversineMeters(
      Number(userLocation.lat),
      Number(userLocation.lng),
      centerLat,
      centerLng
    );
  }, [hasCenter, userLocation, centerLat, centerLng]);

  const nearThresholdMeters = useMemo(() => {
    const w = Number(parcel?.volume?.widthMeters || 14);
    const d = Number(parcel?.volume?.depthMeters || 14);
    return Math.max(75, Math.hypot(w / 2, d / 2) + 35);
  }, [parcel]);

  const isNearProperty = distanceMeters !== null && distanceMeters <= nearThresholdMeters;

  const directionsUrl = hasCenter
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
        `${centerLat.toFixed(6)},${centerLng.toFixed(6)}`
      )}`
    : '';

  useEffect(() => {
    if (mapDimensionMode !== '2d' || !mapHostRef.current || !hasCenter || mapRef.current) {
      return undefined;
    }

    const map = L.map(mapHostRef.current, {
      center: [centerLat, centerLng],
      zoom: 19,
      maxZoom: 21.5,
      zoomControl: false,
      attributionControl: true
    });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxNativeZoom: 19,
      maxZoom: 21.5
    }).addTo(map);

    const layer = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerRef.current = layer;

    let observer = null;
    if (typeof ResizeObserver === 'function' && mapHostRef.current) {
      observer = new ResizeObserver(() => {
        map.invalidateSize({ animate: false, pan: false });
      });
      observer.observe(mapHostRef.current);
    }

    const t = setTimeout(() => map.invalidateSize(), 100);
    return () => {
      clearTimeout(t);
      observer?.disconnect();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [hasCenter, centerLat, centerLng, mapDimensionMode]);

  useEffect(() => {
    if (mapDimensionMode !== '2d') return undefined;
    const map = mapRef.current;
    if (!map) return undefined;
    const t = setTimeout(() => map.invalidateSize({ animate: false, pan: false }), 80);
    return () => clearTimeout(t);
  }, [isMapFull, mapDimensionMode]);

  useEffect(() => {
    if (mapDimensionMode !== '2d') return;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer || !hasCenter) return;

    layer.clearLayers();
    map.invalidateSize();

    const stroke = isFrozen ? '#7dd3fc' : '#00f5d4';
    const corners = Array.isArray(parcel?.volume?.corners) ? parcel.volume.corners : [];

    let parcelLayer = null;
    if (corners.length >= 4) {
      const latLngs = corners.slice(0, 4).map(([lng, lat]) => [Number(lat), Number(lng)]);
      parcelLayer = L.polygon(latLngs, {
        color: stroke,
        weight: 3,
        fillColor: stroke,
        fillOpacity: 0.25
      }).addTo(layer);
    } else if (parcel?.bounds?.sw && parcel?.bounds?.ne) {
      parcelLayer = L.rectangle([parcel.bounds.sw, parcel.bounds.ne], {
        color: stroke,
        weight: 3,
        fillColor: stroke,
        fillOpacity: 0.25
      }).addTo(layer);
    }

    // Center property beacon
    L.circleMarker([centerLat, centerLng], {
      radius: 6,
      color: '#ffffff',
      weight: 2,
      fillColor: isFrozen ? '#38bdf8' : '#ffd166',
      fillOpacity: 1
    })
      .bindTooltip(parcel?.customName || parcel?.parcelId || 'Virtual Land')
      .addTo(layer);

    // Sculptures on this property
    for (const sc of sculptures || []) {
      const sLat = Number(sc.lat);
      const sLng = Number(sc.lng);
      if (!Number.isFinite(sLat) || !Number.isFinite(sLng)) continue;
      L.circleMarker([sLat, sLng], {
        radius: 5,
        color: '#04101a',
        weight: 1.5,
        fillColor: '#ff3e7f',
        fillOpacity: 0.95
      })
        .bindTooltip(sc.title || '3D Artwork')
        .on('click', () => onSelectSculpture?.(sc))
        .addTo(layer);
    }

    // Live user GPS blue dot
    if (
      userLocation &&
      Number.isFinite(Number(userLocation.lat)) &&
      Number.isFinite(Number(userLocation.lng))
    ) {
      L.circleMarker([Number(userLocation.lat), Number(userLocation.lng)], {
        radius: 7,
        color: '#ffffff',
        weight: 2.5,
        fillColor: '#00bbf9',
        fillOpacity: 1
      })
        .bindTooltip('You are here')
        .addTo(layer);
    }

    // Keep the property cleanly centered
    if (parcelLayer && typeof parcelLayer.getBounds === 'function') {
      map.fitBounds(parcelLayer.getBounds(), { padding: [44, 44], maxZoom: 21 });
    } else {
      map.setView([centerLat, centerLng], 19);
    }
  }, [parcel, sculptures, userLocation, hasCenter, centerLat, centerLng, isFrozen, onSelectSculpture, mapDimensionMode]);

  async function handleCopyShareLink() {
    if (!parcel?.parcelId) return;
    const shareUrl = buildParcelShareUrl({
      origin: window.location.origin,
      pathname: window.location.pathname,
      parcelId: parcel.parcelId,
      customName: parcel.customName || '',
      compact: true
    });
    const ok = await copyToClipboard(shareUrl);
    setCopiedMsg(ok ? 'Link copied!' : shareUrl);
    setTimeout(() => setCopiedMsg(''), 2200);
  }

  return (
    <div
      className="mobile-parcel-visit-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Visit Virtual Land Parcel"
      data-testid="mobile-parcel-visit-view"
    >
      {/* Clean Top Bar */}
      <header className="mobile-parcel-header">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <h1 className="mobile-parcel-title">
              {loading ? 'Loading Land…' : parcel?.customName || parcel?.parcelId || 'Virtual Land'}
            </h1>
            {parcel && (
              <span className={`badge ${isFrozen ? 'badge-error' : 'teal'}`} style={{ fontSize: 10 }}>
                {isFrozen ? '❄️ Frozen' : '✅ Open'}
              </span>
            )}
          </div>
          {parcel && (
            <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              {parcel.parcelId}
              {formatLandDimensions(parcel) ? ` · ${formatLandDimensions(parcel)}` : ''}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {parcel && (
            <button
              type="button"
              className="btn btn-sm"
              aria-label="Copy parcel share link"
              onClick={handleCopyShareLink}
            >
              {copiedMsg ? '✓' : '🔗'}
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Close parcel visit view"
            onClick={onClose}
          >
            <XeroIcon emoji="✕" size={14} />
          </button>
        </div>
      </header>

      {copiedMsg && (
        <div className="status-banner" role="status" style={{ margin: '0 14px 8px' }}>
          {copiedMsg}
        </div>
      )}

      {error ? (
        <div className="mobile-parcel-body">
          <div className="card" style={{ padding: 16, textAlign: 'center' }}>
            <p style={{ margin: '0 0 10px', fontSize: 14 }}>{error}</p>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Open GRAFFILAND Studio
            </button>
          </div>
        </div>
      ) : loading || !parcel ? (
        <div className="mobile-parcel-body" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <span className="mono" style={{ fontSize: 13, color: 'var(--muted)' }}>
            Loading property map…
          </span>
        </div>
      ) : (
        <>
          {/* Clean Centered Map Focused on This Exact Property (2D <-> 3D Isometric + Full Expand) */}
          <div
            className={`mobile-parcel-map-frame ${isMapFull ? 'is-fullscreen' : ''}`}
            data-map-mode={mapDimensionMode}
          >
            {mapDimensionMode === '3d' ? (
              <MobileIsometricMap
                parcels={[parcel]}
                sculptures={sculptures}
                userLocation={userLocation}
                selectedParcelId={parcel.parcelId}
                isFullExpanded={isMapFull}
                onToggle2D={() => setMapDimensionMode('2d')}
                onToggleFullMap={() => setIsMapFull((v) => !v)}
                onSelectSculpture={onSelectSculpture}
              />
            ) : (
              <>
                <div ref={mapHostRef} className="mobile-parcel-map-canvas" />
                <div
                  className="map-compact-fab-row"
                  onPointerDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="btn map-recenter-fab map-mode-toggle-fab"
                    data-testid="mobile-map-3d-toggle-btn"
                    aria-label="Switch to 3D isometric map"
                    title="View this land in 3D isometric view"
                    onClick={() => setMapDimensionMode('3d')}
                  >
                    <XeroIcon emoji="🧊" size={13} /> 3D
                  </button>
                  <button
                    type="button"
                    className="btn map-recenter-fab"
                    data-testid="mobile-map-fullscreen-btn"
                    aria-label={isMapFull ? 'Exit full map' : 'Expand full map'}
                    title={isMapFull ? 'Exit full-screen map' : 'Expand map full-screen'}
                    onClick={() => setIsMapFull((v) => !v)}
                  >
                    {isMapFull ? '⤡' : '⤢'}
                  </button>
                </div>
                <div className="mobile-parcel-map-pill mono">
                  {hasCenter ? `${centerLat.toFixed(5)}, ${centerLng.toFixed(5)}` : parcel.parcelId}
                </div>
              </>
            )}
          </div>

          {/* Clear Options & Proximity Actions */}
          {!isMapFull && (
          <div className="mobile-parcel-body">
            {parcel.description && (
              <p className="mobile-parcel-desc">{parcel.description}</p>
            )}

            <div className="mobile-parcel-distance-row">
              {isNearProperty ? (
                <span className="badge teal" data-testid="parcel-proximity-near">
                  📍 You are at this property ({formatDistance(distanceMeters)} away)
                </span>
              ) : distanceMeters !== null ? (
                <span className="badge gold" data-testid="parcel-proximity-far">
                  📍 {formatDistance(distanceMeters)} away
                </span>
              ) : (
                <span className="badge" data-testid="parcel-proximity-unknown">
                  📡 Checking GPS distance…
                </span>
              )}
              {onRefreshLocation && !isNearProperty && (
                <button
                  type="button"
                  className="btn btn-xs"
                  onClick={onRefreshLocation}
                >
                  Refresh GPS
                </button>
              )}
            </div>

            {/* Clean Primary Action Buttons */}
            <div className="mobile-parcel-actions" data-testid="mobile-parcel-actions">
              {isNearProperty ? (
                <>
                  <button
                    type="button"
                    className="btn btn-primary mobile-parcel-cta"
                    onClick={() => onViewInAR?.(parcel, sculptures)}
                  >
                    <XeroIcon emoji="👁️" size={18} /> View in AR
                  </button>

                  {!isFrozen ? (
                    <button
                      type="button"
                      className="btn mobile-parcel-cta is-make-art"
                      onClick={() => onMakeArt?.(parcel)}
                    >
                      <XeroIcon emoji="🎨" size={18} /> Make Art on This Property
                    </button>
                  ) : (
                    <div className="mobile-parcel-frozen-note" role="status">
                      ❄️ This property is frozen by the owner — viewing in AR only.
                    </div>
                  )}
                </>
              ) : (
                <>
                  {directionsUrl && (
                    <a
                      href={directionsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-primary mobile-parcel-cta"
                    >
                      <XeroIcon emoji="🧭" size={18} /> Get Directions
                    </a>
                  )}
                  <div className="mobile-parcel-hint">
                    {isFrozen
                      ? 'Walk near this property to unlock View in AR (placements are frozen).'
                      : 'Walk near this property to unlock View in AR and Make Art on This Property.'}
                  </div>
                </>
              )}
            </div>

            {/* Artworks on This Property */}
            {sculptures.length > 0 && (
              <div className="mobile-parcel-art-section">
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
                  3D Artworks Here ({sculptures.length})
                </div>
                <div className="mobile-parcel-art-strip">
                  {sculptures.map((sc) => (
                    <button
                      key={sc.id}
                      type="button"
                      className="mobile-parcel-art-chip"
                      onClick={() => onSelectSculpture?.(sc)}
                    >
                      <strong>{sc.title}</strong>
                      <span className="mono">
                        {sc.modelType === 'custom-3d'
                          ? `.${sc.customModel?.format || 'glb'}`
                          : `${sc.voxelCount || 0} blocks`}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          )}
        </>
      )}
    </div>
  );
}
