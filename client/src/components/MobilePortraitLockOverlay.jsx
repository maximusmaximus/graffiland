import React from 'react';

/**
 * Full-screen portrait-only guard shown on mobile browsers that cannot enforce
 * `screen.orientation.lock('portrait-primary')` when the user tilts the phone sideways.
 */
export default function MobilePortraitLockOverlay() {
  return (
    <div
      className="mobile-portrait-lock-overlay"
      data-testid="mobile-portrait-lock-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Portrait mode required"
    >
      <div className="mobile-portrait-lock-card">
        <div className="mobile-portrait-phone-glyph" aria-hidden="true">
          <span className="mobile-portrait-phone-notch" />
          <span className="mobile-portrait-phone-bar" />
        </div>
        <h2 className="mobile-portrait-lock-title">Hold Phone Upright</h2>
        <p className="mobile-portrait-lock-copy">
          SPRAY.LAND stays locked to Portrait mode.
        </p>
      </div>
    </div>
  );
}
