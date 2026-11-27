import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import {
  computeInsideLandModelFraming,
  computeIsometricLandFraming
} from '../client/src/utils/isometricCameraFraming.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('Desktop Studio 3D Model Zoom Inside Land & Corner HUD Layout', () => {
  test('1. computeInsideLandModelFraming zooms inside the land to fill viewport with the model & unlocks macro close-up zoom', () => {
    // Exact real-world scenario: 5.56x4.97x4.68m Scholar's Bonsai inside 22.9x22.4x32.5m land
    const landOnly = computeIsometricLandFraming({
      volW: 22.9,
      volD: 22.4,
      volH: 32.5,
      modelHeight: 4.97,
      fovDeg: 46,
      aspect: 1.5
    });
    const insideModel = computeInsideLandModelFraming({
      modelWidth: 5.56,
      modelHeight: 4.97,
      modelDepth: 4.68,
      modelCenterX: 3.2,
      modelCenterY: 2.38,
      modelCenterZ: -2.1,
      modelMinY: 0,
      volW: 22.9,
      volD: 22.4,
      volH: 32.5,
      fovDeg: 46,
      aspect: 1.5,
      fillRatio: 0.84
    });

    // Camera distance for inside-land model focus is dramatically closer than full-land framing
    assert.ok(
      insideModel.distance < landOnly.distance * 0.35,
      `Expected inside-land model distance (${insideModel.distance.toFixed(2)}m) < 35% of full-land distance (${landOnly.distance.toFixed(2)}m)`
    );
    // Targets the model's actual offset position inside the land (not empty land center)
    assert.equal(insideModel.target[0], 3.2);
    assert.equal(insideModel.target[1], 2.38);
    assert.equal(insideModel.target[2], -2.1);

    // Camera sits right inside/close to the 22.9x22.4m land footprint filling the window with the bonsai
    assert.ok(
      insideModel.distance < 13.5,
      `Expected close-up window-filling distance < 13.5m, got ${insideModel.distance.toFixed(2)}m`
    );

    // Close-up zoom & near-clip plane allow flying right up to model details without clipping
    assert.ok(insideModel.minDistance <= 1.7, `minDistance too large: ${insideModel.minDistance}`);
    assert.ok(insideModel.near <= 0.08, `near clip plane too far: ${insideModel.near}`);
    // Still allows zooming all the way out past the entire 32.5m land volume
    assert.ok(insideModel.maxDistance >= 120, `maxDistance too small: ${insideModel.maxDistance}`);

    // Even in full-land framing, minDistance is unlocked so users can scroll into the land
    assert.ok(landOnly.minDistance <= 1.5, `landOnly minDistance should allow zooming into land, got ${landOnly.minDistance}`);
    assert.ok(landOnly.near <= 0.08, `landOnly near clip should avoid close clipping, got ${landOnly.near}`);
  });

  test('2. CSS defines desktop 2-column split studio (left 3D model view, right tooling) and 4-corner overlays', () => {
    const css = fs.readFileSync(path.join(ROOT, 'client', 'src', 'styles.css'), 'utf8');
    assert.match(css, /@media \(min-width: 960px\)[\s\S]*\.modal-card\.sculpture-modal-card\.is-studio-split/);
    assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1\.55fr\)\s*minmax\(380px,\s*445px\)/);
    assert.match(css, /\.viewer-corner-stack\.is-top-left/);
    assert.match(css, /\.viewer-corner-stack\.is-top-right/);
    assert.match(css, /\.viewer-corner-stack\.is-bottom-left/);
    assert.match(css, /\.sculpture-gizmo-hud-chip\.is-corner-br/);
  });
});

