import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

const tipCloseHandlers = new Map();

/**
 * Close any currently unfolded or open InfoTip across the page.
 */
export function closeAllInfoTips(exceptId = '') {
  for (const [otherId, closeFn] of tipCloseHandlers.entries()) {
    if (otherId !== exceptId) closeFn();
  }
}

function findScrollParent(el) {
  if (!el || typeof window === 'undefined') return null;
  let cur = el.parentElement;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    try {
      const style = window.getComputedStyle(cur);
      const oy = style.overflowY || style.overflow || '';
      if (/(auto|scroll|overlay)/.test(oy) && cur.scrollHeight > cur.clientHeight + 4) {
        return cur;
      }
    } catch {
      // ignore in restricted environments
    }
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Clickable "i" button that unfolds concise details directly underneath the item by default
 * (`mode="inline"`), never overflowing off-screen. Automatically closes when another item is
 * selected, when clicking outside, on Escape, or when the user scrolls past it.
 * Use `mode="popover"` only inside fixed single-line toolbars (with automatic viewport clamping).
 */
export default function InfoTip({
  title = 'Details',
  children,
  align = 'left',
  mode = 'inline',
  className = ''
}) {
  const [open, setOpen] = useState(false);
  const [popoverShiftX, setPopoverShiftX] = useState(0);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const wasVisibleRef = useRef(false);
  const tipId = useId();
  const isInline = mode !== 'popover';

  // Clamp toolbar popover mode strictly inside viewport bounds so it never clips off-screen
  useLayoutEffect(() => {
    if (!open || isInline || !panelRef.current || typeof window === 'undefined') {
      setPopoverShiftX(0);
      return;
    }
    const rect = panelRef.current.getBoundingClientRect();
    const vw = window.innerWidth || 0;
    if (!vw || rect.width <= 0) return;
    const margin = 10;
    let shift = 0;
    if (rect.right > vw - margin) {
      shift = vw - margin - rect.right;
    }
    if (rect.left + shift < margin) {
      shift += margin - (rect.left + shift);
    }
    setPopoverShiftX(Math.round(shift));
  }, [open, isInline]);

  useEffect(() => {
    if (!open) {
      wasVisibleRef.current = false;
      return undefined;
    }
    tipCloseHandlers.set(tipId, () => setOpen(false));

    // Use `click` (not `pointerdown`) so clicking a button/checkbox below an unfolded inline
    // InfoTip completes on its intended target before the panel collapses and shifts layout.
    const onOutsideClick = (e) => {
      const target = e.target;
      const inBtn = btnRef.current && btnRef.current.contains(target);
      const inPanel = panelRef.current && panelRef.current.contains(target);
      if (!inBtn && !inPanel) {
        setOpen(false);
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };

    const scrollParent = findScrollParent(panelRef.current || btnRef.current);
    const openScrollTop = scrollParent ? scrollParent.scrollTop : window.scrollY || 0;

    let observer = null;
    if (typeof IntersectionObserver === 'function' && panelRef.current) {
      observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (!entry) return;
          if (entry.intersectionRatio >= 0.12) {
            wasVisibleRef.current = true;
          } else if (wasVisibleRef.current && entry.intersectionRatio < 0.08) {
            setOpen(false);
          }
        },
        { root: scrollParent || null, threshold: [0, 0.08, 0.12] }
      );
      observer.observe(panelRef.current);
    }

    const onScroll = (e) => {
      const el = panelRef.current;
      if (!el) return;
      const scTarget =
        e?.target && e.target !== document && e.target !== window && e.target.getBoundingClientRect
          ? e.target
          : scrollParent;
      const rect = el.getBoundingClientRect();
      const btnRect = btnRef.current ? btnRef.current.getBoundingClientRect() : rect;
      const bounds = scTarget
        ? scTarget.getBoundingClientRect()
        : { top: 0, bottom: window.innerHeight || 800 };

      // Close when the item header or unfolded panel scrolls past the visible bounds,
      // or when the user scrolls well past (>= 140px) the point where they opened it.
      const scrolledPastTop = rect.bottom <= bounds.top + 8 || btnRect.bottom <= bounds.top + 12;
      const scrolledPastBottom = rect.top >= bounds.bottom - 8;
      const curTop = scTarget ? scTarget.scrollTop : window.scrollY || 0;
      const scrolledPastItem = Math.abs(curTop - openScrollTop) >= 140;

      if (scrolledPastTop || scrolledPastBottom || scrolledPastItem) {
        setOpen(false);
      }
    };

    document.addEventListener('click', onOutsideClick);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKeyDown);

    return () => {
      tipCloseHandlers.delete(tipId);
      observer?.disconnect();
      document.removeEventListener('click', onOutsideClick);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, tipId]);

  const toggleOpen = (e) => {
    e.stopPropagation();
    const next = !open;
    if (next) {
      closeAllInfoTips(tipId);
    }
    setOpen(next);
  };

  if (isInline) {
    return (
      <span
        className={`info-tip-wrap is-inline ${className}`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          ref={btnRef}
          type="button"
          className={`info-tip-btn ${open ? 'is-open' : ''}`}
          aria-label={`Info: ${title}`}
          aria-expanded={open}
          aria-controls={open ? tipId : undefined}
          title={title}
          onClick={toggleOpen}
        >
          i
        </button>
        {open && (
          <div
            ref={panelRef}
            id={tipId}
            role="tooltip"
            data-info-tip-mode="inline"
            className="info-tip-unfold"
          >
            <div className="info-tip-header">
              <strong>{title}</strong>
              <button
                type="button"
                className="info-tip-close"
                aria-label={`Close ${title} tooltip`}
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="info-tip-body">{children}</div>
          </div>
        )}
      </span>
    );
  }

  return (
    <span
      className={`info-tip-wrap ${className}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        ref={btnRef}
        type="button"
        className={`info-tip-btn ${open ? 'is-open' : ''}`}
        aria-label={`Info: ${title}`}
        aria-expanded={open}
        aria-controls={open ? tipId : undefined}
        title={title}
        onClick={toggleOpen}
      >
        i
      </button>
      {open && (
        <div
          ref={panelRef}
          id={tipId}
          role="tooltip"
          data-info-tip-mode="popover"
          className={`info-tip-popover align-${align}`}
          style={popoverShiftX ? { transform: `translateX(${popoverShiftX}px)` } : undefined}
        >
          <div className="info-tip-header">
            <strong>{title}</strong>
            <button
              type="button"
              className="info-tip-close"
              aria-label={`Close ${title} tooltip`}
              onClick={() => setOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className="info-tip-body">{children}</div>
        </div>
      )}
    </span>
  );
}
