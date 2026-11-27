import React, { useEffect, useRef, useState } from 'react';
import { api, API_BASE } from '../utils/api.js';
import { requestGlbThumbnail } from '../utils/catalogThumbnailRenderer.js';
import InfoTip from './InfoTip.jsx';
import XeroIcon from './XeroIcon.jsx';

const SOURCE_TABS = [
  { id: 'all', label: 'All (9k+)' },
  { id: 'simready', label: 'SimReady' },
  { id: 'pixels', label: 'Pixels' },
  { id: 'xeroemoji', label: 'XeroEmoji' }
];

const SOURCE_META = {
  simready: { badge: 'SimReady', emoji: '📦', accent: '#00f5d4' },
  pixels: { badge: 'Pixels', emoji: '🕹️', accent: '#a855f7' },
  xeroemoji: { badge: 'XeroEmoji', emoji: '✨', accent: '#ffd166' }
};

function resolveFetchableModelUrl(rawUrl) {
  const u = String(rawUrl || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('/') && API_BASE) {
    return `${API_BASE.replace(/\/$/, '')}${u}`;
  }
  return u;
}

function CatalogItemThumb({ item }) {
  const [glbThumb, setGlbThumb] = useState(null);
  const meta = SOURCE_META[item?.source] || SOURCE_META.simready;

  useEffect(() => {
    if (!item || item.previewImageUrl || !item.modelUrl) return undefined;
    let active = true;
    const req = requestGlbThumbnail(resolveFetchableModelUrl(item.modelUrl));
    req.promise.then((dataUrl) => {
      if (active && dataUrl) setGlbThumb(dataUrl);
    });
    return () => {
      active = false;
      req.cancel();
    };
  }, [item]);

  if (item?.previewImageUrl) {
    return (
      <img
        src={item.previewImageUrl}
        alt={item.title}
        className="catalog-card-thumb-img is-emoji"
        loading="lazy"
      />
    );
  }
  if (glbThumb) {
    return (
      <img
        src={glbThumb}
        alt={item.title}
        className="catalog-card-thumb-img is-glb"
      />
    );
  }
  return (
    <div className="catalog-card-thumb-placeholder" aria-hidden="true">
      <XeroIcon emoji={meta.emoji} size={28} />
      <span className="mono">.GLB</span>
    </div>
  );
}

/**
 * Reusable "Search to Add" box querying:
 * - maximusmaximus/simready-pile (SimReady 3D GLBs)
 * - maximusmaximus/pixels (6,194 Pixel Art Atlas 3D GLBs)
 * - maximusmaximus/xeroemoji-pile (Top 500 3D extruded Xero Emojis)
 *
 * Allows picking and placing ONE item at a time with live previews.
 */
