import { useEffect, useState } from 'react';

export const UNIT_PREFERENCE_STORAGE_KEY = 'graffiland_unit_system_v1';
export const UNIT_PREFERENCE_EVENT = 'graffiland:unit-system-changed';

export const FEET_PER_METER = 3.280839895;
export const METERS_PER_MILE = 1609.344;
export const SQ_FEET_PER_SQ_METER = 10.7639104167;
export const CU_FEET_PER_CU_METER = 35.3146667215;

const US_TIMEZONES = new Set([
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'America/Adak',
  'America/Boise',
  'America/Detroit',
  'America/Juneau',
  'America/Menominee',
  'America/Metlakatla',
  'America/Nome',
  'America/Sitka',
  'America/Yakutat',
  'Pacific/Honolulu',
  'America/Puerto_Rico',
  'Pacific/Guam',
  'Pacific/Pago_Pago'
]);

/** @type {{ lat: number, lng: number } | null} */
let lastKnownUnitLocation = null;

/**
 * Normalize a preference value into `'auto' | 'imperial' | 'metric'`.
 * @param {any} raw
 * @returns {'auto' | 'imperial' | 'metric'}
 */
export function normalizeUnitPreference(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'imperial' || s === 'us') return 'imperial';
  if (s === 'metric') return 'metric';
  return 'auto';
}

/**
 * Normalize a resolved unit system into `'imperial' | 'metric'`.
 * @param {any} raw
 * @returns {'imperial' | 'metric'}
 */
export function normalizeUnitSystem(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return s === 'imperial' || s === 'us' ? 'imperial' : 'metric';
}

function dispatchUnitChangeEvent(detail) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    const Ctor = window.CustomEvent || window.Event;
    if (Ctor === window.CustomEvent) {
      window.dispatchEvent(new Ctor(UNIT_PREFERENCE_EVENT, { detail }));
    } else if (Ctor) {
      window.dispatchEvent(new Ctor(UNIT_PREFERENCE_EVENT));
    }
  } catch {
    // ignore in constrained environments
  }
}

/**
 * Cache the latest valid GPS coordinates so modals without direct location props
 * still detect Auto units accurately from the user's current position.
 * @param {{ lat?: number, lng?: number } | null | undefined} loc
 */
function isValidCoordPair(loc) {
  if (!loc || typeof loc !== 'object') return false;
  if (loc.lat === null || loc.lat === undefined || loc.lat === '') return false;
  if (loc.lng === null || loc.lng === undefined || loc.lng === '') return false;
  return Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng));
}

export function setLastKnownUnitLocation(loc) {
  if (!isValidCoordPair(loc)) return;
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  const changed =
    !lastKnownUnitLocation ||
    Math.abs(lastKnownUnitLocation.lat - lat) > 0.05 ||
    Math.abs(lastKnownUnitLocation.lng - lng) > 0.05;
  lastKnownUnitLocation = { lat, lng };
  if (changed) {
    dispatchUnitChangeEvent({
      preference: getStoredUnitPreference(),
      location: lastKnownUnitLocation
    });
  }
}

/**
 * @returns {{ lat: number, lng: number } | null}
 */
export function getLastKnownUnitLocation() {
  return lastKnownUnitLocation;
}

/**
 * Reset cached location (primarily for isolated tests).
 */
export function clearLastKnownUnitLocation() {
  lastKnownUnitLocation = null;
}

/**
 * Determine whether geographic coordinates fall in a region whose default
 * everyday measurement system is Imperial (feet & miles) — primarily the USA
 * (50 states + DC + territories), Liberia, and Myanmar.
 * Carefully excludes Canadian & Mexican border metros (Vancouver, Toronto, Tijuana, Monterrey).
 * @param {number | null | undefined} lat
 * @param {number | null | undefined} lng
 * @returns {boolean}
 */
