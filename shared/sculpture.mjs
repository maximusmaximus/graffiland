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

export function serializeSculptureRow(
  row,
  { includeAdminFields = false, includeVoxels = true, transfers } = {}
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

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    creatorSub: row.creator_sub,
    creatorName: row.creator_name,
    ...(includeAdminFields ? { creatorEmail: row.creator_email } : {}),
    recipientAddress: row.recipient_address,
    ownerAddress: row.recipient_address,
    modelGlbUrl: `/api/sculptures/${row.id}/model.glb`,
    metadataUrl: `/api/sculptures/${row.id}/metadata.json`,
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
    animation_mime_type: 'model/gltf-binary',
    ...(voxelJsonUri ? { voxel_model_uri: voxelJsonUri } : {}),
    external_url: `${publicUrl}/?sculpture=${sculptureId}`,
    seller_fee_basis_points: royaltyBps,
    fee_recipient: royaltyReceiver,
    properties: {
      category: '3d-model',
      files: [
        { uri: modelUri, type: 'model/gltf-binary' },
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
  const glbUrl = `${apiOrigin}/api/sculptures/${s.id}/model.glb`;
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
    animation_mime_type: 'model/gltf-binary',
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
        { uri: glbUrl, type: 'model/gltf-binary' },
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
