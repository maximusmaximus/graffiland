import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graffiland-orb-auto-'));
process.env.GRAFFILAND_DB_PATH = path.join(testTmpDir, 'test.sqlite');
process.env.GRAFFILAND_IPFS_DIR = path.join(testTmpDir, 'ipfs');
process.env.PINATA_JWT = '';
process.env.ROBINHOOD_CONTRACT_ADDRESS = '';
process.env.ROBINHOOD_RELAYER_PRIVATE_KEY = '';

const { createAppServer } = await import('../server/index.mjs');
const { getDb } = await import('../server/db.mjs');
const {
  classifyEnvironmentTier,
  seedEnvironmentTierForCoords
} = await import('../shared/geocodeService.mjs');
const {
  ENV_TIER_SEED_THRESHOLDS,
  applyLightingRelaxation,
  computeAutoThresholdsFromPack,
  fetchParcelLandmarkAnchor,
  getLandSecurityPolicy,
  normalizeLightingSlot,
  saveParcelLandmarkAnchor,
  seedLandSecurityPolicy,
  updateLandSecurityPolicy,
  verifyMatchedDescriptorsGeometry,
  verifyOrbProofAgainstParcel
} = await import('../shared/landmarkService.mjs');
const { claimDormantLand, getLandTelemetry } = await import('../shared/agentQuestService.mjs');
const { handleMcpJsonRpc } = await import('../shared/mcpService.mjs');
const { encodeGeohash } = await import('../server/services/pol.mjs');

function wrapSqlite(rawDb) {
  return {
    get: async (sql, params = []) => rawDb.prepare(sql).get(...params),
    all: async (sql, params = []) => rawDb.prepare(sql).all(...params),
    run: async (sql, params = []) => rawDb.prepare(sql).run(...params)
  };
}

function makeFeature(seed, { u, v, response = 58 } = {}) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = (seed * 31 + i * 17) & 0xff;
  }
  return {
    u: u ?? 0.1 + ((seed % 4) * 0.22),
    v: v ?? 0.15 + ((Math.floor(seed / 4) % 3) * 0.28),
    x: 0.4,
    y: 0.1,
    z: -2.4,
    angle: 0.25,
    response,
    descB64: Buffer.from(bytes).toString('base64')
  };
}

function buildHighQualityKeyframes({ lightingTag = 'daylight', countPerKf = 12, response = 65 } = {}) {
  const yaws = [-26, 0, 26];
  return yaws.map((yawOffsetDeg, kIdx) => {
    const features = [];
    for (let i = 0; i < countPerKf; i += 1) {
      const col = i % 4;
      const row = Math.floor(i / 4) % 3;
      features.push(
        makeFeature(kIdx * 40 + i + 1, {
          u: 0.12 + col * 0.24,
          v: 0.16 + row * 0.3,
          response
        })
      );
    }
    return {
      yawOffsetDeg,
      pitchDeg: 0,
      frameWidth: 160,
      frameHeight: 120,
      lightingTag,
      features
    };
  });
}

function buildSparseLowTextureKeyframes({ lightingTag = 'daylight' } = {}) {
  const features = [];
  for (let i = 0; i < 12; i += 1) {
    features.push(
      makeFeature(300 + i, {
        u: 0.35 + (i % 2) * 0.08,
        v: 0.42 + (Math.floor(i / 2) % 2) * 0.08,
        response: 34
      })
    );
  }
  return [
    {
      yawOffsetDeg: 0,
      pitchDeg: 0,
      frameWidth: 160,
      frameHeight: 120,
      lightingTag,
      features
    }
  ];
}

let server;
let baseUrl;
let rawDb;
let dbAdapter;

