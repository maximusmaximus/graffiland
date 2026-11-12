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
  const diff = date - start;
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
  const altitudeDeg = (Math.asin(Math.max(-1, Math.min(1, sinAlt))) * 180) / Math.PI;

  let regime = 'daylight';
  if (altitudeDeg < -6) regime = 'night';
  else if (altitudeDeg < 6) regime = 'twilight';

  return {
    solarAltitudeDeg: Math.round(altitudeDeg * 100) / 100,
    solarTimeHours: Math.round(solarTimeHours * 100) / 100,
    regime
  };
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
        'User-Agent': 'GRAFFILAND-3D/1.0 (location-metadata-enrichment)'
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
      displayName: data.display_name || placeName
    };
  } catch {
    return fallback;
  }
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
  const altitude = Number.isFinite(Number(locationInput?.altitude)) ? Number(locationInput.altitude) : null;
  const heading = Number.isFinite(Number(locationInput?.heading)) ? Number(locationInput.heading) : null;
  const speed = Number.isFinite(Number(locationInput?.speed)) ? Number(locationInput.speed) : null;
  const timezone = String(locationInput?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');

  const geohash = encodeGeohash(lat, lng, 8);
  const parcelBounds = decodeGeohashBounds(geohash);
  const parcelId = `GLAND-${geohash.toUpperCase()}`;
  const parcelBytes32 = ethers.keccak256(ethers.toUtf8Bytes(parcelId));

  // Verify GPS sample trajectory (no teleporting)
  const gpsSamples = Array.isArray(polInput?.gpsSamples) ? polInput.gpsSamples : [];
  let maxTeleportSpeed = 0;
  for (let i = 1; i < gpsSamples.length; i++) {
    const a = gpsSamples[i - 1];
    const b = gpsSamples[i];
    const dtSec = Math.max(0.5, (Number(b.t || 0) - Number(a.t || 0)) / 1000);
    const dist = haversineMeters(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
    const implied = dist / dtSec;
    if (implied > maxTeleportSpeed) maxTeleportSpeed = implied;
  }
  const gpsTrajectoryValid = maxTeleportSpeed < 60;

  const gyroSamples = Math.max(0, Number(polInput?.gyroSamples || 0));
  const cameraFrames = Math.max(0, Number(polInput?.cameraFrames || 0));
  const opticalFlowCorrelation = Math.max(
    0,
    Math.min(1, Number(polInput?.opticalFlowCorrelation ?? 0))
  );
  const horizonLuminance = Math.max(0, Math.min(255, Number(polInput?.horizonLuminance ?? 128)));
  const ambientPalette = Array.isArray(polInput?.ambientPalette)
    ? polInput.ambientPalette.slice(0, 6).map((c) => String(c))
    : [];
  const visualDHash = String(polInput?.visualDHash || '').slice(0, 64);
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
  const verified = gpsTrajectoryValid && score >= 45;

  const geoInfo = await reverseGeocode(lat, lng);

  const proofBundle = {
    version: 'pol-v1',
    parcelId,
    geohash,
    parcelBounds,
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    altitude,
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
    altitude,
    accuracy,
    heading,
    timezone,
    geoInfo,
    solar,
    proofBundle,
    proofHash,
    score,
    verified
  };
}
