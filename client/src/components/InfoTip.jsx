import React, { useEffect, useId, useRef, useState } from 'react';

const tipCloseHandlers = new Map();

/**
 * Compact clickable "i" button that toggles an inline tooltip popover on demand,
 * keeping primary UI copy crisp and scannable.
 */
export default function InfoTip({
  title = 'Details',
  children,
  align = 'left',
  className = ''
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const tipId = useId();

  useEffect(() => {
    if (!open) return undefined;
    tipCloseHandlers.set(tipId, () => setOpen(false));
    const onPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      tipCloseHandlers.delete(tipId);
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, tipId]);

  return (
    <span
      ref={rootRef}
      className={`info-tip-wrap ${className}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={`info-tip-btn ${open ? 'is-open' : ''}`}
        aria-label={`Info: ${title}`}
        aria-expanded={open}
        aria-controls={open ? tipId : undefined}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          const next = !open;
          if (next) {
            for (const [otherId, closeFn] of tipCloseHandlers.entries()) {
              if (otherId !== tipId) closeFn();
            }
          }
          setOpen(next);
        }}
      >
        i
      </button>
      {open && (
        <div
          id={tipId}
          role="tooltip"
          className={`info-tip-popover align-${align}`}
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
