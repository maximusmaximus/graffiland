import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  clearLastKnownUnitLocation,
  detectUnitSystemForLocation,
  detectUnitSystemFromLocale,
  formatArea,
  formatDimensionTriple,
  formatDistance,
  formatLandDimensionsWithUnits,
  formatRadiusLabel,
  formatVolume,
  isImperialCoords,
  resolveUnitSystem
} from '../client/src/utils/measurementUnits.js';
import {
  buildParcelGeoSummary,
  computeScaleBarForZoom
} from '../client/src/utils/landPreviewHelpers.js';
import { formatCompactNeighborDistance } from '../client/src/utils/neighborEdgeArrows.js';

describe('Location-Aware Measurement Units (US Imperial Default + Metric + Settings Override)', () => {
  test('isImperialCoords detects USA (mainland, AK, HI, PR) as imperial and non-US / border cities as metric', () => {
    // USA locations -> Imperial (ft & mi)
    assert.equal(isImperialCoords(39.7302, -121.84067), true, 'Chico, CA');
    assert.equal(isImperialCoords(37.7749, -122.4194), true, 'San Francisco, CA');
    assert.equal(isImperialCoords(40.7128, -74.006), true, 'New York, NY');
    assert.equal(isImperialCoords(25.7617, -80.1918), true, 'Miami, FL');
    assert.equal(isImperialCoords(47.6062, -122.3321), true, 'Seattle, WA');
    assert.equal(isImperialCoords(32.7157, -117.1611), true, 'San Diego, CA');
    assert.equal(isImperialCoords(42.3314, -83.0458), true, 'Detroit, MI');
    assert.equal(isImperialCoords(61.2181, -149.9003), true, 'Anchorage, AK');
    assert.equal(isImperialCoords(21.3069, -157.8583), true, 'Honolulu, HI');
    assert.equal(isImperialCoords(18.4655, -66.1057), true, 'San Juan, PR');

    // Non-US & Canadian/Mexican border metros -> Metric (m & km)
    assert.equal(isImperialCoords(49.2827, -123.1207), false, 'Vancouver, BC');
    assert.equal(isImperialCoords(43.6532, -79.3832), false, 'Toronto, ON');
    assert.equal(isImperialCoords(45.5017, -73.5673), false, 'Montreal, QC');
    assert.equal(isImperialCoords(32.5149, -117.0382), false, 'Tijuana, MX');
    assert.equal(isImperialCoords(19.4326, -99.1332), false, 'Mexico City, MX');
    assert.equal(isImperialCoords(48.8566, 2.3522), false, 'Paris, FR');
    assert.equal(isImperialCoords(35.6762, 139.6503), false, 'Tokyo, JP');
    assert.equal(isImperialCoords(-33.8688, 151.2093), false, 'Sydney, AU');
    assert.equal(isImperialCoords(51.5074, -0.1278), false, 'London, UK');
  });

  test('detectUnitSystemForLocation prioritizes GPS coords, falls back to parcel coords, then locale/timezone', () => {
    clearLastKnownUnitLocation();
    assert.deepEqual(detectUnitSystemForLocation({ lat: 39.7302, lng: -121.8407 }), {
      system: 'imperial',
      source: 'gps'
    });
    assert.deepEqual(detectUnitSystemForLocation({ lat: 48.8566, lng: 2.3522 }), {
      system: 'metric',
      source: 'gps'
    });
    assert.deepEqual(
      detectUnitSystemForLocation(null, { fallbackCoords: { lat: 37.7749, lng: -122.4194 } }),
      { system: 'imperial', source: 'parcel' }
    );
    assert.equal(detectUnitSystemFromLocale('en-US'), 'imperial');
    assert.equal(detectUnitSystemFromLocale('fr-FR'), 'metric');
    assert.equal(detectUnitSystemFromLocale('en-GB'), 'metric');
    assert.equal(detectUnitSystemFromLocale('en', 'America/Los_Angeles'), 'imperial');
    assert.equal(detectUnitSystemFromLocale('en', 'Europe/Paris'), 'metric');
  });

  test('resolveUnitSystem honors user settings override (imperial / metric) over auto-detected location', () => {
    const usLoc = { lat: 37.7749, lng: -122.4194 };
    const euLoc = { lat: 48.8566, lng: 2.3522 };

    assert.equal(resolveUnitSystem({ preference: 'auto', location: usLoc }).unitSystem, 'imperial');
    assert.equal(resolveUnitSystem({ preference: 'auto', location: euLoc }).unitSystem, 'metric');
    assert.equal(resolveUnitSystem({ preference: 'metric', location: usLoc }).unitSystem, 'metric');
    assert.equal(resolveUnitSystem({ preference: 'imperial', location: euLoc }).unitSystem, 'imperial');
  });

  test('distance, dimension, area, volume, radius, neighbor arrow, and map scale bar format cleanly in both Imperial and Metric', () => {
    // Distances
    assert.equal(formatDistance(10, 'imperial'), '33 ft');
    assert.equal(formatDistance(100, 'imperial'), '328 ft');
    assert.equal(formatDistance(500, 'imperial'), '0.3 mi');
    assert.equal(formatDistance(5000, 'imperial'), '3.1 mi');
    assert.equal(formatDistance(25000, 'imperial'), '16 mi');

    assert.equal(formatDistance(10, 'metric'), '10 m');
    assert.equal(formatDistance(1500, 'metric'), '1.5 km');
    assert.equal(formatRadiusLabel(5000, 'imperial'), '3.1 mi');
    assert.equal(formatRadiusLabel(5000, 'metric'), '5 km');

    // Neighbor compact distances
    assert.equal(formatCompactNeighborDistance(120, 'imperial'), '394ft');
    assert.equal(formatCompactNeighborDistance(2400, 'imperial'), '1.5mi');
    assert.equal(formatCompactNeighborDistance(120, 'metric'), '120m');

    // Dimensions, area & volume
    assert.equal(formatDimensionTriple(2.8, 2.9, 1.9, 'imperial'), '9.2×9.5×6.2 ft');
    assert.equal(formatDimensionTriple(24, 16, 36, 'imperial'), '79×52×118 ft');
    assert.equal(formatArea(384, 'imperial'), '4,133 ft²');
    assert.equal(formatVolume(100, 'imperial'), '3,531 ft³');
    assert.equal(
      formatLandDimensionsWithUnits(
        { volume: { widthMeters: 24, depthMeters: 16, heightMeters: 36, footprintAreaSqM: 384 } },
        'imperial'
      ),
      '79×52×118 ft · 4,133 ft²'
    );

    // Cartographic scale bar
    const impScale = computeScaleBarForZoom(39.73, 18.5, 92, 'imperial');
    assert.match(impScale.label, /\b(ft|mi)\b/);
    const metScale = computeScaleBarForZoom(39.73, 18.5, 92, 'metric');
    assert.match(metScale.label, /\b(m|km)\b/);

    // Parcel geo summary in imperial
    const summary = buildParcelGeoSummary(
      {
        parcelId: 'GLAND-US1',
        volume: {
          centerLat: 39.7302,
          centerLng: -121.84067,
          widthMeters: 24,
          depthMeters: 16,
          heightMeters: 36,
          footprintAreaSqM: 384,
          volumeCubicM: 13824
        }
      },
      {
        userLocation: { lat: 39.735, lng: -121.84067 },
        unitSystem: 'imperial'
      }
    );
    assert.ok(summary.dimensionsLabel.includes('ft'));
    assert.ok(summary.dimensionsLabel.includes('ft²'));
    assert.ok(summary.volumeLabel.includes('ft³'));
    assert.match(summary.distanceFromUserLabel, /\b(ft|mi)\b/);
  });
});
