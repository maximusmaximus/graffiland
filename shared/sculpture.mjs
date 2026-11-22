import { decodeGeohashBounds } from '../server/services/pol.mjs';
import { resolveLandDisplayName } from './landVolume.mjs';
import {
  extractPublicUsername,
  resolvePublicUserHandle,
  resolveSafeUserAvatar
} from './userDisplay.mjs';

/**
 * Shared SELECT column list omitting `voxels_json` on lightweight list/spatial queries
 * so D1 / SQLite never reads large 3D voxel blobs when `includeVoxels=0`.
 */
export const SCULPTURE_BASE_COLUMNS_NO_VOXELS = `
  s.id, s.title, s.description, s.creator_sub, s.creator_name, s.creator_email, s.recipient_address,
  s.lat, s.lng, s.altitude, s.accuracy, s.heading, s.parcel_id, s.geohash, s.place_name, s.country, s.timezone,
  s.voxel_count, s.pol_score, s.pol_json, s.proof_hash, s.preview_data_url,
  s.ipfs_metadata_cid, s.ipfs_model_cid, s.ipfs_image_cid, s.ipfs_gateway_url,
  s.chain_id, s.chain_name, s.contract_address, s.token_id, s.tx_hash, s.simulated_chain,
  s.royalty_bps, s.royalty_receiver, s.hidden, s.hidden_reason, s.hidden_by,
  s.terms_accepted_version, s.created_at
`;

export function buildSculptureSelectSql({ includeVoxels = true } = {}) {
  const cols = includeVoxels ? 's.*' : SCULPTURE_BASE_COLUMNS_NO_VOXELS;
  return `
    SELECT ${cols},
      (SELECT COUNT(*) FROM sculpture_chat_boards b WHERE b.sculpture_id = s.id) AS chat_initialized,
      (SELECT COUNT(*) FROM sculpture_chat_messages m WHERE m.sculpture_id = s.id) AS chat_message_count,
      (SELECT COUNT(*) FROM sculpture_chat_boards b WHERE b.sculpture_id = s.id AND b.clue_prompt != '' AND b.clue_wrapped_json != '') AS chat_has_clue,
      (SELECT b.batch_seq FROM sculpture_pin_batches b WHERE b.sculpture_id = s.id) AS pin_batch_seq,
      (SELECT b.pin_count FROM sculpture_pin_batches b WHERE b.sculpture_id = s.id) AS pin_count,
      (SELECT b.ipfs_cid FROM sculpture_pin_batches b WHERE b.sculpture_id = s.id) AS pin_ipfs_cid,
      (SELECT b.ipfs_uri FROM sculpture_pin_batches b WHERE b.sculpture_id = s.id) AS pin_ipfs_uri,
      (SELECT b.updated_at FROM sculpture_pin_batches b WHERE b.sculpture_id = s.id) AS pin_updated_at,
      m.model_format AS custom_model_format,
      m.mime_type AS custom_model_mime,
      m.source_type AS custom_model_source_type,
      m.model_url AS custom_model_url,
      m.model_cid AS custom_model_cid,
      m.model_uri AS custom_model_uri,
      m.scale AS custom_model_scale,
      m.rotation_y AS custom_model_rotation_y,
      m.byte_length AS custom_model_bytes,
      a.dx AS anchor_dx,
      a.dy AS anchor_dy,
      a.dz AS anchor_dz,
      a.yaw AS anchor_yaw,
      a.current_rev AS current_rev,
      a.last_erc4906_tx_hash AS last_erc4906_tx_hash,
      a.mesh_stats_json AS mesh_stats_json,
      COALESCE(l.layer_role, 'artist_work') AS layer_role,
      COALESCE(l.quest_id, '') AS layer_quest_id,
      COALESCE(l.plinth_slot_id, '') AS layer_plinth_slot_id,
      COALESCE(l.qual_contributor, 1) AS qual_contributor,
      COALESCE(pc.custom_name, '') AS parcel_custom_name,
      COALESCE(cu.username, '') AS creator_username,
      COALESCE(cu.avatar_image, '') AS creator_avatar,
      COALESCE(cu.user_number, 0) AS creator_user_number
     FROM sculptures s
     LEFT JOIN sculpture_models m ON m.sculpture_id = s.id
     LEFT JOIN sculpture_anchors a ON a.sculpture_id = s.id
     LEFT JOIN sculpture_layers l ON l.sculpture_id = s.id
     LEFT JOIN parcel_curations pc ON pc.parcel_id = s.parcel_id
     LEFT JOIN users cu ON cu.id = s.creator_sub
  `;
}

