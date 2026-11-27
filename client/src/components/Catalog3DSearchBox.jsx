import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, API_BASE } from '../utils/api.js';
import { requestGlbThumbnail } from '../utils/catalogThumbnailRenderer.js';
import InfoTip from './InfoTip.jsx';
import XeroIcon from './XeroIcon.jsx';

const SOURCE_TABS = [
  { id: 'all', label: 'All (10k+)' },
  { id: 'simready', label: 'SimReady' },
  { id: 'pixels', label: 'Pixels' },
  { id: 'xeroemoji', label: 'XeroEmoji' }
];

const SOURCE_META = {
  simready: { badge: 'SimReady', emoji: '📦', accent: '#00f5d4' },
  pixels: { badge: 'Pixels', emoji: '🕹️', accent: '#a855f7' },
  xeroemoji: { badge: 'XeroEmoji', emoji: '✨', accent: '#ffd166' }
};

function makeFreshShuffleSeed() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveFetchableModelUrl(rawUrl) {
  const u = String(rawUrl || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('/') && API_BASE) {
    return `${API_BASE.replace(/\/$/, '')}${u}`;
  }
  return u;
}

function detectTouchPointer(compactProp) {
  if (compactProp) return true;
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
  } catch {
    // ignore in jsdom
  }
  return Number(window.innerWidth || 1024) <= 640;
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
 * - maximusmaximus/xeroemoji-pile (XeroEmoji 3D extruded GLBs)
 *
 * Loads 6 fresh random items each time the menu opens (or when shuffled),
 * lets desktop users scroll through them with the mouse wheel, and gives
 * mobile users a natural snap-swipe horizontal carousel counterpart.
 */