export function isImperialCoords(lat, lng) {
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return false;

  // Contiguous United States (excluding Canadian & Mexican border cities)
  if (nLat >= 24.39 && nLat <= 49.38 && nLng >= -124.85 && nLng <= -66.88) {
    // Exclude Vancouver / BC north of the 49th parallel west of -95°W
    if (nLng < -95.0 && nLat > 49.0) return false;
    // Exclude Southern Ontario (Toronto / Hamilton / Windsor peninsula north of Lake Erie)
    if (nLng >= -82.65 && nLng <= -79.05 && nLat > 43.02) return false;
    // Exclude Quebec / Montreal / Ottawa above 45.02°N between -79.05°W and -71.0°W
    if (nLng >= -79.05 && nLng <= -71.0 && nLat > 45.02) return false;
    // Exclude New Brunswick east of Maine above 47.46°N
    if (nLng > -67.8 && nLat > 47.46) return false;

    // Southern border with Mexico
    if (nLng < -114.72 && nLat < 32.53) return false; // Baja / Tijuana
    if (nLng >= -114.72 && nLng < -111.0 && nLat < 31.33) return false; // Sonora
    if (nLng >= -111.0 && nLng < -104.0 && nLat < 29.0) return false; // Chihuahua
    if (nLng >= -104.0 && nLng < -99.8 && nLat < 28.8) return false; // Coahuila / Monterrey
    if (nLng >= -99.8 && nLng < -97.0 && nLat < 25.83) return false; // Tamaulipas
    if (nLng >= -97.0 && nLat < 24.4) return false; // Gulf / Cuba

    return true;
  }

  // Alaska (mainland + Aleutians)
  if (nLat >= 51.2 && nLat <= 71.5 && nLng >= -179.2 && nLng <= -129.9) return true;
  if (nLat >= 51.2 && nLat <= 55.5 && nLng >= 172.4 && nLng <= 180) return true;

  // Hawaii
  if (nLat >= 18.8 && nLat <= 22.3 && nLng >= -160.3 && nLng <= -154.7) return true;

  // Puerto Rico & US Virgin Islands
  if (nLat >= 17.6 && nLat <= 18.6 && nLng >= -67.35 && nLng <= -64.5) return true;

  // Guam & Northern Mariana Islands
  if (nLat >= 13.2 && nLat <= 20.6 && nLng >= 144.6 && nLng <= 146.1) return true;

  // American Samoa
  if (nLat >= -14.6 && nLat <= -11.0 && nLng >= -171.2 && nLng <= -168.0) return true;

  // Liberia
  if (nLat >= 4.3 && nLat <= 8.6 && nLng >= -11.5 && nLng <= -7.3) return true;

  // Myanmar
  if (nLat >= 9.7 && nLat <= 28.6 && nLng >= 92.1 && nLng <= 101.2) return true;

  return false;
}

/**
 * Fallback detection from browser locale & timezone when GPS coordinates aren't available yet.
 * @param {string} [localeOverride]
 * @param {string} [timeZoneOverride]
 * @returns {'imperial' | 'metric'}
 */
export function detectUnitSystemFromLocale(localeOverride = '', timeZoneOverride = '') {
  const rawLocale =
    localeOverride ||
    (typeof navigator !== 'undefined'
      ? (Array.isArray(navigator.languages) && navigator.languages[0]) || navigator.language || ''
      : '');
  const loc = String(rawLocale || '').trim();
  const regionMatch = loc.match(/[-_]([A-Za-z]{2})(?:$|[-_])/);
  if (regionMatch) {
    const region = regionMatch[1].toUpperCase();
    if (region === 'US' || region === 'LR' || region === 'MM') return 'imperial';
    return 'metric';
  }

  let tz = String(timeZoneOverride || '').trim();
  if (!tz) {
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      tz = '';
    }
  }
  if (
    tz &&
    (US_TIMEZONES.has(tz) ||
      tz.startsWith('America/Indiana/') ||
      tz.startsWith('America/Kentucky/') ||
      tz.startsWith('America/North_Dakota/') ||
      tz.startsWith('US/'))
  ) {
    return 'imperial';
  }
  return 'metric';
}

