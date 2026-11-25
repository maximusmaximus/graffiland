import { useCallback, useEffect, useState } from 'react';

export const MAP_THEME_STORAGE_KEY = 'graffiland_map_theme_v1';
export const DEFAULT_MAP_THEME = 'dark';

export const OPENFREEMAP_DARK_STYLE = 'https://tiles.openfreemap.org/styles/dark';
export const OPENFREEMAP_LIGHT_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

export const FALLBACK_DARK_STYLE = {
  version: 8,
  sources: {
    'carto-dark': {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'
      ],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }
  },
  layers: [
    {
      id: 'carto-dark-layer',
      type: 'raster',
      source: 'carto-dark',
      minzoom: 0,
      maxzoom: 22
    }
  ]
};

export const FALLBACK_LIGHT_STYLE = {
  version: 8,
  sources: {
    'carto-light': {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png'
      ],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }
  },
  layers: [
    {
      id: 'carto-light-layer',
      type: 'raster',
      source: 'carto-light',
      minzoom: 0,
      maxzoom: 22
    }
  ]
};

export function normalizeMapTheme(raw) {
  return String(raw || '').trim().toLowerCase() === 'light' ? 'light' : 'dark';
}

export function getStoredMapTheme() {
  if (typeof window === 'undefined') return DEFAULT_MAP_THEME;
  try {
    const saved = window.localStorage?.getItem(MAP_THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // ignore storage restrictions
  }
  return DEFAULT_MAP_THEME;
}

export function setStoredMapTheme(nextTheme) {
  const clean = normalizeMapTheme(nextTheme);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.setItem(MAP_THEME_STORAGE_KEY, clean);
    } catch {
      // ignore
    }
    try {
      window.dispatchEvent(new CustomEvent('graffiland:map-theme', { detail: clean }));
    } catch {
      // ignore
    }
  }
  return clean;
}

export function useMapTheme() {
  const [mapTheme, setMapThemeState] = useState(() => getStoredMapTheme());

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onThemeEvt = (ev) => {
      const next = normalizeMapTheme(ev?.detail);
      setMapThemeState(next);
    };
    const onStorage = (ev) => {
      if (ev?.key === MAP_THEME_STORAGE_KEY) {
        setMapThemeState(normalizeMapTheme(ev.newValue));
      }
    };
    window.addEventListener('graffiland:map-theme', onThemeEvt);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('graffiland:map-theme', onThemeEvt);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setMapTheme = useCallback((next) => {
    const resolved = setStoredMapTheme(next);
    setMapThemeState(resolved);
    return resolved;
  }, []);

  const toggleMapTheme = useCallback(() => {
    setMapThemeState((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      setStoredMapTheme(next);
      return next;
    });
  }, []);

  return { mapTheme, isDarkMap: mapTheme !== 'light', setMapTheme, toggleMapTheme };
}

export function getMapLibreStyleForTheme(theme = DEFAULT_MAP_THEME) {
  return normalizeMapTheme(theme) === 'light' ? OPENFREEMAP_LIGHT_STYLE : OPENFREEMAP_DARK_STYLE;
}

export function getFallbackMapLibreStyleForTheme(theme = DEFAULT_MAP_THEME) {
  return normalizeMapTheme(theme) === 'light' ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE;
}

export function getLeafletTileConfig(theme = DEFAULT_MAP_THEME) {
  if (normalizeMapTheme(theme) === 'light') {
    return {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: {
        attribution: '&copy; OpenStreetMap contributors',
        maxNativeZoom: 19,
        maxZoom: 21.5
      }
    };
  }
  return {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      subdomains: 'abcd',
      maxNativeZoom: 20,
      maxZoom: 21.5
    }
  };
}

function safeSetPaint(map, layerId, prop, value) {
  try {
    if (map?.getLayer?.(layerId)) {
      map.setPaintProperty(layerId, prop, value);
    }
  } catch {
    // ignore style differences across fallback / custom basemaps
  }
}

