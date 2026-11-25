import { decodeGeohashBounds } from '../../../server/services/pol.mjs';
import { haversineMeters } from '../../../shared/chatPolicy.mjs';
import { LAND_VOLUME_LIMITS } from '../../../shared/constants.mjs';
import {
  buildDefaultVolumeFromBounds,
  computeOrientedFootprintLngLat,
  normalizeRotationDeg,
  resolveLandDisplayName
} from '../../../shared/landVolume.mjs';
import {
  buildGoogleMapsLandUrl,
  formatDistanceMeters,
  formatLandExpiration,
  resolveLandCoords
} from './landMapHelpers.js';
import {
  FEET_PER_METER,
  formatArea,
  formatDimensionTriple,
  formatVolume,
  normalizeUnitSystem
} from './measurementUnits.js';

const METERS_PER_DEG_LAT = 111320;
const EARTH_CIRCUMFERENCE_M = 40075016.686;
const CARDINAL_DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const SCALE_STEPS_M = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
const SCALE_STEPS_FT = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 1320, 2640, 5280, 10560, 26400];

function metersPerDegLngAtLat(lat) {
  return METERS_PER_DEG_LAT * Math.max(0.08, Math.cos((Number(lat) * Math.PI) / 180));
}

export function normalizeSignedBearing(deg = 0) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return 0;
  let wrapped = ((n % 360) + 360) % 360;
  if (wrapped > 180) wrapped -= 360;
  return Number(wrapped.toFixed(1));
}

/**
 * Defensively resolves a complete 3D parcel volume (with 4 oriented corners + closed ring)
 * from any parcel payload (volume, bounds, center coords, or GLAND-<geohash> parcelId).
 * @param {any} parcel
 */
