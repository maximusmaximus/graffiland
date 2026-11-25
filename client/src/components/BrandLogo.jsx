import React from 'react';
import lockupLightTransparent from '../../../brand/svg/sprayland-lockup-light-transparent.svg';
import lockupStackedLightTransparent from '../../../brand/svg/sprayland-lockup-stacked-light-transparent.svg';
import lockupStackedTransparent from '../../../brand/svg/sprayland-lockup-stacked-transparent.svg';
import lockupTransparent from '../../../brand/svg/sprayland-lockup-transparent.svg';
import markSmallTransparent from '../../../brand/svg/sprayland-mark-small-transparent.svg';
import markTransparent from '../../../brand/svg/sprayland-mark-transparent.svg';
import wordmarkNavyTransparent from '../../../brand/svg/sprayland-wordmark-navy-transparent.svg';
import wordmarkWhiteTransparent from '../../../brand/svg/sprayland-wordmark-white-transparent.svg';

/**
 * Official SPRAY.LAND Brand Kit component (Voxel Spray Can mark + Audiowide logotype).
 * Follows brand/BRAND.md sizing rules:
 * - At <= 48px mark sizes, automatically uses the simplified small-size Voxel Spray Can mark.
 * - Preserves exact SVG aspect ratios and outlined vector paths without recolouring or stretching.
 */
export default function BrandLogo({
  variant = 'lockup', // 'lockup' | 'stacked' | 'mark' | 'wordmark'
  tone = 'dark', // 'dark' (white wordmark on dark UI) | 'light' (navy wordmark on light UI)
  height = null,
  size = null,
  alt = 'SPRAY.LAND',
  decorative = false,
  className = '',
  style = undefined
}) {
  const isLight = tone === 'light';
  const resolvedHeight =
    Number(height ?? size) ||
    (variant === 'stacked' ? 88 : variant === 'mark' ? 28 : variant === 'wordmark' ? 18 : 34);

  let src = lockupTransparent;
  let testVariant = variant;

  if (variant === 'stacked') {
    src = isLight ? lockupStackedLightTransparent : lockupStackedTransparent;
  } else if (variant === 'mark') {
    // BRAND.md: at 48 px and below use the simplified small-size Voxel Spray Can mark
    src = resolvedHeight <= 48 ? markSmallTransparent : markTransparent;
    testVariant = resolvedHeight <= 48 ? 'mark-small' : 'mark';
  } else if (variant === 'wordmark') {
    src = isLight ? wordmarkNavyTransparent : wordmarkWhiteTransparent;
  } else {
    src = isLight ? lockupLightTransparent : lockupTransparent;
  }

  return (
    <img
      src={src}
      alt={decorative ? '' : alt}
      aria-hidden={decorative ? 'true' : undefined}
      draggable={false}
      data-testid={`brand-logo-${variant}`}
      data-brand-asset={testVariant}
      className={['brand-logo', `is-${variant}`, className].filter(Boolean).join(' ')}
      style={{
        height: resolvedHeight,
        width: variant === 'mark' ? resolvedHeight : 'auto',
        ...style
      }}
    />
  );
}