describe('SculptureModal Split Studio & Corner Stats UI (jsdom + Testing Library)', () => {
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
    outTmpDir = fs.mkdtempSync(path.join(ROOT, '.ui-studio-zoom-'));
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

  test('3. SculptureModal opens focused on model inside land, places model stats in viewer corners, and switches Focus Model <-> Fit Land', async () => {
    const { default: SculptureModal } = await loadJsxModule('client/src/components/SculptureModal.jsx');
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/lands/GLAND-CIRCLE1')) {
        return new Response(
          JSON.stringify({
            parcel: {
              parcelId: 'GLAND-CIRCLE1',
              customName: 'CIRCLE LAND',
              displayName: 'CIRCLE LAND',
              volume: {
                parcelId: 'GLAND-CIRCLE1',
                centerLat: 39.73,
                centerLng: -121.84,
                widthMeters: 22.9,
                depthMeters: 22.4,
                heightMeters: 32.5
              }
            },
            sculptures: []
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ ok: true, revisions: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const view = RTL.render(
        React.createElement(SculptureModal, {
          sculpture: {
            id: 'sc-bonsai-1',
            title: "Scholar's Bonsai",
            description: 'Japanese maple bonsai in a Yixing clay pot.',
            creatorSub: 'google:bigdog',
            creatorUsername: 'bigdog',
            creatorName: '@bigdog',
            recipientAddress: '0x2222222222222222222222222222222222222222',
            parcelId: 'GLAND-CIRCLE1',
            parcelName: 'CIRCLE LAND',
            lat: 39.73,
            lng: -121.84,
            modelType: 'custom-3d',
            customModel: { format: 'glb', scale: 8.15 },
            meshStats: { triangleCount: 37342 },
            anchorOffset: { dx: 0, dy: 0, dz: 0, yaw: 160 },
            currentRev: 3,
            polScore: 95,
            viewerIsLandOwner: true,
            chain: { tokenId: '9', royaltyPercent: 5, simulated: true, txHash: '0x055645f7aaaa' },
            ipfs: { metadataCid: 'bafy1' }
          },
          user: {
            id: 'google:bigdog',
            username: 'bigdog',
            walletAddress: '0x2222222222222222222222222222222222222222'
          },
          config: {},
          onClose: () => {}
        })
      );

      await RTL.waitFor(() => {
        assert.ok(view.getByTestId('sculpture-viewer-3d'));
        assert.ok(view.getByTestId('sculpture-viewer-corner-tl'));
        assert.ok(view.getByTestId('sculpture-viewer-corner-tr'));
        assert.ok(view.getByTestId('sculpture-viewer-corner-bl'));
      });

      const modal = view.getByTestId('sculpture-modal');
      assert.ok(modal.className.includes('is-studio-split'));

      // Defaults to zoomed-in model focus INSIDE the land (not pulled far out to land cube)
      const viewer = view.getByTestId('sculpture-viewer-3d');
      assert.equal(viewer.getAttribute('data-camera-focus'), 'model');
      assert.equal(viewer.getAttribute('data-camera-mode'), 'model-in-land');
      assert.equal(viewer.getAttribute('data-land-bounds-preview'), 'on');

      // Valuable model stats live inside the viewer corners (NOT cluttering the right tooling pane)
      const topRight = view.getByTestId('sculpture-viewer-corner-tr');
      assert.match(topRight.textContent, /GLB/);
      assert.match(topRight.textContent, /37,342 tris/);
      assert.match(topRight.textContent, /PoL 95\/100/);
      assert.match(topRight.textContent, /5% Fee/);
      assert.match(topRight.textContent, /v3/);

      const topLeft = view.getByTestId('sculpture-viewer-corner-tl');
      assert.match(topLeft.textContent, /CIRCLE LAND/);
      assert.match(topLeft.textContent, /Yaw 160°/);

      // Clicking Fit Land switches cameraFocus -> land; clicking Focus Model zooms back into model
      RTL.fireEvent.click(view.getByTestId('sculpture-fit-land-btn'));
      assert.equal(viewer.getAttribute('data-camera-focus'), 'land');
      assert.equal(viewer.getAttribute('data-camera-mode'), 'land');

      RTL.fireEvent.click(view.getByTestId('sculpture-focus-model-btn'));
      assert.equal(viewer.getAttribute('data-camera-focus'), 'model');
      assert.equal(viewer.getAttribute('data-camera-mode'), 'model-in-land');
    } finally {
      globalThis.fetch = origFetch;
      cleanup();
    }
  });
});