export default function Catalog3DSearchBox({
  title = 'Search to Add',
  subtitle = 'Search SimReady 3D props, Pixel Art Atlas models & 3D Xero Emojis — pick and place one at a time',
  actionLabel = '+ Place on Land',
  busy = false,
  disabled = false,
  disabledReason = '',
  limit = 6,
  compact = false,
  onPlaceItem,
  onSelectItem = null
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [items, setItems] = useState([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [placingId, setPlacingId] = useState('');
  const reqSeqRef = useRef(0);

  useEffect(() => {
    const seq = ++reqSeqRef.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const res = await api.searchCatalog({
          q: query.trim(),
          source,
          limit
        });
        if (reqSeqRef.current !== seq) return;
        const list = Array.isArray(res?.items) ? res.items : [];
        setItems(list);
        setTotalMatches(Number(res?.totalMatches || list.length));
        setSelectedId((prev) => (list.some((it) => it.id === prev) ? prev : ''));
      } catch (err) {
        if (reqSeqRef.current !== seq) return;
        setError(err?.message || 'Could not search 3D item catalog.');
        setItems([]);
      } finally {
        if (reqSeqRef.current === seq) setLoading(false);
      }
    }, query.trim() ? 180 : 0);

    return () => clearTimeout(timer);
  }, [query, source, limit]);

  const selectedItem = items.find((it) => it.id === selectedId) || null;
  const isActionBusy = Boolean(busy || placingId);

  const handleSelectCard = (item) => {
    if (isActionBusy) return;
    setSelectedId((prev) => {
      const next = prev === item.id ? '' : item.id;
      if (next && onSelectItem) onSelectItem(item);
      return next;
    });
  };

  const handlePlaceSelected = async (targetItem) => {
    const item = targetItem || selectedItem;
    if (!item || isActionBusy || disabled) return;
    setPlacingId(item.id);
    try {
      await onPlaceItem?.({
        ...item,
        modelUrl: resolveFetchableModelUrl(item.modelUrl)
      });
      setSelectedId('');
    } finally {
      setPlacingId('');
    }
  };

  return (
    <section
      className={`catalog-search-box ${compact ? 'is-compact' : ''}`}
      data-testid="catalog-search-box"
      aria-label={title}
    >
      <div className="catalog-search-head">
        <div className="catalog-search-title-group">
          <strong className="catalog-search-title">
            <XeroIcon emoji="🔍" size={15} />
            <span>{title}</span>
            <InfoTip title="3D Item Search Libraries">
              Search 9,000+ ready-to-place 3D models &amp; emojis across three open libraries:{' '}
              <strong>SimReady Pile</strong> (<code>maximusmaximus/simready-pile</code>),{' '}
              <strong>Pixels Atlas</strong> (<code>maximusmaximus/pixels</code>), and{' '}
              <strong>XeroEmoji Pile</strong> (<code>maximusmaximus/xeroemoji-pile</code>). Pick one
              preview at a time to place directly on your land or into Mobile AR.
            </InfoTip>
          </strong>
          {!compact && <span className="catalog-search-sub">{subtitle}</span>}
        </div>
        {totalMatches > 0 && (
          <span className="badge mono" style={{ fontSize: 10 }}>
            {query.trim()
              ? `${totalMatches.toLocaleString()} match${totalMatches === 1 ? '' : 'es'}`
              : `${totalMatches.toLocaleString()} items`}
          </span>
        )}
      </div>

      <div className="catalog-search-controls">
        <div className="catalog-search-input-wrap">
          <input
            type="search"
            className="input catalog-search-input"
            data-testid="catalog-search-input"
            aria-label="Search 3D items to add"
            placeholder="Search cactus, chair, guitar, dragon, fire, pizza..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="catalog-search-clear-btn"
              aria-label="Clear search query"
              onClick={() => setQuery('')}
            >
              ✕
            </button>
          )}
        </div>
        <div className="catalog-source-pills" role="tablist" aria-label="Filter 3D asset library">
          {SOURCE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={source === tab.id}
              data-testid={`catalog-source-tab-${tab.id}`}
              className={`btn btn-xs catalog-source-pill ${source === tab.id ? 'btn-primary' : ''}`}
              onClick={() => setSource(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="status-banner status-banner-error" role="alert" style={{ fontSize: 11.5 }}>
          ⚠️ {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="catalog-search-empty" role="status">
          ⏳ Searching SimReady, Pixels &amp; XeroEmoji libraries…
        </div>
      ) : items.length === 0 ? (
        <div className="catalog-search-empty" role="status">
          No matching 3D items found for &ldquo;{query}&rdquo;. Try another keyword like{' '}
          <code>chair</code>, <code>cactus</code>, <code>guitar</code>, or <code>fire</code>.
        </div>
      ) : (
        <div
          className="catalog-results-grid"
          data-testid="catalog-results-grid"
          role="listbox"
          aria-label="Matching 3D catalog items"
        >
          {items.map((item) => {
            const isSelected = selectedId === item.id;
            const meta = SOURCE_META[item.source] || SOURCE_META.simready;
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-testid={`catalog-item-card-${item.id}`}
                data-catalog-source={item.source}
                className={`catalog-item-card ${isSelected ? 'is-selected' : ''}`}
                disabled={isActionBusy}
                onClick={() => handleSelectCard(item)}
                title={`${item.title} · ${item.sourceName}`}
              >
                <div className="catalog-item-thumb-stage">
                  <CatalogItemThumb item={item} />
                  <span
                    className={`catalog-source-chip is-${item.source}`}
                    style={{ borderColor: meta.accent }}
                  >
                    {meta.badge}
                  </span>
                  {isSelected && <span className="catalog-selected-check">✓</span>}
                </div>
                <div className="catalog-item-card-name">{item.title}</div>
              </button>
            );
          })}
        </div>
      )}

      {selectedItem && (
        <div className="catalog-selected-footer" data-testid="catalog-selected-bar">
          <div className="catalog-selected-meta">
            <strong>{selectedItem.title}</strong>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
              {selectedItem.sourceName} · .GLB
            </span>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            data-testid="catalog-place-selected-btn"
            disabled={isActionBusy || disabled}
            title={disabled && disabledReason ? disabledReason : `Place ${selectedItem.title}`}
            onClick={() => handlePlaceSelected(selectedItem)}
          >
            {placingId === selectedItem.id ? '⏳ Placing…' : actionLabel}
          </button>
        </div>
      )}
    </section>
  );
}
