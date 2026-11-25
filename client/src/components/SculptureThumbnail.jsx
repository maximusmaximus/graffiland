import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  getCachedSculptureThumbnail,
  getSculptureThumbnailSignature,
  projectVoxelsToIsoCubes,
  renderSculptureThumbnail,
  resolveDirectPreviewUrl
} from '../utils/sculptureThumbnailRenderer.js';

export default function SculptureThumbnail({ sculpture, badgeLabel = '' }) {
  const directUrl = resolveDirectPreviewUrl(sculpture);
  const sig = getSculptureThumbnailSignature(sculpture);
  const [thumbUrl, setThumbUrl] = useState(() => getCachedSculptureThumbnail(sculpture));
  const [isVisible, setIsVisible] = useState(
    () => typeof IntersectionObserver !== 'function'
  );
  const hostRef = useRef(null);

  useEffect(() => {
    const cached = getCachedSculptureThumbnail(sculpture);
    setThumbUrl(cached);
  }, [sig, directUrl, sculpture]);

  useEffect(() => {
    if (isVisible || directUrl || thumbUrl) return undefined;
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
      { rootMargin: '120px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [isVisible, directUrl, thumbUrl]);

  useEffect(() => {
    if (!isVisible || directUrl || thumbUrl || !sculpture) return undefined;
    let cancelled = false;
    renderSculptureThumbnail(sculpture).then((url) => {
      if (!cancelled && url) {
        setThumbUrl(url);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isVisible, directUrl, thumbUrl, sig, sculpture]);

  const isoCubes = useMemo(() => {
    if (thumbUrl || sculpture?.modelType === 'custom-3d') return [];
    if (!Array.isArray(sculpture?.voxels) || sculpture.voxels.length === 0) return [];
    return projectVoxelsToIsoCubes(sculpture.voxels, { width: 160, height: 120, maxCubes: 160 });
  }, [thumbUrl, sculpture]);

  const formatTag =
    badgeLabel ||
    (sculpture?.modelType === 'custom-3d'
      ? String(sculpture?.customModel?.format || '3D').toUpperCase()
      : `${sculpture?.voxelCount || sculpture?.voxels?.length || 0} blk`);

  const title = sculpture?.title || 'Sculpture';

  return (
    <div
      ref={hostRef}
      className="gallery-thumb-frame"
      data-testid="gallery-sculpture-thumb"
      data-thumb-kind={
        thumbUrl ? 'image' : isoCubes.length > 0 ? 'voxel-iso' : 'model-placeholder'
      }
    >
      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt={`Preview of ${title}`}
          className="gallery-thumb-img"
          loading="lazy"
          decoding="async"
        />
      ) : isoCubes.length > 0 ? (
        <svg
          className="gallery-thumb-svg"
          viewBox="0 0 160 120"
          role="img"
          aria-label={`Preview of ${title}`}
        >
          <defs>
            <radialGradient id={`gThumbBg-${sculpture?.id || 'v'}`} cx="50%" cy="48%" r="62%">
              <stop offset="0%" stopColor="rgba(0, 245, 212, 0.14)" />
              <stop offset="100%" stopColor="rgba(8, 13, 24, 0)" />
            </radialGradient>
          </defs>
          <rect width="160" height="120" fill={`url(#gThumbBg-${sculpture?.id || 'v'})`} />
          {isoCubes.map((cube, idx) => (
            <g key={idx}>
              <polygon points={cube.left} fill={cube.leftFill} />
              <polygon points={cube.right} fill={cube.rightFill} />
              <polygon points={cube.top} fill={cube.topFill} />
            </g>
          ))}
        </svg>
      ) : (
        <svg
          className="gallery-thumb-svg"
          viewBox="0 0 160 120"
          role="img"
          aria-label={`Preview of ${title}`}
        >
          <polygon
            points="80,22 114,40 80,58 46,40"
            fill="rgba(0, 245, 212, 0.16)"
            stroke="#00f5d4"
            strokeWidth="1.6"
          />
          <polygon
            points="46,40 80,58 80,94 46,76"
            fill="rgba(0, 187, 249, 0.12)"
            stroke="#00bbf9"
            strokeWidth="1.4"
          />
          <polygon
            points="114,40 80,58 80,94 114,76"
            fill="rgba(255, 62, 127, 0.14)"
            stroke="#ff3e7f"
            strokeWidth="1.4"
          />
        </svg>
      )}
      <span className="gallery-thumb-badge mono">{formatTag}</span>
    </div>
  );
}
