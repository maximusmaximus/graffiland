import {
  CHAT_SIGHT_MAX_DISTANCE_M,
  DEFAULT_LAND_CHAT_ACCESS_MODE,
  DEFAULT_LAND_CHAT_ALLOW_AGENTS,
  PIN_PARCEL_MAX_DISTANCE_M,
  formatLandChatAccessModeLabel,
  normalizeLandChatAccessMode,
  normalizeLandChatAllowAgents
} from '../../../shared/chatPolicy.mjs';
import { AR_MAX_VISIBLE_DISTANCE_METERS } from '../../../shared/constants.mjs';
import { resolveLandDisplayName } from '../../../shared/landVolume.mjs';
import { formatDistanceMeters } from './landMapHelpers.js';

export {
  DEFAULT_LAND_CHAT_ACCESS_MODE,
  DEFAULT_LAND_CHAT_ALLOW_AGENTS,
  formatLandChatAccessModeLabel,
  normalizeLandChatAccessMode,
  normalizeLandChatAllowAgents
};

function parseFiniteMetric(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Computes physical on-site proximity gates for AR Land Inspector actions so users
 * cannot trigger in-person-only actions (drawing, check-in, Land Chat, AR alignment)
 * while viewing a land remotely.
 */
export function evaluateArLandActionProximity(land) {
  if (!land) {
    return {
      edgeDistM: null,
      isInside: false,
      outOfArRange: true,
      canDrawAtLand: false,
      canCheckInAtLand: false,
      canChatAtLand: false,
      canAlignAtLand: false
    };
  }
  const edgeDistM =
    parseFiniteMetric(land.edgeDistanceMetersExact) ??
    parseFiniteMetric(land.edgeDistanceMeters) ??
    parseFiniteMetric(land.distanceMeters);
  const isInside = Boolean(land.isInside);
  const outOfArRange =
    Boolean(land.outOfArRange) ||
    (!isInside && edgeDistM !== null && edgeDistM >= AR_MAX_VISIBLE_DISTANCE_METERS);

  const canAlignAtLand =
    !outOfArRange &&
    (isInside || (edgeDistM !== null && edgeDistM < AR_MAX_VISIBLE_DISTANCE_METERS));
  const canChatAtLand =
    !outOfArRange && (isInside || (edgeDistM !== null && edgeDistM <= CHAT_SIGHT_MAX_DISTANCE_M));
  const canCheckInAtLand =
    !outOfArRange && (isInside || (edgeDistM !== null && edgeDistM <= PIN_PARCEL_MAX_DISTANCE_M));
  const canDrawAtLand = !land.isFrozen && canCheckInAtLand;

  return {
    edgeDistM,
    isInside,
    outOfArRange,
    canDrawAtLand,
    canCheckInAtLand,
    canChatAtLand,
    canAlignAtLand
  };
}

/**
 * Resolves the single canonical chat target for a Virtual Land so all visitors and
 * artworks on that land share one chat room (preferring an initialized board, else
 * the earliest sculpture on the land, else the parcel itself for an empty land).
 */
export function resolveLandChatTarget(land, displayName = '') {
  if (!land) return null;
  const rawSculptures = Array.isArray(land.sculptures) ? land.sculptures : [];
  const sculptures = rawSculptures.filter((s) => s && !s.hidden && !s.isPendingApproval);
  const label =
    displayName ||
    resolveLandDisplayName({
      customName: String(land.customName || '').trim(),
      displayName: land.displayName || '',
      firstSculptureTitle: sculptures[0]?.title || rawSculptures[0]?.title || ''
    });
  const landLat = land.centerLat ?? land.volume?.centerLat ?? null;
  const landLng = land.centerLng ?? land.volume?.centerLng ?? null;

  if (sculptures.length > 0) {
    const initialized = sculptures.find((s) => s?.chatSummary?.initialized);
    const chosen = initialized || sculptures[0];
    const resolvedLat = chosen.lat ?? landLat;
    const resolvedLng = chosen.lng ?? landLng;
    return {
      ...chosen,
      parcelId: chosen.parcelId || land.parcelId,
      parcelName: chosen.parcelName || land.customName || label,
      customName: chosen.customName || land.customName || '',
      landDisplayName: label,
      lat: Number.isFinite(Number(resolvedLat)) ? Number(resolvedLat) : chosen.lat,
      lng: Number.isFinite(Number(resolvedLng)) ? Number(resolvedLng) : chosen.lng
    };
  }

  if (!land.parcelId) return null;
  return {
    id: land.parcelId,
    parcelId: land.parcelId,
    parcelName: label,
    customName: land.customName || '',
    landDisplayName: label,
    title: label,
    lat: Number.isFinite(Number(landLat)) ? Number(landLat) : null,
    lng: Number.isFinite(Number(landLng)) ? Number(landLng) : null,
    creatorSub: land.ownerSub || land.stewardSub || '',
    creatorUsername: land.stewardUsername || '',
    creatorName: land.stewardName || '',
    creatorAvatar: land.stewardAvatar || '',
    isParcelChat: true
  };
}

/**
 * Aggregates whether a Virtual Land currently has a live/initialized Land Chat board,
 * encrypted messages, or pinned IPFS notes.
 */
export function getLandChatLiveSummary(land) {
  if (!land) {
    return {
      hasLiveChat: false,
      initialized: false,
      messageCount: 0,
      pinCount: 0
    };
  }
  const sculptures = Array.isArray(land.sculptures) ? land.sculptures : [];
  const initialized = Boolean(
    land.chatInitialized ||
      land.chatSummary?.initialized ||
      sculptures.some((sc) => Boolean(sc?.chatSummary?.initialized))
  );
  let messageCount = Math.max(
    0,
    Number(land.chatMessageCount || 0),
    Number(land.chatSummary?.messageCount || 0)
  );
  let pinCount = Math.max(0, Number(land.chatPinCount || 0), Number(land.pinSummary?.pinCount || 0));
  for (const sc of sculptures) {
    messageCount = Math.max(messageCount, Number(sc?.chatSummary?.messageCount || 0));
    pinCount = Math.max(pinCount, Number(sc?.pinSummary?.pinCount || 0));
  }
  const hasLiveChat = Boolean(initialized || messageCount > 0 || pinCount > 0);
  return {
    hasLiveChat,
    initialized,
    messageCount,
    pinCount
  };
}

/**
 * Evaluates whether the user can currently enter encrypted Land Chat on a given land,
 * returning a clear human-readable reason for the info ("i") tooltip whenever locked.
 */
export function evaluateLandChatAvailability({
  land = null,
  displayName = '',
  proximity = null,
  isDesktop = false,
  isSignedIn = true,
  userId = '',
  user = null,
  cameraReady = true,
  hasLocation = true,
  unitSystem = 'metric'
} = {}) {
  const sculptures = Array.isArray(land?.sculptures) ? land.sculptures : [];
  const label =
    displayName ||
    resolveLandDisplayName({
      customName: String(land?.customName || '').trim(),
      displayName: land?.displayName || '',
      firstSculptureTitle: sculptures[0]?.title || ''
    }) ||
    'this land';
  const gate = proximity || evaluateArLandActionProximity(land);
  const withinLabel = formatDistanceMeters(CHAT_SIGHT_MAX_DISTANCE_M, unitSystem) || '75m';
  const chatAccessMode = normalizeLandChatAccessMode(
    land?.chatAccessMode ?? land?.settings?.chatAccessMode ?? DEFAULT_LAND_CHAT_ACCESS_MODE
  );
  const chatAllowAgents = normalizeLandChatAllowAgents(
    land?.chatAllowAgents ?? land?.settings?.chatAllowAgents
  );
  const uid = String(userId || user?.id || '').trim();

  if (chatAccessMode === 'off') {
    return {
      canChat: false,
      code: 'chat_disabled',
      chatAccessMode: 'off',
      chatAllowAgents,
      title: 'Land Chat is turned off',
      reason: `The land holder has turned off Land Chat on ${label}.`
    };
  }

  if (isDesktop) {
    return {
      canChat: false,
      code: 'desktop_only',
      chatAccessMode,
      chatAllowAgents,
      title: 'Why Land Chat is locked',
      reason: `Land Chat is mobile in-person only — visit ${label} on your phone within ${withinLabel} with live AR camera to join encrypted chat.`
    };
  }

  if (!hasLocation) {
    return {
      canChat: false,
      code: 'no_gps',
      chatAccessMode,
      chatAllowAgents,
      title: 'Why Land Chat is locked',
      reason: `Enable GPS location and stand within ${withinLabel} of ${label} to verify your presence and unlock encrypted Land Chat.`
    };
  }

  if (!gate.canChatAtLand) {
    if (gate.edgeDistM !== null) {
      const distLabel = formatDistanceMeters(gate.edgeDistM, unitSystem);
      return {
        canChat: false,
        code: 'out_of_range',
        chatAccessMode,
        chatAllowAgents,
        title: 'Why Land Chat is locked',
        reason: `You're ${distLabel} away — walk within ${withinLabel} of ${label} in person with live AR camera to unlock encrypted Land Chat.`
      };
    }
    return {
      canChat: false,
      code: 'no_gps',
      chatAccessMode,
      chatAllowAgents,
      title: 'Why Land Chat is locked',
      reason: `Enable GPS location and visit ${label} in person (within ${withinLabel}) to unlock encrypted Land Chat.`
    };
  }

  if (!cameraReady) {
    return {
      canChat: false,
      code: 'no_camera',
      chatAccessMode,
      chatAllowAgents,
      title: 'Why Land Chat is locked',
      reason: `Enable your live mobile AR camera at ${label} to verify Proof of Sight and unlock encrypted Land Chat.`
    };
  }

  if (!isSignedIn) {
    return {
      canChat: false,
      code: 'signed_out',
      chatAccessMode,
      chatAllowAgents,
      title: 'Why Land Chat is locked',
      reason: `Sign in with Google while on site at ${label} to unlock your encrypted chat key and join Land Chat.`
    };
  }

  // Enforce per-land access mode when viewer identity is known
  if (uid) {
    const isLandHolder = Boolean(
      land?.isOwned || land?.ownerSub === uid || land?.stewardSub === uid
    );
    const isWhitelisted = Boolean(
      Array.isArray(land?.chatWhitelistSubs) && land.chatWhitelistSubs.includes(uid)
    );
    const isArtContributor = sculptures.some((s) => !s?.hidden && s?.creatorSub === uid);
    const isAddedContributor = Boolean(
      Array.isArray(land?.contributorSubs) && land.contributorSubs.includes(uid)
    );

    if (chatAccessMode === 'whitelist' && !isLandHolder && !isWhitelisted) {
      return {
        canChat: false,
        code: 'chat_whitelist_only',
        chatAccessMode: 'whitelist',
        chatAllowAgents,
        title: 'Whitelist-Only Land Chat',
        reason: `Land Chat on ${label} is whitelist-only — ask the land holder to add you to the chat whitelist.`
      };
    }

    if (
      chatAccessMode === 'contributors' &&
      !isLandHolder &&
      !isArtContributor &&
      !isAddedContributor &&
      !isWhitelisted
    ) {
      return {
        canChat: false,
        code: 'chat_contributors_only',
        chatAccessMode: 'contributors',
        chatAllowAgents,
        title: 'Contributors-Only Land Chat',
        reason: `Land Chat on ${label} is restricted to the land holder and contributors — add artwork to this land (or ask the land holder to whitelist you) to unlock chat.`
      };
    }
  }

  return {
    canChat: true,
    code: 'ready',
    chatAccessMode,
    chatAllowAgents,
    title: '',
    reason: ''
  };
}

/**
 * Builds an on-land live chat alert object for NotificationCenter whenever the user
 * is physically standing on a land that has an active/live Land Chat.
 */
export function buildLiveLandChatNotification(
  land,
  {
    isDesktop = false,
    isSignedIn = true,
    userId = '',
    user = null,
    cameraReady = true,
    hasLocation = true,
    unitSystem = 'metric'
  } = {}
) {
  if (!land?.parcelId || !land.isInside) return null;
  const chatAccessMode = normalizeLandChatAccessMode(
    land?.chatAccessMode ?? land?.settings?.chatAccessMode ?? DEFAULT_LAND_CHAT_ACCESS_MODE
  );
  if (chatAccessMode === 'off') return null;

  const summary = getLandChatLiveSummary(land);
  if (!summary.hasLiveChat) return null;

  const sculptures = Array.isArray(land.sculptures) ? land.sculptures : [];
  const displayName =
    land.displayName ||
    resolveLandDisplayName({
      customName: String(land.customName || '').trim(),
      displayName: land.displayName || '',
      firstSculptureTitle: sculptures[0]?.title || ''
    });
  const chatTarget = resolveLandChatTarget(land, displayName);
  if (!chatTarget) return null;

  const chatAvailability = evaluateLandChatAvailability({
    land,
    displayName,
    isDesktop,
    isSignedIn,
    userId,
    user,
    cameraReady,
    hasLocation,
    unitSystem
  });

  let message = `You're on ${displayName} — encrypted Land Chat is live here. Tap below to join.`;
  if (summary.messageCount > 0 && summary.pinCount > 0) {
    message = `You're on ${displayName} — ${summary.messageCount} encrypted ${
      summary.messageCount === 1 ? 'message' : 'messages'
    } & ${summary.pinCount} pinned ${summary.pinCount === 1 ? 'note' : 'notes'} live here.`;
  } else if (summary.messageCount > 0) {
    message = `You're on ${displayName} — ${summary.messageCount} encrypted ${
      summary.messageCount === 1 ? 'message' : 'messages'
    } live here. Tap below to open chat.`;
  } else if (summary.pinCount > 0) {
    message = `You're on ${displayName} — ${summary.pinCount} pinned ${
      summary.pinCount === 1 ? 'note' : 'notes'
    } & live encrypted Land Chat available here.`;
  }

  return {
    id: `live-land-chat:${land.parcelId}`,
    parcelId: land.parcelId,
    displayName,
    land,
    chatTarget,
    messageCount: summary.messageCount,
    pinCount: summary.pinCount,
    initialized: summary.initialized,
    chatAvailability,
    title: `Live Land Chat at ${displayName}`,
    message
  };
}
