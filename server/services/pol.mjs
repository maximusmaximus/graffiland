import { ethers } from 'ethers';

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encodeGeohash(lat, lng, precision = 8) {
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let geohash = '';
  let latMin = -90.0;
  let latMax = 90.0;
  let lngMin = -180.0;
  let lngMax = 180.0;

  while (geohash.length < precision) {
    if (evenBit) {
      const lngMid = (lngMin + lngMax) / 2;
      if (lng >= lngMid) {
        idx = idx * 2 + 1;
        lngMin = lngMid;
      } else {
        idx = idx * 2;
        lngMax = lngMid;
      }
    } else {
      const latMid = (latMin + latMax) / 2;
      if (lat >= latMid) {
        idx = idx * 2 + 1;
        latMin = latMid;
      } else {
        idx = idx * 2;
        latMax = latMid;
      }
    }
    evenBit = !evenBit;
    if (++bit === 5) {
      geohash += BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }
  return geohash;
}

export function decodeGeohashBounds(geohash) {
  let evenBit = true;
  let latMin = -90.0;
  let latMax = 90.0;
  let lngMin = -180.0;
  let lngMax = 180.0;

  for (const ch of geohash) {
    const cd = BASE32.indexOf(ch);
    if (cd === -1) continue;
    for (let n = 4; n >= 0; n--) {
      const bitN = (cd >> n) & 1;
      if (evenBit) {
        const lngMid = (lngMin + lngMax) / 2;
        if (bitN === 1) lngMin = lngMid;
        else lngMax = lngMid;
      } else {
        const latMid = (latMin + latMax) / 2;
        if (bitN === 1) latMin = latMid;
        else latMax = latMid;
      }
      evenBit = !evenBit;
    }
  }
  return {
    sw: [latMin, lngMin],
    ne: [latMax, lngMax],
    center: [(latMin + latMax) / 2, (lngMin + lngMax) / 2]
  };
}

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function computeSolarPosition(lat, lng, date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
  const diff = date.getTime() - start.getTime();
  const dayOfYear = Math.floor(diff / 86400000);
  const utcHours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;

  const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (utcHours - 12) / 24);
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma);

  const solarTimeHours = (((utcHours + lng / 15) % 24) + 24) % 24;
  const hourAngle = ((solarTimeHours - 12) * 15 * Math.PI) / 180;
  const latRad = (lat * Math.PI) / 180;

  const sinAlt =
    Math.sin(latRad) * Math.sin(decl) +
    Math.cos(latRad) * Math.cos(decl) * Math.cos(hourAngle);
  const altRad = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const altitudeDeg = (altRad * 180) / Math.PI;

  const cosAltLat = Math.cos(latRad) * Math.cos(altRad);
  let azimuthDeg = 180;
  if (Math.abs(cosAltLat) > 1e-5) {
    const cosAz = (Math.sin(decl) - Math.sin(latRad) * Math.sin(altRad)) / cosAltLat;
    let az = (Math.acos(Math.max(-1, Math.min(1, cosAz))) * 180) / Math.PI;
    if (Math.sin(hourAngle) > 0) az = 360 - az;
    azimuthDeg = az;
  }

  let regime = 'daylight';
  if (altitudeDeg < -6) regime = 'night';
  else if (altitudeDeg < 6) regime = 'twilight';

  return {
    solarAltitudeDeg: Math.round(altitudeDeg * 100) / 100,
    solarAzimuthDeg: Math.round(azimuthDeg * 100) / 100,
    solarTimeHours: Math.round(solarTimeHours * 100) / 100,
    regime
  };
}

export async function fetchTerrainElevation(lat, lng) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${encodeURIComponent(
      lat
    )}&longitude=${encodeURIComponent(lng)}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const val = Array.isArray(data?.elevation) ? Number(data.elevation[0]) : Number(data?.elevation);
    return Number.isFinite(val) ? Math.round(val * 100) / 100 : null;
  } catch {
    return null;
  }
}

