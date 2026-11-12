import React, { useState } from 'react';
import xeroemoji from 'xeroemoji';

const lookupCache = new Map();

function resolveXeroEmoji(emoji) {
  if (!emoji) return null;
  if (lookupCache.has(emoji)) return lookupCache.get(emoji);
  const res = xeroemoji.get(emoji) || null;
  lookupCache.set(emoji, res);
  return res;
}

export default function XeroIcon({
  emoji,
  size = 20,
  label,
  className = '',
  style = {}
}) {
  const entry = resolveXeroEmoji(emoji);
  const [mode, setMode] = useState('svg');

  if (!entry || mode === 'text') {
    return (
      <span
        className={`xero-icon ${className}`}
        role={label ? 'img' : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
        style={{ fontSize: `${Math.round(size * 0.9)}px`, lineHeight: 1, ...style }}
      >
        {emoji}
      </span>
    );
  }

  const src = mode === 'svg' ? entry.svgUrl : entry.pngUrl;

  return (
    <img
      src={src}
      alt={label || ''}
      aria-hidden={label ? undefined : true}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={`xero-icon ${className}`}
      style={{ width: size, height: size, objectFit: 'contain', ...style }}
      onError={() => {
        if (mode === 'svg' && entry.pngUrl) setMode('png');
        else setMode('text');
      }}
    />
  );
}
