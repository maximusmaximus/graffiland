/**
 * Shared public identity helpers.
 * Enforces the platform rule: human users are ALWAYS displayed by their chosen
 * `@username` (never by raw Google first/last name) and custom profile icon
 * (never raw Gmail / Google avatar URLs).
 */

export function isRawGoogleAvatarUrl(url) {
  const s = String(url || '').trim().toLowerCase();
  if (!s) return false;
  return (
    s.includes('googleusercontent.com') ||
    s.includes('lh3.google.com') ||
    s.includes('lh4.google.com') ||
    s.includes('lh5.google.com') ||
    s.includes('lh6.google.com')
  );
}

/**
 * Returns only safe, user-chosen avatar URLs/data-URIs (never raw Gmail photos).
 * @param {any} input
 * @returns {string}
 */
export function resolveSafeUserAvatar(input) {
  if (!input) return '';
  if (typeof input === 'string') {
    const clean = input.trim();
    if (!clean || isRawGoogleAvatarUrl(clean)) return '';
    return clean;
  }
  const candidates = [
    input.avatarImage,
    input.avatar_image,
    input.creatorAvatar,
    input.creator_avatar,
    input.stewardAvatar,
    input.steward_avatar,
    input.editorAvatar,
    input.editor_avatar,
    input.sellerAvatar,
    input.seller_avatar,
    input.senderAvatar,
    input.sender_avatar,
    input.picture
  ];
  for (const raw of candidates) {
    const clean = String(raw || '').trim();
    if (clean && !isRawGoogleAvatarUrl(clean)) {
      return clean;
    }
  }
  return '';
}

function normalizeHandleToken(raw) {
  const clean = String(raw || '').trim().replace(/^@+/, '');
  if (!clean) return '';
  // Reject values with spaces or quotes — valid SPRAY.LAND usernames are 3-24 chars [a-z0-9_]
  if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(clean)) return '';
  return clean;
}

/**
 * Detects whether a user record or sub represents an AI agent account.
 * @param {any} input
 * @returns {boolean}
 */
export function isAgentAccount(input) {
  if (!input || typeof input !== 'object') return false;
  if (input.isAgent === true) return true;
  if (String(input.accountType || input.stewardType || input.editorRole || '').toLowerCase() === 'agent') {
    return true;
  }
  const sub = String(
    input.id ||
      input.userId ||
      input.creatorSub ||
      input.creator_sub ||
      input.stewardSub ||
      input.steward_sub ||
      input.ownerSub ||
      input.editorSub ||
      input.editor_sub ||
      input.sellerSub ||
      input.seller_sub ||
      input.senderSub ||
      input.sender_sub ||
      ''
  ).trim();
  return sub.startsWith('agent:');
}

/**
 * Resolves the safe public display handle for any user or agent across UI and APIs.
 * NEVER returns a human user's Google first/last name.
 * @param {any} input
 * @param {{ fallback?: string, includeAt?: boolean }} [options]
 * @returns {string}
 */
export function resolvePublicUserHandle(input, { fallback = 'Creator', includeAt = true } = {}) {
  const cleanFallback = String(fallback || 'Creator').trim() || 'Creator';
  if (!input) return cleanFallback;

  if (typeof input === 'string') {
    const raw = input.trim();
    if (!raw) return cleanFallback;
    if (raw.startsWith('@')) {
      const token = normalizeHandleToken(raw);
      if (token) return includeAt ? `@${token}` : token;
    }
    return cleanFallback;
  }

  const rawUsername =
    input.username ||
    input.creatorUsername ||
    input.creator_username ||
    input.stewardUsername ||
    input.steward_username ||
    input.editorUsername ||
    input.editor_username ||
    input.sellerUsername ||
    input.seller_username ||
    input.senderUsername ||
    input.sender_username ||
    '';
  const cleanUsername = normalizeHandleToken(rawUsername);
  if (cleanUsername) {
    return includeAt ? `@${cleanUsername}` : cleanUsername;
  }

  // If a stored legacy string already starts with `@handle`, honor that handle cleanly
  const storedNameCandidates = [
    input.creatorName,
    input.creator_name,
    input.stewardName,
    input.steward_name,
    input.editorName,
    input.editor_name,
    input.sellerName,
    input.seller_name,
    input.authorName,
    input.displayName,
    input.name
  ];
  for (const cand of storedNameCandidates) {
    const str = String(cand || '').trim();
    if (str.startsWith('@')) {
      const token = normalizeHandleToken(str);
      if (token) return includeAt ? `@${token}` : token;
    }
  }

  // AI agents may display their registered agent name
  if (isAgentAccount(input)) {
    for (const cand of storedNameCandidates) {
      const str = String(cand || '').trim();
      if (str) return str;
    }
    return 'AI Agent';
  }

  // Human without username set yet: show member number if known, never Google first/last name
  const userNumber = Number(input.userNumber || input.user_number || 0);
  if (Number.isFinite(userNumber) && userNumber > 0) {
    return `Creator #${Math.floor(userNumber)}`;
  }
  return cleanFallback;
}

/**
 * Extracts bare username (without `@`) when known, else empty string.
 * @param {any} input
 * @returns {string}
 */
export function extractPublicUsername(input) {
  if (!input) return '';
  if (typeof input === 'string') {
    const raw = input.trim();
    return raw.startsWith('@') ? normalizeHandleToken(raw) : normalizeHandleToken(raw);
  }
  const direct = normalizeHandleToken(
    input.username ||
      input.creatorUsername ||
      input.creator_username ||
      input.stewardUsername ||
      input.steward_username ||
      input.editorUsername ||
      input.editor_username ||
      input.sellerUsername ||
      input.seller_username ||
      input.senderUsername ||
      input.sender_username ||
      ''
  );
  if (direct) return direct;
  const legacy = [
    input.creatorName,
    input.stewardName,
    input.editorName,
    input.sellerName,
    input.authorName
  ];
  for (const cand of legacy) {
    const s = String(cand || '').trim();
    if (s.startsWith('@')) {
      const tok = normalizeHandleToken(s);
      if (tok) return tok;
    }
  }
  return '';
}

/**
 * Resolves the safe author handle to persist in DB / E2EE payloads on write.
 * Never persists a human's Google first/last name.
 * @param {any} user
 * @param {string} [fallback]
 * @returns {string}
 */
export function resolveAuthorHandleForStorage(user, fallback = 'Creator') {
  return resolvePublicUserHandle(user, { fallback, includeAt: true });
}
