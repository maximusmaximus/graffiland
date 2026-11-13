import { decodeGeohashBounds } from '../server/services/pol.mjs';

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

export function serializeSculptureRow(row, { includeAdminFields = false, includeVoxels = true } = {}) {
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

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    creatorSub: row.creator_sub,
    creatorName: row.creator_name,
    ...(includeAdminFields ? { creatorEmail: row.creator_email } : {}),
    recipientAddress: row.recipient_address,
    lat: row.lat,
    lng: row.lng,
    altitude: row.altitude,
    elevation,
    accuracy: row.accuracy,
    heading: row.heading,
    parcelId: row.parcel_id,
    geohash: row.geohash,
    parcelBounds: decodeGeohashBounds(row.geohash),
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
      gatewayUrl: row.ipfs_gateway_url
    },
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
    ...(includeAdminFields
      ? {
          hiddenReason: row.hidden_reason || '',
          hiddenBy: row.hidden_by || ''
        }
      : {}),
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
    external_url: `${publicUrl}/?sculpture=${sculptureId}`,
    seller_fee_basis_points: royaltyBps,
    fee_recipient: royaltyReceiver,
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
