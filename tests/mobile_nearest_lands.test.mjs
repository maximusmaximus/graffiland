import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildGoogleMapsLandUrl,
  computeClosestLandsPerimeterFit,
  extractParcelPerimeterPoints,
  formatDistanceMeters,
  formatLandDimensions,
  formatLandExpiration,
  formatSculptureAssetMeta,
  formatSimpleLandLabel,
  groupNearestLandsWithSculptures
} from '../client/src/utils/landMapHelpers.js';

describe('Mobile Nearest Lands Map Helpers', () => {
  test('buildGoogleMapsLandUrl builds valid directions URLs and rejects invalid coordinates', () => {
    const url = buildGoogleMapsLandUrl(37.774931, -122.419416);
    assert.equal(
      url,
      'https://www.google.com/maps/dir/?api=1&destination=37.774931%2C-122.419416'
    );
    assert.equal(buildGoogleMapsLandUrl(null, -122.4), '');
    assert.equal(buildGoogleMapsLandUrl('bad', -122.4), '');
  });

  test('formatDistanceMeters formats meters and kilometers cleanly', () => {
    assert.equal(formatDistanceMeters(0), '0 m');
    assert.equal(formatDistanceMeters(418.6), '419 m');
    assert.equal(formatDistanceMeters(1460), '1.5 km');
    assert.equal(formatDistanceMeters(18400), '18 km');
    assert.equal(formatDistanceMeters(null), '');
  });

  test('formatLandExpiration reports remaining lease time, urgent window, expired, and permanent states', () => {
    const now = Date.parse('2026-11-20T12:00:00.000Z');

    const multiDay = formatLandExpiration(
      { stewardStatus: 'dormant', leaseExpiresAt: '2026-11-25T18:30:00.000Z' },
      now
    );
    assert.equal(multiDay.state, 'expiring');
    assert.equal(multiDay.urgent, false);
    assert.equal(multiDay.badgeText, '5d 6h left');

    const urgentHours = formatLandExpiration(
      { stewardStatus: 'dormant', leaseExpiresAt: '2026-11-20T18:25:00.000Z' },
      now
    );
    assert.equal(urgentHours.state, 'expiring-soon');
    assert.equal(urgentHours.urgent, true);
    assert.equal(urgentHours.badgeText, '6h 25m left');

    const urgentMins = formatLandExpiration(
      { stewardStatus: 'dormant', leaseExpiresAt: '2026-11-20T12:19:00.000Z' },
      now
    );
    assert.equal(urgentMins.state, 'expiring-soon');
    assert.equal(urgentMins.urgent, true);
    assert.equal(urgentMins.badgeText, '19m left');

    const expired = formatLandExpiration(
      { stewardStatus: 'dormant', leaseExpiresAt: '2026-11-19T10:00:00.000Z' },
      now
    );
    assert.equal(expired.state, 'expired');
    assert.equal(expired.urgent, true);
    assert.equal(expired.badgeText, 'Expired');

    const permanent = formatLandExpiration(
      { stewardStatus: 'awakened', awakenedAt: '2026-11-18T00:00:00.000Z' },
      now
    );
    assert.equal(permanent.state, 'permanent');
    assert.equal(permanent.urgent, false);
    assert.equal(permanent.badgeText, 'Permanent');
  });

  test('formatLandDimensions and formatSculptureAssetMeta summarize volume and 3D model info', () => {
    assert.equal(
      formatLandDimensions({
        volume: { widthMeters: 24, depthMeters: 16, heightMeters: 36, footprintAreaSqM: 384 }
      }),
      '24×16×36 m · 384 m²'
    );
    assert.equal(formatSculptureAssetMeta({ voxelCount: 42 }), '42 blocks');
    assert.equal(
      formatSculptureAssetMeta({
        modelType: 'custom-3d',
        customModel: { format: 'glb', triangleCount: 1250 }
      }),
      'GLB 3D · 1,250 tris'
    );
  });

  test('groupNearestLandsWithSculptures sorts nearest-first, nests sculptures, handles 5km filter and auto-fallback', () => {
    const now = Date.parse('2026-11-20T12:00:00.000Z');
    const userLoc = { lat: 37.7749, lng: -122.4194 };
    const parcels = [
      {
        parcelId: 'GLAND-FAR',
        customName: 'Far Pier Lot',
        centerLat: 37.9,
        centerLng: -122.4194,
        stewardStatus: 'awakened',
        stewardName: 'Maya'
      },
      {
        parcelId: 'GLAND-NEAR',
        customName: 'Civic Center Corner',
        centerLat: 37.7755,
        centerLng: -122.4194,
        stewardStatus: 'dormant',
        stewardType: 'agent',
        stewardName: 'PainterBot',
        leaseExpiresAt: '2026-11-21T02:00:00.000Z',
        featuredSculptureId: 'sc-featured'
      },
      {
        parcelId: 'GLAND-MID',
        customName: 'Mission Courtyard',
        centerLat: 37.768,
        centerLng: -122.4194,
        stewardStatus: 'awakened',
        stewardName: 'Leo'
      }
    ];
    const sculptures = [
      {
        id: 'sc-stage',
        parcelId: 'GLAND-NEAR',
        title: 'Plinth Base',
        layerRole: 'steward_stage',
        lat: 37.7755,
        lng: -122.4194,
        voxelCount: 12,
        createdAt: '2026-11-20T10:00:00.000Z'
      },
      {
        id: 'sc-featured',
        parcelId: 'GLAND-NEAR',
        title: 'Neon Crane',
        layerRole: 'artist_work',
        lat: 37.7755,
        lng: -122.4194,
        voxelCount: 88,
        createdAt: '2026-11-20T09:00:00.000Z'
      },
      {
        id: 'sc-orphan',
        parcelId: 'GLAND-ORPHAN',
        title: 'Orphan Beacon',
        lat: 37.776,
        lng: -122.4194,
        voxelCount: 15,
        createdAt: '2026-11-20T11:00:00.000Z'
      }
    ];

    const nearby = groupNearestLandsWithSculptures({
      parcels,
      sculptures,
      location: userLoc,
      filterMode: 'nearby',
      radiusMeters: 5000,
      nowMs: now
    });

    assert.equal(nearby.autoFallbackToAll, false);
    assert.deepEqual(
      nearby.displayedLands.map((l) => l.parcelId),
      ['GLAND-NEAR', 'GLAND-ORPHAN', 'GLAND-MID']
    );
    // Featured artwork sorts first inside GLAND-NEAR before steward_stage
    assert.deepEqual(
      nearby.displayedLands[0].sculptures.map((s) => s.id),
      ['sc-featured', 'sc-stage']
    );
    assert.equal(nearby.displayedLands[0].expiration.state, 'expiring-soon');
    assert.equal(nearby.displayedLands[0].expiration.badgeText, '14h left');
    assert.ok(nearby.displayedLands[0].googleMapsUrl.includes('google.com/maps/dir'));
    assert.equal(nearby.expiringCount, 1);

    // When user is far from every land (> 5 km), nearby mode auto-falls back to closest lands sorted by distance
    const farUser = groupNearestLandsWithSculptures({
      parcels,
      sculptures,
      location: { lat: 34.0522, lng: -118.2437 },
      filterMode: 'nearby',
      radiusMeters: 5000,
      nowMs: now
    });
    assert.equal(farUser.autoFallbackToAll, true);
    assert.equal(farUser.displayedLands.length, 4);
    assert.equal(farUser.displayedLands[0].parcelId, 'GLAND-MID');
  });

  test('computeClosestLandsPerimeterFit frames all perimeter corners of the closest lands cluster and formatSimpleLandLabel stays concise', () => {
    assert.equal(formatSimpleLandLabel({ parcelId: 'GLAND-9R1652PV', customName: '' }, 0), '#1 9R1652PV');
    assert.equal(
      formatSimpleLandLabel({ parcelId: 'GLAND-9R1652PV', customName: 'Civic Neon Plaza' }, 1),
      '#2 Civic Neon Plaza'
    );
    assert.equal(
      formatSimpleLandLabel({ parcelId: 'GLAND-9R1652PV', customName: 'Very Long Sculpture Courtyard Name' }),
      'Very Long Sculpture…'
    );

    const p1 = {
      parcelId: 'GLAND-CLOSE1',
      customName: 'Block A',
      centerLat: 39.7276,
      centerLng: -121.8384,
      volume: {
        centerLat: 39.7276,
        centerLng: -121.8384,
        corners: [
          [-121.8388, 39.7276],
          [-121.8384, 39.7279],
          [-121.838, 39.7275],
          [-121.8384, 39.7272]
        ]
      }
    };
    const p2 = {
      parcelId: 'GLAND-CLOSE2',
      customName: 'Block B',
      centerLat: 39.7283,
      centerLng: -121.8389,
      volume: {
        centerLat: 39.7283,
        centerLng: -121.8389,
        corners: [
          [-121.8394, 39.7283],
          [-121.8389, 39.7288],
          [-121.8383, 39.7283],
          [-121.8389, 39.7278]
        ]
      }
    };
    const pFar = {
      parcelId: 'GLAND-TOKYO',
      customName: 'Far Away Lot',
      centerLat: 35.6762,
      centerLng: 139.6503,
      bounds: { sw: [35.676, 139.65], ne: [35.6764, 139.6506], center: [35.6762, 139.6503] }
    };

    assert.equal(extractParcelPerimeterPoints(p1).length, 4);

    // Closest cluster from SF (223 km away) picks BOTH Chico parcels and excludes the distant Tokyo outlier
    const fit = computeClosestLandsPerimeterFit({
      parcels: [pFar, p1, p2],
      location: { lat: 37.7749, lng: -122.4194 }
    });
    assert.deepEqual(
      fit.clusterLands.map((l) => l.parcelId).sort(),
      ['GLAND-CLOSE1', 'GLAND-CLOSE2']
    );
    assert.equal(fit.perimeterPoints.length, 8);
    // Exact perimeter outer corners must define boundsLatLng
    assert.deepEqual(fit.boundsLatLng, [
      [39.7272, -121.8394],
      [39.7288, -121.838]
    ]);
    assert.deepEqual(fit.boundsLngLat, [
      [-121.8394, 39.7272],
      [-121.838, 39.7288]
    ]);
  });
});
