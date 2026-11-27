/* global document, window */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import {
  MOBILE_3D_MAP_MAX_MODELS_COMPACT,
  MOBILE_3D_MAP_MAX_MODELS_FULLSCREEN,
  MOBILE_3D_MAP_MAX_PIXEL_RATIO,
  resolveMapLibrePixelRatio,
  selectPrioritizedThreeLayerSculptures
} from '../client/src/utils/mobileMapPerformance.js';

const ROOT = path.resolve(process.cwd());

describe('Mobile Full-Screen Map Refactor & WebGL Context-Loss / Delay Prevention', () => {
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
      jsx: 'automatic',
      plugins: [
        {
          name: 'ignore-css-and-url',
          setup(build) {
            build.onResolve({ filter: /\.css$/ }, (args) => ({
              path: args.path,
              namespace: 'ignore-css'
            }));
            build.onLoad({ filter: /.*/, namespace: 'ignore-css' }, () => ({
              contents: '',
              loader: 'js'
            }));
            build.onResolve({ filter: /\?url$/ }, (args) => ({
              path: args.path,
              namespace: 'mock-url'
            }));
            build.onLoad({ filter: /.*/, namespace: 'mock-url' }, () => ({
              contents: 'export default "";',
              loader: 'js'
            }));
          }
        }
      ],
      loader: { '.js': 'jsx', '.jsx': 'jsx', '.css': 'empty', '.svg': 'dataurl' },
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}_${Math.random()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-mobile-fullmap-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://spray.land/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.Event = dom.window.Event;
    globalThis.MouseEvent = dom.window.MouseEvent;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      configurable: true
    });
    dom.window.HTMLCanvasElement.prototype.getContext = () => null;

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    try {
      cleanup?.();
    } catch {
      // ignore
    }
    try {
      dom?.window?.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('1. mobileMapPerformance caps mobile DPR and prioritizes Three.js GLB models so 33+ lands never OOM mobile WebGL', () => {
    assert.equal(
      resolveMapLibrePixelRatio({ isDesktop: false, devicePixelRatio: 3.5 }),
      MOBILE_3D_MAP_MAX_PIXEL_RATIO
    );
    assert.equal(resolveMapLibrePixelRatio({ isDesktop: true, devicePixelRatio: 3 }), 2);
    assert.equal(
      resolveMapLibrePixelRatio({ isDesktop: false, devicePixelRatio: 3, lowPowerFallback: true }),
      1
    );

    const manySculptures = Array.from({ length: 33 }, (_, i) => ({
      id: `sc-${i + 1}`,
      parcelId: `GLAND-${i + 1}`,
      lat: 39.73 + i * 0.0005,
      lng: -121.84 + i * 0.0005,
      modelType: 'custom-3d'
    }));

    // Desktop mounts all 33 sculptures
    const desktopList = selectPrioritizedThreeLayerSculptures(manySculptures, {
      isDesktop: true,
      isFullExpanded: true
    });
    assert.equal(desktopList.length, 33);

    // Mobile compact caps to 4, full-screen caps to 6, strictly prioritizing selected & focused parcel first
    const mobileCompact = selectPrioritizedThreeLayerSculptures(manySculptures, {
      isDesktop: false,
      isFullExpanded: false,
      focusedParcelId: 'GLAND-11',
      selectedSculptureId: 'sc-25',
      focusCoords: { lat: 39.735, lng: -121.835 }
    });
    assert.equal(mobileCompact.length, MOBILE_3D_MAP_MAX_MODELS_COMPACT);
    assert.equal(mobileCompact[0].id, 'sc-25', 'Selected sculpture must be #1 priority');
    assert.equal(mobileCompact[1].id, 'sc-11', 'Focused parcel sculpture must be #2 priority');

    const mobileFull = selectPrioritizedThreeLayerSculptures(manySculptures, {
      isDesktop: false,
      isFullExpanded: true,
      focusedParcelId: 'GLAND-11',
      focusCoords: { lat: 39.735, lng: -121.835 }
    });
    assert.equal(mobileFull.length, MOBILE_3D_MAP_MAX_MODELS_FULLSCREEN);
    assert.equal(mobileFull[0].id, 'sc-11', 'Focused parcel must always load first in full-screen');
  });

  test('2. ARViewportCanvas suppresses recovery overlay while renderPaused (map open), scopes z-index below map, and MobileIsometricMap eliminates 2.6s dead-canvas freeze', () => {
    const arCanvasSrc = fs.readFileSync(
      path.join(ROOT, 'client', 'src', 'components', 'studio', 'ARViewportCanvas.jsx'),
      'utf8'
    );
    assert.match(arCanvasSrc, /\{contextLost && !renderPaused && \(/);
    assert.match(arCanvasSrc, /is-ar-viewport-recovery/);
    assert.match(arCanvasSrc, /needsRemountOnResumeRef\.current = true/);
    assert.match(arCanvasSrc, /onRequestContextRecoverRef\.current\?\.\(\)/);
    assert.match(arCanvasSrc, /if \(!activeXrSession && renderPausedRef\.current\)\s*\{\s*rafId = 0;\s*return;/);

    const css = fs.readFileSync(path.join(ROOT, 'client', 'src', 'styles.css'), 'utf8');
    assert.match(css, /\.mobile-map-overlay\s*\{[\s\S]*?z-index:\s*80;/);
    assert.match(css, /\.scene-error-fallback\.is-ar-viewport-recovery\s*\{\s*z-index:\s*45;/);

    const isoSrc = fs.readFileSync(
      path.join(ROOT, 'client', 'src', 'components', 'studio', 'MobileIsometricMap.jsx'),
      'utf8'
    );
    assert.equal(
      isoSrc.includes('2600'),
      false,
      'MobileIsometricMap must not stall for 2600ms on WebGL context loss'
    );
    assert.match(isoSrc, /pixelRatio:\s*safePixelRatio/);
    assert.match(isoSrc, /selectPrioritizedThreeLayerSculptures\(/);
    assert.match(isoSrc, /setWebglLost\(true\)/);
    assert.match(isoSrc, /setMapRemountNonce\(\(n\) => n \+ 1\)/);

    const threeLayerSrc = fs.readFileSync(
      path.join(ROOT, 'client', 'src', 'utils', 'map3dSculptureLayer.js'),
      'utf8'
    );
    assert.match(threeLayerSrc, /maxConcurrentLoads/);
    assert.match(threeLayerSrc, /drainLoadQueue\(\)/);
  });

  test('3. MobileMapSheet full-screen mode uses compact topbar, full dock actions (Add 3D, Find in AR, Navigate, Copy, Manage, List), 3D All-fit, 2D/3D toggle, and Esc exit', async () => {
    const { default: MobileMapSheet } = await loadJsxModule(
      'client/src/components/studio/MobileMapSheet.jsx'
    );

    const parcels = [
      {
        parcelId: 'GLAND-PROM',
        customName: 'Prometheus',
        ownerSub: 'user-mobile-owner',
        lat: 39.7285,
        lng: -121.8375,
        centerLat: 39.7285,
        centerLng: -121.8375,
        bounds: { center: [39.7285, -121.8375], minLat: 39.7284, maxLat: 39.7286, minLng: -121.8376, maxLng: -121.8374 },
        widthMeters: 23,
        depthMeters: 25,
        heightMeters: 50,
        frozen: false,
        requireApproval: false,
        sculptureCount: 1
      },
      {
        parcelId: 'GLAND-CIRCLE',
        customName: 'CIRCLE LAND',
        ownerSub: 'user-other',
        lat: 39.7292,
        lng: -121.8369,
        centerLat: 39.7292,
        centerLng: -121.8369,
        bounds: { center: [39.7292, -121.8369], minLat: 39.7291, maxLat: 39.7293, minLng: -121.837, maxLng: -121.8368 },
        widthMeters: 18,
        depthMeters: 18,
        heightMeters: 24,
        frozen: false,
        requireApproval: false,
        sculptureCount: 1
      }
    ];
    const sculptures = [
      {
        id: 'sc-prom-1',
        title: 'Golden Prometheus',
        parcelId: 'GLAND-PROM',
        lat: 39.7285,
        lng: -121.8375,
        modelType: 'custom-3d'
      },
      {
        id: 'sc-circ-1',
        title: 'Bonsai',
        parcelId: 'GLAND-CIRCLE',
        lat: 39.7292,
        lng: -121.8369,
        modelType: 'custom-3d'
      }
    ];

    const searchAddOpenedFor = [];
    const managedLandIds = [];
    const findArLands = [];

    RTL.render(
      React.createElement(MobileMapSheet, {
        user: { id: 'user-mobile-owner' },
        ownedParcelIds: ['GLAND-PROM'],
        config: {},
        location: { lat: 39.7286, lng: -121.8374 },
        areaFilterMode: 'all',
        setAreaFilterMode: () => {},
        mapParcels: parcels,
        displayedMapSculptures: sculptures,
        areaSculpturesSorted: sculptures,
        selectedParcelId: 'GLAND-PROM',
        onSelectParcel: () => {},
        onSelectSculpture: () => {},
        onFindLandInAR: (land) => findArLands.push(land.parcelId),
        onManageLand: (pid) => managedLandIds.push(pid),
        onOpenSearchAdd: (land) => searchAddOpenedFor.push(land.parcelId),
        onShowHint: () => {},
        onClose: () => {}
      })
    );

    // Compact mode initially
    const overlay = document.querySelector('[data-testid="mobile-map-overlay"]');
    assert.equal(overlay.getAttribute('data-map-fullscreen'), 'false');
    assert.equal(document.querySelector('[data-testid="mobile-map-fullscreen-topbar"]'), null);
    assert.ok(document.querySelector('[data-testid="mobile-nearest-lands-list"]'));

    // Expand to Full Screen
    RTL.fireEvent.click(document.querySelector('[data-testid="mobile-map-expand-header-btn"]'));
    assert.equal(overlay.getAttribute('data-map-fullscreen'), 'true');
    assert.ok(
      document.querySelector('[data-testid="mobile-map-fullscreen-topbar"]'),
      'Full-screen mode should collapse header into compact single-row topbar'
    );
    assert.equal(document.querySelector('[data-testid="mobile-nearest-lands-list"]'), null);

    // Full-screen 3D map toolbar includes Fit, All (cluster fit), 2D toggle, Orbit, Me, Theme, Exit Full, Info
    assert.ok(document.querySelector('[data-testid="mobile-map-fit-btn"]'));
    assert.ok(document.querySelector('[data-testid="mobile-map-fit-all-btn"]'));
    assert.ok(document.querySelector('[data-testid="mobile-map-2d-toggle-btn"]'));
    assert.ok(document.querySelector('[data-testid="mobile-iso-map-info"]'));

    // Bottom Full-Screen Dock exposes Add 3D, Find in AR, Navigate, Copy, Manage, and List
    const dock = document.querySelector('[data-testid="mobile-map-fullscreen-dock"]');
    assert.ok(dock);
    const addBtn = document.querySelector('[data-testid="mobile-map-dock-search-add-btn"]');
    const findArBtn = document.querySelector('[data-testid="mobile-map-dock-find-ar-btn"]');
    const copyBtn = document.querySelector('[data-testid="mobile-map-dock-copy-btn"]');
    const manageBtn = document.querySelector('[data-testid="mobile-map-dock-manage-btn"]');
    assert.ok(addBtn, 'Add 3D button should appear in full-screen dock for open/owned land');
    assert.ok(findArBtn, 'Find in AR button should appear in full-screen dock');
    assert.ok(copyBtn, 'Copy link icon should appear in full-screen dock');
    assert.ok(manageBtn, 'Manage gear should appear in full-screen dock for owned land');

    RTL.fireEvent.click(addBtn);
    RTL.fireEvent.click(findArBtn);
    RTL.fireEvent.click(manageBtn);
    assert.deepEqual(searchAddOpenedFor, ['GLAND-PROM']);
    assert.deepEqual(findArLands, ['GLAND-PROM']);
    assert.deepEqual(managedLandIds, ['GLAND-PROM']);

    // Switch 3D -> 2D while in Full Screen -> stays full-screen and shows 2D map info & 3D toggle
    RTL.fireEvent.click(document.querySelector('[data-testid="mobile-map-2d-toggle-btn"]'));
    assert.equal(overlay.getAttribute('data-map-fullscreen'), 'true');
    assert.ok(document.querySelector('[data-testid="mobile-map-3d-toggle-btn"]'));
    assert.ok(document.querySelector('[data-testid="mobile-2d-map-info"]'));

    // Switch back 2D -> 3D while in Full Screen
    RTL.fireEvent.click(document.querySelector('[data-testid="mobile-map-3d-toggle-btn"]'));
    assert.equal(overlay.getAttribute('data-map-fullscreen'), 'true');
    assert.ok(document.querySelector('[data-testid="mobile-iso-3d-map"]'));

    // Press Esc -> cleanly exits Full Screen back to split map + Nearest Lands list
    RTL.fireEvent.keyDown(window, { key: 'Escape' });
    assert.equal(overlay.getAttribute('data-map-fullscreen'), 'false');
    assert.ok(document.querySelector('[data-testid="mobile-nearest-lands-list"]'));
    cleanup();
  });
});
