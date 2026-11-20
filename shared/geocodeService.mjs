import { decodeGeohashBounds, encodeGeohash, haversineMeters } from '../server/services/pol.mjs';

function normalizeCoordinateQuery(q) {
  const m = String(q || '')
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -85 || lat > 85 || lng < -180 || lng > 180) {
    return null;
  }
  return { lat, lng };
}

function classifyOsmType(category = '', type = '', label = '') {
  const hay = `${category} ${type} ${label}`.toLowerCase();
  if (/&|\band\b|intersection|junction|crossing/.test(hay)) return 'intersection';
  if (
    /amenity|shop|restaurant|cafe|bar|bank|hotel|mall|office|store|company|cinema|theatre|museum|studio|pharmacy|supermarket/.test(
      hay
    )
  ) {
    return 'business';
  }
  if (/tourism|historic|park|plaza|square|monument|tower|stadium/.test(hay)) return 'landmark';
  return 'address';
}

async function safeFetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Searches intersections, businesses, landmarks, addresses, coordinates, or GLAND parcel IDs.
 */
export async function searchLocations({ query = '', lat = null, lng = null, limit = 6 } = {}) {
  const q = String(query || '').trim().slice(0, 140);
  const maxResults = Math.max(1, Math.min(12, Number(limit) || 6));
  if (q.length < 2) {
    return { query: q, results: [] };
  }

  // 1. Direct parcel ID shortcut (GLAND-...)
  if (/^GLAND-[0-9A-Z]{6,10}$/i.test(q)) {
    const cleanId = q.toUpperCase();
    const gh = cleanId.slice(6).toLowerCase();
    const bounds = decodeGeohashBounds(gh);
    return {
      query: q,
      results: [
        {
          id: cleanId,
          label: `${cleanId} (Virtual Land Parcel)`,
          subtitle: `${bounds.center[0]}, ${bounds.center[1]}`,
          category: 'parcel',
          lat: bounds.center[0],
          lng: bounds.center[1],
          parcelId: cleanId
        }
      ]
    };
  }

  // 2. Direct lat, lng coordinate shortcut
  const coord = normalizeCoordinateQuery(q);
  if (coord) {
    const gh = encodeGeohash(coord.lat, coord.lng, 8);
    const parcelId = `GLAND-${gh.toUpperCase()}`;
    return {
      query: q,
      results: [
        {
          id: `${coord.lat},${coord.lng}`,
          label: `${coord.lat.toFixed(5)}, ${coord.lng.toFixed(5)}`,
          subtitle: `Virtual Land ${parcelId}`,
          category: 'coordinates',
          lat: coord.lat,
          lng: coord.lng,
          parcelId
        }
      ]
    };
  }

  const hasBias = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
  const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=${maxResults}&q=${encodeURIComponent(
    q
  )}`;
  const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${maxResults}${
    hasBias ? `&lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lng))}` : ''
  }`;

  const [nomData, photonData] = await Promise.all([
    safeFetchJson(nominatimUrl, {
      'User-Agent': 'GRAFFILAND/1.0 (+https://maximusmaximus.github.io/graffiland)',
      Accept: 'application/json'
    }),
    safeFetchJson(photonUrl, { Accept: 'application/json' })
  ]);

  const combined = [];

  if (Array.isArray(nomData)) {
    for (const item of nomData) {
      const rLat = Number(item.lat);
      const rLng = Number(item.lon);
      if (!Number.isFinite(rLat) || !Number.isFinite(rLng)) continue;
      const gh = encodeGeohash(rLat, rLng, 8);
      const label = String(item.name || item.display_name || q).split(',')[0].trim();
      const subtitle = String(item.display_name || '')
        .split(',')
        .slice(1, 4)
        .join(',')
        .trim();
      combined.push({
        id: `nom-${item.place_id || `${rLat},${rLng}`}`,
        label: label || q,
        subtitle: subtitle || `GLAND-${gh.toUpperCase()}`,
        category: classifyOsmType(item.category, item.type, `${q} ${item.display_name || ''}`),
        lat: Number(rLat.toFixed(6)),
        lng: Number(rLng.toFixed(6)),
        parcelId: `GLAND-${gh.toUpperCase()}`
      });
    }
  }

  if (Array.isArray(photonData?.features)) {
    for (const feat of photonData.features) {
      const coords = feat?.geometry?.coordinates;
      const props = feat?.properties || {};
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const rLng = Number(coords[0]);
      const rLat = Number(coords[1]);
      if (!Number.isFinite(rLat) || !Number.isFinite(rLng)) continue;
      const gh = encodeGeohash(rLat, rLng, 8);
      const nameParts = [props.name, props.street && props.housenumber ? `${props.housenumber} ${props.street}` : props.street]
        .filter(Boolean);
      const subParts = [props.city || props.town || props.state, props.country].filter(Boolean);
      const label = nameParts[0] || subParts[0] || q;
      combined.push({
        id: `ph-${props.osm_id || `${rLat},${rLng}`}`,
        label,
        subtitle: subParts.join(', ') || `GLAND-${gh.toUpperCase()}`,
        category: classifyOsmType(props.osm_key, props.osm_value, `${q} ${label}`),
        lat: Number(rLat.toFixed(6)),
        lng: Number(rLng.toFixed(6)),
        parcelId: `GLAND-${gh.toUpperCase()}`
      });
    }
  }

  // Deduplicate candidates within 30m
  const deduped = [];
  for (const cand of combined) {
    const dup = deduped.some((kept) => haversineMeters(kept.lat, kept.lng, cand.lat, cand.lng) < 30);
    if (!dup) deduped.push(cand);
    if (deduped.length >= maxResults) break;
  }

  return { query: q, results: deduped };
}
