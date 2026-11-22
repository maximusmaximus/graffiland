import React from 'react';
import PlotVisitView from '../PlotVisitView.jsx';

/**
 * Mobile wrapper for the unified Isometric Plot Link Showcase.
 * Preserves all existing MobileParcelVisitView props and test hooks while
 * auto-opening in 3D isometric mode with clickable Land & Side Artwork labels
 * and contextual owner/contributor management controls below.
 */
export default function MobileParcelVisitView(props) {
  return <PlotVisitView variant="mobile" {...props} />;
}
