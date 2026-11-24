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
  groupNearestLandsWithSculptures,
  isLandOwnedByUser
} from '../client/src/utils/landMapHelpers.js';
import {
  computeArLandPrismLocalGeometry,
  computeParcelEdgeDistanceMeters,
  findNearbyCameraLands,
  isPointInsideParcelFootprint
} from '../client/src/utils/arLandHelpers.js';
import {
  computeFloatingLandLabelBox,
  computeSideArtworkCallouts
} from '../client/src/utils/map3dLabelOverlay.js';

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
      { stewardStatus: 'awakened', awakenedAt: '2026-11-18T00:00:00.000Z', hadHumanInteraction: true },
      now
    );
    assert.equal(permanent.state, 'permanent');
    assert.equal(permanent.urgent, false);
    assert.equal(permanent.badgeText, 'Permanent');

    const mapMadeFirst = formatLandExpiration(
      {
        stewardStatus: 'awakened',
        hadHumanInteraction: false,
        inactivityExpiresAt: '2026-12-18T12:00:00.000Z'
      },
      now
    );
    assert.equal(mapMadeFirst.state, 'expiring');
    assert.equal(mapMadeFirst.badgeText, '28d left');
    assert.match(mapMadeFirst.detailText, /Land created first/i);
    assert.match(mapMadeFirst.detailText, /fully mint & permanently own/i);
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

  test('computeClosestLandsPerimeterFit frames all perimeter corners of the closest lands cluster and formatSimpleLandLabel never leaks internal parcel IDs', () => {
    assert.equal(formatSimpleLandLabel({ parcelId: 'GLAND-9R1652PV', customName: '' }, 0), '#1 Unnamed Land');
    assert.equal(
      formatSimpleLandLabel({ parcelId: 'GLAND-9R1652PV', customName: 'GLAND-9R1652PV' }, 0),
      '#1 Unnamed Land'
    );
    assert.equal(
      formatSimpleLandLabel({ parcelId: 'GLAND-9R16561P', customName: '', firstSculptureTitle: 'Magnolia' }, 0),
      '#1 Magnolia Land'
    );
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

  test('isLandOwnedByUser accurately identifies owned lands via ownedParcelIds, ownerSub, or wallet and returns false when signed out', () => {
    const user = {
      id: 'google:owner-1',
      walletAddress: '0xAaBbCc0000000000000000000000000000000001',
      customPayoutAddress: '0xAaBbCc0000000000000000000000000000000002'
    };
    const landById = { parcelId: 'GLAND-MINE1', ownerSub: 'someone-else' };
    const landBySub = { parcelId: 'GLAND-MINE2', ownerSub: 'google:owner-1' };
    const landByWallet = {
      parcelId: 'GLAND-MINE3',
      ownerSub: 'other',
      firstClaimantAddress: '0xaabbcc0000000000000000000000000000000002'
    };
    const otherLand = {
      parcelId: 'GLAND-OTHER',
      ownerSub: 'google:stranger',
      firstClaimantAddress: '0x9999990000000000000000000000000000000099'
    };

    assert.equal(isLandOwnedByUser(landBySub, { user: null, ownedParcelIds: ['GLAND-MINE2'] }), false);
    assert.equal(isLandOwnedByUser(landById, { user, ownedParcelIds: ['gland-mine1'] }), true);
    assert.equal(isLandOwnedByUser(landBySub, { user }), true);
    assert.equal(isLandOwnedByUser(landByWallet, { user }), true);
    assert.equal(isLandOwnedByUser(otherLand, { user, ownedParcelIds: ['GLAND-MINE1'] }), false);
  });

  test('arLandHelpers detects inside/near lands from camera GPS and projects 3D AR land prism vertices', () => {
    const userLoc = { lat: 39.738873, lng: -121.847904 };
    const insideLand = {
      parcelId: 'GLAND-INSIDE',
      customName: 'Magnolia Lot',
      ownerSub: 'google:owner-1',
      stewardStatus: 'awakened',
      volume: {
        centerLat: 39.738873,
        centerLng: -121.847904,
        widthMeters: 2.82,
        depthMeters: 2.94,
        heightMeters: 1.92,
        corners: [
          [-121.8479205, 39.7388862],
          [-121.8478875, 39.7388862],
          [-121.8478875, 39.7388598],
          [-121.8479205, 39.7388598]
        ]
      }
    };
    const nearLand = {
      parcelId: 'GLAND-NEAR20',
      customName: 'Corner Plaza',
      ownerSub: 'google:other',
      stewardStatus: 'awakened',
      volume: {
        centerLat: 39.73905,
        centerLng: -121.847904,
        widthMeters: 10,
        depthMeters: 10,
        heightMeters: 12
      }
    };
    const farLand = {
      parcelId: 'GLAND-FARAWAY',
      customName: 'Distant Peak',
      centerLat: 37.7749,
      centerLng: -122.4194,
      stewardStatus: 'awakened'
    };

    assert.equal(isPointInsideParcelFootprint(userLoc.lat, userLoc.lng, insideLand.volume), true);
    assert.equal(computeParcelEdgeDistanceMeters(userLoc.lat, userLoc.lng, insideLand.volume), 0);

    const result = findNearbyCameraLands({
      parcels: [farLand, nearLand, insideLand],
      sculptures: [
        { id: 'sc-1', parcelId: 'GLAND-INSIDE', title: 'Magnolia', lat: 39.738873, lng: -121.847904 }
      ],
      location: userLoc,
      user: { id: 'google:owner-1' },
      ownedParcelIds: ['GLAND-INSIDE']
    });

    assert.equal(result.visibleLands.length, 2, 'Distant land (>120m) is excluded from camera view');
    assert.equal(result.primaryLand?.parcelId, 'GLAND-INSIDE');
    assert.equal(result.primaryLand?.isInside, true);
    assert.equal(result.primaryLand?.isOwned, true);
    assert.equal(result.primaryLand?.sculptures.length, 1);
    assert.equal(result.immediateLands.length, 2);
    assert.equal(result.immediateLands[1].parcelId, 'GLAND-NEAR20');
    assert.equal(result.immediateLands[1].isInside, false);
    assert.equal(result.immediateLands[1].isNear, true);

    const prism = computeArLandPrismLocalGeometry({
      location: userLoc,
      volume: result.primaryLand.volume,
      baseY: -1.15
    });
    assert.ok(prism);
    assert.equal(prism.bottomCorners.length, 4);
    assert.equal(prism.topCorners.length, 4);
    assert.equal(prism.baseY, -1.15);
    assert.equal(prism.topY, Number((-1.15 + 1.92).toFixed(3)));
  });

  test('computeFloatingLandLabelBox and computeSideArtworkCallouts lay out floating land label and non-overlapping left/right artwork pointers', () => {
    const landBox = computeFloatingLandLabelBox(
      {
        bottom: [
          { x: 340, y: 245 },
          { x: 460, y: 245 },
          { x: 460, y: 285 },
          { x: 340, y: 285 }
        ],
        top: [
          { x: 340, y: 140 },
          { x: 460, y: 140 },
          { x: 460, y: 180 },
          { x: 340, y: 180 }
        ]
      },
      { viewportWidth: 800, liftPx: 20, minY: 48, pillHeight: 28, approxWidth: 160 }
    );
    assert.ok(landBox);
    assert.equal(landBox.centerX, 400);
    assert.ok(landBox.y + landBox.height <= 140, 'Floating land label stays strictly above wireframe');
    assert.equal(landBox.toX, 400);
    assert.equal(landBox.toY, 160, 'Land tag leader line connects strictly to top center of land boundary');

    const sculptures = [
      { id: 'sc-1', title: 'Alpha Tree', modelType: 'custom-3d', customModel: { format: 'glb' }, lat: 39.738, lng: -121.849 },
      { id: 'sc-2', title: 'Beta Arch', voxelCount: 42, lat: 39.7381, lng: -121.8488 },
      { id: 'sc-3', title: 'Gamma Cube', voxelCount: 18, lat: 39.7382, lng: -121.8485 },
      { id: 'sc-4', title: 'Delta Spire', voxelCount: 95, lat: 39.7383, lng: -121.8482 },
      { id: 'sc-5', title: 'Epsilon Orb', voxelCount: 12, lat: 39.7384, lng: -121.8479 }
    ];
    const mockPts = {
      'sc-1': { x: 310, y: 190 },
      'sc-2': { x: 345, y: 196 },
      'sc-3': { x: 380, y: 200 },
      'sc-4': { x: 440, y: 192 },
      'sc-5': { x: 475, y: 198 }
    };

    const seenAltById = {};
    const callouts = computeSideArtworkCallouts({
      sculptures,
      volume: { centerLat: 39.7382, centerLng: -121.8485, heightMeters: 40 },
      viewportWidth: 800,
      viewportHeight: 420,
      selectedSculptureId: 'sc-4',
      topInsetPx: 66,
      bottomInsetPx: 46,
      marginPx: 14,
      labelHeight: 40,
      gapPx: 8,
      getSculptureTransform: (id) =>
        id === 'sc-1'
          ? { lat: 39.738, lng: -121.849, altitudeMeters: 0, anchorDx: 0, anchorDz: 0, renderedSize: { x: 1, y: 2, z: 1 } }
          : null,
      projectScreenPt: (_lng, _lat, alt, sc) => {
        seenAltById[sc.id] = alt;
        return mockPts[sc.id];
      }
    });

    assert.equal(callouts.length, 5);
    assert.equal(seenAltById['sc-1'], 1, 'Pointer targets true un-autoscaled 3D sculpture midpoint (2m / 2 = 1m)');
    assert.ok(seenAltById['sc-2'] < 2, 'Fallback pointer uses real un-autoscaled height instead of autoscaled parcel height');
    for (const c of callouts) {
      assert.ok(
        c.sculptureUrl && c.sculptureUrl.includes(`sculpture=${c.sculptureId}`),
        `Expected side sculpture callout to include direct link for ${c.sculptureId}, got ${c.sculptureUrl}`
      );
    }
    const leftSide = callouts.filter((c) => c.side === 'left').sort((a, b) => a.y - b.y);
    const rightSide = callouts.filter((c) => c.side === 'right').sort((a, b) => a.y - b.y);
    assert.ok(leftSide.length >= 2 && rightSide.length >= 2, 'Balanced left/right side split');

    // No vertical overlaps in either column and all stay inside viewport bounds
    for (const col of [leftSide, rightSide]) {
      for (let i = 0; i < col.length; i += 1) {
        assert.ok(col[i].y >= 66 - 0.5, 'Stays below top inset');
        assert.ok(col[i].y + col[i].height <= 420 - 46 + 0.5, 'Stays above bottom inset');
        if (i > 0) {
          assert.ok(
            col[i].y >= col[i - 1].y + col[i - 1].height + 7.5,
            'Zero vertical overlap between side artwork labels'
          );
        }
      }
    }

    const selectedCallout = callouts.find((c) => c.sculptureId === 'sc-4');
    assert.equal(selectedCallout?.isSelected, true);
    assert.equal(selectedCallout?.side, 'right');
    assert.equal(selectedCallout?.targetX, 440);
    assert.equal(selectedCallout?.targetY, 192);
  });
});