/**
 * Harmonizes OpenFreeMap Dark/Light vector basemaps with Graffiland's midnight-obsidian palette
 * and guarantees extruded 3D buildings (`building-3d`) are present in dark mode too.
 */
export function applyGraffilandMapLibreTheme(
  map,
  { theme = DEFAULT_MAP_THEME, showBuildings = true, buildingOpacity = 0.78 } = {}
) {
  if (!map) return;
  const isDark = normalizeMapTheme(theme) !== 'light';

  if (isDark) {
    safeSetPaint(map, 'background', 'background-color', '#090d18');
    safeSetPaint(map, 'water', 'fill-color', '#0e1d36');
    safeSetPaint(map, 'waterway', 'line-color', '#122646');
    safeSetPaint(map, 'landuse_residential', 'fill-color', '#0d1323');
    safeSetPaint(map, 'landuse_park', 'fill-color', '#0f2326');
    safeSetPaint(map, 'landcover_wood', 'fill-pattern', null);
    safeSetPaint(map, 'landcover_wood', 'fill-color', '#0f2124');
    safeSetPaint(map, 'building', 'fill-color', '#131c31');
    safeSetPaint(map, 'building', 'fill-outline-color', '#21304f');
    safeSetPaint(map, 'highway_path', 'line-color', '#23314c');
    safeSetPaint(map, 'highway_minor', 'line-color', '#1b263d');
    safeSetPaint(map, 'highway_major_casing', 'line-color', '#2e3e60');
    safeSetPaint(map, 'highway_major_inner', 'line-color', '#162036');
    safeSetPaint(map, 'highway_major_subtle', 'line-color', '#283654');
    safeSetPaint(map, 'highway_motorway_casing', 'line-color', '#3a4e78');
    safeSetPaint(map, 'highway_motorway_inner', 'line-color', '#1c2a46');
    safeSetPaint(map, 'highway_name_other', 'text-color', '#9db3d4');
    safeSetPaint(map, 'highway_name_other', 'text-halo-color', '#060912');
    safeSetPaint(map, 'highway_name_motorway', 'text-color', '#b8cae6');
    safeSetPaint(map, 'highway_name_motorway', 'text-halo-color', '#060912');
    for (const placeLayer of [
      'place_other',
      'place_suburb',
      'place_village',
      'place_town',
      'place_city',
      'place_city_large',
      'place_state',
      'place_country_other',
      'place_country_minor',
      'place_country_major',
      'water_name'
    ]) {
      safeSetPaint(map, placeLayer, 'text-color', placeLayer === 'water_name' ? '#6690c2' : '#c6d6ee');
      safeSetPaint(map, placeLayer, 'text-halo-color', 'rgba(6, 9, 18, 0.92)');
    }
  }

  try {
    if (!map.getLayer?.('building-3d') && map.getSource?.('openmaptiles')) {
      const styleLayers = map.getStyle?.()?.layers || [];
      const firstSymbolId = styleLayers.find((l) => l.type === 'symbol')?.id;
      map.addLayer(
        {
          id: 'building-3d',
          type: 'fill-extrusion',
          source: 'openmaptiles',
          'source-layer': 'building',
          minzoom: 14,
          filter: ['!', ['has', 'hide_3d']],
          paint: {
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
            'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
            'fill-extrusion-color': isDark ? '#1e2c4a' : '#24324f',
            'fill-extrusion-opacity': showBuildings ? buildingOpacity : 0
          }
        },
        firstSymbolId
      );
    } else if (map.getLayer?.('building-3d')) {
      map.setPaintProperty('building-3d', 'fill-extrusion-color', isDark ? '#1e2c4a' : '#24324f');
      map.setPaintProperty(
        'building-3d',
        'fill-extrusion-opacity',
        showBuildings ? buildingOpacity : 0
      );
    }
  } catch {
    // ignore on fallback raster style without vector building source
  }
}
