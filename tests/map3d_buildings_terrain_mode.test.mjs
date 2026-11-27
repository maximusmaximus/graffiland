import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import {
  projectLngLatAltToScreen,
  resolveTerrainGroundMeters
} from '../client/src/utils/map3dProjection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('MapView3D Default Buildings & Terrain (3D ON, 2D Buildings OFF, No Toggle Buttons)', () => {
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
      plugins: [
        {
          name: 'stub-css-for-jsdom',
          setup(build) {
            build.onResolve({ filter: /\.css$/ }, () => ({
              path: 'stub.css',
              namespace: 'stub-css'
            }));
            build.onResolve({ filter: /\?url$/ }, () => ({
              path: 'stub-url',
              namespace: 'stub-url'
            }));
            build.onLoad({ filter: /.*/, namespace: 'stub-css' }, () => ({
              contents: '',
              loader: 'js'
            }));
            build.onLoad({ filter: /.*/, namespace: 'stub-url' }, () => ({
              contents: 'export default "";',
              loader: 'js'
            }));
          }
        }
      ],
      loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.ui-map3d-bt-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost:5173/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true
    });
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    cleanup?.();
    dom?.window?.close();
    if (outTmpDir) {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    }
  });

  test('1. resolveTerrainGroundMeters lifts 3D wireframes & sculptures cleanly onto active terrain elevation and safely returns 0 when terrain is off', () => {
    const mapWithTerrain = {
      getTerrain: () => ({ source: 'terrarium-dem', exaggeration: 1.25 }),
      queryTerrainElevation: (lngLat, opts) => {
        assert.equal(opts?.exaggerated, true);
        return lngLat[0] < -120 ? 74.5 : 12.0;
      }
    };
    assert.equal(resolveTerrainGroundMeters(mapWithTerrain, -121.84, 39.73), 74.5);

    const mapNoTerrain = {
      getTerrain: () => null,
      queryTerrainElevation: () => 999
    };
    assert.equal(resolveTerrainGroundMeters(mapNoTerrain, -121.84, 39.73), 0);
    assert.equal(resolveTerrainGroundMeters(null, -121.84, 39.73), 0);
  });

  test('2. MapView3D enables Buildings & Terrain by default in 3D/isometric, turns Buildings OFF in 2D, and removes both toggle buttons', async () => {
    const { default: MapView3D } = await loadJsxModule('client/src/components/MapView3D.jsx');

    // Render in 3D isometric mode (default desktop mode)
    const view = RTL.render(
      React.createElement(MapView3D, {
        sculptures: [],
        parcels: [],
        viewMode: 'isometric',
        onViewModeChange: () => {}
      })
    );

    const stage = view.container.querySelector('.map3d-stage');
    assert.ok(stage, 'Expected .map3d-stage root');
    assert.equal(stage.getAttribute('data-view-mode'), 'isometric');
    assert.equal(stage.getAttribute('data-show-buildings'), 'on');
    assert.equal(stage.getAttribute('data-show-terrain'), 'on');

    const toolbar = view.getByTestId('map3d-overlay-toolbar');
    assert.ok(!toolbar.textContent.includes('Buildings'), 'Buildings button must be removed');
    assert.ok(!toolbar.textContent.includes('Terrain'), 'Terrain button must be removed');
    assert.ok(toolbar.textContent.includes('2D'), '2D button remains available');
    assert.ok(toolbar.textContent.includes('3D'), '3D button remains available');

    // Switch to 3D mode -> Buildings ON, Terrain ON
    view.rerender(
      React.createElement(MapView3D, {
        sculptures: [],
        parcels: [],
        viewMode: '3d',
        onViewModeChange: () => {}
      })
    );
    assert.equal(stage.getAttribute('data-show-buildings'), 'on');
    assert.equal(stage.getAttribute('data-show-terrain'), 'on');

    // Switch to 2D mode -> Buildings OFF, Terrain stays ON
    view.rerender(
      React.createElement(MapView3D, {
        sculptures: [],
        parcels: [],
        viewMode: '2d',
        onViewModeChange: () => {}
      })
    );
    assert.equal(stage.getAttribute('data-view-mode'), '2d');
    assert.equal(stage.getAttribute('data-show-buildings'), 'off');
    assert.equal(stage.getAttribute('data-show-terrain'), 'on');
    cleanup();
  });

  test('3. MapView3D ensureCustomLayers applies setTerrain immediately on style load and updates building-3d opacity with viewMode', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'client', 'src', 'components', 'MapView3D.jsx'),
      'utf8'
    );
    assert.match(src, /const showBuildings = viewMode !== '2d';/);
    assert.match(src, /const showTerrain = true;/);
    assert.match(src, /map\.setTerrain\(\{ source: 'terrarium-dem', exaggeration: 1\.25 \}\)/);
    assert.doesNotMatch(src, /🏢.*Buildings/);
    assert.doesNotMatch(src, /🏔️.*Terrain/);
  });

  test('4. projectLngLatAltToScreen keeps 3D wireframes flush on ground at high terrain elevation (75m+) without double-lifting via mercatorMatrix', () => {
    // Reproduces MapLibre GL v6 camera at Chico CA (elevation ~75m):
    // - pixelMatrix3D subtracts camera.elevation (-75m) -> z_net = alt - 75m
    // - mercatorMatrix omits -camera.elevation!
    const width = 1000;
    const height = 800;
    const worldSize = 1000;
    const camElevation = 75;
    const lng = -121.84;
    const lat = 39.73;

    const MC = {
      fromLngLat: ([lo, la], alt = 0) => ({
        x: (lo + 180) / 360,
        y: (90 - la) / 180,
        z: alt / 1000 // 1000m = 1.0 mercator unit in this test harness
      })
    };
    const mc0 = MC.fromLngLat([lng, lat], 0);
    const px0 = mc0.x * worldSize;
    const py0 = mc0.y * worldSize;

    // Column-major pixelMatrix3D: sx = px - px0 + 500, sy = py - py0 + 400 - 2 * (alt - camElevation)
    const pixelMatrix3D = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, -2, 1, 0,
      500 - px0, 400 - py0 + 2 * camElevation, 0, 1
    ];
    // Column-major mercatorMatrix WITHOUT -camElevation (as MapLibre v6 constructs it):
    // ndcX = 0, ndcY = 2 * (mc.z * 1000) / (height/2) -> sy = 400 - 2 * alt
    const mercatorMatrix = [
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, (2 * 1000) / (height * 0.5), 1, 0,
      0, 0, 0, 1
    ];

    const mapWithPixel3D = {
      getCanvas: () => ({ clientWidth: width, clientHeight: height }),
      getTerrain: () => ({ source: 'terrarium-dem', exaggeration: 1.25 }),
      queryTerrainElevation: () => camElevation,
      _camera: {
        projectedCamera: {
          elevation: camElevation,
          worldSize,
          pixelMatrix3D,
          mercatorMatrix
        }
      }
    };

    // Ground point (relAlt = 0) MUST project to exact ground footprint center (500, 400), NOT 400 - 150 = 250!
    const groundPt = projectLngLatAltToScreen(mapWithPixel3D, { MercatorCoordinate: MC }, lng, lat, 0);
    assert.equal(groundPt.visible, true);
    assert.ok(Math.abs(groundPt.x - 500) < 0.01, `Expected ground x=500, got ${groundPt.x}`);
    assert.ok(Math.abs(groundPt.y - 400) < 0.01, `Expected ground y=400 (flush on footprint), got ${groundPt.y}`);

    // Roof point (relAlt = 20m) MUST lift by exactly 20m * 2px/m = 40px above ground footprint (y = 360)
    const roofPt = projectLngLatAltToScreen(mapWithPixel3D, { MercatorCoordinate: MC }, lng, lat, 20);
    assert.equal(roofPt.visible, true);
    assert.ok(Math.abs(roofPt.y - 360) < 0.01, `Expected roof y=360, got ${roofPt.y}`);

    // Fallback mercatorMatrix path (without pixelMatrix3D) MUST ALSO subtract camElevation and stay flush at y=400!
    const mapMercatorOnly = {
      getCanvas: () => ({ clientWidth: width, clientHeight: height }),
      getTerrain: () => ({ source: 'terrarium-dem', exaggeration: 1.25 }),
      queryTerrainElevation: () => camElevation,
      _camera: {
        projectedCamera: {
          elevation: camElevation,
          mercatorMatrix
        }
      }
    };
    const mercGround = projectLngLatAltToScreen(mapMercatorOnly, { MercatorCoordinate: MC }, lng, lat, 0);
    assert.equal(mercGround.visible, true);
    assert.ok(Math.abs(mercGround.y - 400) < 0.01, `Expected mercator fallback ground y=400, got ${mercGround.y}`);
    const mercRoof = projectLngLatAltToScreen(mapMercatorOnly, { MercatorCoordinate: MC }, lng, lat, 20);
    assert.ok(Math.abs(mercRoof.y - 360) < 0.01, `Expected mercator fallback roof y=360, got ${mercRoof.y}`);
  });
});
