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

function looksLikeIntersection(q) {
  return /\s(&|and|\/|at|@)\s/i.test(String(q || '')) || /&/.test(String(q || ''));
}

function classifyOsmType(category = '', type = '', label = '') {
  const hay = `${category} ${type} ${label}`.toLowerCase();
  if (/streetint|intersection|junction|crossing/.test(hay) || (looksLikeIntersection(label) && !/deli|market|pizza|cafe|bar|shop/.test(hay))) {
    return 'intersection';
  }
  if (
    /poi|amenity|shop|restaurant|cafe|coffee|bar|bank|hotel|mall|office|store|company|cinema|theatre|museum|studio|pharmacy|supermarket|food|retail/.test(
      hay
    )
  ) {
    return 'business';
  }
  if (/tourism|historic|park|plaza|square|monument|tower|stadium|landmark|bridge|attraction/.test(hay)) {
    return 'landmark';
  }
  return 'address';
}

async function safeFetchJson(url, headers = {}, timeoutMs = 4200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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

function scoreCandidate(cand, query, biasLat, biasLng, hasBias) {
  let score = Number(cand._providerScore || 50);
  const qLower = String(query || '').trim().toLowerCase();
  const labelLower = String(cand.label || '').toLowerCase();
  const fullLower = `${labelLower} ${String(cand.subtitle || '').toLowerCase()}`;

  // Exact or prefix match boost
  if (labelLower === qLower) score += 40;
  else if (labelLower.startsWith(qLower)) score += 22;
  else if (fullLower.includes(qLower)) score += 12;

  // Intersection query strongly prefers actual street intersections over businesses containing "&"
  if (looksLikeIntersection(qLower)) {
    if (cand.category === 'intersection') score += 55;
    else if (cand.category === 'business') score -= 18;
  }

  // Token overlap bonus (handles explicit city/neighborhood names like "Times Square" or "San Francisco")
  const tokens = qLower
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !['and', 'the', 'ave', 'street', 'road', 'blvd'].includes(t));
  let matchedTokens = 0;
  for (const tok of tokens) {
    if (fullLower.includes(tok)) matchedTokens += 1;
  }
  if (tokens.length > 0) {
    score += (matchedTokens / tokens.length) * 28;
  }

  // Proximity boost around current map center when available
  if (hasBias && Number.isFinite(cand.distanceMeters)) {
    if (cand.distanceMeters <= 1500) score += 42;
    else if (cand.distanceMeters <= 8000) score += 32;
    else if (cand.distanceMeters <= 35000) score += 20;
    else if (cand.distanceMeters <= 150000) score += 8;
  }

  return score;
}