export function buildSpatialBoundingWhere({ lat = null, lng = null, radiusMeters = null, parcel = '' } = {}) {
  const clauses = ['s.hidden = 0'];
  const params = [];
  const cleanParcel = String(parcel || '').trim().toUpperCase();
  if (cleanParcel) {
    clauses.push('s.parcel_id = ?');
    params.push(cleanParcel);
  }
  if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(radiusMeters) && radiusMeters > 0) {
    const padLat = radiusMeters / 111320 + 0.0005;
    const cosLat = Math.max(0.15, Math.abs(Math.cos((lat * Math.PI) / 180)));
    const padLng = radiusMeters / (111320 * cosLat) + 0.0005;
    clauses.push('s.lat BETWEEN ? AND ?');
    params.push(lat - padLat, lat + padLat);
    clauses.push('s.lng BETWEEN ? AND ?');
    params.push(lng - padLng, lng + padLng);
  }
  return { whereSql: clauses.join(' AND '), params };
}

export function computeVerticalBounds(voxels = []) {
  if (!Array.isArray(voxels) || voxels.length === 0) {
    return { minY: 0, maxY: 0 };
  }
  let minY = Infinity;
  let maxY = -Infinity;
  for (const v of voxels) {
    const y = Number(v?.y);
    if (!Number.isFinite(y)) continue;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minY)) return { minY: 0, maxY: 0 };
  return {
    minY: Math.round(minY * 1000) / 1000,
    maxY: Math.round(maxY * 1000) / 1000
  };
}

