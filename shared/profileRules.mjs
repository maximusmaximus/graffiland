export const USERNAME_MIN_LEN = 3;
export const USERNAME_MAX_LEN = 24;
export const BIO_MAX_LEN = 280;
export const MAX_AVATAR_DATA_URL_LEN = 300_000;
export const MAX_HEADER_DATA_URL_LEN = 620_000;
export const MAX_PROFILE_IMAGE_URL_LEN = 512;

export const PROFILE_HEADER_PRESETS = [
  {
    id: 'cyber-grid',
    token: 'preset:cyber-grid',
    label: 'Cyber Grid',
    background:
      'radial-gradient(circle at 20% 25%, rgba(0, 245, 212, 0.38), transparent 52%), radial-gradient(circle at 82% 20%, rgba(0, 187, 249, 0.34), transparent 50%), linear-gradient(135deg, #071224 0%, #0d1f3a 52%, #091426 100%)'
  },
  {
    id: 'neon-skyline',
    token: 'preset:neon-skyline',
    label: 'Neon Skyline',
    background:
      'radial-gradient(circle at 18% 28%, rgba(255, 62, 127, 0.44), transparent 52%), radial-gradient(circle at 84% 24%, rgba(0, 245, 212, 0.36), transparent 52%), linear-gradient(135deg, #160926 0%, #1d1140 50%, #091d30 100%)'
  },
  {
    id: 'sunset-voxel',
    token: 'preset:sunset-voxel',
    label: 'Sunset Voxel',
    background:
      'radial-gradient(circle at 22% 22%, rgba(255, 183, 3, 0.44), transparent 52%), radial-gradient(circle at 80% 35%, rgba(255, 77, 109, 0.42), transparent 54%), linear-gradient(135deg, #211026 0%, #341638 52%, #131126 100%)'
  },
  {
    id: 'emerald-mesh',
    token: 'preset:emerald-mesh',
    label: 'Emerald Mesh',
    background:
      'radial-gradient(circle at 24% 24%, rgba(16, 185, 129, 0.45), transparent 52%), radial-gradient(circle at 78% 70%, rgba(0, 245, 212, 0.3), transparent 55%), linear-gradient(135deg, #061b17 0%, #0a2b25 52%, #071521 100%)'
  },
  {
    id: 'gold-monolith',
    token: 'preset:gold-monolith',
    label: 'Gold Monolith',
    background:
      'radial-gradient(circle at 76% 24%, rgba(255, 209, 102, 0.42), transparent 50%), radial-gradient(circle at 18% 72%, rgba(245, 158, 11, 0.28), transparent 52%), linear-gradient(135deg, #141219 0%, #241c13 52%, #0d111d 100%)'
  },
  {
    id: 'midnight-wave',
    token: 'preset:midnight-wave',
    label: 'Midnight Wave',
    background:
      'radial-gradient(circle at 22% 28%, rgba(99, 102, 241, 0.45), transparent 52%), radial-gradient(circle at 80% 30%, rgba(56, 189, 248, 0.34), transparent 52%), linear-gradient(135deg, #090d1f 0%, #141e42 52%, #0a1428 100%)'
  }
];

const HEADER_PRESET_MAP = new Map(PROFILE_HEADER_PRESETS.map((p) => [p.token, p]));
const RASTER_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/]+=*$/;
const BLOCKED_IMAGE_HOST_RE =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1\]?|172\.(1[6-9]|2\d|3[01])\.)/i;

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
 * @param {{ origin?: string, pathname?: string, username?: string }} [options]
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

/**
 * Format a positive sequential member number cleanly (e.g. 1 -> "#0001", 42 -> "#0042", 12345 -> "#12345").
 * @param {number | string | null | undefined} num
 * @returns {string}
 */
export function formatUserNumber(num) {
  const n = Math.floor(Number(num));
  if (!Number.isFinite(n) || n <= 0) return '';
  return `#${String(n).padStart(4, '0')}`;
}

/**
 * Resolve a `preset:...` header token to its preset definition, or null if not a preset.
 * @param {string} raw
 */
export function findHeaderPreset(raw) {
  const clean = String(raw || '').trim().toLowerCase();
  if (!clean) return PROFILE_HEADER_PRESETS[0];
  return HEADER_PRESET_MAP.get(clean) || null;
}

/**
 * Validate and sanitize a user bio image (avatar) or profile header background.
 * Allows empty string (reset to default), curated `preset:<id>` tokens (header only),
 * strict base64 raster data URLs (PNG/JPEG/WebP — SVG explicitly blocked), or public HTTPS image URLs.
 * @param {string} raw
 * @param {{ kind?: 'avatar' | 'header' }} [options]
 * @returns {{ ok: boolean, value: string, format: 'none' | 'preset' | 'data-url' | 'https', error: string }}
 */
