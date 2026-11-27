import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolveTerrainGroundMeters } from '../client/src/utils/map3dProjection.js';

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
});
