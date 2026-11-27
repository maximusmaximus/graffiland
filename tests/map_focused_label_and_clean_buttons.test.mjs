import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('Map Focused Land Labels (One Size Up), Removal of 90° & All, Pin-Only Me, and Square Map Buttons', () => {
  let dom;
  let React;
  let RTL;
  let cleanup;
  let outTmpDir;

  async function loadJsxModule(relPath) {
    const absIn = path.join(ROOT, relPath);
    const safeName = relPath.replace(/[^a-zA-Z0-9._-]/g, '_');
    const absOut = path.join(outTmpDir, `${safeName}.mjs`);
    await esbuild.build({
      entryPoints: [absIn],
      bundle: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      loader: { '.svg': 'dataurl' },
      define: { 'import.meta.env': '{}' },
      plugins: [
        {
          name: 'stub-css-for-jsdom',
          setup(build) {
            build.onResolve({ filter: /\.css$/ }, () => ({ path: 'stub.css', namespace: 'stub-css' }));
            build.onResolve({ filter: /\?url$/ }, () => ({ path: 'stub-url', namespace: 'stub-url' }));
            build.onLoad({ filter: /.*/, namespace: 'stub-css' }, () => ({ contents: '', loader: 'js' }));
            build.onLoad({ filter: /.*/, namespace: 'stub-url' }, () => ({
              contents: 'export default "";',
              loader: 'js'
            }));
          }
        }
      ],
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-map-labels-btns-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://spray.land/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true
    });

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    cleanup?.();
    dom?.window?.close();
    if (outTmpDir) fs.rmSync(outTmpDir, { recursive: true, force: true });
  });

  test('1. Canvas drawFloatingLandLabel renders focused (isPrimary) land label one size up from other lands', async () => {
    const { drawFloatingLandLabel } = await loadJsxModule('client/src/utils/map3dLabelOverlay.js');
    const calls = [];
    const ctx = {
      font: '',
      save() {},
      restore() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      arc() {},
      rect() {},
      roundRect() {},
      closePath() {},
      fill() {},
      stroke() {},
      measureText(str) {
        return { width: String(str).length * 7 };
      },
      fillText(txt) {
        calls.push({ txt, font: this.font });
      }
    };
    const geom = {
      bottom: [
        { x: 100, y: 200 },
        { x: 180, y: 200 },
        { x: 180, y: 260 },
        { x: 100, y: 260 }
      ],
      top: [
        { x: 100, y: 120 },
        { x: 180, y: 120 },
        { x: 180, y: 180 },
        { x: 100, y: 180 }
      ],
      topCenter: { x: 140, y: 150, visible: true }
    };

    const otherLabel = drawFloatingLandLabel(ctx, geom, { label: 'Other Land', isPrimary: false });
    const focusedLabel = drawFloatingLandLabel(ctx, geom, { label: 'Focused Land', isPrimary: true });

    assert.ok(focusedLabel.fontSizePx > otherLabel.fontSizePx, 'Focused land font must be larger');
    assert.ok(focusedLabel.height > otherLabel.height, 'Focused land pill must be taller');
    assert.ok(focusedLabel.width > otherLabel.width, 'Focused land pill must have wider padding');
    assert.match(calls[0].font, /10\.5px/);
    assert.match(calls[1].font, /12\.5px/);
  });

  test('2. All map views style focused land labels one size up in CSS and mark focused pills consistently', () => {
    const css = fs.readFileSync(path.join(ROOT, 'client/src/styles.css'), 'utf8');
    // 2D Leaflet map focused label
    assert.match(css, /\.map-land-simple-label\.is-selected,\s*\.map-land-simple-label\.is-focused[\s\S]*font-size:\s*13px/);
    // 3D Desktop MapLibre map focused label
    assert.match(css, /\.map3d-land-label-pill\.is-focused\s+\.map3d-owned-plus-tag[\s\S]*font-size:\s*12\.5px/);
    // Isometric PlotVisit / Showcase focused label
    assert.match(
      css,
      /\.plot-iso-land-label-pill\.is-focused\s+\.plot-iso-land-label-btn,[\s\S]*font-size:\s*14px/
    );

    // MapView, MapView3D, PlotVisitView, and MobileIsometricMap all propagate focused state
    const mapViewSrc = fs.readFileSync(path.join(ROOT, 'client/src/components/MapView.jsx'), 'utf8');
    const map3dSrc = fs.readFileSync(path.join(ROOT, 'client/src/components/MapView3D.jsx'), 'utf8');
    const plotSrc = fs.readFileSync(path.join(ROOT, 'client/src/components/PlotVisitView.jsx'), 'utf8');
    const mobIsoSrc = fs.readFileSync(
      path.join(ROOT, 'client/src/components/studio/MobileIsometricMap.jsx'),
      'utf8'
    );
    assert.match(mapViewSrc, /is-selected is-focused/);
    assert.match(mapViewSrc, /data-focused=/);
    assert.match(map3dSrc, /pillEl\.classList\.toggle\('is-focused',\s*isFocusedPin\)/);
    assert.match(plotSrc, /plot-iso-land-label-pill is-focused/);
    assert.match(mobIsoSrc, /plot-iso-land-label-pill is-focused/);
  });

  test('3. 90° and All buttons are removed across MobileIsometricMap and LandIsometricPreview; Me text is removed for pin-only icon', async () => {
    const { default: MobileIsometricMap } = await loadJsxModule(
      'client/src/components/studio/MobileIsometricMap.jsx'
    );
    const { default: LandIsometricPreview } = await loadJsxModule(
      'client/src/components/LandIsometricPreview.jsx'
    );
    const { default: MapView } = await loadJsxModule('client/src/components/MapView.jsx');
    const { default: MapView3D } = await loadJsxModule('client/src/components/MapView3D.jsx');

    const parcelA = {
      parcelId: 'GLAND-A1',
      customName: 'Alpha Plaza',
      centerLat: 39.73,
      centerLng: -121.84,
      sculptureCount: 2,
      stewardStatus: 'awakened',
      volume: {
        parcelId: 'GLAND-A1',
        centerLat: 39.73,
        centerLng: -121.84,
        widthMeters: 20,
        depthMeters: 20,
        heightMeters: 16,
        rotationDeg: 0
      }
    };
    const parcelB = {
      ...parcelA,
      parcelId: 'GLAND-B2',
      customName: 'Beta Park',
      centerLat: 39.7305,
      centerLng: -121.8405,
      volume: { ...parcelA.volume, parcelId: 'GLAND-B2', centerLat: 39.7305, centerLng: -121.8405 }
    };

    // 3a) MobileIsometricMap (even in fullscreen with 2 parcels) has NO 90° button, NO All button, and pin-only Me button
    const mobView = RTL.render(
      React.createElement(MobileIsometricMap, {
        parcels: [parcelA, parcelB],
        sculptures: [],
        userLocation: { lat: 39.73, lng: -121.84 },
        selectedParcelId: 'GLAND-A1',
        isFullExpanded: true,
        onToggle2D: () => {},
        onToggleFullMap: () => {}
      })
    );
    assert.equal(mobView.queryByTestId('mobile-map-orbit-btn'), null);
    assert.equal(mobView.queryByTestId('mobile-map-fit-all-btn'), null);
    assert.equal(mobView.container.textContent.includes('90°'), false);
    const mobMe = mobView.getByTestId('mobile-map-me-btn');
    assert.equal((mobMe.textContent || '').trim(), '', 'Mobile 3D map pin must not show "Me"');
    assert.ok(mobMe.className.includes('is-square-icon'));
    assert.ok(mobView.getByTestId('mobile-map-theme-toggle-btn').className.includes('is-square-icon'));
    assert.ok(mobView.getByTestId('mobile-map-fullscreen-btn').className.includes('is-square-icon'));
    mobView.unmount();

    // 3b) LandIsometricPreview has NO 90° button
    const prevView = RTL.render(
      React.createElement(LandIsometricPreview, {
        parcel: parcelA,
        otherParcels: [parcelB],
        sculptures: []
      })
    );
    assert.equal(prevView.queryByRole('button', { name: /90 degrees/i }), null);
    assert.equal(prevView.container.textContent.includes('90°'), false);
    prevView.unmount();

    // 3c) Compact 2D MapView has pin-only square location button (no "Me")
    const map2dView = RTL.render(
      React.createElement(MapView, {
        parcels: [parcelA, parcelB],
        sculptures: [],
        userLocation: { lat: 39.73, lng: -121.84 },
        compact: true,
        selectedParcelId: 'GLAND-A1',
        onToggle3D: () => {},
        onToggleFullMap: () => {}
      })
    );
    const map2dMe = map2dView.getByTestId('mobile-map-me-btn');
    assert.equal((map2dMe.textContent || '').trim(), '', '2D map pin must not show "Me"');
    assert.ok(map2dMe.className.includes('is-square-icon'));
    assert.ok(map2dView.getByTestId('mobile-map-theme-toggle-btn').className.includes('is-square-icon'));
    assert.ok(map2dView.getByTestId('mobile-map-fullscreen-btn').className.includes('is-square-icon'));
    map2dView.unmount();

    // 3d) Desktop 3D MapView3D has pin-only square location button (no "Me")
    const map3dView = RTL.render(
      React.createElement(MapView3D, {
        parcels: [parcelA, parcelB],
        sculptures: [],
        userLocation: { lat: 39.73, lng: -121.84 },
        selectedParcelId: 'GLAND-A1'
      })
    );
    const map3dMe = map3dView.getByTestId('map3d-me-btn');
    assert.equal((map3dMe.textContent || '').trim(), '', 'Desktop 3D map pin must not show "Me"');
    assert.ok(map3dMe.className.includes('is-square-icon'));
    map3dView.unmount();
  });

  test('4. CSS enforces square map buttons and prevents coarse-pointer vertical stretching', () => {
    const css = fs.readFileSync(path.join(ROOT, 'client/src/styles.css'), 'utf8');
    // Icon buttons on maps are strict 1:1 squares
    assert.match(css, /\.map-recenter-fab\.is-square-icon,[\s\S]*width:\s*32px;[\s\S]*height:\s*32px;[\s\S]*aspect-ratio:\s*1\s*\/\s*1;/);
    assert.match(css, /\.map3d-floating-toolbar\s+\.btn\.is-square-icon[\s\S]*width:\s*30px;[\s\S]*height:\s*30px;[\s\S]*aspect-ratio:\s*1\s*\/\s*1;/);
    // Coarse pointer (touch) must NOT inflate .map-recenter-fab to 44px tall vertical bars — keeps 36x36 squares!
    assert.match(css, /@media\s*\(pointer:\s*coarse\)[\s\S]*\.btn:not\(\.btn-sm\):not\(\.btn-xs\):not\(\.map-recenter-fab\):not\(\.map-square-btn\)/);
    assert.match(
      css,
      /@media\s*\(pointer:\s*coarse\)[\s\S]*\.map-recenter-fab\.is-square-icon,[\s\S]*width:\s*36px;[\s\S]*height:\s*36px;[\s\S]*aspect-ratio:\s*1\s*\/\s*1;/
    );
  });
});