/**
 * Auto-detect the most suitable unit system for a given location.
 * @param {{ lat?: number, lng?: number } | null | undefined} location
 * @param {{
 *   fallbackCoords?: { lat?: number, lng?: number } | null,
 *   locale?: string,
 *   timeZone?: string
 * }} [options]
 * @returns {{ system: 'imperial' | 'metric', source: 'gps' | 'parcel' | 'locale' }}
 */
export function detectUnitSystemForLocation(location = null, options = {}) {
  if (isValidCoordPair(location)) {
    return {
      system: isImperialCoords(Number(location.lat), Number(location.lng)) ? 'imperial' : 'metric',
      source: 'gps'
    };
  }

  const fb = options.fallbackCoords || lastKnownUnitLocation;
  if (isValidCoordPair(fb)) {
    return {
      system: isImperialCoords(Number(fb.lat), Number(fb.lng)) ? 'imperial' : 'metric',
      source: options.fallbackCoords ? 'parcel' : 'gps'
    };
  }

  return {
    system: detectUnitSystemFromLocale(options.locale, options.timeZone),
    source: 'locale'
  };
}

/**
 * Read the user's saved measurement unit preference (`'auto' | 'imperial' | 'metric'`).
 * @returns {'auto' | 'imperial' | 'metric'}
 */
export function getStoredUnitPreference() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return 'auto';
    return normalizeUnitPreference(window.localStorage.getItem(UNIT_PREFERENCE_STORAGE_KEY));
  } catch {
    return 'auto';
  }
}

/**
 * Persist the user's measurement unit preference and broadcast a live update event.
 * @param {'auto' | 'imperial' | 'metric'} preference
 * @returns {'auto' | 'imperial' | 'metric'}
 */
export function setStoredUnitPreference(preference) {
  const normalized = normalizeUnitPreference(preference);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(UNIT_PREFERENCE_STORAGE_KEY, normalized);
    }
  } catch {
    // ignore storage quota/privacy mode errors
  }
  dispatchUnitChangeEvent({ preference: normalized });
  return normalized;
}

/**
 * Subscribe to unit system preference or location-detection changes.
 * @param {() => void} listener
 * @returns {() => void}
 */