export function serializeSculptureRow(
  row,
  {
    includeAdminFields = false,
    includeVoxels = true,
    transfers = undefined,
    viewerCanContribute = undefined,
    viewerIsLandOwner = undefined,
    parcelFrozen = undefined
  } = {}
) {
  const pol = JSON.parse(row.pol_json || '{}');
  const elevation = pol.elevation || {
    deviceAltitudeMeters: row.altitude ?? null,
    altitudeAccuracyMeters: null,
    altitudeSource: row.altitude !== null && row.altitude !== undefined ? 'device-sensor' : 'unavailable',
    terrainElevationMeters: null,
    anchorAltitudeMeters: row.altitude ?? null,
    heightAboveGroundMeters: null,
    sculptureVerticalMinM: 0,
    sculptureVerticalMaxM: 0
  };
  const customFormat = row.custom_model_format || '';
  const isCustom3d = Boolean(customFormat);
  const parsedMeshStats = row.mesh_stats_json
    ? (() => {
        try {
          const parsed = JSON.parse(row.mesh_stats_json);
          return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
          return null;
        }
      })()
    : null;
  const rawTransformScale =
    parsedMeshStats?.transformScale !== undefined && parsedMeshStats?.transformScale !== null
      ? Number(parsedMeshStats.transformScale)
      : isCustom3d && row.custom_model_scale !== undefined && row.custom_model_scale !== null
      ? Number(row.custom_model_scale)
      : 1;
  const effectiveScale =
    Number.isFinite(rawTransformScale) && rawTransformScale > 0
      ? Math.max(0.1, Math.min(60, Math.round(rawTransformScale * 10000) / 10000))
      : 1;

  const creatorUsername = extractPublicUsername({
    username: row.creator_username || '',
    creatorName: row.creator_name || ''
  });
  const creatorAvatar = resolveSafeUserAvatar(row.creator_avatar || '');
  const safeCreatorName = resolvePublicUserHandle(
    {
      id: row.creator_sub,
      username: creatorUsername,
      creatorName: row.creator_name,
      userNumber: row.creator_user_number
    },
    { fallback: 'Creator', includeAt: true }
  );

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    creatorSub: row.creator_sub,
    creatorName: safeCreatorName,
    creatorUsername,
    creatorAvatar,
    ...(includeAdminFields ? { creatorEmail: row.creator_email } : {}),
    recipientAddress: row.recipient_address,
    ownerAddress: row.recipient_address,
    modelType: isCustom3d ? 'custom-3d' : 'voxel',
    scale: effectiveScale,
    ...(isCustom3d
      ? {
          customModel: {
            format: customFormat,
            mimeType: row.custom_model_mime || 'model/gltf-binary',
            sourceType: row.custom_model_source_type || 'ipfs',
            externalUrl: row.custom_model_url || '',
            ipfsCid: row.custom_model_cid || row.ipfs_model_cid || '',
            ipfsUri: row.custom_model_uri || `ipfs://${row.ipfs_model_cid}`,
            downloadUrl: `/api/sculptures/${row.id}/model`,
            scale: effectiveScale,
            rotationY: Number(row.custom_model_rotation_y || 0),
            byteLength: Number(row.custom_model_bytes || 0)
          }
        }
      : { customModel: null }),
    modelGlbUrl:
      isCustom3d && customFormat !== 'glb'
        ? `/api/sculptures/${row.id}/model`
        : `/api/sculptures/${row.id}/model.glb`,
    metadataUrl: `/api/sculptures/${row.id}/metadata.json`,
    lat: row.lat,
    lng: row.lng,
    altitude: row.altitude,
    elevation,
    accuracy: row.accuracy,
    heading: row.heading,
    parcelId: row.parcel_id,
    parcelName: String(row.parcel_custom_name || '').trim(),
    landDisplayName: resolveLandDisplayName({
      customName: row.parcel_custom_name || '',
      placeName: row.place_name || '',
      firstSculptureTitle: row.title || ''
    }),
    geohash: row.geohash,
    parcelBounds: decodeGeohashBounds(row.geohash),
    anchorOffset: {
      dx: Number(row.anchor_dx || 0),
      dy: Number(row.anchor_dy || 0),
      dz: Number(row.anchor_dz || 0),
      yaw: Number(row.anchor_yaw || 0),
      scale: effectiveScale
    },
    currentRev: Number(row.current_rev || 1),
    lastErc4906TxHash: row.last_erc4906_tx_hash || '',
    layerRole: row.layer_role || 'artist_work',
    questId: row.layer_quest_id || '',
    plinthSlotId: row.layer_plinth_slot_id || '',
    qualifiesForContributorPool:
      row.qual_contributor !== undefined ? Boolean(row.qual_contributor) : true,
    ...(parsedMeshStats ? { meshStats: parsedMeshStats } : {}),
    placeName: row.place_name,
    country: row.country,
    timezone: row.timezone,
    voxelCount: row.voxel_count,
    ...(includeVoxels ? { voxels: JSON.parse(row.voxels_json || '[]') } : {}),
    polScore: row.pol_score,
    proofOfLocation: pol,
    proofHash: row.proof_hash,
    previewDataUrl: row.preview_data_url,
    ipfs: {
      metadataCid: row.ipfs_metadata_cid,
      modelCid: row.ipfs_model_cid,
      imageCid: row.ipfs_image_cid,
      metadataUri: `ipfs://${row.ipfs_metadata_cid}`,
      modelUri: `ipfs://${row.ipfs_model_cid}`,
      imageUri: `ipfs://${row.ipfs_image_cid}`,
      gatewayUrl: row.ipfs_gateway_url
    },
    ...(Array.isArray(transfers) ? { transfers } : {}),
    chain: {
      chainId: row.chain_id,
      chainName: row.chain_name,
      contractAddress: row.contract_address,
      tokenId: row.token_id,
      txHash: row.tx_hash,
      simulated: Boolean(row.simulated_chain),
      royaltyBps: row.royalty_bps,
      royaltyPercent: row.royalty_bps / 100,
      royaltyReceiver: row.royalty_receiver
    },
    hidden: Boolean(row.hidden),
    ...(row.chat_message_count !== undefined || row.chat_initialized !== undefined
      ? {
          chatSummary: {
            initialized: Boolean(row.chat_initialized),
            messageCount: Number(row.chat_message_count || 0),
            hasClue: Boolean(row.chat_has_clue)
          }
        }
      : {}),
    ...(row.pin_batch_seq !== undefined ||
    row.pin_count !== undefined ||
    row.pin_ipfs_cid !== undefined
      ? {
          pinSummary: {
            hasPins: Number(row.pin_count || 0) > 0 && Boolean(row.pin_ipfs_cid),
            batchSeq: Number(row.pin_batch_seq || 0),
            pinCount: Number(row.pin_count || 0),
            ipfsCid: row.pin_ipfs_cid || '',
            ipfsUri: row.pin_ipfs_uri || '',
            updatedAt: row.pin_updated_at || ''
          }
        }
      : {}),
    ...(includeAdminFields || Boolean(row.hidden)
      ? {
          hiddenReason: row.hidden_reason || '',
          hiddenBy: row.hidden_by || ''
        }
      : {}),
    ...(viewerCanContribute !== undefined
      ? { viewerCanContribute: Boolean(viewerCanContribute) }
      : {}),
    ...(viewerIsLandOwner !== undefined
      ? { viewerIsLandOwner: Boolean(viewerIsLandOwner) }
      : {}),
    ...(parcelFrozen !== undefined ? { parcelFrozen: Boolean(parcelFrozen) } : {}),
    termsAcceptedVersion: row.terms_accepted_version,
    createdAt: row.created_at
  };
}