export function validateProfileImage(raw, { kind = 'avatar' } = {}) {
  const val = String(raw ?? '').trim();
  const label = kind === 'header' ? 'Profile header' : 'Bio image';

  if (!val) {
    return { ok: true, value: '', format: 'none', error: '' };
  }

  if (val.toLowerCase().startsWith('preset:')) {
    if (kind !== 'header') {
      return {
        ok: false,
        value: '',
        format: 'none',
        error: 'Presets are only available for the profile header.'
      };
    }
    const preset = HEADER_PRESET_MAP.get(val.toLowerCase());
    if (!preset) {
      return {
        ok: false,
        value: '',
        format: 'none',
        error: 'Unknown profile header background preset.'
      };
    }
    return { ok: true, value: preset.token, format: 'preset', error: '' };
  }

  if (/^data:/i.test(val)) {
    if (/^data:image\/svg/i.test(val)) {
      return {
        ok: false,
        value: '',
        format: 'none',
        error: `${label} must be PNG, JPEG, or WebP (SVG uploads are not allowed).`
      };
    }
    const maxLen = kind === 'header' ? MAX_HEADER_DATA_URL_LEN : MAX_AVATAR_DATA_URL_LEN;
    if (val.length > maxLen) {
      const kb = Math.round(maxLen / 1024);
      return {
        ok: false,
        value: '',
        format: 'none',
        error: `${label} is too large (max ~${kb} KB encoded). Try a smaller or cropped image.`
      };
    }
    if (!RASTER_DATA_URL_RE.test(val)) {
      return {
        ok: false,
        value: '',
        format: 'none',
        error: `${label} must be a valid PNG, JPEG, or WebP image.`
      };
    }
    return { ok: true, value: val, format: 'data-url', error: '' };
  }

  if (/^https:\/\//i.test(val)) {
    if (val.length > MAX_PROFILE_IMAGE_URL_LEN || /\s/.test(val)) {
      return {
        ok: false,
        value: '',
        format: 'none',
        error: `${label} URL must be a valid public HTTPS URL under ${MAX_PROFILE_IMAGE_URL_LEN} characters.`
      };
    }
    try {
      const parsed = new URL(val);
      if (parsed.protocol !== 'https:' || !parsed.hostname || BLOCKED_IMAGE_HOST_RE.test(parsed.hostname)) {
        return {
          ok: false,
          value: '',
          format: 'none',
          error: `${label} URL must point to a public HTTPS image host.`
        };
      }
      return { ok: true, value: parsed.toString(), format: 'https', error: '' };
    } catch {
      return {
        ok: false,
        value: '',
        format: 'none',
        error: `${label} URL is invalid.`
      };
    }
  }

  return {
    ok: false,
    value: '',
    format: 'none',
    error: `${label} must be an uploaded PNG/JPEG/WebP image${kind === 'header' ? ', a background preset,' : ''} or an HTTPS image URL.`
  };
}

/**
 * 10 core SPRAY.LAND features summing to exactly 100 points for the User Profile Feature Rating.
 */
export const PROFILE_FEATURE_MILESTONES = Object.freeze([
  {
    id: 'profile_setup',
    label: 'Customize Profile',
    points: 10,
    tip: 'Add a bio, custom avatar, or banner in Edit Profile.'
  },
  {
    id: 'own_land',
    label: 'Claim a Virtual Land',
    points: 10,
    tip: 'Claim or mint your first Virtual Land plot.'
  },
  {
    id: 'publish_art',
    label: 'Sculpt & Publish 3D Art',
    points: 15,
    tip: 'Paint or sculpt a 3D piece in Mobile AR and publish it.'
  },
  {
    id: 'place_3d_model',
    label: 'Place a 3D Model',
    points: 10,
    tip: 'Search & place a 3D catalog model or upload a .GLB/.OBJ.'
  },
  {
    id: 'irl_permanent',
    label: 'Awaken / IRL Land Lock',
    points: 10,
    tip: 'Visit a land in person on Mobile AR (check in or add 3+ blocks).'
  },
  {
    id: 'explore_lands',
    label: 'Explore Lands & Art',
    points: 10,
    tip: 'Explore lands on the 2D/3D Map and inspect artworks.'
  },
  {
    id: 'agent_collab',
    label: 'AI Agent Collaboration',
    points: 10,
    tip: 'Pair an AI agent (GLP-...) or let your agent add models to a land.'
  },
  {
    id: 'manage_land',
    label: 'Customize a Land',
    points: 10,
    tip: 'Name or configure a land inside Land Management.'
  },
  {
    id: 'quests_or_builder',
    label: 'Multi-Piece Builder or Quest',
    points: 10,
    tip: 'Publish 3+ artworks (or 50+ blocks) or launch a Land Quest.'
  },
  {
    id: 'market_or_share',
    label: 'Share or Trade',
    points: 5,
    tip: 'Copy/share a link or list a Land Deed on the Marketplace.'
  }
]);