/**
 * Searches intersections, businesses, landmarks, addresses, coordinates, or GLAND parcel IDs
 * using ArcGIS World Geocoder (intersections + local POIs), Photon (biased OSM POIs), and Nominatim (viewbox biased).
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

  const bLat = Number(lat);
  const bLng = Number(lng);
  const hasBias = Number.isFinite(bLat) && Number.isFinite(bLng);

  // ArcGIS World Geocoder handles intersections ("Market & 5th") and local biased POIs ("Blue Bottle Coffee") cleanly
  const arcgisUrl = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&SingleLine=${encodeURIComponent(
    q
  )}&outFields=Match_addr,Addr_type,Type,PlaceName,City,Region&maxLocations=${maxResults}${
    hasBias ? `&location=${encodeURIComponent(`${bLng},${bLat}`)}` : ''
  }`;

  const viewboxParam = hasBias
    ? `&viewbox=${encodeURIComponent(
        `${(bLng - 0.35).toFixed(4)},${(bLat + 0.35).toFixed(4)},${(bLng + 0.35).toFixed(4)},${(bLat - 0.35).toFixed(4)}`
      )}&bounded=0`
    : '';
  const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=${maxResults}&q=${encodeURIComponent(
    q
  )}${viewboxParam}`;

  const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${maxResults}${
    hasBias ? `&lat=${encodeURIComponent(String(bLat))}&lon=${encodeURIComponent(String(bLng))}` : ''
  }`;

  const [arcgisData, photonData, nomData] = await Promise.all([
    safeFetchJson(arcgisUrl, { Accept: 'application/json' }),
    safeFetchJson(photonUrl, { Accept: 'application/json' }),
    safeFetchJson(nominatimUrl, {
      'User-Agent': 'GRAFFILAND/1.0 (+https://maximusmaximus.github.io/graffiland)',
      Accept: 'application/json'
    })
  ]);

  const combined = [];

  if (Array.isArray(arcgisData?.candidates)) {
    for (const c of arcgisData.candidates) {
      const rLat = Number(c?.location?.y);
      const rLng = Number(c?.location?.x);
      if (!Number.isFinite(rLat) || !Number.isFinite(rLng)) continue;
      const attrs = c.attributes || {};
      const gh = encodeGeohash(rLat, rLng, 8);
      const addrType = String(attrs.Addr_type || '');
      const placeType = String(attrs.Type || '');
      const rawAddr = String(attrs.Match_addr || c.address || q);
      const label = String(attrs.PlaceName || rawAddr.split(',')[0] || q).trim();
      const subParts = [
        attrs.PlaceName && rawAddr !== attrs.PlaceName ? rawAddr.split(',').slice(0, 2).join(',').trim() : '',
        attrs.City,
        attrs.Region
      ].filter(Boolean);
      const subtitle =
        subParts.length > 0
          ? Array.from(new Set(subParts)).slice(0, 3).join(', ')
          : rawAddr.split(',').slice(1, 3).join(',').trim() || `GLAND-${gh.toUpperCase()}`;

      combined.push({
        id: `arc-${rLat.toFixed(5)},${rLng.toFixed(5)}-${label.slice(0, 16)}`,
        label,
        subtitle,
        category: classifyOsmType(addrType, placeType, `${label} ${addrType}`),
        lat: Number(rLat.toFixed(6)),
        lng: Number(rLng.toFixed(6)),
        parcelId: `GLAND-${gh.toUpperCase()}`,
        distanceMeters: hasBias ? Math.round(haversineMeters(bLat, bLng, rLat, rLng)) : null,
        _providerScore: Math.min(95, Number(c.score || 75))
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
      const nameParts = [
        props.name,
        props.street && props.housenumber ? `${props.housenumber} ${props.street}` : props.street
      ].filter(Boolean);
      const subParts = [props.city || props.town || props.state, props.country].filter(Boolean);
      const label = nameParts[0] || subParts[0] || q;
      combined.push({
        id: `ph-${props.osm_id || `${rLat},${rLng}`}`,
        label,
        subtitle: subParts.join(', ') || `GLAND-${gh.toUpperCase()}`,
        category: classifyOsmType(props.osm_key, props.osm_value, `${q} ${label}`),
        lat: Number(rLat.toFixed(6)),
        lng: Number(rLng.toFixed(6)),
        parcelId: `GLAND-${gh.toUpperCase()}`,
        distanceMeters: hasBias ? Math.round(haversineMeters(bLat, bLng, rLat, rLng)) : null,
        _providerScore: 68
      });
    }
  }

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
        parcelId: `GLAND-${gh.toUpperCase()}`,
        distanceMeters: hasBias ? Math.round(haversineMeters(bLat, bLng, rLat, rLng)) : null,
        _providerScore: 62
      });
    }
  }

  // Rank candidates by match quality + local proximity to current map center
  const ranked = combined
    .map((cand) => ({ ...cand, _rank: scoreCandidate(cand, q, bLat, bLng, hasBias) }))
    .sort((a, b) => b._rank - a._rank);

  // Deduplicate candidates within 40m
  const deduped = [];
  for (const cand of ranked) {
    const dup = deduped.some((kept) => haversineMeters(kept.lat, kept.lng, cand.lat, cand.lng) < 40);
    if (!dup) {
      deduped.push({
        id: cand.id,
        label: cand.label,
        subtitle: cand.subtitle,
        category: cand.category,
        lat: cand.lat,
        lng: cand.lng,
        parcelId: cand.parcelId,
        geohash: cand.geohash,
        distanceMeters: cand.distanceMeters
      });
    }
    if (deduped.length >= maxResults) break;
  }

  return { query: q, results: deduped };
}

/**
 * Reverse-geocodes (lat, lng) into concise human-readable geographic context
 * (street/place, neighborhood, city, region, country) using ArcGIS World Geocoder
 * with Photon OSM fallback. Never throws on upstream outage.
 */