before(async () => {
  const { server: srv } = createAppServer();
  server = srv;
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  rawDb = getDb();
  dbAdapter = wrapSqlite(rawDb);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    rawDb?.close();
  } catch {
    // ignore
  }
  try {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function apiJson(route, options = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('Hybrid ORB Auto-Calibration, Per-Origin Lifecycle & Security Hardening', () => {
  test('classifyEnvironmentTier deterministically classifies urban, plaza, nature, and unknown', () => {
    assert.equal(
      classifyEnvironmentTier({ category: 'building', type: 'commercial', street: 'Market St', housenumber: '500' }),
      'dense_urban'
    );
    assert.equal(
      classifyEnvironmentTier({ addrType: 'StreetInt', street: 'Mission & 5th', city: 'San Francisco' }),
      'dense_urban'
    );
    assert.equal(
      classifyEnvironmentTier({ osmKey: 'shop', osmValue: 'coffee', city: 'Tokyo' }),
      'dense_urban'
    );
    assert.equal(
      classifyEnvironmentTier({ category: 'leisure', type: 'park', city: 'San Francisco' }),
      'suburban_plaza'
    );
    assert.equal(
      classifyEnvironmentTier({ placeType: 'Plaza', city: 'Lisbon' }),
      'suburban_plaza'
    );
    assert.equal(
      classifyEnvironmentTier({ category: 'natural', type: 'forest' }),
      'open_nature'
    );
    assert.equal(
      classifyEnvironmentTier({ osmKey: 'natural', osmValue: 'beach' }),
      'open_nature'
    );
    assert.equal(classifyEnvironmentTier({}), 'unknown');
  });

  test('seedEnvironmentTierForCoords reuses geoInfo directly and falls back to unknown on fetch failure', async () => {
    const direct = await seedEnvironmentTierForCoords({
      geoInfo: { category: 'building', type: 'retail', street: 'Broadway', housenumber: '100' },
      skipRemoteLookup: true
    });
    assert.equal(direct, 'dense_urban');

    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        throw new Error('simulated network timeout');
      };
      const fallback = await seedEnvironmentTierForCoords({
        lat: 37.7749,
        lng: -122.4194,
        skipRemoteLookup: false,
        timeoutMs: 120
      });
      assert.equal(fallback, 'unknown');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('computeAutoThresholdsFromPack tightens on dense multi-angle scenes and relaxes on sparse nature scenes', () => {
    const denseCal = computeAutoThresholdsFromPack(buildHighQualityKeyframes({ countPerKf: 14, response: 72 }));
    const sparseCal = computeAutoThresholdsFromPack(buildSparseLowTextureKeyframes());

    assert.ok(denseCal.autoMinOrbInliers >= 8, `Expected dense minInliers >= 8, got ${denseCal.autoMinOrbInliers}`);
    assert.ok(denseCal.autoMaxReprojErrPx <= 6.5, `Expected dense maxErr <= 6.5, got ${denseCal.autoMaxReprojErrPx}`);
    assert.ok(sparseCal.autoMinOrbInliers <= 6, `Expected sparse minInliers <= 6, got ${sparseCal.autoMinOrbInliers}`);
    assert.ok(sparseCal.autoMaxReprojErrPx >= 9.5, `Expected sparse maxErr >= 9.5, got ${sparseCal.autoMaxReprojErrPx}`);
    assert.ok(denseCal.autoMinOrbInliers > sparseCal.autoMinOrbInliers);
    assert.ok(denseCal.autoMaxReprojErrPx < sparseCal.autoMaxReprojErrPx);
  });

  test('applyLightingRelaxation relaxes thresholds at twilight/night with floor 4 and respects lightingAdaptive=false', () => {
    const day = applyLightingRelaxation({
      minOrbInliers: 8,
      maxReprojErrPx: 5.5,
      lightingAdaptive: true,
      solarRegime: 'daylight'
    });
    assert.equal(day.effectiveMinOrbInliers, 8);
    assert.equal(day.effectiveMaxReprojErrPx, 5.5);
    assert.equal(day.relaxed, false);

    const twilight = applyLightingRelaxation({
      minOrbInliers: 8,
      maxReprojErrPx: 5.5,
      lightingAdaptive: true,
      solarRegime: 'twilight'
    });
    assert.equal(twilight.effectiveMinOrbInliers, 7);
    assert.equal(twilight.effectiveMaxReprojErrPx, 7.0);
    assert.equal(twilight.relaxed, true);

    const nightNoSlot = applyLightingRelaxation({
      minOrbInliers: 5,
      maxReprojErrPx: 8.0,
      lightingAdaptive: true,
      solarRegime: 'night',
      hasMatchingLightingSlot: false
    });
    assert.equal(nightNoSlot.effectiveMinOrbInliers, 4, 'Must clamp at floor 4');
    assert.equal(nightNoSlot.effectiveMaxReprojErrPx, 10.5);

    const nightWithLowlightSlot = applyLightingRelaxation({
      minOrbInliers: 8,
      maxReprojErrPx: 5.5,
      lightingAdaptive: true,
      solarRegime: 'night',
      hasMatchingLightingSlot: true
    });
    assert.equal(nightWithLowlightSlot.effectiveMinOrbInliers, 7);
    assert.equal(nightWithLowlightSlot.effectiveMaxReprojErrPx, 7.0);

    const disabled = applyLightingRelaxation({
      minOrbInliers: 8,
      maxReprojErrPx: 5.5,
      lightingAdaptive: false,
      solarRegime: 'night'
    });
    assert.equal(disabled.effectiveMinOrbInliers, 8);
    assert.equal(disabled.effectiveMaxReprojErrPx, 5.5);
    assert.equal(disabled.relaxed, false);

    assert.equal(normalizeLightingSlot('low-light', 'daylight'), 'lowlight');
    assert.equal(normalizeLightingSlot('live-scan', 'night'), 'lowlight');
    assert.equal(normalizeLightingSlot('live-scan', 'daylight'), 'daylight');
  });

  test('Per-origin policy seeding: browser_map, agent_mcp, mobile_ar all default requireOrbUnlock=false & seed envTier', async () => {
    const humanUser = {
      id: 'google-orb-browser-user',
      name: 'Browser Mapper',
      wallet_address: '0x1111111111111111111111111111111111111001'
    };
    const agentUser = {
      id: 'agent:orb-scout-01',
      name: 'ORB Scout Agent',
      actorType: 'agent',
      wallet_address: '0x1111111111111111111111111111111111111002'
    };

    const browserClaim = await claimDormantLand(dbAdapter, {
      agentUser: humanUser,
      lat: 37.7812,
      lng: -122.4112,
      customName: 'Browser Plaza Plot',
      envTier: 'suburban_plaza',
      skipRemoteLookup: true
    });
    assert.equal(browserClaim.securityPolicy.originSource, 'browser_map');
    assert.equal(browserClaim.securityPolicy.envTier, 'suburban_plaza');
    assert.equal(browserClaim.securityPolicy.requireOrbUnlock, false);
    assert.equal(browserClaim.securityPolicy.isAuto, true);
    assert.equal(browserClaim.securityPolicy.minOrbInliers, ENV_TIER_SEED_THRESHOLDS.suburban_plaza.minOrbInliers);
    assert.equal(browserClaim.securityPolicy.maxReprojErrPx, ENV_TIER_SEED_THRESHOLDS.suburban_plaza.maxReprojErrPx);

    const agentClaim = await claimDormantLand(dbAdapter, {
      agentUser,
      lat: 37.7695,
      lng: -122.4862,
      customName: 'Agent Nature Grove',
      geoInfo: { category: 'natural', type: 'forest' },
      skipRemoteLookup: true
    });
    assert.equal(agentClaim.securityPolicy.originSource, 'agent_mcp');
    assert.equal(agentClaim.securityPolicy.envTier, 'open_nature');
    assert.equal(agentClaim.securityPolicy.requireOrbUnlock, false);
    assert.equal(agentClaim.securityPolicy.minOrbInliers, 4);
    assert.equal(agentClaim.securityPolicy.maxReprojErrPx, 12.0);

    const mobileGh = encodeGeohash(37.7897, -122.4014, 8);
    const mobileParcelId = `GLAND-${mobileGh.toUpperCase()}`;
    const mobilePolicy = await seedLandSecurityPolicy(dbAdapter, {
      parcelId: mobileParcelId,
      ownerSub: humanUser.id,
      originSource: 'mobile_ar',
      geoInfo: { category: 'building', type: 'commercial', street: 'Montgomery St', housenumber: '44' },
      skipRemoteLookup: true
    });
    assert.equal(mobilePolicy.originSource, 'mobile_ar');
    assert.equal(mobilePolicy.envTier, 'dense_urban');
    assert.equal(mobilePolicy.requireOrbUnlock, false);
    assert.equal(mobilePolicy.minOrbInliers, 8);
    assert.equal(mobilePolicy.maxReprojErrPx, 5.5);
  });

  test('Graceful no_pack state machine, opt-in unlock gate, anti-poisoning visitor first-scan, and dual lighting slot merge', async () => {
    const owner = {
      id: 'google-orb-owner-2',
      name: 'Land Owner',
      wallet_address: '0x2222222222222222222222222222222222222001'
    };
    const visitor = {
      id: 'google-orb-visitor-2',
      name: 'First IRL Visitor',
      wallet_address: '0x2222222222222222222222222222222222222002'
    };
    const attacker = {
      id: 'google-orb-attacker-2',
      name: 'Spoofer',
      wallet_address: '0x2222222222222222222222222222222222222003'
    };

    const pLat = 37.7555;
    const pLng = -122.4215;
    const claim = await claimDormantLand(dbAdapter, {
      agentUser: owner,
      lat: pLat,
      lng: pLng,
      customName: 'Packless Browser Land',
      envTier: 'suburban_plaza',
      skipRemoteLookup: true
    });
    const parcelId = claim.parcelId;

    // 1. Even if owner turns ON requireOrbUnlock before any scan exists, verifyOrbProofAgainstParcel MUST NOT 403
    await updateLandSecurityPolicy(dbAdapter, {
      parcelId,
      user: owner,
      body: { requireOrbUnlock: true }
    });
    const policyBeforePack = await getLandSecurityPolicy(dbAdapter, parcelId);
    assert.equal(policyBeforePack.requireOrbUnlock, true);
    assert.equal(policyBeforePack.hasLandmarkPack, false);

    const noPackRes = await verifyOrbProofAgainstParcel(dbAdapter, {
      parcelId,
      orbProof: null,
      policy: policyBeforePack,
      lat: pLat,
      lng: pLng
    });
    assert.equal(noPackRes.verified, false);
    assert.equal(noPackRes.skipped, true);
    assert.equal(noPackRes.orbStatus, 'no_pack');
    assert.equal(noPackRes.upgradePath, 'first_mobile_scan');

    // Fetch on packless land returns available:false + orbStatus:'no_pack' + effectivePolicy
    const fetchNoPack = await fetchParcelLandmarkAnchor(dbAdapter, {
      parcelId,
      body: { lat: pLat, lng: pLng, deviceProfile: { isMobile: true } },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
    });
    assert.equal(fetchNoPack.available, false);
    assert.equal(fetchNoPack.orbStatus, 'no_pack');
    assert.equal(fetchNoPack.upgradePath, 'first_mobile_scan');
    assert.ok(fetchNoPack.effectivePolicy.maxReprojErrPx > 0);

    // 2. Anti-poisoning gate: visitor off-site (>65m), desktop, or weak scan MUST be rejected
    await assert.rejects(
      () =>
        saveParcelLandmarkAnchor(dbAdapter, {
          parcelId,
          user: attacker,
          body: {
            allowInitialClaim: true,
            lat: pLat + 0.01,
            lng: pLng + 0.01,
            deviceProfile: { isMobile: true },
            keyframes: buildHighQualityKeyframes({ lightingTag: 'daylight' })
          },
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
        }),
      /within 65m/i
    );

    await assert.rejects(
      () =>
        saveParcelLandmarkAnchor(dbAdapter, {
          parcelId,
          user: attacker,
          body: {
            allowInitialClaim: true,
            lat: pLat,
            lng: pLng,
            deviceProfile: { isMobile: true },
            keyframes: buildSparseLowTextureKeyframes({ lightingTag: 'daylight' })
          },
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
        }),
      /anti-poisoning quality gate/i
    );

    // 3. First verified IRL mobile visitor on-site with strong daylight scan SUCCEEDS and self-calibrates Auto thresholds!
    const visitorDaySave = await saveParcelLandmarkAnchor(dbAdapter, {
      parcelId,
      user: visitor,
      body: {
        allowInitialClaim: true,
        lat: pLat,
        lng: pLng,
        deviceProfile: { isMobile: true },
        keyframes: buildHighQualityKeyframes({ lightingTag: 'daylight', countPerKf: 12, response: 68 })
      },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
    });
    assert.equal(visitorDaySave.ok, true);
    assert.deepEqual(visitorDaySave.lightingSlots, ['daylight']);
    assert.equal(visitorDaySave.keyframeCount, 3);
    assert.equal(visitorDaySave.policy.hasLandmarkPack, true);
    assert.equal(visitorDaySave.policy.isAuto, true);
    assert.ok(visitorDaySave.policy.autoMinOrbInliers >= 8);

    // 4. SECURITY FIX: Another non-owner MUST NOT overwrite the already-calibrated 'daylight' slot!
    await assert.rejects(
      () =>
        saveParcelLandmarkAnchor(dbAdapter, {
          parcelId,
          user: attacker,
          body: {
            allowInitialClaim: true,
            lat: pLat,
            lng: pLng,
            deviceProfile: { isMobile: true },
            keyframes: buildHighQualityKeyframes({ lightingTag: 'daylight', countPerKf: 12, response: 70 })
          },
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
        }),
      /already has a calibrated ORB anchor pack/i
    );

    // 5. Non-owner CAN contribute the missing complementary 'lowlight' slot without overwriting 'daylight'!
    const visitorNightSave = await saveParcelLandmarkAnchor(dbAdapter, {
      parcelId,
      user: visitor,
      body: {
        allowInitialClaim: true,
        lat: pLat,
        lng: pLng,
        deviceProfile: { isMobile: true },
        keyframes: buildHighQualityKeyframes({ lightingTag: 'lowlight', countPerKf: 10, response: 52 })
      },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
    });
    assert.equal(visitorNightSave.ok, true);
    assert.deepEqual(visitorNightSave.lightingSlots.sort(), ['daylight', 'lowlight']);
    assert.equal(visitorNightSave.keyframeCount, 6);

    // 6. Owner custom override MUST be preserved across future recalibrations, and revert cleanly on useAuto:true
    const customPol = await updateLandSecurityPolicy(dbAdapter, {
      parcelId,
      user: owner,
      body: { minOrbInliers: 14, maxReprojErrPx: 4.5, requireOrbUnlock: false }
    });
    assert.equal(customPol.policy.overrideFlag, true);
    assert.equal(customPol.policy.isAuto, false);
    assert.equal(customPol.policy.minOrbInliers, 14);
    assert.equal(customPol.policy.maxReprojErrPx, 4.5);

    // Owner recalibrates pack with sparse features -> auto_* updates, active stays overridden at 14/4.5
    const ownerRecal = await saveParcelLandmarkAnchor(dbAdapter, {
      parcelId,
      user: owner,
      body: {
        replaceAll: true,
        keyframes: buildSparseLowTextureKeyframes({ lightingTag: 'daylight' })
      }
    });
    assert.equal(ownerRecal.policy.overrideFlag, true);
    assert.equal(ownerRecal.policy.minOrbInliers, 14);
    assert.equal(ownerRecal.policy.maxReprojErrPx, 4.5);
    assert.ok(ownerRecal.policy.autoMinOrbInliers <= 6);

    // Turning Auto back on reverts active thresholds to auto_* immediately!
    const revertAuto = await updateLandSecurityPolicy(dbAdapter, {
      parcelId,
      user: owner,
      body: { useAuto: true }
    });
    assert.equal(revertAuto.policy.overrideFlag, false);
    assert.equal(revertAuto.policy.isAuto, true);
    assert.equal(revertAuto.policy.minOrbInliers, ownerRecal.policy.autoMinOrbInliers);
    assert.equal(revertAuto.policy.maxReprojErrPx, ownerRecal.policy.autoMaxReprojErrPx);

    // Opt-in unlock gate: with requireOrbUnlock=false and pack present, omitting orbProof skips cleanly!
    const optInSkip = await verifyOrbProofAgainstParcel(dbAdapter, {
      parcelId,
      orbProof: null,
      policy: revertAuto.policy,
      lat: pLat,
      lng: pLng
    });
    assert.equal(optInSkip.skipped, true);
    assert.equal(optInSkip.orbStatus, 'skipped');
  });

  test('Server-side 2D similarity geometric check accepts rotated+scaled camera views and rejects scrambled/omitted spoofs', async () => {
    const owner = {
      id: 'google-orb-geo-owner',
      name: 'Geo Owner',
      wallet_address: '0x3333333333333333333333333333333333333001'
    };
    const pLat = 37.7911;
    const pLng = -122.4088;
    const claim = await claimDormantLand(dbAdapter, {
      agentUser: owner,
      lat: pLat,
      lng: pLng,
      customName: 'Geometry Gate Plaza',
      envTier: 'dense_urban',
      skipRemoteLookup: true
    });
    const parcelId = claim.parcelId;

    const kfs = buildHighQualityKeyframes({ lightingTag: 'daylight', countPerKf: 12, response: 70 });
    const saved = await saveParcelLandmarkAnchor(dbAdapter, {
      parcelId,
      user: owner,
      body: { keyframes: kfs }
    });
    const digest = saved.descriptorDigest;

    await updateLandSecurityPolicy(dbAdapter, {
      parcelId,
      user: owner,
      body: { requireOrbUnlock: true, minOrbInliers: 8, maxReprojErrPx: 6.0, lightingAdaptive: false }
    });
    const strictPolicy = await getLandSecurityPolicy(dbAdapter, parcelId);

    // Build a genuine rotated (+16 deg) + scaled (1.18x) + translated live view of keyframe 0
    const kf0 = kfs[0];
    const theta = (16 * Math.PI) / 180;
    const scale = 1.18;
    const cosT = Math.cos(theta) * scale;
    const sinT = Math.sin(theta) * scale;
    const fw = 160;
    const fh = 120;

    const validSimMatches = kf0.features.slice(0, 10).map((f, idx) => {
      const kx = f.u * fw;
      const ky = f.v * fh;
      // Rotate around frame center so points remain inside [0..1]
      const cx = kx - fw * 0.5;
      const cy = ky - fh * 0.5;
      const lx = cosT * cx - sinT * cy + fw * 0.5 + 3.5;
      const ly = sinT * cx + cosT * cy + fh * 0.5 - 2.0;
      return {
        keyframeIndex: 0,
        featureIndex: idx,
        liveDescB64: f.descB64,
        u: Math.max(0.01, Math.min(0.99, lx / fw)),
        v: Math.max(0.01, Math.min(0.99, ly / fh))
      };
    });

    const okRes = await verifyOrbProofAgainstParcel(dbAdapter, {
      parcelId,
      orbProof: {
        descriptorDigest: digest,
        inlierCount: 10,
        reprojectionErrorPx: 1.9,
        matchedDescriptors: validSimMatches
      },
      policy: strictPolicy,
      lat: pLat,
      lng: pLng,
      nowDate: new Date('2026-06-21T20:00:00Z') // SF noon daylight
    });
    assert.equal(okRes.verified, true);
    assert.equal(okRes.orbStatus, 'verified');
    assert.ok(okRes.geometricInliers >= 8);

    // 1. Omitted matchedDescriptors -> 403
    await assert.rejects(
      () =>
        verifyOrbProofAgainstParcel(dbAdapter, {
          parcelId,
          orbProof: {
            descriptorDigest: digest,
            inlierCount: 10,
            reprojectionErrorPx: 1.9
          },
          policy: strictPolicy,
          lat: pLat,
          lng: pLng
        }),
      /matchedDescriptors array is required/i
    );

    // 2. Valid binary descriptors with scrambled / inconsistent (u, v) coordinates -> 403!
    const scrambledMatches = kf0.features.slice(0, 10).map((f, idx) => ({
      keyframeIndex: 0,
      featureIndex: idx,
      liveDescB64: f.descB64,
      u: ((idx * 37) % 100) / 100,
      v: ((idx * 61 + 19) % 100) / 100
    }));
    await assert.rejects(
      () =>
        verifyOrbProofAgainstParcel(dbAdapter, {
          parcelId,
          orbProof: {
            descriptorDigest: digest,
            inlierCount: 10,
            reprojectionErrorPx: 1.9,
            matchedDescriptors: scrambledMatches
          },
          policy: strictPolicy,
          lat: pLat,
          lng: pLng
        }),
      /geometric verification failed/i
    );

    // 3. Valid binary descriptors stripped of (u, v) -> 403!
    const noUvMatches = kf0.features.slice(0, 10).map((f, idx) => ({
      keyframeIndex: 0,
      featureIndex: idx,
      liveDescB64: f.descB64
    }));
    await assert.rejects(
      () =>
        verifyOrbProofAgainstParcel(dbAdapter, {
          parcelId,
          orbProof: {
            descriptorDigest: digest,
            inlierCount: 10,
            reprojectionErrorPx: 1.9,
            matchedDescriptors: noUvMatches
          },
          policy: strictPolicy,
          lat: pLat,
          lng: pLng
        }),
      /geometric verification failed/i
    );

    // 4. Direct helper rejects unphysical extreme scale (scale=4.5)
    const extremeScalePairs = kf0.features.slice(0, 6).map((f, idx) => ({
      kIdx: 0,
      fIdx: idx,
      kx: f.u * fw,
      ky: f.v * fh,
      lx: f.u * fw * 4.5,
      ly: f.v * fh * 4.5,
      hasUv: true
    }));
    const geoExtreme = verifyMatchedDescriptorsGeometry(extremeScalePairs, 6.0);
    assert.equal(geoExtreme.totalGeometricInliers, 0);
  });

  test('HTTP /api/lands/:parcelId/security supports Auto toggle, Custom Override, and lightingAdaptive', async () => {
    const authRes = await apiJson('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({
        devProfile: { email: 'orb-owner@example.com', name: 'ORB Policy Owner' }
      })
    });
    assert.equal(authRes.status, 200);
    const token = authRes.body.token;

    const claimRes = await apiJson('/api/lands/claim', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        lat: 37.7621,
        lng: -122.4351,
        customName: 'HTTP Policy Test Land'
      })
    });
    assert.equal(claimRes.status, 201, JSON.stringify(claimRes.body));
    const parcelId = claimRes.body.parcelId;
    assert.equal(claimRes.body.securityPolicy.originSource, 'browser_map');
    assert.equal(claimRes.body.securityPolicy.isAuto, true);

    const customRes = await apiJson(`/api/lands/${parcelId}/security`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        requireOrbUnlock: true,
        minOrbInliers: 11,
        maxReprojErrPx: 5.0,
        lightingAdaptive: false
      })
    });
    assert.equal(customRes.status, 200);
    assert.equal(customRes.body.policy.overrideFlag, true);
    assert.equal(customRes.body.policy.isAuto, false);
    assert.equal(customRes.body.policy.minOrbInliers, 11);
    assert.equal(customRes.body.policy.maxReprojErrPx, 5.0);
    assert.equal(customRes.body.policy.lightingAdaptive, false);

    const autoRes = await apiJson(`/api/lands/${parcelId}/security`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        useAuto: true,
        lightingAdaptive: true
      })
    });
    assert.equal(autoRes.status, 200);
    assert.equal(autoRes.body.policy.overrideFlag, false);
    assert.equal(autoRes.body.policy.isAuto, true);
    assert.equal(autoRes.body.policy.minOrbInliers, autoRes.body.policy.autoMinOrbInliers);
    assert.equal(autoRes.body.policy.maxReprojErrPx, autoRes.body.policy.autoMaxReprojErrPx);
    assert.equal(autoRes.body.policy.lightingAdaptive, true);

    // Verify MCP get_land and get_land_telemetry expose full securityPolicy fields
    const mcpGetLand = await handleMcpJsonRpc(dbAdapter, {
      rpcBody: {
        jsonrpc: '2.0',
        id: 'orb-mcp-1',
        method: 'tools/call',
        params: { name: 'get_land', arguments: { parcelId } }
      },
      callerUser: {
        id: 'agent:orb-policy-inspector',
        name: 'ORB Inspector Agent',
        actorType: 'agent',
        wallet_address: authRes.body.user.walletAddress
      }
    });
    const mcpPol = mcpGetLand.result.structuredContent.securityPolicy;
    assert.equal(mcpPol.parcelId, parcelId);
    assert.equal(mcpPol.originSource, 'browser_map');
    assert.equal(mcpPol.isAuto, true);
    assert.equal(mcpPol.lightingAdaptive, true);
    assert.equal(mcpPol.hasLandmarkPack, false);

    const telemetry = await getLandTelemetry(dbAdapter, parcelId);
    assert.equal(telemetry.securityPolicy.parcelId, parcelId);
    assert.equal(telemetry.securityPolicy.originSource, 'browser_map');
    assert.equal(telemetry.securityPolicy.isAuto, true);
  });
});