/**
 * Computes a transparent 0–100 Feature Rating based on the user's real history,
 * plus exact remaining tips so they know what else to try to raise their score.
 *
 * @param {{
 *   profile?: any,
 *   stats?: any,
 *   lands?: any[],
 *   sculptures?: any[],
 *   listings?: any[],
 *   quests?: any[],
 *   actions?: any[],
 *   localActions?: any[],
 *   lastViewed?: any[]
 * }} [params]
 */
export function computeProfileFeatureScore({
  profile = null,
  stats = null,
  lands = [],
  sculptures = [],
  listings = [],
  quests = [],
  actions = [],
  localActions = [],
  lastViewed = []
} = {}) {
  const safeLands = Array.isArray(lands) ? lands : [];
  const safeSculptures = Array.isArray(sculptures) ? sculptures : [];
  const safeListings = Array.isArray(listings) ? listings : [];
  const safeQuests = Array.isArray(quests) ? quests : [];
  const allActions = [
    ...(Array.isArray(actions) ? actions : []),
    ...(Array.isArray(localActions) ? localActions : [])
  ];
  const safeViewed = Array.isArray(lastViewed) ? lastViewed : [];

  const actionText = (act) =>
    `${act?.type || ''} ${act?.title || ''} ${act?.detail || ''}`.toLowerCase();
  const hasActionMatching = (re) => allActions.some((a) => re.test(actionText(a)));

  const landCount = Math.max(Number(stats?.landCount || 0), safeLands.length);
  const sculptureCount = Math.max(Number(stats?.sculptureCount || 0), safeSculptures.length);
  const totalBlocks = Number(stats?.totalBlocks || 0);
  const awakenedLands = Number(stats?.awakenedLands || 0);
  const activeListingCount = Math.max(Number(stats?.activeListingCount || 0), safeListings.length);
  const questCount = Math.max(Number(stats?.questCount || 0), safeQuests.length);

  const checks = {
    profile_setup: Boolean(
      profile?.username &&
        (String(profile?.bio || '').trim() ||
          String(profile?.avatarImage || '').trim() ||
          (String(profile?.headerImage || '').trim() &&
            String(profile?.headerImage || '').trim() !== 'preset:cyber-grid') ||
          hasActionMatching(/update_profile/))
    ),
    own_land: Boolean(
      landCount >= 1 || hasActionMatching(/\b(mint_land|claim_land|create_land|claim parcel)\b/)
    ),
    publish_art: Boolean(
      sculptureCount >= 1 ||
        totalBlocks >= 1 ||
        hasActionMatching(/\b(publish|create_sculpture|sculpt|paint)\b/)
    ),
    place_3d_model: Boolean(
      safeSculptures.some(
        (sc) => sc?.modelType === 'custom-3d' || Boolean(sc?.customModel?.format)
      ) || hasActionMatching(/\b(model|catalog|glb|gltf|obj|stl|ply|3d item|3d model)\b/)
    ),
    irl_permanent: Boolean(
      awakenedLands >= 1 ||
        safeLands.some(
          (l) =>
            l?.stewardStatus === 'awakened' ||
            l?.expiration?.state === 'permanent' ||
            Boolean(l?.hadHumanInteraction)
        ) ||
        hasActionMatching(/\b(check[_ -]?in|awaken|irl visit|in-person)\b/)
    ),
    explore_lands: Boolean(
      safeViewed.length >= 1 ||
        landCount >= 2 ||
        hasActionMatching(/\b(view|visit|inspect|explore|map|navigate)\b/)
    ),
    agent_collab: Boolean(
      profile?.accountType === 'agent' ||
        allActions.some((a) => a?.type === 'signed_action') ||
        hasActionMatching(/\b(agent|mcp|pair|signed_action|approved)\b/)
    ),
    manage_land: Boolean(
      safeLands.some(
        (l) =>
          Boolean(String(l?.customName || '').trim()) ||
          Boolean(String(l?.curationNote || l?.description || '').trim())
      ) || hasActionMatching(/\b(manage|rename|update_land|land settings|curation)\b/)
    ),
    quests_or_builder: Boolean(
      questCount >= 1 ||
        sculptureCount >= 3 ||
        totalBlocks >= 50 ||
        hasActionMatching(/\b(quest)\b/)
    ),
    market_or_share: Boolean(
      activeListingCount >= 1 ||
        hasActionMatching(/\b(list|listing|buy|sale|market|share|copied|copy)\b/)
    )
  };

  let score = 0;
  const completed = [];
  const nextToTry = [];
  for (const item of PROFILE_FEATURE_MILESTONES) {
    if (checks[item.id]) {
      score += item.points;
      completed.push(item);
    } else {
      nextToTry.push(item);
    }
  }

  return {
    score: Math.min(100, Math.max(0, score)),
    maxScore: 100,
    completedCount: completed.length,
    totalFeatures: PROFILE_FEATURE_MILESTONES.length,
    completed,
    nextToTry
  };
}
