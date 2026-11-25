import { useCallback, useEffect, useState } from 'react';

export const MAP_THEME_STORAGE_KEY = 'graffiland_map_theme_v1';
export const DEFAULT_MAP_THEME = 'dark';

export const OPENFREEMAP_DARK_STYLE = 'https://tiles.openfreemap.org/styles/dark';
export const OPENFREEMAP_LIGHT_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
export const OSM_RASTER_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const FALLBACK_DARK_STYLE = {
  version: 8,
  sources: {
    'osm-dark-fallback': {
      type: 'raster',
      tiles: [OSM_RASTER_TILE_URL],
      tileSize: 256,
      maxzoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }
  },
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: {
        'background-color': '#090d18'
      }
    },
    {
      id: 'osm-dark-fallback-layer',
      type: 'raster',
      source: 'osm-dark-fallback',
      minzoom: 0,
      maxzoom: 22,
      paint: {
        'raster-brightness-min': 0.02,
        'raster-brightness-max': 0.38,
        'raster-saturation': -0.72,
        'raster-contrast': 0.24,
        'raster-opacity': 0.92
      }
    }
  ]
};

export const FALLBACK_LIGHT_STYLE = {
  version: 8,
  sources: {
    'osm-light-fallback': {
      type: 'raster',
      tiles: [OSM_RASTER_TILE_URL],
      tileSize: 256,
      maxzoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }
  },
  layers: [
    {
      id: 'osm-light-fallback-layer',
      type: 'raster',
      source: 'osm-light-fallback',
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
  const isLight = normalizeMapTheme(theme) === 'light';
  return {
    url: OSM_RASTER_TILE_URL,
    options: {
      attribution: '&copy; OpenStreetMap contributors',
      maxNativeZoom: 19,
      maxZoom: 21.5
    },
    isDarkFilter: !isLight
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
 * Harmonizes OpenFreeMap Dark/Light vector basemaps with SPRAY.LAND's midnight-obsidian palette
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
    safeSetPaint(map, 'water', 'fill-color', '#122a4e');
    safeSetPaint(map, 'waterway', 'line-color', '#183663');
    safeSetPaint(map, 'landuse_residential', 'fill-color', '#10182d');
    safeSetPaint(map, 'landuse_park', 'fill-color', '#132e33');
    safeSetPaint(map, 'landcover_wood', 'fill-pattern', null);
    safeSetPaint(map, 'landcover_wood', 'fill-color', '#122b30');
    safeSetPaint(map, 'building', 'fill-color', '#1b2945');
    safeSetPaint(map, 'building', 'fill-outline-color', '#324b78');
    safeSetPaint(map, 'highway_path', 'line-color', '#2e4266');
    safeSetPaint(map, 'highway_minor', 'line-color', '#283959');
    safeSetPaint(map, 'highway_major_casing', 'line-color', '#425b8a');
    safeSetPaint(map, 'highway_major_inner', 'line-color', '#21304f');
    safeSetPaint(map, 'highway_major_subtle', 'line-color', '#364b73');
    safeSetPaint(map, 'highway_motorway_casing', 'line-color', '#506fa6');
    safeSetPaint(map, 'highway_motorway_inner', 'line-color', '#293d66');
    safeSetPaint(map, 'highway_name_other', 'text-color', '#b8ceee');
    safeSetPaint(map, 'highway_name_other', 'text-halo-color', '#060912');
    safeSetPaint(map, 'highway_name_motorway', 'text-color', '#d0e0f8');
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
      safeSetPaint(map, placeLayer, 'text-color', placeLayer === 'water_name' ? '#79a8de' : '#d2e2f7');
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
            'fill-extrusion-color': isDark ? '#273a61' : '#24324f',
            'fill-extrusion-opacity': showBuildings ? buildingOpacity : 0
          }
        },
        firstSymbolId
      );
    } else if (map.getLayer?.('building-3d')) {
      map.setPaintProperty('building-3d', 'fill-extrusion-color', isDark ? '#273a61' : '#24324f');
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
