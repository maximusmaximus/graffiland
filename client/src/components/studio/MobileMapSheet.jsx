import React from 'react';
import { getSculptureChainLinks } from '../../utils/chainLinks.js';
import {
  buildSculptureShareUrl,
  buildShareToXUrl,
  copyToClipboard
} from '../../utils/clipboard.js';
import MapView from '../MapView.jsx';
import XeroIcon from '../XeroIcon.jsx';

export default function MobileMapSheet({
  config,
  location,
  areaFilterMode,
  setAreaFilterMode,
  mapLoading,
  loadPublicMapData,
  displayedMapSculptures,
  areaSculpturesSorted,
  mapParcels,
  mapSelectedSculpture,
  onSelectSculpture,
  onShowHint,
  onClose
}) {
  return (
    <div className="mobile-map-overlay" role="dialog" aria-label="Public Area Sculpture Map">
      <div className="mobile-map-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <XeroIcon emoji="🗺️" size={22} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Public Area Map</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              Tap any pin or card to inspect 3D &amp; navigate
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            type="button"
            className={`btn ${areaFilterMode === 'nearby' ? 'btn-primary' : ''}`}
            onClick={() => setAreaFilterMode('nearby')}
          >
            Area (5km)
          </button>
          <button
            type="button"
            className={`btn ${areaFilterMode === 'all' ? 'btn-primary' : ''}`}
            onClick={() => setAreaFilterMode('all')}
          >
            All ({areaSculpturesSorted.length})
          </button>
          <button
            type="button"
            className="btn"
            disabled={mapLoading}
            onClick={loadPublicMapData}
            aria-label="Refresh public map"
          >
            <XeroIcon emoji="🔄" size={14} />
          </button>
          <button type="button" className="btn" onClick={onClose} aria-label="Close map">
            <XeroIcon emoji="❌" size={15} />
          </button>
        </div>
      </div>

      <div className="mobile-map-canvas">
        <MapView
          sculptures={displayedMapSculptures}
          parcels={mapParcels}
          userLocation={location}
          focusArea={areaFilterMode === 'nearby'}
          areaRadiusMeters={5000}
          selectedSculptureId={mapSelectedSculpture?.id || ''}
          config={config}
          compact
          onSelectSculpture={onSelectSculpture}
        />
      </div>

      <div className="mobile-map-list">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>
            Sculptures {areaFilterMode === 'nearby' && location ? 'in Your Area' : 'Worldwide'} ({displayedMapSculptures.length})
          </strong>
          {areaFilterMode === 'nearby' &&
            displayedMapSculptures.length === 0 &&
            areaSculpturesSorted.length > 0 && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setAreaFilterMode('all')}
              >
                Show All Public ({areaSculpturesSorted.length})
              </button>
            )}
        </div>

        {mapLoading && displayedMapSculptures.length === 0 ? (
          <div className="card" style={{ padding: 12, fontSize: 12, color: 'var(--muted)' }}>
            Loading nearby sculptures...
          </div>
        ) : displayedMapSculptures.length === 0 ? (
          <div className="card" style={{ padding: 12, fontSize: 12, color: 'var(--muted)' }}>
            No public sculptures in this area yet. Be the first to paint &amp; mint here!
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {displayedMapSculptures.map((sc) => {
              const chainLinks = getSculptureChainLinks(sc, config);
              const txShort = sc.chain?.txHash ? `${sc.chain.txHash.slice(0, 10)}...` : '';
              const distText =
                sc.distanceMeters == null
                  ? ''
                  : sc.distanceMeters >= 1000
                  ? `${(sc.distanceMeters / 1000).toFixed(1)} km`
                  : `${sc.distanceMeters} m`;
              return (
                <div
                  key={sc.id}
                  className="card mobile-map-item"
                  onClick={() => onSelectSculpture(sc)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectSculpture(sc);
                    }
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{sc.title}</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                      {distText && (
                        <span className="badge teal">
                          <XeroIcon emoji="📍" size={11} /> {distText}
                        </span>
                      )}
                      <span className="badge gold">
                        <XeroIcon emoji="🗺️" size={11} /> Land {sc.parcelId}
                      </span>
                      <span className="badge">
                        <XeroIcon emoji="🧱" size={11} /> {sc.voxelCount} blocks
                      </span>
                      {chainLinks.txUrl ? (
                        <a
                          className="badge teal"
                          href={chainLinks.txUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          title="View mint transaction on chain"
                        >
                          <XeroIcon emoji="⛓️" size={11} /> Tx {txShort}
                        </a>
                      ) : txShort ? (
                        <span className="badge">
                          <XeroIcon emoji="⛓️" size={11} />{' '}
                          {chainLinks.isSimulated ? 'Pre-chain' : 'Tx'} {txShort}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="btn"
                      title="Copy shareable link"
                      aria-label={`Copy share link for ${sc.title}`}
                      onClick={async (e) => {
                        e.stopPropagation();
                        const ok = await copyToClipboard(buildSculptureShareUrl(sc.id));
                        onShowHint?.(ok ? 'Copied shareable link!' : 'Copy unavailable');
                      }}
                    >
                      <XeroIcon emoji="📤" size={14} />
                    </button>
                    <a
                      className="btn"
                      href={buildShareToXUrl({
                        title: sc.title,
                        parcelId: sc.parcelId,
                        sculptureId: sc.id
                      })}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title="Share to X"
                      aria-label={`Share ${sc.title} to X`}
                    >
                      𝕏
                    </a>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectSculpture(sc);
                      }}
                    >
                      <XeroIcon emoji="🧊" size={14} /> Review 3D
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