export function buildIpfsMetadata({
  sculptureId,
  title,
  description,
  imageUri,
  modelUri,
  modelMimeType = 'model/gltf-binary',
  modelFormat = 'glb',
  voxelJsonUri,
  publicUrl,
  voxels,
  locationBundle,
  creatorAddress,
  royaltyBps,
  royaltyReceiver
}) {
  const elev = locationBundle.elevation || {};
  const attrs = [
    { trait_type: 'Virtual Land Parcel', value: locationBundle.parcelId },
    { trait_type: 'Geohash', value: locationBundle.geohash },
    { trait_type: 'City', value: locationBundle.geoInfo.city || 'Unknown' },
    { trait_type: 'Country', value: locationBundle.geoInfo.country || 'Unknown' },
    { trait_type: 'Model Format', value: String(modelFormat || 'glb').toUpperCase() },
    { trait_type: 'Voxel Count', display_type: 'number', value: voxels.length },
    { trait_type: 'Proof of Location Score', display_type: 'number', value: locationBundle.score },
    {
      trait_type: 'Camera-Gyro Flow Match',
      display_type: 'boost_percentage',
      value: Math.round((locationBundle.proofBundle.sensors.opticalFlowCorrelation || 0) * 100)
    },
    { trait_type: 'Solar Regime', value: locationBundle.solar.regime },
    { trait_type: 'Resale Fee', value: `${royaltyBps / 100}%` }
  ];

  if (elev.anchorAltitudeMeters !== null && elev.anchorAltitudeMeters !== undefined) {
    attrs.push({
      trait_type: 'Anchor Elevation (m)',
      display_type: 'number',
      value: elev.anchorAltitudeMeters
    });
  }
  if (elev.heightAboveGroundMeters !== null && elev.heightAboveGroundMeters !== undefined) {
    attrs.push({
      trait_type: 'Height Above Ground (m)',
      display_type: 'number',
      value: elev.heightAboveGroundMeters
    });
  }

  return {
    name: title,
    description,
    image: imageUri,
    animation_url: modelUri,
    animation_mime_type: modelMimeType,
    ...(voxelJsonUri ? { voxel_model_uri: voxelJsonUri } : {}),
    external_url: `${publicUrl}/?sculpture=${sculptureId}`,
    seller_fee_basis_points: royaltyBps,
    fee_recipient: royaltyReceiver,
    properties: {
      category: '3d-model',
      files: [
        { uri: modelUri, type: modelMimeType },
        { uri: imageUri, type: 'image/png' }
      ]
    },
    royalty: {
      standard: 'ERC-2981',
      resale_fee_bps: royaltyBps,
      resale_fee_percent: royaltyBps / 100,
      recipient: royaltyReceiver
    },
    virtual_land: {
      parcel_id: locationBundle.parcelId,
      geohash: locationBundle.geohash,
      bounds: locationBundle.parcelBounds,
      claimant: creatorAddress,
      anchor_elevation_meters: elev.anchorAltitudeMeters ?? null
    },
    location: {
      latitude: locationBundle.lat,
      longitude: locationBundle.lng,
      altitude_meters: locationBundle.altitude,
      altitude_accuracy_meters: elev.altitudeAccuracyMeters ?? null,
      altitude_source: elev.altitudeSource || 'unavailable',
      terrain_elevation_meters: elev.terrainElevationMeters ?? null,
      height_above_ground_meters: elev.heightAboveGroundMeters ?? null,
      sculpture_vertical_min_m: elev.sculptureVerticalMinM ?? 0,
      sculpture_vertical_max_m: elev.sculptureVerticalMaxM ?? 0,
      gps_accuracy_meters: locationBundle.accuracy,
      compass_heading_deg: locationBundle.heading,
      timezone: locationBundle.timezone,
      place_name: locationBundle.geoInfo.placeName,
      neighborhood: locationBundle.geoInfo.neighborhood,
      road: locationBundle.geoInfo.road,
      city: locationBundle.geoInfo.city,
      state: locationBundle.geoInfo.state,
      country: locationBundle.geoInfo.country,
      country_code: locationBundle.geoInfo.countryCode,
      postcode: locationBundle.geoInfo.postcode,
      display_name: locationBundle.geoInfo.displayName,
      solar_altitude_deg: locationBundle.solar.solarAltitudeDeg,
      solar_azimuth_deg: locationBundle.solar.solarAzimuthDeg ?? null,
      solar_regime: locationBundle.solar.regime
    },
    proof_of_location: {
      hash: locationBundle.proofHash,
      score: locationBundle.score,
      verified: locationBundle.verified,
      ...locationBundle.proofBundle
    },
    attributes: attrs
  };
}

