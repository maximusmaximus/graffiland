import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

const ROOT = path.resolve(process.cwd());

describe('Center Tool & Block-Diameter Reticle Circle (Brush & Pencil)', () => {
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
          }
        }
      ],
      loader: { '.js': 'jsx', '.jsx': 'jsx', '.css': 'empty', '.svg': 'dataurl' },
      outfile: absOut
    });
    return import(`${pathToFileURL(absOut).href}?v=${Date.now()}_${Math.random()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-tool-reticle-'));
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
    globalThis.PointerEvent = dom.window.PointerEvent || dom.window.MouseEvent;
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
    dom.window.HTMLCanvasElement.prototype.getContext = (kind) =>
      kind === '2d'
        ? {
            createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
            getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
            putImageData: () => {},
            clearRect: () => {},
            drawImage: () => {}
          }
        : null;

    React = (await import('react')).default;
    RTL = await import('@testing-library/react');
    cleanup = RTL.cleanup;
  });

  after(() => {
    cleanup?.();
    try {
      fs.rmSync(outTmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test('1. computeCenterToolReticleMetrics scales strictly across S/M/L/XL, Brush vs Pencil, and depth', async () => {
    const { computeCenterToolReticleMetrics } = await loadJsxModule(
      'client/src/utils/toolReticleSizing.js'
    );

    for (const depthMeters of [0.8, 1.8, 3.0]) {
      const s = computeCenterToolReticleMetrics({ tool: 'pencil', blockSize: 0.5, depthMeters });
      const m = computeCenterToolReticleMetrics({ tool: 'pencil', blockSize: 1, depthMeters });
      const l = computeCenterToolReticleMetrics({ tool: 'pencil', blockSize: 1.5, depthMeters });
      const xl = computeCenterToolReticleMetrics({ tool: 'pencil', blockSize: 2, depthMeters });
      assert.ok(
        s.diameterPx < m.diameterPx && m.diameterPx < l.diameterPx && l.diameterPx < xl.diameterPx,
        `Pencil diameter must scale monotonically at depth=${depthMeters}m: ${s.diameterPx}, ${m.diameterPx}, ${l.diameterPx}, ${xl.diameterPx}`
      );

      const brushM = computeCenterToolReticleMetrics({ tool: 'brush', blockSize: 1, depthMeters });
      assert.ok(
        brushM.diameterPx > m.diameterPx,
        `Brush diameter (${brushM.diameterPx}) must reflect spray cone wider than Pencil (${m.diameterPx})`
      );
      assert.equal(brushM.blockDiameterPx, m.blockDiameterPx);
    }

    const nearM = computeCenterToolReticleMetrics({ tool: 'pencil', blockSize: 1, depthMeters: 0.8 });
    const farM = computeCenterToolReticleMetrics({ tool: 'pencil', blockSize: 1, depthMeters: 2.4 });
    assert.ok(nearM.diameterPx > farM.diameterPx, 'Closer surface depth must render a larger projected diameter');
  });

  test('2. ToolCenterReticle displays tool/block diameter circle, sets surface on first click, then draws at center', async () => {
    const { default: ToolCenterReticle } = await loadJsxModule(
      'client/src/components/studio/ToolCenterReticle.jsx'
    );

    let setSurfaceCalls = 0;
    let drawCenterCalls = 0;
    let holdStartCalls = 0;
    let holdStopCalls = 0;

    // 2a) Non-brush/pencil tools keep standard passive .reticle
    const stackView = RTL.render(
      React.createElement(ToolCenterReticle, {
        tool: 'stack',
        blockSize: 1
      })
    );
    assert.equal(stackView.queryByTestId('tool-center-reticle'), null);
    assert.ok(stackView.container.querySelector('.reticle'));
    cleanup();

    // 2b) Pencil with no surface yet -> first click sets surface, does NOT draw
    const view = RTL.render(
      React.createElement(ToolCenterReticle, {
        tool: 'pencil',
        blockSize: 0.5,
        color: '#ef4444',
        reachMeters: 1.4,
        surfaceAnchor: null,
        onSetCenterSurface: () => {
          setSurfaceCalls += 1;
        },
        onDrawAtCenter: () => {
          drawCenterCalls += 1;
        },
        onStartCenterBrushHold: () => {
          holdStartCalls += 1;
        },
        onStopCenterBrushHold: () => {
          holdStopCalls += 1;
        }
      })
    );

    const reticle = view.getByTestId('tool-center-reticle');
    const ring = view.getByTestId('tool-reticle-ring');
    const smallDiameter = Number(reticle.getAttribute('data-diameter-px'));
    assert.equal(reticle.getAttribute('data-surface-set'), 'false');
    assert.match(view.getByTestId('tool-reticle-caption').textContent, /Tap circle to set surface/i);
    assert.equal(ring.style.width, `${smallDiameter}px`);

    // First tap inside circle sets the surface location
    RTL.fireEvent.pointerDown(reticle, { button: 0, pointerId: 1 });
    RTL.fireEvent.pointerUp(reticle, { button: 0, pointerId: 1 });
    assert.equal(setSurfaceCalls, 1, 'First click in circle must set surface');
    assert.equal(drawCenterCalls, 0, 'First click must set surface before drawing');

    // 2c) Rerender with XL block & locked surface -> circle grows & click draws at center!
    view.rerender(
      React.createElement(ToolCenterReticle, {
        tool: 'pencil',
        blockSize: 2,
        color: '#ef4444',
        reachMeters: 1.4,
        surfaceAnchor: { x: 0, y: 0, z: -1.4, nx: 0, ny: 0, nz: 1, depthM: 1.4, locked: true },
        onSetCenterSurface: () => {
          setSurfaceCalls += 1;
        },
        onDrawAtCenter: () => {
          drawCenterCalls += 1;
        },
        onStartCenterBrushHold: () => {
          holdStartCalls += 1;
        },
        onStopCenterBrushHold: () => {
          holdStopCalls += 1;
        }
      })
    );

    const xlDiameter = Number(view.getByTestId('tool-center-reticle').getAttribute('data-diameter-px'));
    assert.ok(xlDiameter > smallDiameter, 'Selecting XL block must increase center circle diameter');
    assert.equal(view.getByTestId('tool-center-reticle').getAttribute('data-surface-set'), 'true');

    RTL.fireEvent.pointerDown(view.getByTestId('tool-center-reticle'), { button: 0, pointerId: 2 });
    RTL.fireEvent.pointerUp(view.getByTestId('tool-center-reticle'), { button: 0, pointerId: 2 });
    assert.equal(setSurfaceCalls, 1, 'Subsequent click must not re-set surface');
    assert.equal(drawCenterCalls, 1, 'Subsequent click in circle must draw at center location');

    // 2d) Brush mode hold inside circle starts & stops continuous spray
    view.rerender(
      React.createElement(ToolCenterReticle, {
        tool: 'brush',
        blockSize: 2,
        color: '#00f5d4',
        reachMeters: 1.4,
        surfaceAnchor: { x: 0, y: 0, z: -1.4, nx: 0, ny: 0, nz: 1, depthM: 1.4, locked: true },
        onSetCenterSurface: () => {
          setSurfaceCalls += 1;
        },
        onDrawAtCenter: () => {
          drawCenterCalls += 1;
        },
        onStartCenterBrushHold: () => {
          holdStartCalls += 1;
        },
        onStopCenterBrushHold: () => {
          holdStopCalls += 1;
        }
      })
    );

    const brushXlDiameter = Number(
      view.getByTestId('tool-center-reticle').getAttribute('data-diameter-px')
    );
    assert.ok(brushXlDiameter > xlDiameter, 'Brush diameter should exceed Pencil for the same XL block');

    RTL.fireEvent.pointerDown(view.getByTestId('tool-center-reticle'), { button: 0, pointerId: 3 });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(holdStartCalls, 1, 'Holding inside circle in Brush mode must start continuous spray');
    RTL.fireEvent.pointerUp(view.getByTestId('tool-center-reticle'), { button: 0, pointerId: 3 });
    assert.equal(holdStopCalls, 1, 'Releasing circle hold must stop continuous spray');
    cleanup();
  });

  test('3. End-to-end with useVoxelBrush: first circle click sets surfaceAnchor, second draws voxel at locked location', async () => {
    const { default: ToolCenterReticle } = await loadJsxModule(
      'client/src/components/studio/ToolCenterReticle.jsx'
    );
    const { useVoxelBrush } = await loadJsxModule('client/src/hooks/useVoxelBrush.js');

    function CenterCircleDrawHarness() {
      const polRef = React.useRef({
        analyzeSurfacePatch: () => ({ sharpnessScore: 0.42 })
      });
      const rawOrientationRef = React.useRef(null);
      const fallbackEulerRef = React.useRef({ yaw: 0, pitch: 0 });
      const canvasHostRef = React.useRef({
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 })
      });
      const cameraRef = React.useRef(null);
      if (!cameraRef.current) {
        const cam = new THREE.PerspectiveCamera(65, 390 / 844, 0.05, 100);
        cam.position.set(0, 0.4, 2.2);
        cam.lookAt(0, 0.4, 0);
        cam.updateMatrixWorld(true);
        cameraRef.current = cam;
      }
      const draftGroupRef = React.useRef(new THREE.Group());
      const transformBoxRef = React.useRef(null);
      const surfaceMarkerRef = React.useRef(null);
      const shadowPlaneRef = React.useRef(null);
      const gridHelperRef = React.useRef(null);
      const nearbyGroupRef = React.useRef(new THREE.Group());
      const arTargetedIdRef = React.useRef('');
      const locationRef = React.useRef({ lat: 39.73, lng: -121.84 });

      const brush = useVoxelBrush({
        config: { policy: {} },
        initialDraft: {},
        user: { id: 'u1', username: 'creator' },
        location: locationRef.current,
        locationRef,
        cameraReady: true,
        sceneScan: { optimal: true, scannedCount: 7, targetCount: 7 },
        calibrationReady: true,
        polRef,
        rawOrientationRef,
        fallbackEulerRef,
        enterFullscreen: () => {},
        setSensorBanner: () => {},
        showTemporaryHint: () => {},
        canvasHostRef,
        cameraRef,
        draftGroupRef,
        transformBoxRef,
        surfaceMarkerRef,
        shadowPlaneRef,
        gridHelperRef,
        nearbyGroupRef,
        arTargetedIdRef,
        setArTargetedSculpture: () => {},
        arPinPreview: null,
        openCameraSelectedChat: () => {},
        openAgentHandoffRef: React.useRef(() => {}),
        openPublishSheetRef: React.useRef(() => {})
      });

      return React.createElement(
        'div',
        null,
        React.createElement('div', { 'data-testid': 'voxel-count' }, String(brush.voxels.length)),
        React.createElement(
          'div',
          { 'data-testid': 'surface-label' },
          brush.surfaceAnchor?.label || 'none'
        ),
        React.createElement(ToolCenterReticle, {
          tool: brush.tool,
          blockSize: brush.blockSize,
          color: brush.color,
          reachMeters: brush.reachMeters,
          surfaceAnchor: brush.surfaceAnchor,
          painting: brush.painting,
          onSetCenterSurface: () => brush.selectSurfaceAtScreenPoint(),
          onDrawAtCenter: brush.drawAtCenter,
          onStartCenterBrushHold: () => brush.startContinuousHoldTool('brush'),
          onStopCenterBrushHold: brush.stopBrushPainting
        })
      );
    }

    const view = RTL.render(React.createElement(CenterCircleDrawHarness));
    assert.equal(view.getByTestId('surface-label').textContent, 'none');
    assert.equal(view.getByTestId('voxel-count').textContent, '0');

    // First click in circle sets surface at center location
    RTL.fireEvent.click(view.getByTestId('tool-center-reticle'));
    assert.notEqual(view.getByTestId('surface-label').textContent, 'none');
    assert.equal(view.getByTestId('voxel-count').textContent, '0');

    // Second click in circle draws at that specific locked location!
    RTL.fireEvent.click(view.getByTestId('tool-center-reticle'));
    assert.equal(view.getByTestId('voxel-count').textContent, '1');
    cleanup();
  });
});
