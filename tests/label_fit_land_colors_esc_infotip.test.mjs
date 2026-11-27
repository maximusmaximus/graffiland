import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import {
  LAND_LIFECYCLE_COLORS,
  formatSimpleLandLabel,
  resolveLandColorTheme
} from '../client/src/utils/landMapHelpers.js';
import { computeSideArtworkCallouts } from '../client/src/utils/map3dLabelOverlay.js';
import { resolveNeighborTagTheme } from '../client/src/utils/neighborEdgeArrows.js';

const ROOT = path.resolve(process.cwd());

describe('Label Fit, Land Lifecycle Colors, Esc Draft Removal & Timer/Map InfoTips', () => {
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
    return import(`file://${absOut.replace(/\\/g, '/')}?t=${Date.now()}_${Math.random()}`);
  }

  before(async () => {
    outTmpDir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-ux-polish-'));
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://spray.land/'
    });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Node = dom.window.Node;
    globalThis.Event = dom.window.Event;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.MouseEvent = dom.window.MouseEvent;
    globalThis.CustomEvent = dom.window.CustomEvent;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.sessionStorage = dom.window.sessionStorage;
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

  test('1. Side artwork callouts dynamically widen to fit long titles like "Food Produce Banana (M01)" and CSS prevents left-clipping', () => {
    const sculptures = [
      {
        id: 'sc-banana',
        title: 'Food Produce Banana (M01)',
        modelType: 'custom-3d',
        customModel: { format: 'glb' },
        lat: 39.738,
        lng: -121.849
      },
      {
        id: 'sc-snarl',
        title: 'Steamboat Snarl',
        modelType: 'custom-3d',
        customModel: { format: 'glb' },
        lat: 39.7381,
        lng: -121.8489
      }
    ];

    const callouts = computeSideArtworkCallouts({
      sculptures,
      volume: { centerLat: 39.738, centerLng: -121.849, heightMeters: 20 },
      viewportWidth: 800,
      viewportHeight: 420,
      projectScreenPt: (_lng, _lat, _alt, sc) =>
        sc.id === 'sc-banana' ? { x: 460, y: 180 } : { x: 480, y: 220 }
    });

    const banana = callouts.find((c) => c.sculptureId === 'sc-banana');
    const snarl = callouts.find((c) => c.sculptureId === 'sc-snarl');
    assert.ok(banana && snarl);
    assert.ok(
      banana.width >= 215,
      `Expected "Food Produce Banana (M01)" pill to widen >=215px, got ${banana.width}`
    );
    assert.ok(
      banana.width > snarl.width,
      `Expected longer title (${banana.width}px) to get wider pill than shorter title (${snarl.width}px)`
    );
    assert.ok(banana.x >= 0 && banana.x + banana.width <= 800, 'Callout stays inside viewport');

    // Verify CSS fixes the right-side flex-end left-clipping bug
    const css = fs.readFileSync(path.join(ROOT, 'client/src/styles.css'), 'utf8');
    const rightRuleIdx = css.indexOf('.plot-iso-artwork-callout.is-right .plot-iso-callout-main');
    assert.ok(rightRuleIdx !== -1);
    const rightBlock = css.slice(rightRuleIdx, rightRuleIdx + 180);
    assert.match(rightBlock, /align-items:\s*stretch/);
    assert.doesNotMatch(rightBlock, /align-items:\s*flex-end/);

    const mainIdx = css.indexOf('.plot-iso-callout-main {');
    const mainBlock = css.slice(mainIdx, mainIdx + 240);
    assert.match(mainBlock, /overflow:\s*hidden/);

    // Verify formatSimpleLandLabel preserves default 20-char behavior and supports wider maxLength
    assert.equal(
      formatSimpleLandLabel(
        { parcelId: 'GLAND-1', customName: 'PREMIUM COLLEGE TOWN PLAZA' },
        null,
        { maxLength: 30 }
      ),
      'PREMIUM COLLEGE TOWN PLAZA'
    );
  });

  test('2. Permanent lands and lands needing human artwork resolve distinct colors everywhere', () => {
    const nowMs = Date.UTC(2026, 10, 27, 8, 0, 0);
    const permanentLand = {
      parcelId: 'GLAND-PERM1',
      customName: 'Permanent Plaza',
      stewardStatus: 'awakened',
      hadHumanInteraction: true
    };
    const mapCreatedLand = {
      parcelId: 'GLAND-TEMP1',
      customName: 'Needs Human Art Lot',
      stewardStatus: 'active',
      hadHumanInteraction: false,
      inactivityExpiresAt: new Date(nowMs + (26 * 24 + 18) * 3600 * 1000).toISOString()
    };
    const dormantAgentLand = {
      parcelId: 'GLAND-DORM1',
      customName: 'AI Scouted Stage',
      stewardStatus: 'dormant',
      leaseExpiresAt: new Date(nowMs + 48 * 3600 * 1000).toISOString()
    };
    const frozenLand = {
      parcelId: 'GLAND-FRZN1',
      customName: 'Frozen Gallery',
      frozen: true
    };

    const permTheme = resolveLandColorTheme(permanentLand, { nowMs });
    const tempTheme = resolveLandColorTheme(mapCreatedLand, { nowMs });
    const dormTheme = resolveLandColorTheme(dormantAgentLand, { nowMs });
    const frznTheme = resolveLandColorTheme(frozenLand, { nowMs });

    assert.equal(permTheme.status, 'permanent');
    assert.equal(permTheme.outerColor, LAND_LIFECYCLE_COLORS.permanent.outerColor);
    assert.equal(permTheme.outerColor, '#ff1f8f');

    assert.equal(tempTheme.status, 'needs-human-art');
    assert.equal(tempTheme.outerColor, LAND_LIFECYCLE_COLORS.needsHumanArt.outerColor);
    assert.equal(tempTheme.outerColor, '#ff9f1c');
    assert.notEqual(tempTheme.outerColor, permTheme.outerColor);

    assert.equal(dormTheme.status, 'needs-human-art');
    assert.equal(dormTheme.outerColor, '#ff9f1c');

    assert.equal(frznTheme.status, 'frozen');
    assert.equal(frznTheme.outerColor, '#7dd3fc');

    // Neighbor arrows also separate permanent vs needs-human-art
    const permArrow = resolveNeighborTagTheme({ kind: 'land', defaultLandColor: '#ff1f8f' });
    const tempArrow = resolveNeighborTagTheme({
      kind: 'land',
      defaultLandColor: '#ff1f8f',
      needsHumanArt: true
    });
    assert.equal(permArrow.accentColor, '#ff1f8f');
    assert.equal(tempArrow.accentColor, '#ff9f1c');
  });

  test('3. LandIsometricPreview shows countdown meaning in "i" next to "⏱️ 26d 18h left", puts map navigation "i" inside the map, and colors temporary vs permanent lands differently', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

    try {
      const { default: LandIsometricPreview } = await loadJsxModule(
        'client/src/components/LandIsometricPreview.jsx'
      );

      const expiresIso = new Date(Date.now() + (26 * 24 + 18) * 3600 * 1000 + 20 * 60 * 1000).toISOString();
      const tempParcel = {
        parcelId: 'GLAND-TEMP26',
        customName: 'Sunset Lot',
        stewardStatus: 'active',
        hadHumanInteraction: false,
        inactivityExpiresAt: expiresIso,
        sculptureCount: 1,
        volume: {
          centerLat: 37.7793,
          centerLng: -122.4193,
          widthMeters: 16,
          depthMeters: 16,
          heightMeters: 18,
          rotationDeg: 0
        }
      };

      const view = RTL.render(React.createElement(LandIsometricPreview, { parcel: tempParcel }));

      // 1) Temporary land renders Amber (#ff9f1c), not Neon Pink
      const svgHtml = view.getByTestId('land-preview-svg-fallback').querySelector('svg').innerHTML;
      assert.ok(svgHtml.includes('#ff9f1c'), 'Temporary land SVG preview should render in Amber #ff9f1c');
      assert.ok(!svgHtml.includes('#ff1f8f'), 'Temporary land SVG preview should not render in Permanent Pink');

      // 2) Timer badge + its own "i" button sit together in header and explain countdown meaning
      const timerGroup = view.getByTestId('land-preview-timer-group');
      assert.match(timerGroup.textContent || '', /26d 18h left/i);
      const timerInfoBtn = view
        .getByTestId('land-preview-timer-info')
        .querySelector('button.info-tip-btn');
      assert.ok(timerInfoBtn, 'Expected "i" button right next to countdown badge');
      RTL.fireEvent.click(timerInfoBtn);
      const timerPanel = view.container.querySelector('[role="tooltip"]');
      assert.ok(timerPanel, 'Expected timer InfoTip panel to open');
      const timerText = timerPanel.textContent || '';
      assert.match(timerText, /What This Countdown Means/i);
      assert.match(timerText, /Mobile AR/i);
      assert.match(timerText, /permanent/i);
      assert.doesNotMatch(timerText, /Switch between Iso/i, 'Timer "i" must NOT contain map navigation copy');

      // 3) Map navigation "i" lives INSIDE .land-preview-stage (the map itself)
      const mapInfoWrap = view.getByTestId('land-preview-map-info');
      assert.ok(
        mapInfoWrap.closest('.land-preview-stage'),
        'Map navigation "i" must live inside the map stage'
      );
      const mapInfoBtn = mapInfoWrap.querySelector('button.info-tip-btn');
      assert.ok(mapInfoBtn);
      RTL.fireEvent.click(mapInfoBtn);
      const mapPanel = mapInfoWrap.querySelector('[role="tooltip"]');
      assert.ok(mapPanel, 'Expected map navigation InfoTip panel to open inside map');
      assert.match(mapPanel.textContent || '', /How to Navigate This Map/i);
      assert.match(mapPanel.textContent || '', /Iso/i);
      assert.match(mapPanel.textContent || '', /Neon Pink/i);
      assert.match(mapPanel.textContent || '', /Amber/i);

      cleanup();

      // 4) Permanent land renders Neon Pink (#ff1f8f) and hides countdown badge
      const permParcel = {
        ...tempParcel,
        parcelId: 'GLAND-PERM99',
        stewardStatus: 'awakened',
        hadHumanInteraction: true,
        inactivityExpiresAt: ''
      };
      const permView = RTL.render(React.createElement(LandIsometricPreview, { parcel: permParcel }));
      const permSvg = permView.getByTestId('land-preview-svg-fallback').querySelector('svg').innerHTML;
      assert.ok(permSvg.includes('#ff1f8f'), 'Permanent land SVG preview should render in Neon Pink #ff1f8f');
      assert.equal(permView.queryByTestId('land-preview-timer-group'), null);
      assert.ok(permView.getByTestId('land-preview-map-info').closest('.land-preview-stage'));
      cleanup();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('4. Pressing Esc in DesktopHub after drawing a land removes the newly drawn draft (and MapView3D legend shows Permanent vs Needs Human Art)', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const s = String(url || '');
      if (s.includes('/api/parcels')) {
        return {
          ok: true,
          json: async () => ({
            parcels: [
              {
                parcelId: 'GLAND-PERM',
                customName: 'Permanent Park',
                stewardStatus: 'awakened',
                hadHumanInteraction: true,
                centerLat: 37.7749,
                centerLng: -122.4194
              },
              {
                parcelId: 'GLAND-TEMP',
                customName: 'Needs Art Plaza',
                stewardStatus: 'dormant',
                leaseExpiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
                centerLat: 37.7755,
                centerLng: -122.419
              }
            ]
          })
        };
      }
      if (s.includes('/api/sculptures')) {
        return { ok: true, json: async () => ({ sculptures: [] }) };
      }
      if (s.includes('/api/marketplace')) {
        return { ok: true, json: async () => ({ listings: [] }) };
      }
      if (s.includes('/api/agents/leaderboard')) {
        return { ok: true, json: async () => ({ aiStewards: [], humanArtists: [] }) };
      }
      if (s.includes('/api/lands/mine')) {
        return { ok: true, json: async () => ({ parcelCount: 0, parcels: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    };

    try {
      const { default: DesktopHub } = await loadJsxModule('client/src/components/DesktopHub.jsx');
      const view = RTL.render(
        React.createElement(DesktopHub, {
          user: { id: 'u1', username: 'artist1', walletAddress: '0x0000000000000000000000000000000000000001' },
          config: { network: 'testnet' }
        })
      );

      // Verify MapView3D legend clearly shows both Permanent (1) and Needs Human Art (1)
      await RTL.waitFor(() => {
        assert.match(view.getByTestId('map3d-legend-permanent').textContent || '', /Permanent \(1\)/i);
        assert.match(
          view.getByTestId('map3d-legend-needs-human-art').textContent || '',
          /Needs Human Art \(1\)/i
        );
      });

      // Open Mint Land builder and place a draft land via "+ Add Square"
      const mintLandTab = view.getAllByRole('button', { name: /Mint Land/i })[0];
      RTL.fireEvent.click(mintLandTab);

      const addSquareBtn = await RTL.waitFor(() =>
        view.getByRole('button', { name: /\+ Add Square|Add 3D Land/i })
      );
      RTL.fireEvent.click(addSquareBtn);

      // Confirm 1 draft land exists
      await RTL.waitFor(() => {
        const stage = view.container.querySelector('.map3d-stage');
        assert.equal(stage?.getAttribute('data-draft-count'), '1');
      });

      // Press Escape -> removes the newly drawn draft land immediately!
      RTL.fireEvent.keyDown(dom.window, { key: 'Escape' });

      await RTL.waitFor(() => {
        const stage = view.container.querySelector('.map3d-stage');
        assert.equal(stage?.getAttribute('data-draft-count'), '0');
      });

      // Ctrl+Z can still undo the Esc removal if pressed accidentally
      RTL.fireEvent.keyDown(dom.window, { key: 'z', ctrlKey: true });
      await RTL.waitFor(() => {
        const stage = view.container.querySelector('.map3d-stage');
        assert.equal(stage?.getAttribute('data-draft-count'), '1');
      });

      cleanup();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
