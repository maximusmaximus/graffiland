import React, { useEffect, useRef } from 'react';
import XeroIcon from '../XeroIcon.jsx';

/**
 * First-time interactive popup explaining how to use the fluid 3D Paint Brush
 * by holding and sweeping the phone like a spray can.
 */
export default function SprayBrushIntroModal({ onClose }) {
  const startedInsideCardRef = useRef(false);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget && !startedInsideCardRef.current) {
      onClose?.();
    }
    startedInsideCardRef.current = false;
  }

  return (
    <div
      className="spray-guide-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="spray-brush-guide-title"
      data-testid="spray-brush-guide-backdrop"
      onPointerDown={(e) => {
        startedInsideCardRef.current = e.target !== e.currentTarget;
      }}
      onClick={handleBackdropClick}
    >
      <div
        className="spray-guide-card"
        data-testid="spray-brush-guide-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="spray-guide-header">
          <h2 id="spray-brush-guide-title" className="spray-guide-title">
            <XeroIcon emoji="🖌️" size={20} /> Spray Paint in 3D
          </h2>
          <button
            type="button"
            className="direct-link-intro-close-box"
            aria-label="Close brush guide"
            title="Close"
            data-testid="spray-brush-guide-close-btn"
            onClick={() => onClose?.()}
          >
            ✕
          </button>
        </div>

        <p className="spray-guide-lead">
          Use your phone just like a real spray can to paint smooth lines in the air.
        </p>

        <div className="spray-guide-steps">
          <div className="spray-guide-step">
            <span className="spray-guide-step-icon" aria-hidden="true">
              <XeroIcon emoji="👆" size={16} />
            </span>
            <div>
              <strong>Hold to spray</strong>
              <p>Press and hold the Brush button (or hold the screen) to start spraying.</p>
            </div>
          </div>

          <div className="spray-guide-step">
            <span className="spray-guide-step-icon" aria-hidden="true">
              <XeroIcon emoji="📱" size={16} />
            </span>
            <div>
              <strong>Move your phone</strong>
              <p>Sweep your phone up, down, or sideways — your paint flows smoothly with your hand.</p>
            </div>
          </div>

          <div className="spray-guide-step">
            <span className="spray-guide-step-icon" aria-hidden="true">
              <XeroIcon emoji="🎨" size={16} />
            </span>
            <div>
              <strong>Let go to stop</strong>
              <p>Lift your thumb anytime, and tap the 🎨 dock for colors, size, Pencil, or Eraser.</p>
            </div>
          </div>
        </div>

        <button
          type="button"
          className="btn btn-primary spray-guide-start-btn"
          data-testid="spray-brush-guide-start-btn"
          onClick={() => onClose?.()}
        >
          Start Spraying
        </button>
      </div>
    </div>
  );
}
