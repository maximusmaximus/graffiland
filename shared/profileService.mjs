import { buildParcelShareUrl } from './landVolume.mjs';
import { listLandsWithCurations } from './mcp/landMutations.mjs';
import {
  buildPublicProfileUrl,
  normalizeUsername,
  validateBio,
  validateUsername
} from './profileRules.mjs';

function makeError(message, statusCode = 400) {
  const err = new Error(message);
  /** @type {any} */ (err).statusCode = statusCode;
  return err;
}

function buildSculptureLink(origin, pathname, sculptureId) {
  if (!sculptureId) return '';
  const cleanPath = pathname && pathname.startsWith('/') ? pathname : `/${pathname || ''}`;
  const base = origin ? `${origin.replace(/\/+$/, '')}${cleanPath}` : cleanPath;
  return `${base}?sculpture=${encodeURIComponent(sculptureId)}`;
}

function buildGoogleMapsUrl(lat, lng) {
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return '';
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    `${nLat.toFixed(6)},${nLng.toFixed(6)}`
  )}`;
}

/**
 * Check whether a username is valid and available to claim.
 * @param {any} db
 * @param {{ username: string, excludeUserId?: string }} params
 */
export async function checkUsernameAvailability(db, { username, excludeUserId = '' } = {}) {
  const check = validateUsername(username);
  if (!check.ok) {
    return {
      available: false,
      isCurrent: false,
      username: check.username,
      reason: check.error
    };
  }

  const existing = await db.get(
    'SELECT id, username FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1',
    [check.username]
  );

  if (existing && String(existing.id) === String(excludeUserId || '')) {
    return {
      available: true,
      isCurrent: true,
      username: check.username,
      reason: 'This is your current username.'
    };
  }

  if (existing) {
    return {
      available: false,
      isCurrent: false,
      username: check.username,
      reason: `@${check.username} is already taken. Try another handle.`
    };
  }

  return {
    available: true,
    isCurrent: false,
    username: check.username,
    reason: `@${check.username} is available!`
  };
}

/**
 * Update an authenticated user's unique username and/or bio.
 * Enforces format rules + case-insensitive uniqueness across all accounts.
 * @param {any} db
 * @param {{ user: any, username?: string, bio?: string }} params
 */
export async function updateUserProfile(db, { user, username, bio } = {}) {
  if (!user?.id) {
    throw makeError('Authentication required.', 401);
  }

  const currentRow = await db.get('SELECT * FROM users WHERE id = ?', [user.id]);
  if (!currentRow) {
    throw makeError('Account not found.', 404);
  }

  let nextUsername = String(currentRow.username || '');
  let usernameChanged = false;

  if (username !== undefined) {
    const check = validateUsername(username);
    if (!check.ok) {
      throw makeError(check.error, 400);
    }
    const existing = await db.get(
      'SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ? LIMIT 1',
      [check.username, user.id]
    );
    if (existing) {
      throw makeError(`@${check.username} is already taken. Choose a different username.`, 409);
    }
    usernameChanged = check.username.toLowerCase() !== nextUsername.toLowerCase();
    nextUsername = check.username;
  } else if (!nextUsername) {
    throw makeError('Username is required to complete onboarding.', 400);
  }

  let nextBio = String(currentRow.bio || '');
  if (bio !== undefined) {
    const bioCheck = validateBio(bio);
    if (!bioCheck.ok) {
      throw makeError(bioCheck.error, 400);
    }
    nextBio = bioCheck.bio;
  }

  const now = new Date().toISOString();
  const nextUpdatedAt = usernameChanged
    ? now
    : String(currentRow.username_updated_at || '');

  try {
    await db.run(
      'UPDATE users SET username = ?, bio = ?, username_updated_at = ? WHERE id = ?',
      [nextUsername, nextBio, nextUpdatedAt, user.id]
    );
  } catch (err) {
    const msg = String(err?.message || '');
    if (/UNIQUE|constraint/i.test(msg)) {
      throw makeError(`@${nextUsername} is already taken. Choose a different username.`, 409);
    }
    throw err;
  }

  const updated = await db.get('SELECT * FROM users WHERE id = ?', [user.id]);
  return updated;
}

/**
 * Fetch a public profile by @username (case-insensitive) or exact user id,
 * including public links to all lands, sculptures, active listings, quests, and recent actions.
 * Never returns private fields (email, encrypted keys, auth tokens).
 * @param {any} db
 * @param {{ identifier: string, origin?: string, pathname?: string }} params
 */
export async function getPublicProfile(db, { identifier, origin = '', pathname = '/' } = {}) {
  const raw = String(identifier || '').trim();
  if (!raw) {
    throw makeError('Profile handle is required.', 400);
  }
  const normalizedHandle = normalizeUsername(raw);

  let userRow = null;
  if (normalizedHandle) {
    userRow = await db.get(
      'SELECT id, name, username, bio, picture, wallet_address, custom_payout_address, created_at FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1',
      [normalizedHandle]
    );
  }
  if (!userRow) {
    userRow = await db.get(
      'SELECT id, name, username, bio, picture, wallet_address, custom_payout_address, created_at FROM users WHERE id = ? LIMIT 1',
      [raw]
    );
  }
  if (!userRow) {
    throw makeError('Profile not found.', 404);
  }

  const userId = String(userRow.id);
  const accountType = userId.startsWith('agent:') ? 'agent' : 'human';
  const walletSet = new Set(
    [userRow.wallet_address, userRow.custom_payout_address]
      .filter(Boolean)
      .map((a) => String(a).toLowerCase())
  );

  // 1. Lands owned/stewarded by this account
  const allParcels = await listLandsWithCurations(db);
  const ownedLands = allParcels
    .filter((p) => {
      if (p.ownerSub === userId || p.stewardSub === userId) return true;
      const addr = String(p.firstClaimantAddress || '').toLowerCase();
      return Boolean(addr && walletSet.has(addr));
    })
    .map((p) => {
      const shareUrl = buildParcelShareUrl({
        origin,
        pathname,
        parcelId: p.parcelId,
        customName: p.customName || '',
        compact: true
      });
      return {
        parcelId: p.parcelId,
        customName: p.customName || '',
        displayName: p.customName || p.parcelId,
        description: p.description || p.curationNote || '',
        centerLat: p.centerLat,
        centerLng: p.centerLng,
        sculptureCount: Number(p.sculptureCount || 0),
        stewardStatus: p.stewardStatus || 'awakened',
        leaseExpiresAt: p.leaseExpiresAt || '',
        awakenedAt: p.awakenedAt || '',
        frozen: Boolean(p.frozen),
        openQuestCount: Number(p.openQuestCount || 0),
        humanContributorCount: Number(p.humanContributorCount || 0),
        volume: p.volume || null,
        slug: p.slug || p.parcelId.toLowerCase(),
        latestAt: p.latestAt || '',
        shareUrl,
        googleMapsUrl: buildGoogleMapsUrl(p.centerLat, p.centerLng)
      };
    });

  // 2. Public sculptures authored by this account
  const scRows = await db.all(
    `SELECT s.id, s.title, s.description, s.parcel_id, s.lat, s.lng, s.voxel_count,
            s.pol_score, s.tx_hash, s.token_id, s.simulated_chain, s.created_at,
            l.layer_role,
            m.model_format AS model_format, m.byte_length AS model_bytes
     FROM sculptures s
     LEFT JOIN sculpture_layers l ON l.sculpture_id = s.id
     LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
     WHERE s.creator_sub = ? AND s.hidden = 0
     ORDER BY s.created_at DESC
     LIMIT 100`,
    [userId]
  );

  const sculptures = (scRows || []).map((r) => ({
    id: r.id,
    title: r.title || 'Untitled Sculpture',
    description: r.description || '',
    parcelId: r.parcel_id,
    lat: Number(r.lat),
    lng: Number(r.lng),
    voxelCount: Number(r.voxel_count || 0),
    modelType: r.model_format ? 'custom-3d' : 'voxel',
    customModel: r.model_format
      ? { format: r.model_format, byteLength: Number(r.model_bytes || 0) }
      : null,
    polScore: Number(r.pol_score || 0),
    layerRole: r.layer_role || 'artist_work',
    createdAt: r.created_at,
    chain: {
      txHash: r.tx_hash || '',
      tokenId: r.token_id || '',
      simulated: Boolean(r.simulated_chain)
    },
    shareUrl: buildSculptureLink(origin, pathname, r.id),
    landShareUrl: buildParcelShareUrl({
      origin,
      pathname,
      parcelId: r.parcel_id,
      compact: true
    })
  }));

  // 3. Active marketplace listings by this account
  const listingRows = await db
    .all(
      `SELECT ml.id, ml.sculpture_id, ml.parcel_id, ml.price_eth, ml.status, ml.created_at,
              s.title AS sculpture_title
       FROM marketplace_listings ml
       LEFT JOIN sculptures s ON s.id = ml.sculpture_id
       WHERE ml.seller_sub = ? AND ml.status = 'active'
       ORDER BY ml.created_at DESC
       LIMIT 30`,
      [userId]
    )
    .catch(() => []);

  const listings = (listingRows || []).map((l) => ({
    id: l.id,
    sculptureId: l.sculpture_id,
    sculptureTitle: l.sculpture_title || l.sculpture_id,
    parcelId: l.parcel_id,
    priceEth: Number(l.price_eth || 0),
    status: l.status,
    createdAt: l.created_at,
    shareUrl: buildSculptureLink(origin, pathname, l.sculpture_id)
  }));

  // 4. Quests posted by this steward (if any)
  const questRows = await db
    .all(
      `SELECT id, parcel_id, title, prompt, bounty_eth, status, created_at
       FROM land_quests
       WHERE steward_sub = ?
       ORDER BY created_at DESC
       LIMIT 25`,
      [userId]
    )
    .catch(() => []);

  const quests = (questRows || []).map((q) => ({
    id: q.id,
    parcelId: q.parcel_id,
    title: q.title,
    prompt: q.prompt || '',
    bountyEth: Number(q.bounty_eth || 0),
    status: q.status,
    createdAt: q.created_at,
    landShareUrl: buildParcelShareUrl({
      origin,
      pathname,
      parcelId: q.parcel_id,
      compact: true
    })
  }));

  // 5. Recent approved/signed public land actions (summary only, zero private keys/signatures)
  const signedRows = await db
    .all(
      `SELECT id, action, parcel_id, sculpture_id, agent_name, status, updated_at, created_at
       FROM land_signature_requests
       WHERE owner_sub = ? AND status IN ('signed', 'executed', 'completed')
       ORDER BY COALESCE(updated_at, created_at) DESC
       LIMIT 20`,
      [userId]
    )
    .catch(() => []);

  // 6. Quest completions / XP earned
  const xpRow = await db
    .get(
      `SELECT COALESCE(SUM(xp_awarded), 0) AS xp, COALESCE(SUM(awakened_parcel), 0) AS awakened
       FROM land_quest_completions
       WHERE human_sub = ?`,
      [userId]
    )
    .catch(() => null);

  // Build unified public activity/actions feed
  /** @type {any[]} */
  const actions = [];

  for (const sc of sculptures.slice(0, 15)) {
    actions.push({
      id: `sc-${sc.id}`,
      type: 'sculpture_published',
      icon: '🧊',
      title: `Published "${sc.title}"`,
      detail: `${sc.parcelId} · ${
        sc.modelType === 'custom-3d'
          ? `${String(sc.customModel?.format || '3D').toUpperCase()} 3D`
          : `${sc.voxelCount} blocks`
      }`,
      parcelId: sc.parcelId,
      sculptureId: sc.id,
      url: sc.shareUrl,
      linkLabel: 'View Sculpture',
      createdAt: sc.createdAt
    });
  }

  for (const land of ownedLands.slice(0, 15)) {
    actions.push({
      id: `land-${land.parcelId}`,
      type: 'land_claimed',
      icon: '🗺️',
      title: `Stewarding ${land.displayName}`,
      detail: `${land.parcelId} · ${land.sculptureCount} sculpture${
        land.sculptureCount === 1 ? '' : 's'
      }${land.stewardStatus === 'dormant' ? ' · Dormant' : ' · Awakened'}`,
      parcelId: land.parcelId,
      sculptureId: '',
      url: land.shareUrl,
      linkLabel: 'Open Land',
      createdAt: land.latestAt || land.awakenedAt || userRow.created_at
    });
  }

  for (const lst of listings.slice(0, 10)) {
    actions.push({
      id: `list-${lst.id}`,
      type: 'listing_created',
      icon: '🏷️',
      title: `Listed "${lst.sculptureTitle}" for ${lst.priceEth} ETH`,
      detail: `${lst.parcelId} · Active Marketplace Listing`,
      parcelId: lst.parcelId,
      sculptureId: lst.sculptureId,
      url: lst.shareUrl,
      linkLabel: 'View Listing',
      createdAt: lst.createdAt
    });
  }

  for (const q of quests.slice(0, 10)) {
    actions.push({
      id: `quest-${q.id}`,
      type: 'quest_created',
      icon: '🎯',
      title: `Posted quest "${q.title}"`,
      detail: `${q.parcelId} · ${q.status}${q.bountyEth > 0 ? ` · ${q.bountyEth} ETH` : ''}`,
      parcelId: q.parcelId,
      sculptureId: '',
      url: q.landShareUrl,
      linkLabel: 'Open Land',
      createdAt: q.createdAt
    });
  }

  for (const sr of signedRows || []) {
    const scLink = sr.sculpture_id ? buildSculptureLink(origin, pathname, sr.sculpture_id) : '';
    const landLink = sr.parcel_id
      ? buildParcelShareUrl({ origin, pathname, parcelId: sr.parcel_id, compact: true })
      : '';
    const actionLabel = String(sr.action || 'land_action')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    actions.push({
      id: `sig-${sr.id}`,
      type: 'signed_action',
      icon: '✅',
      title: `Approved ${actionLabel}`,
      detail: [
        sr.parcel_id ? `Land ${sr.parcel_id}` : '',
        sr.agent_name ? `Agent: ${sr.agent_name}` : 'Signed on-account action'
      ]
        .filter(Boolean)
        .join(' · '),
      parcelId: sr.parcel_id || '',
      sculptureId: sr.sculpture_id || '',
      url: scLink || landLink,
      linkLabel: scLink ? 'View Sculpture' : landLink ? 'Open Land' : '',
      createdAt: sr.updated_at || sr.created_at
    });
  }

  actions.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const totalBlocks = sculptures.reduce((sum, sc) => sum + Number(sc.voxelCount || 0), 0);
  const baseXp = Number(xpRow?.xp || 0);
  const totalXp = baseXp > 0 ? baseXp : sculptures.length * 100;
  const publicHandle = String(userRow.username || '').trim();

  return {
    profile: {
      id: userId,
      username: publicHandle,
      displayName: userRow.name || publicHandle || 'Creator',
      bio: userRow.bio || '',
      picture: userRow.picture || '',
      walletAddress: userRow.custom_payout_address || userRow.wallet_address || '',
      accountType,
      joinedAt: userRow.created_at,
      profileUrl: publicHandle
        ? buildPublicProfileUrl({ origin, pathname, username: publicHandle })
        : ''
    },
    stats: {
      landCount: ownedLands.length,
      sculptureCount: sculptures.length,
      activeListingCount: listings.length,
      questCount: quests.length,
      actionCount: actions.length,
      totalBlocks,
      awakenedLands: ownedLands.filter((l) => l.stewardStatus === 'awakened').length,
      totalXp
    },
    lands: ownedLands,
    sculptures,
    listings,
    quests,
    actions: actions.slice(0, 30)
  };
}