export function subscribeUnitPreference(listener) {
  if (typeof window === 'undefined' || typeof listener !== 'function') {
    return () => {};
  }
  const onCustom = () => listener();
  const onStorage = (e) => {
    if (!e || !e.key || e.key === UNIT_PREFERENCE_STORAGE_KEY) {
      listener();
    }
  };
  window.addEventListener(UNIT_PREFERENCE_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(UNIT_PREFERENCE_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * Resolve the effective unit system (`'imperial' | 'metric'`) given preference + location.
 * @param {{
 *   preference?: 'auto' | 'imperial' | 'metric',
 *   location?: { lat?: number, lng?: number } | null,
 *   fallbackCoords?: { lat?: number, lng?: number } | null,
 *   locale?: string,
 *   timeZone?: string
 * }} [params]
 * @returns {{
 *   preference: 'auto' | 'imperial' | 'metric',
 *   unitSystem: 'imperial' | 'metric',
 *   detectedSystem: 'imperial' | 'metric',
 *   detectedSource: 'gps' | 'parcel' | 'locale'
 * }}
 */
export function resolveUnitSystem({
  preference = getStoredUnitPreference(),
  location = null,
  fallbackCoords = null,
  locale = '',
  timeZone = ''
} = {}) {
  const pref = normalizeUnitPreference(preference);
  const detected = detectUnitSystemForLocation(location, {
    fallbackCoords,
    locale,
    timeZone
  });
  const unitSystem = pref === 'auto' ? detected.system : pref;
  return {
    preference: pref,
    unitSystem,
    detectedSystem: detected.system,
    detectedSource: detected.source
  };
}

function formatCompactNum(val) {
  if (val < 10) {
    const rounded = Number(val.toFixed(1));
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }
  return String(Math.round(val));
}

/**
 * Format a distance (in meters) into the resolved unit system (ft/mi or m/km).
 * @param {number | null | undefined} meters
 * @param {'imperial' | 'metric'} [unitSystem='metric']
 * @param {{ compact?: boolean }} [options]
 * @returns {string}
 */
export function formatDistance(meters, unitSystem = 'metric', { compact = false } = {}) {
  if (meters === null || meters === undefined) return '';
  const val = Number(meters);
  if (!Number.isFinite(val) || val < 0) return '';
  const sep = compact ? '' : ' ';

  if (normalizeUnitSystem(unitSystem) === 'imperial') {
    const feet = val * FEET_PER_METER;
    if (feet < 1000) {
      return `${Math.round(feet)}${sep}ft`;
    }
    const miles = val / METERS_PER_MILE;
    if (miles < 10) {
      return `${miles.toFixed(1)}${sep}mi`;
    }
    return `${Math.round(miles).toLocaleString()}${sep}mi`;
  }

  if (val < 1000) return `${Math.round(val)}${sep}m`;
  if (val < 10000) return `${(val / 1000).toFixed(1)}${sep}km`;
  return `${Math.round(val / 1000)}${sep}km`;
}

/**
 * Format a short precision or depth length (e.g., AR surface depth or GPS precision).
 * @param {number | null | undefined} meters
 * @param {'imperial' | 'metric'} [unitSystem='metric']
 * @param {{ decimals?: number, compact?: boolean }} [options]
 * @returns {string}
 */
export function formatShortLength(
  meters,
  unitSystem = 'metric',
  { decimals = 1, compact = true } = {}
) {
  if (meters === null || meters === undefined) return '';
  const val = Number(meters);
  if (!Number.isFinite(val)) return '';
  const sep = compact ? '' : ' ';

  if (normalizeUnitSystem(unitSystem) === 'imperial') {
    const feet = val * FEET_PER_METER;
    const d = Math.abs(feet) >= 100 ? 0 : decimals;
    return `${feet.toFixed(d)}${sep}ft`;
  }
  return `${val.toFixed(decimals)}${sep}m`;
}

/**
 * Format W×D×H (or W×D) parcel dimensions in feet or meters.
 * @param {number} widthMeters
 * @param {number} depthMeters
 * @param {number | null | undefined} [heightMeters]
 * @param {'imperial' | 'metric'} [unitSystem='metric']
 * @param {{ compact?: boolean }} [options]
 * @returns {string}
 */
export function formatDimensionTriple(
  widthMeters,
  depthMeters,
  heightMeters = null,
  unitSystem = 'metric',
  { compact = false } = {}
) {
  const wM = Number(widthMeters);
  const dM = Number(depthMeters);
  if (!Number.isFinite(wM) || !Number.isFinite(dM)) return '';
  const hM =
    heightMeters !== null && heightMeters !== undefined && heightMeters !== ''
      ? Number(heightMeters)
      : NaN;
  const isImp = normalizeUnitSystem(unitSystem) === 'imperial';
  const mult = isImp ? FEET_PER_METER : 1;
  const unit = isImp ? 'ft' : 'm';
  const sep = compact ? '' : ' ';

  const wStr = formatCompactNum(wM * mult);
  const dStr = formatCompactNum(dM * mult);
  if (Number.isFinite(hM)) {
    return `${wStr}×${dStr}×${formatCompactNum(hM * mult)}${sep}${unit}`;
  }
  return `${wStr}×${dStr}${sep}${unit}`;
}

/**
 * Format an area (in m²) into `ft²` or `m²`.
 * @param {number | null | undefined} sqMeters
 * @param {'imperial' | 'metric'} [unitSystem='metric']
 * @returns {string}
 */
export function formatArea(sqMeters, unitSystem = 'metric') {
  const raw = Number(sqMeters);
  if (!Number.isFinite(raw) || raw <= 0) return '';
  const isImp = normalizeUnitSystem(unitSystem) === 'imperial';
  const val = isImp ? raw * SQ_FEET_PER_SQ_METER : raw;
  const unit = isImp ? 'ft²' : 'm²';
  const numStr =
    val < 10
      ? Number.isInteger(Number(val.toFixed(1)))
        ? String(Math.round(val))
        : val.toFixed(1)
      : Math.round(val).toLocaleString();
  return `${numStr} ${unit}`;
}

/**
 * Format a volume (in m³) into `ft³` or `m³`.
 * @param {number | null | undefined} cubicMeters
 * @param {'imperial' | 'metric'} [unitSystem='metric']
 * @returns {string}
 */
export function formatVolume(cubicMeters, unitSystem = 'metric') {
  const raw = Number(cubicMeters);
  if (!Number.isFinite(raw) || raw <= 0) return '';
  const isImp = normalizeUnitSystem(unitSystem) === 'imperial';
  const val = isImp ? raw * CU_FEET_PER_CU_METER : raw;
  const unit = isImp ? 'ft³' : 'm³';
  const numStr =
    val < 10
      ? Number.isInteger(Number(val.toFixed(1)))
        ? String(Math.round(val))
        : val.toFixed(1)
      : Math.round(val).toLocaleString();
  return `${numStr} ${unit}`;
}

/**
 * Format a parcel's 3D dimensions + footprint area in the target unit system.
 * @param {any} parcel
 * @param {'imperial' | 'metric'} [unitSystem='metric']
 * @returns {string}
 */
export function formatLandDimensionsWithUnits(parcel, unitSystem = 'metric') {
  const vol = parcel?.volume;
  if (!vol) return '';
  const w = Number(vol.widthMeters);
  const d = Number(vol.depthMeters);
  const h = Number(vol.heightMeters);
  if (!Number.isFinite(w) || !Number.isFinite(d)) return '';
  const rawArea = Number.isFinite(Number(vol.footprintAreaSqM))
    ? Number(vol.footprintAreaSqM)
    : w * d;
  const dimPart = formatDimensionTriple(w, d, Number.isFinite(h) ? h : null, unitSystem);
  const areaPart = rawArea > 0 ? formatArea(rawArea, unitSystem) : '';
  return areaPart ? `${dimPart} · ${areaPart}` : dimPart;
}

/**
 * Format a search radius (e.g. 5000 m -> `3.1 mi` in US Imperial, `5 km` in Metric).
 * @param {number} radiusMeters
 * @param {'imperial' | 'metric'} [unitSystem='metric']
 * @returns {string}
 */
export function formatRadiusLabel(radiusMeters, unitSystem = 'metric') {
  const val = Number(radiusMeters);
  if (!Number.isFinite(val) || val <= 0) return '';
  if (normalizeUnitSystem(unitSystem) === 'imperial') {
    const miles = val / METERS_PER_MILE;
    return miles >= 10 ? `${Math.round(miles)} mi` : `${miles.toFixed(1)} mi`;
  }
  if (val >= 1000 && val % 1000 === 0) return `${val / 1000} km`;
  return formatDistance(val, 'metric');
}

/**
 * React hook returning the live resolved unit system + setter, updating automatically
 * whenever the user edits their settings or their GPS location updates.
 * @param {{ lat?: number, lng?: number } | null | undefined} [location]
 * @param {{ lat?: number, lng?: number } | null | undefined} [fallbackCoords]
 */
export function useMeasurementUnits(location = null, fallbackCoords = null) {
  const [version, setVersion] = useState(0);
  const locLat = location?.lat;
  const locLng = location?.lng;

  useEffect(() => {
    if (
      locLat !== null &&
      locLat !== undefined &&
      locLat !== '' &&
      locLng !== null &&
      locLng !== undefined &&
      locLng !== '' &&
      Number.isFinite(Number(locLat)) &&
      Number.isFinite(Number(locLng))
    ) {
      setLastKnownUnitLocation({ lat: Number(locLat), lng: Number(locLng) });
    }
  }, [locLat, locLng]);

  useEffect(() => subscribeUnitPreference(() => setVersion((v) => v + 1)), []);

  void version;
  const resolved = resolveUnitSystem({
    preference: getStoredUnitPreference(),
    location,
    fallbackCoords
  });

  return {
    ...resolved,
    setPreference: (nextPref) => {
      setStoredUnitPreference(nextPref);
      setVersion((v) => v + 1);
    }
  };
}
