export const USERNAME_MIN_LEN = 3;
export const USERNAME_MAX_LEN = 24;
export const BIO_MAX_LEN = 280;

export const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'agent',
  'agents',
  'api',
  'app',
  'auth',
  'graffiland',
  'help',
  'home',
  'info',
  'land',
  'lands',
  'leaderboard',
  'leaders',
  'login',
  'logout',
  'map',
  'market',
  'marketplace',
  'mcp',
  'me',
  'mod',
  'moderator',
  'official',
  'owner',
  'parcel',
  'parcels',
  'profile',
  'profiles',
  'quest',
  'quests',
  'root',
  'sculpture',
  'sculptures',
  'settings',
  'signin',
  'signup',
  'staff',
  'support',
  'system',
  'terms',
  'user',
  'users',
  'wallet'
]);

/**
 * Normalize a raw username input (strip leading @, trim, lowercase).
 * @param {string} raw
 * @returns {string}
 */
export function normalizeUsername(raw) {
  return String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

/**
 * Validate username format & reserved-word policy.
 * Allowed: 3-24 chars, lowercase letters/digits, optional _ or - inside,
 * must start and end with a letter or digit, no consecutive __ or --.
 * @param {string} raw
 * @returns {{ ok: boolean, username: string, error: string }}
 */
export function validateUsername(raw) {
  const username = normalizeUsername(raw);
  if (!username) {
    return { ok: false, username: '', error: 'Username is required.' };
  }
  if (username.length < USERNAME_MIN_LEN) {
    return {
      ok: false,
      username,
      error: `Username must be at least ${USERNAME_MIN_LEN} characters.`
    };
  }
  if (username.length > USERNAME_MAX_LEN) {
    return {
      ok: false,
      username,
      error: `Username must be ${USERNAME_MAX_LEN} characters or fewer.`
    };
  }
  if (!/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(username)) {
    return {
      ok: false,
      username,
      error:
        'Use letters, numbers, underscores (_) or hyphens (-), starting and ending with a letter or number.'
    };
  }
  if (/[_-]{2,}/.test(username)) {
    return {
      ok: false,
      username,
      error: 'Avoid consecutive underscores or hyphens.'
    };
  }
  if (RESERVED_USERNAMES.has(username)) {
    return {
      ok: false,
      username,
      error: 'That username is reserved. Please choose another.'
    };
  }
  return { ok: true, username, error: '' };
}

/**
 * Validate & sanitize user bio text.
 * @param {string} raw
 * @returns {{ ok: boolean, bio: string, error: string }}
 */
export function validateBio(raw) {
  const bio = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (bio.length > BIO_MAX_LEN) {
    return {
      ok: false,
      bio,
      error: `Bio must be ${BIO_MAX_LEN} characters or fewer (${bio.length}/${BIO_MAX_LEN}).`
    };
  }
  return { ok: true, bio, error: '' };
}

/**
 * Generate a clean, valid initial username suggestion from a Google display name or email.
 * @param {string} [name]
 * @param {string} [email]
 * @returns {string}
 */
export function suggestUsernameFromName(name = '', email = '') {
  const source = String(name || '').trim() || String(email || '').split('@')[0] || 'artist';
  let slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .replace(/[_-]{2,}/g, '_')
    .slice(0, 20);
  if (slug.length < USERNAME_MIN_LEN) {
    slug = `${slug || 'creator'}_art`.slice(0, 20);
  }
  if (RESERVED_USERNAMES.has(slug)) {
    slug = `${slug}_irl`.slice(0, USERNAME_MAX_LEN);
  }
  return slug;
}

/**
 * Build a shareable public profile URL (`?u=<username>`).
 * @param {{ origin?: string, pathname?: string, username: string }} options
 * @returns {string}
 */
export function buildPublicProfileUrl({ origin = '', pathname = '/', username = '' } = {}) {
  const handle = normalizeUsername(username);
  if (!handle) return '';
  const cleanPath = pathname && pathname.startsWith('/') ? pathname : `/${pathname || ''}`;
  const query = `?u=${encodeURIComponent(handle)}`;
  if (!origin) return `${cleanPath}${query}`;
  return `${origin.replace(/\/+$/, '')}${cleanPath}${query}`;
}

/**
 * Extract a requested public profile handle from URL query params (`?u=` or `?profile=`).
 * @param {string} search
 * @returns {string}
 */
export function parseProfileParamFromLocation(search = '') {
  try {
    const sp = new URLSearchParams(String(search || ''));
    const raw = sp.get('u') || sp.get('profile') || '';
    return String(raw).trim().replace(/^@+/, '');
  } catch {
    return '';
  }
}