export default function Catalog3DSearchBox({
  title = 'Search to Add',
  subtitle = '6 fresh picks each load — scroll with mouse wheel or search SimReady, Pixels & XeroEmoji',
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
  const [shuffleSeed, setShuffleSeed] = useState(() => makeFreshShuffleSeed());
  const [items, setItems] = useState([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [placingId, setPlacingId] = useState('');
  const [activeSlideIdx, setActiveSlideIdx] = useState(0);
  const [scrollState, setScrollState] = useState({ canLeft: false, canRight: true });
  const reqSeqRef = useRef(0);
  const carouselRef = useRef(null);
  const isTouchMode = detectTouchPointer(compact);

  useEffect(() => {
    const seq = ++reqSeqRef.current;
    const trimmed = query.trim();
    const isBrowseRandom = !trimmed;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const res = await api.searchCatalog({
          q: trimmed,
          source,
          limit,
          random: isBrowseRandom,
          seed: isBrowseRandom ? shuffleSeed : ''
        });
        if (reqSeqRef.current !== seq) return;
        const list = Array.isArray(res?.items) ? res.items : [];
        setItems(list);
        setTotalMatches(Number(res?.totalMatches || list.length));
        setSelectedId((prev) => (list.some((it) => it.id === prev) ? prev : ''));
        setActiveSlideIdx(0);
        if (carouselRef.current) {
          carouselRef.current.scrollLeft = 0;
        }
      } catch (err) {
        if (reqSeqRef.current !== seq) return;
        setError(err?.message || 'Could not search 3D item catalog.');
        setItems([]);
      } finally {
        if (reqSeqRef.current === seq) setLoading(false);
      }
    }, trimmed ? 180 : 0);

    return () => clearTimeout(timer);
  }, [query, source, limit, shuffleSeed]);

  const syncScrollMetrics = useCallback(() => {
    const el = carouselRef.current;
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
    const left = el.scrollLeft || 0;
    setScrollState({
      canLeft: left > 4,
      canRight: maxScroll > 4 && left < maxScroll - 4
    });
    if (items.length > 1 && maxScroll > 0) {
      const ratio = Math.max(0, Math.min(1, left / maxScroll));
      setActiveSlideIdx(Math.round(ratio * (items.length - 1)));
    } else {
      setActiveSlideIdx(0);
    }
  }, [items.length]);

  // Desktop mouse wheel -> smooth horizontal scroll across the 6 catalog cards
  useEffect(() => {
    const el = carouselRef.current;
    if (!el) return undefined;

    syncScrollMetrics();

    const onWheel = (e) => {
      const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
      if (maxScroll <= 1) return;

      const scale = e.deltaMode === 1 ? 28 : e.deltaMode === 2 ? el.clientWidth * 0.8 : 1;
      const rawY = Number(e.deltaY || 0) * scale;
      const rawX = Number(e.deltaX || 0) * scale;
      const delta = Math.abs(rawY) >= Math.abs(rawX) ? rawY : rawX;
      if (!delta) return;

      const curLeft = el.scrollLeft || 0;
      const atStart = curLeft <= 1 && delta < 0;
      const atEnd = curLeft >= maxScroll - 1 && delta > 0;
      if (atStart || atEnd) return;

      e.preventDefault();
      const nextLeft = Math.max(0, Math.min(maxScroll, curLeft + delta));
      el.scrollLeft = nextLeft;
      syncScrollMetrics();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('scroll', syncScrollMetrics, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', syncScrollMetrics);
    };
  }, [items.length, syncScrollMetrics]);

  const scrollCarouselBy = (direction) => {
    const el = carouselRef.current;
    if (!el) return;
    const step = Math.max(150, Math.round((el.clientWidth || 320) * 0.72));
    const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
    const nextLeft = Math.max(0, Math.min(maxScroll, (el.scrollLeft || 0) + direction * step));
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ left: nextLeft, behavior: 'smooth' });
    } else {
      el.scrollLeft = nextLeft;
    }
    syncScrollMetrics();
  };

  const scrollToSlideIndex = (idx) => {
    const el = carouselRef.current;
    if (!el || items.length === 0) return;
    const child = el.children?.[idx];
    const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
    let targetLeft = 0;
    if (child && Number.isFinite(child.offsetLeft)) {
      targetLeft = Math.max(0, Math.min(maxScroll, child.offsetLeft - 6));
    } else if (items.length > 1) {
      targetLeft = Math.round((idx / (items.length - 1)) * maxScroll);
    }
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ left: targetLeft, behavior: 'smooth' });
    } else {
      el.scrollLeft = targetLeft;
    }
    setActiveSlideIdx(idx);
  };

  const handleShuffleFresh = () => {
    if (loading) return;
    setQuery('');
    setSelectedId('');
    setShuffleSeed(makeFreshShuffleSeed());
  };

  const selectedItem = items.find((it) => it.id === selectedId) || null;
  const isActionBusy = Boolean(busy || placingId);

  const handleSelectCard = (item, idx) => {
    if (isActionBusy) return;
    setActiveSlideIdx(idx);
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
              Search 10,000+ ready-to-place 3D models &amp; emojis across three open libraries:{' '}
              <strong>SimReady Pile</strong> (<code>maximusmaximus/simready-pile</code>),{' '}
              <strong>Pixels Atlas</strong> (<code>maximusmaximus/pixels</code>), and{' '}
              <strong>XeroEmoji Pile</strong> (<code>maximusmaximus/xeroemoji-pile</code>). Every
              time you open this menu it loads <strong>6 fresh random picks</strong> —{' '}
              {isTouchMode ? 'swipe left/right' : 'scroll with your mouse wheel'} to browse, or tap{' '}
              <strong>🎲 New 6</strong> for another batch.
            </InfoTip>
          </strong>
          {!compact && <span className="catalog-search-sub">{subtitle}</span>}
        </div>
        <div className="catalog-search-head-actions">
          <button
            type="button"
            className="btn btn-xs catalog-shuffle-btn"
            data-testid="catalog-shuffle-btn"
            disabled={loading}
            title={`Load ${limit} fresh random 3D items`}
            onClick={handleShuffleFresh}
          >
            <XeroIcon emoji="🎲" size={12} /> New {limit}
          </button>
          {totalMatches > 0 && (
            <span className="badge mono" style={{ fontSize: 10 }}>
              {query.trim()
                ? `${totalMatches.toLocaleString()} match${totalMatches === 1 ? '' : 'es'}`
                : `${totalMatches.toLocaleString()} items`}
            </span>
          )}
        </div>
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
              onClick={() => {
                setQuery('');
                setShuffleSeed(makeFreshShuffleSeed());
              }}
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
              onClick={() => {
                setSource(tab.id);
                if (!query.trim()) setShuffleSeed(makeFreshShuffleSeed());
              }}
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
          ⏳ Loading {limit} fresh 3D items from SimReady, Pixels &amp; XeroEmoji…
        </div>
      ) : items.length === 0 ? (
        <div className="catalog-search-empty" role="status">
          No matching 3D items found for &ldquo;{query}&rdquo;. Try another keyword like{' '}
          <code>chair</code>, <code>cactus</code>, <code>guitar</code>, or <code>fire</code>.
        </div>
      ) : (
        <div className="catalog-carousel-shell" data-testid="catalog-carousel-shell">
          {!isTouchMode && items.length > 2 && (
            <button
              type="button"
              className={`catalog-carousel-nav is-prev ${scrollState.canLeft ? '' : 'is-dim'}`}
              data-testid="catalog-scroll-prev"
              aria-label="Scroll 3D items left"
              title="Scroll left (or use mouse wheel)"
              onClick={() => scrollCarouselBy(-1)}
            >
              ‹
            </button>
          )}
          <div
            ref={carouselRef}
            className={`catalog-results-grid catalog-results-carousel ${
              isTouchMode ? 'is-touch-swipe' : 'is-wheel-scroll'
            }`}
            data-testid="catalog-results-grid"
            data-carousel-mode={isTouchMode ? 'swipe' : 'wheel'}
            role="listbox"
            aria-label="Matching 3D catalog items"
          >
            {items.map((item, idx) => {
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
                  onClick={() => handleSelectCard(item, idx)}
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
          {!isTouchMode && items.length > 2 && (
            <button
              type="button"
              className={`catalog-carousel-nav is-next ${scrollState.canRight ? '' : 'is-dim'}`}
              data-testid="catalog-scroll-next"
              aria-label="Scroll 3D items right"
              title="Scroll right (or use mouse wheel)"
              onClick={() => scrollCarouselBy(1)}
            >
              ›
            </button>
          )}
        </div>
      )}

      {items.length > 1 && (
        <div className="catalog-carousel-footer" data-testid="catalog-carousel-footer">
          <span className="catalog-carousel-hint" data-testid="catalog-carousel-hint">
            {isTouchMode ? (
              <>
                <XeroIcon emoji="👆" size={12} /> Swipe left/right to browse ({items.length})
              </>
            ) : (
              <>
                <XeroIcon emoji="🖱️" size={12} /> Scroll mouse wheel to browse ({items.length})
              </>
            )}
          </span>
          <div className="catalog-carousel-dots" role="group" aria-label="Jump to catalog item">
            {items.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                className={`catalog-carousel-dot ${idx === activeSlideIdx ? 'is-active' : ''}`}
                aria-label={`Show item ${idx + 1} of ${items.length}: ${item.title}`}
                aria-current={idx === activeSlideIdx ? 'true' : undefined}
                onClick={() => scrollToSlideIndex(idx)}
              />
            ))}
          </div>
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
