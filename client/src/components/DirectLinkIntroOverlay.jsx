import React, { useEffect, useRef } from 'react';

export const DIRECT_LINK_INTRO_COPY =
  'You can see virtual art right here. You can also make your own virtual art while minting land to preserve it forever. Sign in for free to save your art, own your land, and keep everything in your account.';

export default function DirectLinkIntroOverlay({ onClose, onSignIn = null }) {
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
      className="direct-link-intro-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="direct-link-intro-title"
      data-testid="direct-link-intro-backdrop"
      onPointerDown={(e) => {
        startedInsideCardRef.current = e.target !== e.currentTarget;
      }}
      onClick={handleBackdropClick}
    >
      <div
        className="direct-link-intro-card"
        data-testid="direct-link-intro-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="direct-link-intro-header">
          <h2 id="direct-link-intro-title" className="direct-link-intro-title">
            Welcome to SPRAY.LAND
          </h2>
          <button
            type="button"
            className="direct-link-intro-close-box"
            aria-label="Close intro"
            title="Close"
            data-testid="direct-link-intro-close-btn"
            onClick={() => onClose?.()}
          >
            ✕
          </button>
        </div>

        <p className="direct-link-intro-copy" data-testid="direct-link-intro-text">
          {DIRECT_LINK_INTRO_COPY}
        </p>

        {typeof onSignIn === 'function' && (
          <div className="direct-link-intro-actions">
            <button
              type="button"
              className="btn btn-primary direct-link-intro-signin-btn"
              data-testid="direct-link-intro-signin-btn"
              onClick={() => onSignIn()}
            >
              Sign In
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
