import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAuthorHandleForStorage,
  resolvePublicUserHandle,
  resolveSafeUserAvatar
} from '../shared/userDisplay.mjs';
import {
  buildObjectFittedLandVolume,
  centerVoxelsHorizontally,
  ensureLandVolumeFitsSculptures,
  offsetLatLngByLocalXZ
} from '../shared/landVolume.mjs';
import {
  computeArLandPrismLocalGeometry,
  isPointInsideParcelFootprint
} from '../client/src/utils/arLandHelpers.js';
import {
  buildDefaultHudReservedRects,
  placeFloatingLabelRect,
  rectsOverlap
} from '../client/src/utils/canvasLabelLayout.js';

describe('Public Usernames, Off-Origin Land Fit & Non-Overlapping HUD Layout', () => {
  test('userDisplay strictly exposes chosen @username + safe avatar and NEVER Google first/last names or Gmail avatars', () => {
    const humanWithUsername = {
      id: 'google:115933089146422565011',
      name: 'drawing "The Drawing Show" show',
      username: 'bigdog',
      picture: 'https://lh3.googleusercontent.com/a/ACg8ocFakeGooglePhoto=s96-c',
      avatarImage: ''
    };
    assert.equal(resolvePublicUserHandle(humanWithUsername), '@bigdog');
    assert.equal(resolveAuthorHandleForStorage(humanWithUsername), '@bigdog');
    assert.equal(resolveSafeUserAvatar(humanWithUsername), '');

    const humanWithCustomIcon = {
      ...humanWithUsername,
      avatarImage: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA='
    };
    assert.equal(resolveSafeUserAvatar(humanWithCustomIcon), humanWithCustomIcon.avatarImage);

    // Human who has NOT chosen a username yet must STILL never leak Google first/last name
    const humanNoUsername = {
      id: 'google:999',
      name: 'Max Infeld',
      username: '',
      userNumber: 7
    };
    const fallbackHandle = resolvePublicUserHandle(humanNoUsername);
    assert.ok(!fallbackHandle.includes('Max'));
    assert.ok(!fallbackHandle.includes('Infeld'));
    assert.equal(fallbackHandle, 'Creator #7');

    // Autonomous AI agents may display their registered agent name
    const aiAgent = {
      id: 'agent:sculptbot',
      stewardType: 'agent',
      stewardName: 'SculptBot Prime'
    };
    assert.equal(resolvePublicUserHandle(aiAgent), 'SculptBot Prime');
  });

  test('Squiggle Bro live off-origin voxel coordinates center cleanly on publish and fit strictly INSIDE its 10%-padded land volume and AR prism', () => {
    // Exact bounding corners from live Squiggle Bro sculpture (GLAND-9R1652WM)
    const squiggleVoxels = [
      { x: 0.467, y: -2.152, z: 1.465, color: '#22c55e' },
      { x: 2.512, y: -2.125, z: 2.381, color: '#eab308' },
      { x: 4.557, y: -2.098, z: 3.297, color: '#ec4899' }
    ];
    const scLat = 39.730204;
    const scLng = -121.840674;

    // 1) centerVoxelsHorizontally recenters new publishes on local (0, 0) while shifting (lat, lng) to the real drawn spot
    const centered = centerVoxelsHorizontally(squiggleVoxels);
    assert.ok(Math.abs(centered.bounds.midX) < 1e-3);
    assert.ok(Math.abs(centered.bounds.midZ) < 1e-3);
    assert.ok(Math.abs(centered.shiftX - 2.512) < 0.01);
    assert.ok(Math.abs(centered.shiftZ - 2.381) < 0.01);

    const publishedGeo = offsetLatLngByLocalXZ(scLat, scLng, centered.shiftX, centered.shiftZ);
    const fitted = buildObjectFittedLandVolume({
      parcelId: 'GLAND-9R1652WM',
      lat: publishedGeo.lat,
      lng: publishedGeo.lng,
      voxels: centered.voxels,
      paddingFraction: 0.1
    });
    assert.ok(fitted);
    for (const v of centered.voxels) {
      const geo = offsetLatLngByLocalXZ(publishedGeo.lat, publishedGeo.lng, v.x, v.z);
      assert.equal(
        isPointInsideParcelFootprint(geo.lat, geo.lng, fitted),
        true,
        `Centered voxel (${v.x}, ${v.z}) must lie strictly inside its fitted land footprint`
      );
    }

    // 2) ensureLandVolumeFitsSculptures expands any parcel whose placed sculpture (with anchorOffset) extends outside
    const shiftedSculpture = {
      lat: publishedGeo.lat,
      lng: publishedGeo.lng,
      voxels: centered.voxels,
      anchorOffset: { dx: 4.2, dy: 0, dz: 2.5, yaw: 0 },
      parcelId: 'GLAND-9R1652WM'
    };
    const repaired = ensureLandVolumeFitsSculptures(fitted, [shiftedSculpture]);
    const shiftedCenterGeo = offsetLatLngByLocalXZ(publishedGeo.lat, publishedGeo.lng, 4.2, 2.5);
    assert.equal(isPointInsideParcelFootprint(shiftedCenterGeo.lat, shiftedCenterGeo.lng, repaired), true);

    // 3) AR prism geometry expands vertically & horizontally to enclose rendered voxels (even at y = -2.15m)
    const arPrism = computeArLandPrismLocalGeometry({
      location: { lat: publishedGeo.lat, lng: publishedGeo.lng },
      volume: fitted,
      baseY: -1.15,
      enclosingLocalBox: {
        minX: -2.07,
        maxX: 2.07,
        minY: -2.18,
        maxY: -2.07,
        minZ: -0.94,
        maxZ: 0.94
      }
    });
    assert.ok(arPrism);
    assert.ok(arPrism.baseY < -2.18, 'AR prism floor must drop below sculpture minY');
    assert.ok(arPrism.topY > -2.07, 'AR prism roof must sit above sculpture maxY');
  });

  test('canvasLabelLayout prevents secondary floating land labels from overlapping top-right NW / 90° HUD buttons', () => {
    const stageW = 310;
    const stageH = 228;
    const reserved = buildDefaultHudReservedRects({
      stageWidth: stageW,
      stageHeight: stageH,
      measuredRects: [
        { x: 6, y: 6, w: 146, h: 30 }, // Iso | Area | 2D
        { x: 184, y: 6, w: 120, h: 30 }, // NW + 90°
        { x: 6, y: 192, w: 72, h: 28 }, // Scale bar
        { x: 248, y: 192, w: 56, h: 28 } // Fit
      ]
    });
    const placed = [];

    // Primary land label centered in open middle
    const primary = placeFloatingLabelRect({
      desiredX: 70,
      desiredY: 72,
      width: 170,
      height: 20,
      stageWidth: stageW,
      stageHeight: stageH,
      reservedRects: reserved,
      placedRects: placed,
      isPrimary: true
    });
    assert.ok(primary);
    for (const r of reserved) {
      assert.equal(rectsOverlap(primary, r, 0), false);
    }
    placed.push(primary);

    // Secondary neighbor land label trying to render directly behind [NW] [↻ 90°] at top-right!
    const neighbor = placeFloatingLabelRect({
      desiredX: 200,
      desiredY: 8,
      width: 96,
      height: 20,
      stageWidth: stageW,
      stageHeight: stageH,
      reservedRects: reserved,
      placedRects: placed,
      isPrimary: false
    });
    // Must either be nudged completely clear of every HUD button & primary label, or suppressed (null)
    if (neighbor) {
      for (const r of reserved) {
        assert.equal(rectsOverlap(neighbor, r, 0), false);
      }
      assert.equal(rectsOverlap(neighbor, primary, 0), false);
    }
  });
});
