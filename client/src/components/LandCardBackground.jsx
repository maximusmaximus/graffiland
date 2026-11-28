import React, { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeLandOgImageMode } from '../../../shared/landOgImage.mjs';
import {
  buildLandLowAngleSvgDataUrl,
  getCachedLandPreview,
  getLandPreviewSignature,
  renderLandIsometricPreview
} from '../utils/landPreviewRenderer.js';
import BrandLogo from './BrandLogo.jsx';

/**
 * Full-bleed low-angle isometric land preview rendered as the background card image for
 * each Virtual Land in the Land tab (respecting custom image & logo-only owner settings).
 */
export default function LandCardBackground({ land, sculptures = null, className = '' }) {
  const ogMode = normalizeLandOgImageMode(
    land?.ogImageMode ?? land?.settings?.ogImageMode ?? 'auto'
  );
  const customImageUrl = String(
    land?.ogCustomImageUrl ?? land?.settings?.ogCustomImageUrl ?? ''
  ).trim();
  const sig = useMemo(
    () => getLandPreviewSignature(land, sculptures, { width: 560, height: 315 }),
    [land, sculptures]
  );

  const fallbackSvg = useMemo(
    () => (ogMode === 'auto' ? buildLandLowAngleSvgDataUrl(land, sculptures) : ''),
    [land, sculptures, ogMode]
  );

  const [renderedUrl, setRenderedUrl] = useState(() =>
    ogMode === 'auto'
      ? getCachedLandPreview(land, sculptures, { width: 560, height: 315 })
      : ''
  );
  const [isVisible, setIsVisible] = useState(() => typeof IntersectionObserver !== 'function');
  const hostRef = useRef(null);

  useEffect(() => {
    if (ogMode !== 'auto') {
      setRenderedUrl('');
      return;
    }
    setRenderedUrl(getCachedLandPreview(land, sculptures, { width: 560, height: 315 }));
  }, [sig, ogMode, land, sculptures]);

  useEffect(() => {
    if (ogMode !== 'auto' || isVisible || renderedUrl) return undefined;
    const node = hostRef.current;
    if (!node || typeof IntersectionObserver !== 'function') {
      setIsVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '180px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ogMode, isVisible, renderedUrl]);

  useEffect(() => {
    if (ogMode !== 'auto' || !isVisible || renderedUrl || !land) return undefined;
    let cancelled = false;
    renderLandIsometricPreview(land, sculptures, { width: 560, height: 315 }).then((url) => {
      if (!cancelled && url) setRenderedUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [ogMode, isVisible, renderedUrl, sig, land, sculptures]);

  const resolvedSrc =
    ogMode === 'custom' && customImageUrl
      ? customImageUrl
      : ogMode === 'logo'
      ? ''
      : renderedUrl || fallbackSvg;

  return (
    <div
      ref={hostRef}
      className={['desktop-land-card-bg', `is-mode-${ogMode}`, className]
        .filter(Boolean)
        .join(' ')}
      data-testid="land-card-preview-bg"
      data-preview-mode={ogMode}
      data-preview-source={
        ogMode === 'logo'
          ? 'brand-logo'
          : ogMode === 'custom' && customImageUrl
          ? 'custom'
          : renderedUrl
          ? 'webgl-low-angle-iso'
          : 'svg-low-angle-iso'
      }
      aria-hidden="true"
    >
      {ogMode === 'logo' ? (
        <div className="desktop-land-card-bg-logo-only">
          <BrandLogo variant="lockup" height={26} decorative />
        </div>
      ) : resolvedSrc ? (
        <img
          src={resolvedSrc}
          alt=""
          className="desktop-land-card-bg-img"
          loading="lazy"
          decoding="async"
        />
      ) : null}
      <div className="desktop-land-card-bg-scrim" />
    </div>
  );
}