export async function reverseGeocodeLocation({ lat, lng } = {}) {
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (
    !Number.isFinite(nLat) ||
    !Number.isFinite(nLng) ||
    nLat < -85 ||
    nLat > 85 ||
    nLng < -180 ||
    nLng > 180
  ) {
    return {
      lat: null,
      lng: null,
      parcelId: '',
      street: '',
      neighborhood: '',
      city: '',
      region: '',
      country: '',
      shortLabel: '',
      fullLabel: ''
    };
  }

  const gh = encodeGeohash(nLat, nLng, 8);
  const parcelId = `GLAND-${gh.toUpperCase()}`;

  const arcgisUrl = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?f=json&location=${encodeURIComponent(
    `${nLng.toFixed(6)},${nLat.toFixed(6)}`
  )}`;
  const photonUrl = `https://photon.komoot.io/reverse?lon=${encodeURIComponent(
    nLng.toFixed(6)
  )}&lat=${encodeURIComponent(nLat.toFixed(6))}`;

  const [arcgisData, photonData] = await Promise.all([
    safeFetchJson(arcgisUrl, { Accept: 'application/json' }, 3500),
    safeFetchJson(photonUrl, { Accept: 'application/json' }, 3500)
  ]);

  let street = '';
  let neighborhood = '';
  let city = '';
  let region = '';
  let country = '';
  let fullLabel = '';

  const addr = arcgisData?.address;
  if (addr && typeof addr === 'object') {
    const rawStreet = String(addr.Address || addr.ShortLabel || addr.PlaceName || '').trim();
    const rawCity = String(addr.City || addr.Subregion || '').trim();
    const rawRegion = String(addr.RegionAbbr || addr.Region || '').trim();
    const rawCountry = String(addr.CountryCode || addr.CntryName || '').trim();
    const rawNbr = String(addr.Neighborhood || addr.District || '').trim();
    street = rawStreet && rawStreet.toLowerCase() !== rawCity.toLowerCase() ? rawStreet : '';
    neighborhood = rawNbr && rawNbr.toLowerCase() !== rawCity.toLowerCase() ? rawNbr : '';
    city = rawCity;
    region = rawRegion;
    country = rawCountry;
    fullLabel = String(addr.LongLabel || addr.Match_addr || '').trim();
  }

  const phProps = photonData?.features?.[0]?.properties;
  if (phProps && typeof phProps === 'object') {
    if (!street) {
      const phStreet = phProps.street
        ? phProps.housenumber
          ? `${phProps.housenumber} ${phProps.street}`
          : phProps.street
        : phProps.name || '';
      street = String(phStreet || '').trim();
    }
    if (!neighborhood) {
      neighborhood = String(phProps.district || phProps.locality || '').trim();
    }
    if (!city) {
      city = String(phProps.city || phProps.town || phProps.county || '').trim();
    }
    if (!region) {
      region = String(phProps.state || '').trim();
    }
    if (!country) {
      country = String(phProps.countrycode || phProps.country || '').trim();
    }
  }

  const localityParts = [];
  if (neighborhood && neighborhood.toLowerCase() !== street.toLowerCase()) {
    localityParts.push(neighborhood);
  }
  if (city && !localityParts.some((p) => p.toLowerCase() === city.toLowerCase())) {
    localityParts.push(city);
  }
  if (region && !localityParts.some((p) => p.toLowerCase() === region.toLowerCase())) {
    localityParts.push(region);
  }
  if (!city && country) {
    localityParts.push(country);
  }

  const areaLine = localityParts.join(', ');
  const shortLabel =
    street && areaLine
      ? `${street} · ${areaLine}`
      : street || areaLine || fullLabel || `${nLat.toFixed(5)}, ${nLng.toFixed(5)}`;

  return {
    lat: Number(nLat.toFixed(6)),
    lng: Number(nLng.toFixed(6)),
    parcelId,
    street,
    neighborhood,
    city,
    region,
    country,
    shortLabel,
    fullLabel: fullLabel || shortLabel
  };
}