export async function reverseGeocode(lat, lng) {
  const fallback = {
    placeName: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    neighborhood: '',
    road: '',
    city: '',
    state: '',
    country: '',
    countryCode: '',
    postcode: '',
    displayName: `Coordinates ${lat.toFixed(5)}, ${lng.toFixed(5)}`
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'SPRAY.LAND-3D/1.0 (location-metadata-enrichment)'
      }
    });
    clearTimeout(timer);
    if (!res.ok) return fallback;
    const data = await res.json();
    const addr = data.address || {};
    const city = addr.city || addr.town || addr.village || addr.municipality || '';
    const neighborhood = addr.neighbourhood || addr.suburb || addr.quarter || '';
    const road = addr.road || addr.pedestrian || addr.footway || '';
    const placeName =
      [road || neighborhood, city, addr.state_code || addr.state].filter(Boolean).join(', ') ||
      data.name ||
      fallback.placeName;

    return {
      placeName,
      neighborhood,
      road,
      city,
      state: addr.state || '',
      country: addr.country || '',
      countryCode: (addr.country_code || '').toUpperCase(),
      postcode: addr.postcode || '',
      displayName: data.display_name || placeName,
      category: String(data.category || data.class || '').toLowerCase(),
      type: String(data.type || '').toLowerCase(),
      addresstype: String(data.addresstype || '').toLowerCase(),
      housenumber: String(addr.house_number || '').trim()
    };
  } catch {
    return fallback;
  }
}

export const POL_LIMITS = {
  minGpsSamples: 2,
  maxGpsSamples: 120,
  maxSampleDistanceM: 250,
  maxSampleAgeMs: 30 * 60 * 1000,
  maxFutureSkewMs: 2 * 60 * 1000,
  minCameraFrames: 1,
  minFallbackCameraFrames: 4,
  minGyroSamples: 1,
  // Cross-publish "impossible travel": faster than a commercial jet between two publishes.
  maxTravelSpeedMs: 280,
  travelGraceMeters: 2000
};

function sampleTime(sample) {
  const t = Number(sample?.t ?? sample?.ts);
  return Number.isFinite(t) ? t : NaN;
}