export function resolveParcelVolume(parcel) {
  if (!parcel || typeof parcel !== 'object') return null;

  const pid = String(parcel.parcelId || '').trim().toUpperCase();
  const rawGeohash = String(
    parcel.geohash ||
      parcel.volume?.geohash ||
      (pid.startsWith('GLAND-') ? pid.slice(6) : '')
  )
    .trim()
    .toLowerCase();

  const vol = parcel.volume;
  if (
    vol &&
    Number.isFinite(Number(vol.centerLat)) &&
    Number.isFinite(Number(vol.centerLng))
  ) {
    const centerLat = Number(vol.centerLat);
    const centerLng = Number(vol.centerLng);
    const widthMeters = Math.max(
      0.5,
      Number(vol.widthMeters || LAND_VOLUME_LIMITS.defaultWidthMeters)
    );
    const depthMeters = Math.max(
      0.5,
      Number(vol.depthMeters || LAND_VOLUME_LIMITS.defaultDepthMeters)
    );
    const heightMeters = Math.max(
      0.5,
      Number(vol.heightMeters || LAND_VOLUME_LIMITS.defaultHeightMeters)
    );
    const baseAltitudeM = Math.max(0, Number(vol.baseAltitudeM || 0));
    const rotationDeg = normalizeRotationDeg(vol.rotationDeg || 0);

    const hasValidCorners =
      Array.isArray(vol.corners) &&
      vol.corners.length >= 4 &&
      vol.corners.slice(0, 4).every(
        (pair) =>
          Array.isArray(pair) &&
          pair.length >= 2 &&
          Number.isFinite(Number(pair[0])) &&
          Number.isFinite(Number(pair[1]))
      );

    const footprint = hasValidCorners
      ? {
          corners: vol.corners.slice(0, 4).map(([lng, lat]) => [Number(lng), Number(lat)]),
          ring: [
            ...vol.corners.slice(0, 4).map(([lng, lat]) => [Number(lng), Number(lat)]),
            [Number(vol.corners[0][0]), Number(vol.corners[0][1])]
          ]
        }
      : computeOrientedFootprintLngLat({
          lat: centerLat,
          lng: centerLng,
          widthMeters,
          depthMeters,
          rotationDeg
        });

    const footprintAreaSqM = Number.isFinite(Number(vol.footprintAreaSqM))
      ? Number(vol.footprintAreaSqM)
      : Number((widthMeters * depthMeters).toFixed(2));
    const volumeCubicM = Number.isFinite(Number(vol.volumeCubicM))
      ? Number(vol.volumeCubicM)
      : Number((footprintAreaSqM * heightMeters).toFixed(2));

    return {
      parcelId: pid || vol.parcelId || `GLAND-${rawGeohash.toUpperCase()}`,
      geohash: rawGeohash,
      centerLat,
      centerLng,
      widthMeters,
      depthMeters,
      heightMeters,
      baseAltitudeM,
      rotationDeg,
      footprintAreaSqM,
      volumeCubicM,
      corners: footprint.corners,
      ring: footprint.ring
    };
  }

  if (parcel.bounds) {
    const built = buildDefaultVolumeFromBounds(parcel.bounds, pid, rawGeohash);
    if (built) return built;
  }

  const coords = resolveLandCoords(parcel);
  if (coords) {
    const widthMeters = LAND_VOLUME_LIMITS.defaultWidthMeters;
    const depthMeters = LAND_VOLUME_LIMITS.defaultDepthMeters;
    const heightMeters = LAND_VOLUME_LIMITS.defaultHeightMeters;
    const { corners, ring } = computeOrientedFootprintLngLat({
      lat: coords.lat,
      lng: coords.lng,
      widthMeters,
      depthMeters,
      rotationDeg: 0
    });
    const footprintAreaSqM = Number((widthMeters * depthMeters).toFixed(2));
    return {
      parcelId: pid || `GLAND-${rawGeohash.toUpperCase()}`,
      geohash: rawGeohash,
      centerLat: coords.lat,
      centerLng: coords.lng,
      widthMeters,
      depthMeters,
      heightMeters,
      baseAltitudeM: 0,
      rotationDeg: 0,
      footprintAreaSqM,
      volumeCubicM: Number((footprintAreaSqM * heightMeters).toFixed(2)),
      corners,
      ring
    };
  }

  if (/^[0-9a-z]{5,10}$/i.test(rawGeohash)) {
    try {
      const decoded = decodeGeohashBounds(rawGeohash);
      if (decoded) {
        return buildDefaultVolumeFromBounds(decoded, pid, rawGeohash);
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Computes exact MapLibre camera framing (center, zoom, pitch, bearing, padding)
 * so a 3D land parcel's full oriented footprint AND vertical Z-height fit crisply
 * inside an isometric (or context / top-down) viewport with surrounding street context.
 * @param {ReturnType<typeof resolveParcelVolume>} volume
 * @param {{
 *   viewportWidth?: number,
 *   viewportHeight?: number,
 *   viewMode?: 'isometric' | 'context' | 'topdown',
 *   bearingOffsetDeg?: number
 * }} [options]
 */
export function computeIsometricCameraFit(
  volume,
  {
    viewportWidth = 600,
    viewportHeight = 270,
    viewMode = 'isometric',
    bearingOffsetDeg = 0
  } = {}
) {
  if (!volume || !Number.isFinite(volume.centerLat) || !Number.isFinite(volume.centerLng)) {
    return null;
  }

  const vw = Math.max(200, Number(viewportWidth) || 600);
  const vh = Math.max(150, Number(viewportHeight) || 270);
  const isTopDown = viewMode === 'topdown';
  const isContext = viewMode === 'context';

  // True architectural isometric tilt is atan(sqrt(2)) ≈ 54.74°, aligned 45° off parcel axis
  const pitch = isTopDown ? 0 : isContext ? 46 : 55;
  const bearing = isTopDown
    ? 0
    : normalizeSignedBearing((Number(volume.rotationDeg) || 0) - 45 + Number(bearingOffsetDeg || 0));

  const pitchRad = (pitch * Math.PI) / 180;
  const bearingRad = (bearing * Math.PI) / 180;
  const cosB = Math.cos(bearingRad);
  const sinB = Math.sin(bearingRad);
  const mPerDegLng = metersPerDegLngAtLat(volume.centerLat);

  // Project all 4 footprint corners onto camera-aligned screen ground axes (u = right, v = forward)
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const [cLng, cLat] of volume.corners || []) {
    const eastM = (Number(cLng) - volume.centerLng) * mPerDegLng;
    const northM = (Number(cLat) - volume.centerLat) * METERS_PER_DEG_LAT;
    const u = eastM * cosB - northM * sinB;
    const v = eastM * sinB + northM * cosB;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const spanU = Math.max(1.0, Number.isFinite(maxU - minU) ? maxU - minU : volume.widthMeters);
  const spanV = Math.max(1.0, Number.isFinite(maxV - minV) ? maxV - minV : volume.depthMeters);
  const heightM = Math.max(0, Number(volume.heightMeters || 0));

  // Total vertical screen span at center depth = ground foreshortening + vertical extrusion lift
  const projectedHeightM =
    spanV * Math.cos(pitchRad) + heightM * Math.sin(pitchRad);

  const cosLat = Math.max(0.1, Math.cos((volume.centerLat * Math.PI) / 180));
  const metersPerPxAtZ0 = (EARTH_CIRCUMFERENCE_M * cosLat) / 512;

  // Target comfortable architectural framing so the entire 3D prism + surrounding streets fit cleanly
  const fillX = isTopDown ? 0.52 : 0.56;
  const fillY = isTopDown ? 0.54 : 0.56;
  const usableW = Math.max(120, vw - 36);
  const usableH = Math.max(100, vh - 44);

  const targetMetersPerPx = Math.max(
    spanU / (usableW * fillX),
    Math.max(1.0, projectedHeightM) / (usableH * fillY)
  );

  const rawIsoZoom = Math.log2(metersPerPxAtZ0 / Math.max(0.006, targetMetersPerPx));
  // Keep small 2-8m lands framed with visible surrounding streets & buildings on mobile screens
  // instead of over-zooming into an empty tile pocket at z21+. Users can still pinch-zoom closer.
  const maxAutoIsoZoom = vw <= 520 ? 19.6 : 20.4;
  const clampedIsoZoom = Math.max(14.0, Math.min(maxAutoIsoZoom, rawIsoZoom));
  const zoom = isContext
    ? Math.max(12.2, Math.min(16.8, clampedIsoZoom - 2.35))
    : clampedIsoZoom;

  // Shift ground anchor slightly downward by half the extruded prism screen height so the 3D cube
  // centers optically inside the preview frame (never clipping the roof under top HUD controls)
  const actualMetersPerPx = metersPerPxAtZ0 / Math.pow(2, zoom);
  const halfHeightLiftPx =
    isTopDown || isContext
      ? 0
      : Math.round(((heightM * Math.sin(pitchRad)) / Math.max(0.05, actualMetersPerPx)) * 0.5);

  const maxTopPad = Math.floor(vh * 0.36);
  const padTop = isTopDown ? 18 : Math.min(maxTopPad, 22 + Math.max(0, halfHeightLiftPx));
  const padBottom = isTopDown ? 18 : 22;

  return {
    center: [volume.centerLng, volume.centerLat],
    zoom: Number(zoom.toFixed(2)),
    pitch,
    bearing,
    padding: {
      top: padTop,
      bottom: padBottom,
      left: 18,
      right: 18
    },
    metersPerPixel: Number(actualMetersPerPx.toFixed(4))
  };
}

/**
 * Computes a clean cartographic scale bar (metric or imperial) for a given latitude and MapLibre zoom level.
 * @param {number} lat
 * @param {number} zoom
 * @param {number} [maxWidthPx]
 * @param {'imperial' | 'metric'} [unitSystem='metric']
 */
export function computeScaleBarForZoom(lat, zoom, maxWidthPx = 92, unitSystem = 'metric') {
  const isImp = normalizeUnitSystem(unitSystem) === 'imperial';
  const nLat = Number(lat);
  const nZoom = Number(zoom);
  if (!Number.isFinite(nLat) || !Number.isFinite(nZoom)) {
    return isImp
      ? { meters: 15.24, widthPx: 64, label: '50 ft' }
      : { meters: 20, widthPx: 64, label: '20 m' };
  }
  const cosLat = Math.max(0.1, Math.cos((nLat * Math.PI) / 180));
  const metersPerPx = (EARTH_CIRCUMFERENCE_M * cosLat) / (512 * Math.pow(2, nZoom));
  const maxMeters = metersPerPx * Math.max(40, maxWidthPx);

  if (isImp) {
    const maxFeet = maxMeters * FEET_PER_METER;
    let chosenFt = SCALE_STEPS_FT[0];
    for (const step of SCALE_STEPS_FT) {
      if (step <= maxFeet) {
        chosenFt = step;
      } else {
        break;
      }
    }
    const chosenMeters = chosenFt / FEET_PER_METER;
    const widthPx = Math.max(
      28,
      Math.min(maxWidthPx, Math.round(chosenMeters / Math.max(0.001, metersPerPx)))
    );
    let label = `${chosenFt} ft`;
    if (chosenFt === 1320) label = '0.25 mi';
    else if (chosenFt === 2640) label = '0.5 mi';
    else if (chosenFt >= 5280) label = `${chosenFt / 5280} mi`;
    return { meters: Number(chosenMeters.toFixed(2)), widthPx, label };
  }

  let chosen = SCALE_STEPS_M[0];
  for (const step of SCALE_STEPS_M) {
    if (step <= maxMeters) {
      chosen = step;
    } else {
      break;
    }
  }
  const widthPx = Math.max(28, Math.min(maxWidthPx, Math.round(chosen / Math.max(0.001, metersPerPx))));
  const label = chosen >= 1000 ? `${chosen / 1000} km` : `${chosen} m`;
  return { meters: chosen, widthPx, label };
}

/**
 * Formats coordinates into human-readable cardinal degrees (e.g. "37.77493° N, 122.41942° W").
 */
export function formatCardinalCoords(lat, lng) {
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return '';
  const latDir = nLat >= 0 ? 'N' : 'S';
  const lngDir = nLng >= 0 ? 'E' : 'W';
  return `${Math.abs(nLat).toFixed(5)}° ${latDir}, ${Math.abs(nLng).toFixed(5)}° ${lngDir}`;
}

/**
 * Maps a compass bearing in degrees to an 8-point cardinal label.
 */
export function formatBearingCardinal(bearingDeg = 0) {
  const wrapped = (((Number(bearingDeg) || 0) % 360) + 360) % 360;
  const idx = Math.round(wrapped / 45) % 8;
  return { label: CARDINAL_DIRS[idx], degrees: Math.round(wrapped) };
}

/**
 * Computes compass bearing (0° = North, 90° = East) from point A to point B.
 */
export function computeBearingBetween(fromLat, fromLng, toLat, toLng) {
  const lat1 = (Number(fromLat) * Math.PI) / 180;
  const lat2 = (Number(toLat) * Math.PI) / 180;
  const dLng = ((Number(toLng) - Number(fromLng)) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return formatBearingCardinal(deg);
}

/**
 * Builds structured geographic metadata & spatial context cues for a parcel inside Land Management.
 */
export function buildParcelGeoSummary(
  parcel,
  { allParcels = [], userLocation = null, placeContext = null, unitSystem = 'metric' } = {}
) {
  const volume = resolveParcelVolume(parcel);
  if (!volume) return null;

  const cardinalCoords = formatCardinalCoords(volume.centerLat, volume.centerLng);
  const rawCoords = `${volume.centerLat.toFixed(6)}, ${volume.centerLng.toFixed(6)}`;
  const googleMapsUrl = buildGoogleMapsLandUrl(volume.centerLat, volume.centerLng);

  const rawArea = Number.isFinite(Number(volume.footprintAreaSqM))
    ? Number(volume.footprintAreaSqM)
    : volume.widthMeters * volume.depthMeters;
  const rawVolM3 = Number.isFinite(Number(volume.volumeCubicM))
    ? Number(volume.volumeCubicM)
    : rawArea * volume.heightMeters;
  const rot = Math.round(volume.rotationDeg || 0);
  const tripleStr = formatDimensionTriple(
    volume.widthMeters,
    volume.depthMeters,
    volume.heightMeters,
    unitSystem
  );
  const areaStr = formatArea(rawArea, unitSystem);
  const volStr = formatVolume(rawVolM3, unitSystem);
  const dimensionsLabel = areaStr ? `${tripleStr} · ${areaStr}` : tripleStr;
  const volumeLabel = `${volStr}${rot ? ` · ${rot}° rot` : ''}`;

  let distanceFromUserLabel = '';
  if (
    userLocation &&
    Number.isFinite(Number(userLocation.lat)) &&
    Number.isFinite(Number(userLocation.lng))
  ) {
    const distM = haversineMeters(
      Number(userLocation.lat),
      Number(userLocation.lng),
      volume.centerLat,
      volume.centerLng
    );
    const dir = computeBearingBetween(
      Number(userLocation.lat),
      Number(userLocation.lng),
      volume.centerLat,
      volume.centerLng
    );
    distanceFromUserLabel =
      distM < 30
        ? 'At your location'
        : `${formatDistanceMeters(distM, unitSystem)} ${dir.label} of you`;
  }

  let nearestOwnedLand = null;
  for (const other of allParcels || []) {
    if (!other || other.parcelId === parcel?.parcelId) continue;
    const otherVol = resolveParcelVolume(other);
    if (!otherVol) continue;
    const distM = haversineMeters(
      volume.centerLat,
      volume.centerLng,
      otherVol.centerLat,
      otherVol.centerLng
    );
    if (!nearestOwnedLand || distM < nearestOwnedLand.distanceMeters) {
      // Bearing FROM other land TO this land, so "<dist> <dir> of <otherName>" is geographically accurate
      const dir = computeBearingBetween(
        otherVol.centerLat,
        otherVol.centerLng,
        volume.centerLat,
        volume.centerLng
      );
      nearestOwnedLand = {
        parcelId: other.parcelId,
        name: resolveLandDisplayName(other),
        distanceMeters: distM,
        distanceLabel: formatDistanceMeters(distM, unitSystem),
        cardinal: dir.label
      };
    }
  }

  const placePrimary =
    String(placeContext?.shortLabel || '').trim() ||
    [placeContext?.street, placeContext?.neighborhood, placeContext?.city, placeContext?.region]
      .filter(Boolean)
      .join(', ') ||
    '';

  const expiration = formatLandExpiration(parcel);

  return {
    volume,
    cardinalCoords,
    rawCoords,
    geohash: (volume.geohash || '').toUpperCase(),
    dimensionsLabel,
    volumeLabel,
    rotationDeg: rot,
    googleMapsUrl,
    distanceFromUserLabel,
    nearestOwnedLand,
    placePrimary,
    expiration
  };
}
