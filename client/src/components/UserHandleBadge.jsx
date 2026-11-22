import React from 'react';
import {
  extractPublicUsername,
  isAgentAccount,
  resolvePublicUserHandle,
  resolveSafeUserAvatar
} from '../../../shared/userDisplay.mjs';

/**
 * Displays a user's chosen `@username` paired with their profile icon
 * (or a crisp GRAFFILAND monogram emblem when no custom icon is uploaded).
 * NEVER displays raw Google first/last names or raw Gmail profile photos.
 */
export default function UserHandleBadge({
  user = null,
  username = '',
  avatarImage = '',
  isAgent = false,
  fallback = 'Creator',
  size = 'sm', // 'xs' | 'sm' | 'md'
  className = '',
  interactive = false,
  onClick = null,
  title = ''
}) {
  const merged = user && typeof user === 'object' ? { ...user } : {};
  if (username) merged.username = username;
  if (avatarImage) merged.avatarImage = avatarImage;
  if (isAgent) merged.isAgent = true;

  const agent = isAgent || isAgentAccount(merged);
  const resolvedHandle = resolvePublicUserHandle(merged, {
    fallback: agent ? 'AI Agent' : fallback,
    includeAt: true
  });
  const bareUsername = extractPublicUsername(merged);
  const avatarSrc = resolveSafeUserAvatar(avatarImage || merged);
  const initial = String(bareUsername || resolvedHandle || (agent ? 'A' : 'G'))
    .replace(/^@+/, '')
    .slice(0, 1)
    .toUpperCase() || 'G';

  const sizeClass =
    size === 'xs' ? 'is-xs' : size === 'md' ? 'is-md' : 'is-sm';
  const combinedClass = [
    'user-handle-badge',
    sizeClass,
    agent ? 'is-agent' : '',
    onClick || interactive ? 'is-interactive' : '',
    className
  ]
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      {avatarSrc ? (
        <img
          src={avatarSrc}
          alt=""
          className="user-handle-avatar"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className="user-handle-avatar-fallback" aria-hidden="true">
          {agent ? 'AI' : initial}
        </span>
      )}
      <span className="user-handle-text">{resolvedHandle}</span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={combinedClass}
        onClick={onClick}
        title={title || `View ${resolvedHandle}'s profile`}
        data-testid="user-handle-badge"
      >
        {content}
      </button>
    );
  }

  return (
    <span
      className={combinedClass}
      title={title || resolvedHandle}
      data-testid="user-handle-badge"
    >
      {content}
    </span>
  );
}