function countish(value) {
  if (Array.isArray(value)) return value.length;
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Server-side sanity checks on client-reported sensor evidence. These cannot make GPS spoofing
 * impossible (all inputs are client-asserted), but they stop trivially empty or inconsistent
 * payloads from passing and force a spoofer to fabricate a coherent, recent trajectory.
 * Returns a list of human-readable issues (empty when acceptable).
 */
export function assessPolEvidence({
  lat,
  lng,
  gpsSamples = [],
  gyroSamples = 0,
  cameraFrames = 0,
  visualDHash = '',
  now = Date.now()
}) {
  const issues = [];
  if (gpsSamples.length < POL_LIMITS.minGpsSamples) {
    issues.push(`At least ${POL_LIMITS.minGpsSamples} GPS samples are required`);
  }
  for (const sample of gpsSamples) {
    const sLat = Number(sample?.lat);
    const sLng = Number(sample?.lng);
    const t = sampleTime(sample);
    if (!Number.isFinite(sLat) || !Number.isFinite(sLng) || !Number.isFinite(t)) {
      issues.push('GPS samples must include finite lat, lng and timestamp');
      break;
    }
    if (t > now + POL_LIMITS.maxFutureSkewMs || now - t > POL_LIMITS.maxSampleAgeMs) {
      issues.push('GPS samples are stale or timestamped in the future');
      break;
    }
    if (haversineMeters(lat, lng, sLat, sLng) > POL_LIMITS.maxSampleDistanceM) {
      issues.push('GPS samples do not match the claimed location');
      break;
    }
  }
  if (cameraFrames < POL_LIMITS.minCameraFrames) issues.push('Live camera frames are required');
  // iOS Safari 13+ may run in touch-drag fallback (gyroSamples === 0) if motion permission is
  // declined; allow continuous live camera scan (>=4 frames + visual dHash) to satisfy motion check.
  const hasCameraFallback =
    cameraFrames >= POL_LIMITS.minFallbackCameraFrames && String(visualDHash || '').trim().length >= 8;
  if (gyroSamples < POL_LIMITS.minGyroSamples && !hasCameraFallback) {
    issues.push(
      `Device motion samples (or at least ${POL_LIMITS.minFallbackCameraFrames} live camera scan frames) are required`
    );
  }
  return issues;
}

/**
 * Compares a new publish location against the same account's previous publish. Returns
 * { ok, distanceM, speedMs }. `previous` is { lat, lng, at } with `at` an ISO string or ms.
 */
export function assessTravelFeasibility(previous, next, now = Date.now()) {
  if (!previous) return { ok: true, distanceM: 0, speedMs: 0 };
  const pLat = Number(previous.lat);
  const pLng = Number(previous.lng);
  const pAt = typeof previous.at === 'number' ? previous.at : Date.parse(String(previous.at || ''));
  if (!Number.isFinite(pLat) || !Number.isFinite(pLng) || !Number.isFinite(pAt)) {
    return { ok: true, distanceM: 0, speedMs: 0 };
  }
  const distanceM = haversineMeters(pLat, pLng, Number(next.lat), Number(next.lng));
  const dtSec = Math.max(1, (now - pAt) / 1000);
  const speedMs = distanceM / dtSec;
  const ok = distanceM <= POL_LIMITS.travelGraceMeters || speedMs <= POL_LIMITS.maxTravelSpeedMs;
  return { ok, distanceM: Math.round(distanceM), speedMs: Math.round(speedMs * 10) / 10 };
}

export async function verifyAndEnrichLocation(locationInput, polInput, userSub) {
  const lat = Number(locationInput?.lat);
  const lng = Number(locationInput?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error('Valid GPS latitude and longitude are required.');
  }
  if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) {
    throw new Error('GPS fix cannot be null island (0, 0).');
  }

  const accuracy = Number.isFinite(Number(locationInput?.accuracy)) ? Number(locationInput.accuracy) : 50;
  const deviceAltitudeMeters =
    locationInput?.altitude !== null &&
    locationInput?.altitude !== undefined &&
    Number.isFinite(Number(locationInput.altitude))
      ? Math.round(Number(locationInput.altitude) * 100) / 100
      : null;
  const altitudeAccuracyMeters =
    locationInput?.altitudeAccuracy !== null &&
    locationInput?.altitudeAccuracy !== undefined &&
    Number.isFinite(Number(locationInput.altitudeAccuracy))
      ? Math.round(Number(locationInput.altitudeAccuracy) * 100) / 100
      : null;
  const heading =
    locationInput?.heading !== null &&
    locationInput?.heading !== undefined &&
    Number.isFinite(Number(locationInput.heading))
      ? Number(locationInput.heading)
      : null;
  const speed =
    locationInput?.speed !== null &&
    locationInput?.speed !== undefined &&
    Number.isFinite(Number(locationInput.speed))
      ? Number(locationInput.speed)
      : null;
  const timezone = String(locationInput?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');

  const sculptureVerticalMinM = Number.isFinite(Number(locationInput?.sculptureVerticalMinM))
    ? Math.round(Number(locationInput.sculptureVerticalMinM) * 1000) / 1000
    : 0;
  const sculptureVerticalMaxM = Number.isFinite(Number(locationInput?.sculptureVerticalMaxM))
    ? Math.round(Number(locationInput.sculptureVerticalMaxM) * 1000) / 1000
    : 0;

  const geohash = encodeGeohash(lat, lng, 8);
  const parcelBounds = decodeGeohashBounds(geohash);
  const parcelId = `GLAND-${geohash.toUpperCase()}`;
  const parcelBytes32 = ethers.keccak256(ethers.toUtf8Bytes(parcelId));

  // Verify GPS sample trajectory (no teleporting)
  const gpsSamples = Array.isArray(polInput?.gpsSamples)
    ? polInput.gpsSamples.slice(-POL_LIMITS.maxGpsSamples)
    : [];
  let maxTeleportSpeed = 0;
  for (let i = 1; i < gpsSamples.length; i++) {
    const a = gpsSamples[i - 1];
    const b = gpsSamples[i];
    const dtSec = Math.max(0.5, Math.abs(sampleTime(b) - sampleTime(a)) / 1000);
    const dist = haversineMeters(Number(a?.lat), Number(a?.lng), Number(b?.lat), Number(b?.lng));
    const implied = dist / dtSec;
    if (implied > maxTeleportSpeed) maxTeleportSpeed = implied;
  }
  const gpsTrajectoryValid = maxTeleportSpeed < 60;

  const gyroSamples = Math.max(0, countish(polInput?.gyroSamples));
  const cameraFrames = Math.max(0, countish(polInput?.cameraFrames));
  const opticalFlowCorrelation = Math.max(
    0,
    Math.min(1, Number(polInput?.opticalFlowCorrelation ?? 0))
  );
  const horizonLuminance = Math.max(0, Math.min(255, Number(polInput?.horizonLuminance ?? 128)));
  const ambientPalette = Array.isArray(polInput?.ambientPalette)
    ? polInput.ambientPalette.slice(0, 6).map((c) => String(c))
    : [];
  const visualDHash = String(polInput?.visualDHash || '').slice(0, 64);
  const evidenceIssues = assessPolEvidence({
    lat,
    lng,
    gpsSamples,
    gyroSamples,
    cameraFrames,
    visualDHash
  });
  const cameraFacingMode = String(polInput?.cameraFacingMode || 'environment');
  const cameraResolution = String(polInput?.cameraResolution || 'unknown');
  const sculptDurationMs = Math.max(0, Number(polInput?.sculptDurationMs || 0));

  const solar = computeSolarPosition(lat, lng, new Date());
  let solarMatchScore = 15;
  if (solar.regime === 'daylight' && horizonLuminance >= 55) solarMatchScore = 20;
  else if (solar.regime === 'night' && horizonLuminance <= 155) solarMatchScore = 20;
  else if (solar.regime === 'twilight') solarMatchScore = 18;
  else solarMatchScore = 10;

  // Score components (total 100)
  const gpsScore = accuracy <= 25 ? 25 : accuracy <= 80 ? 20 : accuracy <= 200 ? 15 : 10;
  const trajectoryBonus = gpsTrajectoryValid ? 10 : 0;
  const cameraScore = cameraFrames >= 5 && visualDHash ? 20 : cameraFrames >= 1 ? 12 : 4;
  const gyroFlowScore =
    gyroSamples >= 8
      ? Math.round(10 + opticalFlowCorrelation * 15)
      : gyroSamples >= 1
      ? 10
      : 4;

  const score = Math.min(100, gpsScore + trajectoryBonus + cameraScore + gyroFlowScore + solarMatchScore);
  // The score alone is reachable with zero sensor data (GPS accuracy + empty trajectory + solar
  // defaults), so hard minimum evidence is required on top of it.
  const verified = gpsTrajectoryValid && evidenceIssues.length === 0 && score >= 45;

  const [geoInfo, terrainElevationMeters] = await Promise.all([
    reverseGeocode(lat, lng),
    fetchTerrainElevation(lat, lng)
  ]);

  const altitudeSource =
    deviceAltitudeMeters !== null
      ? 'device-sensor'
      : terrainElevationMeters !== null
      ? 'terrain-dem'
      : 'unavailable';
  const anchorAltitudeMeters =
    deviceAltitudeMeters !== null ? deviceAltitudeMeters : terrainElevationMeters;
  const heightAboveGroundMeters =
    deviceAltitudeMeters !== null && terrainElevationMeters !== null
      ? Math.round((deviceAltitudeMeters - terrainElevationMeters) * 100) / 100
      : null;

  const elevation = {
    deviceAltitudeMeters,
    altitudeAccuracyMeters,
    altitudeSource,
    terrainElevationMeters,
    anchorAltitudeMeters,
    heightAboveGroundMeters,
    sculptureVerticalMinM,
    sculptureVerticalMaxM
  };

  const proofBundle = {
    version: 'pol-v1',
    parcelId,
    geohash,
    parcelBounds,
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    altitude: anchorAltitudeMeters,
    elevation,
    accuracy,
    heading,
    speed,
    timezone,
    solar,
    geoInfo,
    sensors: {
      gpsSampleCount: Math.max(1, gpsSamples.length),
      gpsTrajectoryValid,
      maxTeleportSpeedMs: Math.round(maxTeleportSpeed * 100) / 100,
      gyroSamples,
      cameraFrames,
      opticalFlowCorrelation: Math.round(opticalFlowCorrelation * 1000) / 1000,
      horizonLuminance: Math.round(horizonLuminance),
      ambientPalette,
      visualDHash,
      cameraFacingMode,
      cameraResolution,
      sculptDurationMs,
      sceneCoveragePct: Math.max(0, Math.min(100, Number(polInput?.sceneCoveragePct || 0))),
      scannedSectors: Math.max(0, Number(polInput?.scannedSectors || 0)),
      placementPrecisionMeters: Number.isFinite(Number(polInput?.placementPrecisionMeters))
        ? Number(polInput.placementPrecisionMeters)
        : null,
      deviceOrientationSummary: polInput?.deviceOrientationSummary || null
    },
    score,
    verified,
    verifiedAt: new Date().toISOString(),
    creatorSubHash: ethers.keccak256(ethers.toUtf8Bytes(userSub))
  };

  const proofHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(proofBundle)));

  return {
    parcelId,
    parcelBytes32,
    geohash,
    parcelBounds,
    lat: proofBundle.lat,
    lng: proofBundle.lng,
    altitude: anchorAltitudeMeters,
    elevation,
    accuracy,
    heading,
    timezone,
    geoInfo,
    solar,
    proofBundle,
    proofHash,
    score,
    verified,
    evidenceIssues
  };
}
