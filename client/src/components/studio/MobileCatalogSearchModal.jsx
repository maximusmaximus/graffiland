import React from 'react';
import { useSafeBackdropClose } from '../../utils/modalBackdropGuard.js';
import Catalog3DSearchBox from '../Catalog3DSearchBox.jsx';
import XeroIcon from '../XeroIcon.jsx';

export default function MobileCatalogSearchModal({
  busy = false,
  disabled = false,
  disabledReason = '',
  placedItem = null,
  onPlaceItem,
  onRemovePlacedItem = null,
  onClose
}) {
  const backdropCloseProps = useSafeBackdropClose(onClose);

  return (
    <div
      className="modal-backdrop mobile-catalog-search-backdrop"
      data-testid="mobile-catalog-search-modal"
      {...backdropCloseProps}
    >
      <div
        className="modal-card mobile-catalog-search-card"
        role="dialog"
        aria-modal="true"
        aria-label="Search 3D items to place in AR"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header" style={{ marginBottom: 8 }}>
          <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 16 }}>
            <XeroIcon emoji="🔍" size={18} />
            <span>Search 3D Items</span>
          </h3>
          <button
            type="button"
            className="btn btn-sm"
            data-testid="mobile-catalog-search-close-btn"
            aria-label="Close 3D item search"
            onClick={onClose}
          >
            <XeroIcon emoji="✕" size={15} />
          </button>
        </div>

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
      </div>
    </div>
  );
}
