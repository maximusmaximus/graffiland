import { resolveLandDisplayName } from '../../../shared/landVolume.mjs';
import { resolveLandCoords } from './landMapHelpers.js';

const PENDING_SCULPTURE_ACTIONS = new Set([
  'create_sculpture',
  'publish_sculpture',
  'update_sculpture'
]);

const KNOWN_3D_FORMATS = new Set(['glb', 'gltf', 'obj', 'stl', 'ply']);

export function isPendingSculptureAction(action = '') {
  return PENDING_SCULPTURE_ACTIONS.has(String(action || '').trim());
}

function inferModelFormatFromPayload(payload = {}) {
  const direct = String(payload?.modelFormat || payload?.model?.format || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '');
  if (KNOWN_3D_FORMATS.has(direct)) return direct;

  const urlRaw = String(payload?.modelUrl || payload?.model?.url || '').trim();
  if (urlRaw) {
    const cleanPath = urlRaw.split(/[?#]/)[0];
    const ext = cleanPath.includes('.') ? cleanPath.split('.').pop().toLowerCase() : '';
    if (KNOWN_3D_FORMATS.has(ext)) return ext;
    return 'glb';
  }
  return '';
}

function normalizeAnchorOffset(rawOffset = null, fallbackOffset = null) {
  const base = fallbackOffset && typeof fallbackOffset === 'object' ? fallbackOffset : {};
  const src = rawOffset && typeof rawOffset === 'object' ? rawOffset : {};
  const pick = (k) => {
    if (src[k] !== undefined && Number.isFinite(Number(src[k]))) return Number(src[k]);
    if (base[k] !== undefined && Number.isFinite(Number(base[k]))) return Number(base[k]);
    return 0;
  };
  return {
    dx: pick('dx'),
    dy: Math.max(0, pick('dy')),
    dz: pick('dz'),
    yaw: pick('yaw'),
    pitch: pick('pitch'),
    roll: pick('roll')
  };
}

/**
 * Converts a pending signature request (create_sculpture / publish_sculpture / update_sculpture)
 * into a temporary GRAFFILAND sculpture preview object so 3D/2D maps, land showcases,
 * and the 3D Sculpture Viewer can render the live preview with an unmistakable "Preview" label
 * before the land holder approves & mints it.
 */
export function buildPendingPreviewSculpture(
  req,
  { parcels = [], existingSculptures = [] } = {}
) {
  if (!req || req.status !== 'pending' || !isPendingSculptureAction(req.action)) {
    return null;
  }

  const payload = req.payload && typeof req.payload === 'object' ? req.payload : {};
  const pidUpper = String(req.parcelId || payload.parcelId || '').toUpperCase();
  const matchedParcel = pidUpper
    ? (parcels || []).find((p) => String(p?.parcelId || '').toUpperCase() === pidUpper) || null
    : null;
  const existing = req.sculptureId
    ? (existingSculptures || []).find((s) => s && s.id === req.sculptureId) || null
    : null;

  const rawVoxels = Array.isArray(payload.voxels)
    ? payload.voxels
    : Array.isArray(payload.cleanVoxels)
      ? payload.cleanVoxels
      : null;

  const inlineBase64 = String(payload.modelBase64 || payload.model?.dataBase64 || '').trim();
  const inlineText = String(
    payload.modelData || payload.model?.data || payload.model?.dataText || ''
  );
  const modelUrl = String(payload.modelUrl || payload.model?.url || '').trim();
  const inferredFormat = inferModelFormatFromPayload(payload);
  const payloadHasCustomModel = Boolean(
    inferredFormat || inlineBase64 || inlineText.trim() || modelUrl
  );

  let modelType = 'voxel';
  let voxels = [];
  let customModel = null;

  if (payloadHasCustomModel) {
    const scaleNum = Number(payload.modelScale ?? payload.model?.scale ?? existing?.customModel?.scale ?? 1);
    const rotYNum = Number(
      payload.modelRotationY ?? payload.model?.rotationY ?? existing?.customModel?.rotationY ?? 0
    );
    modelType = 'custom-3d';
    customModel = {
      format: inferredFormat || 'glb',
      downloadUrl: modelUrl,
      proxyUrl: `/api/signatures/requests/${encodeURIComponent(req.id)}/preview-model`,
      inlineBase64,
      inlineText: inlineText.trim() ? inlineText : '',
      scale: Number.isFinite(scaleNum) && scaleNum > 0 ? scaleNum : 1,
      rotationY: Number.isFinite(rotYNum) ? rotYNum : 0
    };
  } else if (rawVoxels && rawVoxels.length > 0) {
    modelType = 'voxel';
    voxels = rawVoxels;
  } else if (req.action === 'update_sculpture' && existing) {
    modelType = existing.modelType || (existing.customModel?.format ? 'custom-3d' : 'voxel');
    voxels = Array.isArray(existing.voxels) ? existing.voxels : [];
    if (existing.customModel) {
      const nextScale = Number(payload.modelScale ?? existing.customModel.scale ?? 1);
      customModel = {
        ...existing.customModel,
        scale: Number.isFinite(nextScale) && nextScale > 0 ? nextScale : 1
      };
    }
  } else {
    return null;
  }

  const parcelCoords = matchedParcel ? resolveLandCoords(matchedParcel) : null;
  const locBundle = payload.locationBundle && typeof payload.locationBundle === 'object'
    ? payload.locationBundle
    : null;
  const latCandidates = [
    parcelCoords?.lat,
    payload.lat,
    locBundle?.lat,
    existing?.lat
  ];
  const lngCandidates = [
    parcelCoords?.lng,
    payload.lng,
    locBundle?.lng,
    existing?.lng
  ];
  const lat = latCandidates.map(Number).find((v) => Number.isFinite(v));
  const lng = lngCandidates.map(Number).find((v) => Number.isFinite(v));

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const landDisplayName = resolveLandDisplayName(
    {
      customName:
        matchedParcel?.customName || req.parcelName || req.landDisplayName || existing?.parcelName || '',
      displayName: matchedParcel?.displayName || req.landDisplayName || ''
    },
    { defaultName: 'Virtual Land' }
  );

  const rawTitle = String(
    payload.title ||
      existing?.title ||
      String(req.summaryTitle || '')
        .replace(/^(Place|Update|Publish)\s+"/i, '')
        .replace(/"$/, '') ||
      'Pending Artwork'
  ).trim();

  const scaleVal =
    modelType === 'custom-3d'
      ? customModel?.scale || 1
      : Number.isFinite(Number(payload.modelScale)) && Number(payload.modelScale) > 0
        ? Number(payload.modelScale)
        : 1;

  return {
    id: `pending-preview:${req.id}`,
    isPendingPreview: true,
    pendingRequestId: req.id,
    pendingRequest: req,
    pendingAction: req.action,
    pendingAgentName: String(req.agentName || 'Paired Agent').trim(),
    pendingExpiresAt: req.expiresAt || '',
    parcelId: matchedParcel?.parcelId || req.parcelId || existing?.parcelId || '',
    parcelName: matchedParcel?.customName || req.parcelName || '',
    landDisplayName,
    title: rawTitle,
    description: String(payload.description || req.summaryDescription || existing?.description || '').trim(),
    lat,
    lng,
    altitude: Number.isFinite(Number(payload.altitude)) ? Number(payload.altitude) : 0,
    modelType,
    voxels,
    voxelCount: voxels.length,
    customModel,
    scale: scaleVal,
    anchorOffset: normalizeAnchorOffset(payload.anchorOffset, existing?.anchorOffset),
    previewDataUrl: String(payload.previewDataUrl || '').trim(),
    createdAt: req.createdAt || new Date().toISOString()
  };
}

export function buildPendingPreviewSculptures(
  pendingRequests = [],
  { parcels = [], existingSculptures = [] } = {}
) {
  if (!Array.isArray(pendingRequests) || pendingRequests.length === 0) return [];
  const out = [];
  const seenReqIds = new Set();
  for (const req of pendingRequests) {
    if (!req?.id || seenReqIds.has(req.id)) continue;
    const preview = buildPendingPreviewSculpture(req, { parcels, existingSculptures });
    if (preview) {
      seenReqIds.add(req.id);
      out.push(preview);
    }
  }
  return out;
}
