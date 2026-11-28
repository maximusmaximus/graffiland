import React, { Component, useEffect, useState } from 'react';
import Catalog3DSearchBox from '../Catalog3DSearchBox.jsx';
import XeroIcon from '../XeroIcon.jsx';

class CatalogSearchErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch() {
    // Keep the search sheet stably mounted instead of crashing back to camera view
  }

  handleRetry = () => {
    this.setState({ hasError: false });
    this.props.onRetry?.();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="catalog-search-empty mobile-catalog-error-fallback"
          data-testid="mobile-catalog-search-error"
          role="alert"
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            3D model preview hit a temporary hiccup
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
            Tap below to reload the 3D catalog without leaving search.
          </div>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            data-testid="mobile-catalog-search-retry-btn"
            onClick={this.handleRetry}
          >
            Reload 3D Search
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function MobileCatalogSearchModal({
  busy = false,
  disabled = false,
  disabledReason = '',
  placedItem = null,
  onPlaceItem,
  onRemovePlacedItem = null,
  onClose
}) {
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.info-tip-popover')) return;
      e.preventDefault();
      onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop mobile-catalog-search-backdrop is-fullscreen-sheet"
      data-testid="mobile-catalog-search-modal"
      data-camera-hidden="true"
      data-full-viewport="true"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="modal-card mobile-catalog-search-card is-full-viewport-height"
        data-testid="mobile-catalog-search-card"
        role="dialog"
        aria-modal="true"
        aria-label="Search 3D items to place in AR"
      >
        <div className="modal-header mobile-catalog-search-header">
          <div className="mobile-catalog-search-heading">
            <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 16 }}>
              <XeroIcon emoji="🔍" size={18} />
              <span>Search 3D Models</span>
            </h3>
            <div
              className="mobile-catalog-camera-paused-note"
              data-testid="mobile-catalog-camera-paused-note"
            >
              <XeroIcon emoji="📷" size={11} />
              <span>Camera hidden while browsing for smooth 3D search</span>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm mobile-catalog-close-btn"
            data-testid="mobile-catalog-search-close-btn"
            aria-label="Close 3D item search and return to camera"
            onClick={() => onClose?.()}
          >
            <XeroIcon emoji="✕" size={14} />
            <span>Camera</span>
          </button>
        </div>

        <div className="mobile-catalog-search-body">
          {placedItem && (
            <div className="mobile-placed-catalog-banner" data-testid="mobile-placed-catalog-banner">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)' }}>
                  Active in AR: {placedItem.title}
                </div>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                  Picking another item replaces the current placed 3D item.
                </div>
              </div>
              {onRemovePlacedItem && (
                <button
                  type="button"
                  className="btn btn-xs btn-danger"
                  onClick={onRemovePlacedItem}
                >
                  Remove
                </button>
              )}
            </div>
          )}

          {disabled && disabledReason && (
            <div
              className="status-banner"
              data-testid="mobile-catalog-calibration-notice"
              style={{ marginBottom: 8, fontSize: 11.5 }}
            >
              📡 {disabledReason} You can still browse now and place once calibrated.
            </div>
          )}

          <CatalogSearchErrorBoundary
            key={retryKey}
            onRetry={() => setRetryKey((k) => k + 1)}
          >
            <Catalog3DSearchBox
              title="Search to Add"
              actionLabel="✨ Place & Scale"
              busy={busy}
              disabled={disabled}
              disabledReason={disabledReason}
              limit={6}
              compact
              onPlaceItem={onPlaceItem}
            />
          </CatalogSearchErrorBoundary>
        </div>
      </div>
    </div>
  );
}