export function buildContractMetadata({
  publicUrl,
  apiOrigin,
  royaltyBps = 500,
  royaltyReceiver,
  contractAddress,
  chain
}) {
  return {
    name: 'GRAFFILAND 3D',
    symbol: 'GLAND',
    description:
      'Location-anchored 3D voxel graffiti sculptures and Geohash Virtual Land deeds verified by Camera + GPS Proof of Location on Robinhood Chain.',
    image: `${publicUrl}/icon-512.png`,
    external_link: publicUrl,
    seller_fee_basis_points: royaltyBps,
    fee_recipient: royaltyReceiver,
    royalties: {
      standard: 'ERC-2981',
      bps: royaltyBps,
      percent: royaltyBps / 100,
      recipient: royaltyReceiver
    },
    contract: {
      address: contractAddress || null,
      chainId: chain?.chainId || 46630,
      chainName: chain?.name || 'Robinhood Chain Testnet',
      standards: ['ERC-721', 'ERC-721Enumerable', 'ERC-721URIStorage', 'ERC-4906', 'ERC-2981', 'EIP-7572'],
      tokenMetadataEndpoint: `${apiOrigin}/api/tokens/{id}.json`
    }
  };
}

export function formatMarketplaceTokenMetadata(row, { apiOrigin, publicUrl }) {
  const s = serializeSculptureRow(row, { includeVoxels: false });
  const glbUrl = s.customModel?.downloadUrl
    ? `${apiOrigin}${s.customModel.downloadUrl}`
    : `${apiOrigin}/api/sculptures/${s.id}/model.glb`;
  const modelMime = s.customModel?.mimeType || 'model/gltf-binary';
  const imageUrl = s.ipfs?.imageCid
    ? `${apiOrigin}/ipfs/${s.ipfs.imageCid}`
    : `${publicUrl}/icon-512.png`;
  const pol = s.proofOfLocation || {};
  const elev = s.elevation || {};
  const geo = pol.geoInfo || {};
  const attrs = [
    { trait_type: 'Virtual Land Parcel', value: s.parcelId },
    { trait_type: 'Geohash', value: s.geohash },
    { trait_type: 'City', value: geo.city || s.placeName || 'Unknown' },
    { trait_type: 'Country', value: s.country || geo.country || 'Unknown' },
    { trait_type: 'Voxel Count', display_type: 'number', value: s.voxelCount },
    { trait_type: 'Proof of Location Score', display_type: 'number', value: s.polScore },
    { trait_type: 'Resale Fee', value: `${s.chain.royaltyPercent}%` }
  ];
  if (elev.anchorAltitudeMeters !== null && elev.anchorAltitudeMeters !== undefined) {
    attrs.push({
      trait_type: 'Anchor Elevation (m)',
      display_type: 'number',
      value: elev.anchorAltitudeMeters
    });
  }
  return {
    name: s.title,
    description: s.description,
    image: imageUrl,
    animation_url: glbUrl,
    animation_mime_type: modelMime,
    external_url: `${publicUrl}/?sculpture=${s.id}`,
    seller_fee_basis_points: s.chain.royaltyBps,
    fee_recipient: s.chain.royaltyReceiver,
    owner: s.recipientAddress,
    token_id: s.chain.tokenId,
    contract_address: s.chain.contractAddress,
    chain_id: s.chain.chainId,
    properties: {
      category: '3d-model',
      files: [
        { uri: glbUrl, type: modelMime },
        { uri: imageUrl, type: 'image/png' }
      ]
    },
    royalty: {
      standard: 'ERC-2981',
      resale_fee_bps: s.chain.royaltyBps,
      resale_fee_percent: s.chain.royaltyPercent,
      recipient: s.chain.royaltyReceiver
    },
    virtual_land: {
      parcel_id: s.parcelId,
      geohash: s.geohash,
      bounds: s.parcelBounds,
      current_owner: s.recipientAddress,
      anchor_elevation_meters: elev.anchorAltitudeMeters ?? null
    },
    location: {
      latitude: s.lat,
      longitude: s.lng,
      altitude_meters: s.altitude,
      altitude_accuracy_meters: elev.altitudeAccuracyMeters ?? null,
      altitude_source: elev.altitudeSource || 'unavailable',
      terrain_elevation_meters: elev.terrainElevationMeters ?? null,
      height_above_ground_meters: elev.heightAboveGroundMeters ?? null,
      sculpture_vertical_min_m: elev.sculptureVerticalMinM ?? 0,
      sculpture_vertical_max_m: elev.sculptureVerticalMaxM ?? 0,
      place_name: s.placeName || geo.placeName || '',
      country: s.country || geo.country || '',
      timezone: s.timezone || ''
    },
    proof_of_location_hash: s.proofHash,
    attributes: attrs
  };
}
